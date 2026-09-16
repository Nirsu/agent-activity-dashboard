import { createHash } from 'node:crypto';
import { normalizeText, type Source } from '../sources.js';
import type { Citation, Rule, Finding, Outcome } from './types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function cite(source: Source, pattern: RegExp): Citation | undefined {
  const lines = source.content.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : { sourceId: source.id, line: index + 1, quote: lines[index] };
}

export function proposeRules(sources: Source[]): Rule[] {
  const source = sources.find(
    (source) =>
      source.kind === 'notion' &&
      source.status === 'published' &&
      normalizeText(source.title).includes('socle'),
  );
  if (!source) {
    return [];
  }
  const definitions = [
    {
      key: 'backend',
      title: 'Backend framework',
      topic: 'Backend',
      pattern: /\|\s*BFF\s*\|.*NestJS/,
      description: 'Compare NestJS with the framework declared in server/package.json.',
    },
    {
      key: 'storage',
      title: 'Storage technology',
      topic: 'Storage',
      pattern: /\|\s*Base de données\s*\|.*PostgreSQL/,
      description: 'Identify a SQLite dependency against the PostgreSQL decision.',
    },
    {
      key: 'web',
      title: 'Web interface foundations',
      topic: 'Web extranet',
      pattern: /\|\s*Extranet web\s*\|.*React.*Vite/,
      description: 'Check React and Vite dependencies in the ui/package.json manifest.',
    },
  ] as const;
  return definitions.flatMap(({ key, title, topic, pattern, description }) => {
    const citation = cite(source, pattern);
    if (!citation) {
      return [];
    }
    const version = hash(`demo-v1:${key}:${source.revision}`);
    return [
      {
        id: `${key}-${version.slice(0, 12)}`,
        title,
        topic,
        description,
        source: citation,
        sourceRevision: source.revision,
        version,
        active: false,
        scope:
          'Demonstration only · agent-activity-dashboard is not identified as the product BFF or extranet.',
      },
    ];
  });
}

export function evaluate(rule: Rule, sources: Source[], commit: string, runId: string): Finding {
  const path = rule.id.startsWith('web-') ? 'ui/package.json' : 'server/package.json';
  const source = sources.find((source) => source.kind === 'code' && source.path === path);
  let outcome: Outcome = 'insufficient';
  let explanation = 'The required manifest is missing or invalid.';
  const evidence: Citation[] = [];
  if (source) {
    try {
      const manifest = JSON.parse(source.content);
      const dependencies = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
      };
      const citeDependency = (name: string) => {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const citation = cite(source, new RegExp(`"${escapedName}"\\s*:`));
        if (citation) {
          evidence.push(citation);
        }
      };
      if (rule.id.startsWith('backend-')) {
        if (dependencies['@nestjs/core']) {
          outcome = 'aligned';
          explanation = 'NestJS is declared in the server manifest.';
          citeDependency('@nestjs/core');
        } else if (dependencies.fastify) {
          outcome = 'difference';
          explanation =
            'The architecture specifies a NestJS BFF. The dashboard server declares Fastify and does not declare @nestjs/core.';
          citeDependency('fastify');
        } else {
          explanation = 'Neither framework is declared in this manifest.';
        }
      } else if (rule.id.startsWith('storage-')) {
        if (dependencies['better-sqlite3'] || dependencies.sqlite3) {
          outcome = 'difference';
          explanation =
            'The architecture specifies PostgreSQL. The server declares a SQLite dependency. Both can coexist: the dependency alone does not describe the entire architecture.';
          citeDependency(dependencies['better-sqlite3'] ? 'better-sqlite3' : 'sqlite3');
        } else {
          explanation = 'The database actually used cannot be determined from this manifest alone.';
        }
      } else if (rule.id.startsWith('web-')) {
        if (dependencies.react && dependencies.vite) {
          outcome = 'aligned';
          explanation =
            'React and Vite are both declared, matching the architecture decision for the web extranet.';
          citeDependency('react');
          citeDependency('vite');
        } else {
          explanation =
            'React and Vite are not both declared. The build must be analyzed before drawing a conclusion.';
        }
      }
    } catch {
      /* invalid manifests are insufficient, never compliant */
    }
  }
  const questions: Record<Outcome, string> = {
    difference:
      'Should the new application architecture apply to this internal tool, or should a scope exception be documented?',
    aligned: 'The match is observed in the manifest. It does not validate application behavior.',
    insufficient: 'What evidence or scope details are needed to evaluate this rule?',
  };
  return {
    id: hash(`${rule.version}:${commit}:${source?.id ?? 'missing'}`),
    ruleId: rule.id,
    ruleVersion: rule.version,
    title: rule.title,
    outcome,
    explanation,
    decision: rule.source,
    evidence,
    commit,
    runId,
    createdAt: now(),
    question: questions[outcome],
    limitation:
      'Exact rule for declared dependencies only. Git commit snapshot excludes local changes and production state. Applicability to the dashboard is hypothetical for this demonstration.',
  };
}
