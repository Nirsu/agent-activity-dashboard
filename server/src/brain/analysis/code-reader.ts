import { createHash } from 'node:crypto';
import { brainConfig } from '../config.js';
import { makeSource, minimizeSourceContent, type Source } from '../sources.js';
import { isAllowedCodePath, requireRepoPath, runGit } from './projects.js';
import type { AnalysisRun, Project, SubmittedFile } from './types.js';
import { fail, requireObject, requireText } from './validation.js';

type SearchMatch = { path: string; line: number; text: string };

/** Reads only the pinned Git tree and the submitted overlay; never the working directory. */
export class CodeReader {
  readonly files: string[];
  private readonly submitted: Map<string, SubmittedFile>;
  private readonly searches: { query: string; matches: SearchMatch[]; truncated: boolean }[] = [];

  constructor(
    private readonly run: AnalysisRun,
    private readonly project: Project,
    files: string[],
    submission: SubmittedFile[] = [],
  ) {
    this.submitted = new Map(
      submission
        .filter((file) => isAllowedCodePath(project, file.path))
        .map((file) => [file.path, file]),
    );
    this.files = [...new Set([...files, ...submission.map((file) => file.path)])]
      .filter((path) => {
        if (!isAllowedCodePath(project, path) || this.submitted.get(path)?.content === null) {
          return false;
        }
        try {
          requireRepoPath(path);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
    run.codeRetrieval = { strategy: 'on_demand', excerpts: [], searches: [] };
  }

  async prime() {
    const changed = this.run.baseCommit || this.run.submission;
    const candidates = changed
      ? this.files.filter((path) => this.run.changedFiles.includes(path))
      : this.files;
    for (const path of candidates.slice(0, brainConfig.codeRetrieval.initialFiles)) {
      await this.read(path, 1, brainConfig.codeRetrieval.maxLinesPerRead);
    }
  }

  get sources() {
    const captured = new Set(this.run.codeRetrieval!.excerpts.map((excerpt) => excerpt.sourceId));
    return this.run.sources.filter((source) => captured.has(source.id));
  }

  get context() {
    const changedPaths = new Set(this.run.changedFiles);
    const catalog = [
      ...this.files.filter((path) => changedPaths.has(path)),
      ...this.files.filter((path) => !changedPaths.has(path)),
    ];
    return {
      files: catalog.slice(0, brainConfig.codeRetrieval.maxCatalogFiles),
      totalFiles: this.files.length,
      catalogTruncated: this.files.length > brainConfig.codeRetrieval.maxCatalogFiles,
      maxLinesPerRead: brainConfig.codeRetrieval.maxLinesPerRead,
      maxRequestsPerRound: brainConfig.codeRetrieval.maxRequestsPerRound,
      searches: this.searches,
      filesRead: this.sources.map((source) => ({ path: source.path, totalLines: source.lines })),
    };
  }

  async requests(value: unknown) {
    if (!Array.isArray(value)) {
      fail('Code retrieval requests must be an array.');
    }
    if (value.length > brainConfig.codeRetrieval.maxRequestsPerRound) {
      fail(
        `Code retrieval requested ${value.length} operations; the configured limit is ${brainConfig.codeRetrieval.maxRequestsPerRound} operations per round (codeRetrieval.maxRequestsPerRound). No validated results.`,
      );
    }
    for (const raw of value) {
      const request = requireObject(raw);
      if (request.action === 'read') {
        await this.read(requireRepoPath(request.path), request.startLine, request.endLine);
      } else if (request.action === 'search') {
        await this.search(requireText(request.query, brainConfig.codeRetrieval.maxQueryCharacters));
      } else {
        fail('Unknown code retrieval action.');
      }
    }
  }

  private async capture(path: string): Promise<Source> {
    requireRepoPath(path);
    if (!this.files.includes(path)) {
      fail('Code read is outside the allowed snapshot or refers to a deleted file.');
    }
    const existing = this.run.sources.find(
      (source) => source.status === 'observed' && source.path === path,
    );
    if (existing) {
      return existing;
    }
    const content = await runGit(this.project, ['show', `${this.run.commit}:${path}`]);
    if (content.includes('\0')) {
      fail('Binary files cannot be used as code evidence.');
    }
    const source = makeSource('code', path, content, this.run.commit!);
    source.id = createHash('sha256').update(`${this.project.id}:code:${source.id}`).digest('hex');
    source.topic = this.project.name;
    this.run.sources.push(source);
    return source;
  }

  private async read(path: string, start: unknown, end: unknown) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      Number(start) < 1 ||
      Number(end) < Number(start) ||
      Number(end) - Number(start) + 1 > brainConfig.codeRetrieval.maxLinesPerRead
    ) {
      fail('Code reads require a valid bounded line range.');
    }
    const source = await this.capture(path);
    if (Number(start) > source.lines) {
      fail('Code read starts beyond the captured file.');
    }
    const excerpts = [
      ...this.run.codeRetrieval!.excerpts,
      {
        sourceId: source.id,
        startLine: Number(start),
        endLine: Math.min(Number(end), source.lines),
      },
    ];
    const evidenceIds = new Set([
      ...this.run.sources
        .filter((capture) => capture.status === 'published')
        .map((capture) => capture.id),
      ...excerpts.map((excerpt) => excerpt.sourceId),
    ]);
    if (evidenceIds.size > brainConfig.analysis.maxSources) {
      fail(
        `Code retrieval requires ${evidenceIds.size} evidence sources; the configured limit is ${brainConfig.analysis.maxSources} sources (analysis.maxSources). No validated results.`,
      );
    }
    // Merge repeated/overlapping reads so context and byte accounting remain bounded.
    const merged: typeof excerpts = [];
    for (const excerpt of excerpts.sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.startLine - b.startLine,
    )) {
      const previous = merged.at(-1);
      if (previous?.sourceId === excerpt.sourceId && excerpt.startLine <= previous.endLine + 1) {
        previous.endLine = Math.max(previous.endLine, excerpt.endLine);
      } else {
        merged.push({ ...excerpt });
      }
    }
    const bytes = merged.reduce((total, excerpt) => {
      const capture = this.run.sources.find((source) => source.id === excerpt.sourceId)!;
      return (
        total +
        Buffer.byteLength(
          capture.content
            .split('\n')
            .slice(excerpt.startLine - 1, excerpt.endLine)
            .join('\n'),
        )
      );
    }, 0);
    if (bytes > brainConfig.analysis.maxSourceBytes) {
      fail(
        `Code retrieval requires ${bytes} UTF-8 bytes of evidence; the configured limit is ${brainConfig.analysis.maxSourceBytes} bytes (analysis.maxSourceBytes). No validated results.`,
      );
    }
    this.run.codeRetrieval!.excerpts = merged;
  }

