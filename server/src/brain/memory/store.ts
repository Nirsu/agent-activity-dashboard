import type { Source } from '../sources.js';
import { BrainStorage } from '../persistence.js';
import type { SourceRegistration, SyncJob } from './types.js';

export class MemoryStore {
  private readonly storage: BrainStorage;
  private events = Promise.resolve();

  constructor(readonly path: string) {
    this.storage = new BrainStorage(
      path,
      [
        'brain_memory_sources',
        'brain_memory_captures',
        'brain_memory_jobs',
        'brain_webhook_events',
        'brain_memory_datasets',
      ],
      2,
    );
  }

  async init() {
    await this.storage.init();
    for (const job of this.jobs()) {
      if (job.status === 'running') {
        await this.saveJob({
          ...job,
          status: 'queued',
          error: 'Resuming synchronization after restart.',
        });
      }
    }
  }

  sources() {
    return this.storage
      .entries<SourceRegistration>('brain_memory_sources')
      .map((entry) => entry.data);
  }
  jobs() {
    return this.storage.entries<SyncJob>('brain_memory_jobs').map((entry) => entry.data);
  }
  source(id: string) {
    return this.storage.get<SourceRegistration>('brain_memory_sources', id);
  }
  capture(id: string): Source | undefined {
    return (
      this.storage.get<Source>('brain_memory_captures', id) ??
      this.storage.legacyCapture<Source>(id)
    );
  }
  saveSource(source: SourceRegistration) {
    return this.storage.put('brain_memory_sources', source.id, source);
  }
  saveCapture(source: Source) {
    return this.storage.put('brain_memory_captures', source.id, source, true);
  }
  dataset(id: string) {
    return this.storage.get<{ datasetId: string }>('brain_memory_datasets', id)?.datasetId;
  }
  saveDataset(id: string, datasetId: string) {
    return this.storage.put('brain_memory_datasets', id, { id, datasetId });
  }
  saveJob(job: SyncJob) {
    return this.storage.put('brain_memory_jobs', job.id, job);
  }

  afterCommit(callback: () => void) {
    this.storage.afterCommit(callback);
  }
  transaction<T>(work: () => T | Promise<T>) {
    return this.storage.transaction(work);
  }

  recordEvent(id: string, enqueue: () => void | Promise<void>) {
    const operation = this.events.then(() =>
      this.storage.transaction(async () => {
        if (this.storage.get('brain_webhook_events', id)) {
          return false;
        }
        await enqueue();
        await this.storage.put(
          'brain_webhook_events',
          id,
          { id, receivedAt: new Date().toISOString() },
          true,
        );
        return true;
      }),
    );
    this.events = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  async close() {
    await this.events;
    await this.storage.close();
  }
}
