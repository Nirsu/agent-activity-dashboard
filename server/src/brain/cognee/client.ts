import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { brainConfig } from '../config.js';
import { CogneeHttp, identifier, record } from './http.js';
import type { CogneeGraph, CogneeHit, CogneeOptions, CogneeSource } from './types.js';

export type { CogneeGraph, CogneeHit, CogneeOptions, CogneeSource } from './types.js';

const completed = 'DATASET_PROCESSING_COMPLETED';
const failed = 'DATASET_PROCESSING_ERRORED';
const processing = ['DATASET_PROCESSING_INITIATED', 'DATASET_PROCESSING_STARTED'];

export class CogneeClient {
  private readonly http: CogneeHttp;

  constructor(options: CogneeOptions = {}) {
    this.http = new CogneeHttp(options);
  }

  close() {
    this.http.close();
  }

  async status(): Promise<{
    configured: boolean;
    available: boolean;
    reason?: string;
    version?: string;
  }> {
    if (!this.http.configured) {
      return {
        configured: false,
        available: false,
        reason: 'Configure COGNEE_API_URL and Cognee service credentials on the server.',
      };
    }
    try {
      await this.http.request('/health');
      await this.http.request('/api/v1/auth/me');
      return { configured: true, available: true };
    } catch (error) {
      return { configured: true, available: false, reason: (error as Error).message };
    }
  }

  async index(source: CogneeSource, datasetName: string): Promise<{ datasetId: string }> {
    if (!source.content.trim() || !/^[a-zA-Z0-9_-]+$/.test(datasetName)) {
      throw new Error('A nonempty capture and a valid immutable dataset name are required.');
    }
    const dataset = record(await this.json('/api/v1/datasets', { name: datasetName }));
    const datasetId = identifier(dataset.id);
    const current = await this.pipelineStatus(datasetId);
    if (current === completed) {
      return { datasetId };
    }
    if (current && processing.includes(current)) {
      await this.waitForIndex(datasetId);
      return { datasetId };
    }

    const captureName = createHash('sha256')
      .update(`${source.id}\n${source.revision}`)
      .digest('hex');
    const body = new FormData();
    body.set('datasetId', datasetId);
    body.set('data', new Blob([source.content], { type: 'text/plain' }), `${captureName}.txt`);
    body.set('run_in_background', 'false');
    const added = record(await this.http.request('/api/v1/add', { method: 'POST', body }));
    if (
      identifier(added.dataset_id) !== datasetId ||
      !['PipelineRunCompleted', 'PipelineRunAlreadyCompleted'].includes(String(added.status))
    ) {
      throw new Error('Cognee did not finish adding the source capture.');
    }
    const result = record(
      await this.json('/api/v1/cognify', {
        dataset_ids: [datasetId],
        run_in_background: true,
        chunks_per_batch: brainConfig.cognee.chunksPerBatch,
        data_per_batch: brainConfig.cognee.dataPerBatch,
      }),
    );
    const run = record(result[datasetId]);
    if (
      identifier(run.dataset_id) !== datasetId ||
      !['PipelineRunStarted', 'PipelineRunCompleted', 'PipelineRunAlreadyCompleted'].includes(
        String(run.status),
      )
    ) {
      throw new Error('Cognee could not start indexing the source capture.');
    }
    await this.waitForIndex(datasetId);
    return { datasetId };
  }

  async search(query: string, datasetIds: string[]): Promise<CogneeHit[]> {
    const allowed = new Set(datasetIds.map(identifier));
    if (!allowed.size || !query.trim()) {
      return [];
    }
    const response = await this.json('/api/v1/search', {
      search_type: 'CHUNKS',
      query,
      dataset_ids: [...allowed],
      top_k: brainConfig.cognee.topK,
      only_context: true,
      verbose: true,
    });
    if (!Array.isArray(response)) {
      throw new Error('Cognee returned an invalid search response.');
    }
    const hits: CogneeHit[] = [];
    for (const value of response) {
      const group = record(value);
      const datasetId = identifier(group.dataset_id);
      if (!allowed.has(datasetId) || !Array.isArray(group.objects_result)) {
        throw new Error('Cognee returned unscoped search results. Dataset isolation is required.');
      }
      for (const item of group.objects_result) {
        const object = record(item);
        const payload = record(object.payload);
        if (typeof payload.text !== 'string') {
          throw new Error('Cognee returned a chunk without its original text.');
        }
        hits.push({ datasetId, chunkId: identifier(object.id), text: payload.text });
      }
    }
    return hits;
  }

  async graph(datasetIds: string[]): Promise<CogneeGraph> {
    const graph: CogneeGraph = { nodes: [], edges: [], truncated: false };
    for (const datasetId of new Set(datasetIds.map(identifier))) {
      const data = record(await this.http.request(`/api/v1/datasets/${datasetId}/graph`));
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new Error('Cognee returned an invalid graph response.');
      }
      const included = new Set<string>();
      for (const value of data.nodes) {
        if (graph.nodes.length >= brainConfig.cognee.maxGraphNodes) {
          graph.truncated = true;
          break;
        }
        const node = record(value);
        const id = `${datasetId}:${identifier(node.id)}`;
        included.add(id);
        graph.nodes.push({
          id,
          datasetId,
          label: String(node.label),
          type: String(node.type),
          properties: record(node.properties),
        });
      }
      for (const value of data.edges) {
        if (graph.edges.length >= brainConfig.cognee.maxGraphEdges) {
          graph.truncated = true;
          break;
        }
        const edge = record(value);
        const source = `${datasetId}:${identifier(edge.source)}`;
        const target = `${datasetId}:${identifier(edge.target)}`;
        if (!included.has(source) || !included.has(target)) {
          continue;
        }
        const label = String(edge.label);
        const id = createHash('sha256').update(`${source}\n${target}\n${label}`).digest('hex');
        graph.edges.push({ id, datasetId, source, target, label });
      }
    }
    return graph;
  }

  private json(path: string, body: unknown) {
    return this.http.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async pipelineStatus(datasetId: string): Promise<string | undefined> {
    const result = record(
      await this.http.request(
        `/api/v1/datasets/status?dataset=${datasetId}&pipeline=cognify_pipeline`,
      ),
    );
    const status = result[datasetId];
    if (status === undefined || status === null) {
      return undefined;
    }
    if (typeof status !== 'string' || ![completed, failed, ...processing].includes(status)) {
      throw new Error('Cognee returned an unknown indexing state.');
    }
    return status;
  }

  private async waitForIndex(datasetId: string): Promise<void> {
    const started = Date.now();
    while (true) {
      const status = await this.pipelineStatus(datasetId);
      if (status === completed) {
        return;
      }
      if (status === failed) {
        throw new Error(
          'Cognee indexing failed. The source has not been made current. Check the private service logs.',
        );
      }
      if (
        brainConfig.cognee.indexTimeoutMs &&
        Date.now() - started >= brainConfig.cognee.indexTimeoutMs
      ) {
        throw new Error('Cognee indexing is still pending. The source has not been made current.');
      }
      await delay(brainConfig.cognee.pollIntervalMs, undefined, { signal: this.http.signal });
    }
  }
}