  private async search(query: string) {
    if (/[\r\n\0]/.test(query)) {
      fail('Code search requires one literal line of text.');
    }
    const matches: SearchMatch[] = [];
    const sanitizedFiles = new Map<string, string[]>();
    let cappedFile = false;
    const perFile = new Map<string, number>();
    const baselineFiles = this.files.filter((path) => !this.submitted.has(path));
    const batchSize = brainConfig.projects.maxCodePaths;
    // Resolve scopes (including **) to literal permitted files before searching. Never grep
    // excluded files, deleted paths or baseline versions replaced by a submitted overlay.
    for (let offset = 0; offset < baselineFiles.length; offset += batchSize) {
      const batch = baselineFiles.slice(offset, offset + batchSize);
      let output = '';
      try {
        output = await runGit(this.project, [
          '-c',
          'core.quotePath=false',
          'grep',
          '--no-color',
          '-n',
          '-z',
          '-I',
          '-F',
          '-m',
          String(brainConfig.codeRetrieval.maxSearchMatches),
          '-e',
          query,
          this.run.commit!,
          '--',
          ...batch.map((path) => `:(literal)${path}`),
        ]);
      } catch (error) {
        // Git uses exit 1 for no matches; transport/size errors must stop the analysis.
        if ((error as { code?: unknown }).code !== 1) {
          throw error;
        }
      }
      for (const line of output.split('\n')) {
        const match = /^[a-f0-9]+:(.*?)\0(\d+)\0(.*)$/.exec(line.replace(/\r$/, ''));
        if (!match || !batch.includes(match[1])) {
          continue;
        }
        const count = (perFile.get(match[1]) ?? 0) + 1;
        perFile.set(match[1], count);
        cappedFile ||= count >= brainConfig.codeRetrieval.maxSearchMatches;
        let lines = sanitizedFiles.get(match[1]);
        if (!lines) {
          // Multiline secrets must be removed before selecting a matching line.
          const content = await runGit(this.project, ['show', `${this.run.commit}:${match[1]}`]);
          lines = minimizeSourceContent(content).split('\n');
          sanitizedFiles.set(match[1], lines);
        }
        const text = lines[Number(match[2]) - 1];
        if (text === undefined || !text.includes(query)) {
          continue;
        }
        matches.push({ path: match[1], line: Number(match[2]), text });
        if (matches.length > brainConfig.codeRetrieval.maxSearchMatches) {
          break;
        }
      }
      if (matches.length > brainConfig.codeRetrieval.maxSearchMatches) {
        break;
      }
    }
    for (const file of this.submitted.values()) {
      if (matches.length > brainConfig.codeRetrieval.maxSearchMatches) {
        break;
      }
      if (file.content === null || !this.files.includes(file.path)) {
        continue;
      }
      const lines = minimizeSourceContent(file.content).split('\n');
      for (const [index, text] of lines.entries()) {
        if (text.includes(query)) {
          matches.push({ path: file.path, line: index + 1, text });
        }
        if (matches.length > brainConfig.codeRetrieval.maxSearchMatches) {
          break;
        }
      }
    }
    const truncated = cappedFile || matches.length > brainConfig.codeRetrieval.maxSearchMatches;
    const result = {
      query,
      matches: matches.slice(0, brainConfig.codeRetrieval.maxSearchMatches),
      truncated,
    };
    this.searches.push(result);
    this.run.codeRetrieval!.searches.push({
      query,
      paths: [...new Set(result.matches.map((match) => match.path))],
      truncated,
    });
  }
}
