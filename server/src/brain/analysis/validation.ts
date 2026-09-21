import { brainConfig } from '../config.js';
import type { Source } from '../sources.js';
import type { SourceExcerpt } from '../memory/types.js';
import type { ArbitrationDossier, Citation, ComparisonCheck, Requirement } from './types.js';

export const reviewDecisions = [
  'confirmed',
  'documentation',
  'false_positive',
  'exception',
  'investigate',
];

export function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Invalid structured response.');
  }
  return value as Record<string, unknown>;
}

export function requireText(
  value: unknown,
  maxLength = brainConfig.analysis.maxTextCharacters,
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    fail('Response text is missing or too long.');
  }
  return value;
}

export function requireList(
  value: unknown,
  maxLength = brainConfig.analysis.maxRequirements,
): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail('List is missing or too long.');
  }
  return value;
}

function parseCitation(value: unknown, sources: Source[], excerpts?: SourceExcerpt[]): Citation {
  const citation = requireObject(value);
  const sourceId = requireText(citation.sourceId, brainConfig.memory.maxRecordIdCharacters);
  const quote = requireText(citation.quote, brainConfig.analysis.maxQuoteCharacters);
  const line = citation.line;
  // Older saved analyses and clients used single-line citations.
  const endLine = citation.endLine === undefined ? line : citation.endLine;
  const source = sources.find((source) => source.id === sourceId);
  const lines = source?.content.split('\n');

  if (
    !Number.isInteger(line) ||
    (line as number) < 1 ||
    !Number.isInteger(endLine) ||
    (endLine as number) < (line as number) ||
    !lines ||
    (endLine as number) > lines.length ||
    lines.slice((line as number) - 1, endLine as number).join('\n') !== quote
  ) {
    fail('Citation rejected: incorrect source, line number, or quote.');
  }
  if (
    excerpts &&
    !quote
      .split('\n')
      .every((_, index) =>
        excerpts.some(
          (excerpt) =>
            excerpt.sourceId === sourceId &&
            (line as number) + index >= excerpt.startLine &&
            (line as number) + index <= excerpt.endLine,
        ),
      )
  ) {
    fail('Citation rejected: the line was not included in the retrieved excerpts.');
  }

  return { sourceId, line: line as number, endLine: endLine as number, quote };
}

function requireExactRequirementIds(
  items: { requirementId: string }[],
  requirements: Requirement[],
) {
  const identifiers = new Set(items.map((item) => item.requirementId));
  const containsUnknownRequirement = items.some(
    (item) => !requirements.some((requirement) => requirement.id === item.requirementId),
  );

  if (
    items.length !== requirements.length ||
    identifiers.size !== items.length ||
    containsUnknownRequirement
  ) {
    fail('The model omitted or invented a requirement.');
  }
}

export function parseRequirements(
  value: unknown,
  specifications: Source[],
  excerpts?: SourceExcerpt[],
): Requirement[] {
  const requirements = requireList(value).map((value) => {
    const requirement = requireObject(value);
    return {
      id: requireText(requirement.id, brainConfig.analysis.maxRequirementIdCharacters),
      statement: requireText(requirement.statement),
      scope: requireText(requirement.scope),
      citation: parseCitation(requirement.citation, specifications, excerpts),
    };
  });

  if (new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length) {
    fail('Duplicate requirement IDs.');
  }
  return requirements;
}

export function parseComparisonChecks(
  value: unknown,
  code: Source[],
  requirements: Requirement[],
  excerpts?: SourceExcerpt[],
): ComparisonCheck[] {
  const checks = requireList(value).map<ComparisonCheck>((value) => {
    const check = requireObject(value);
    const outcome = requireText(check.outcome);
    if (outcome !== 'difference' && outcome !== 'aligned' && outcome !== 'insufficient') {
      fail('Invalid comparison result.');
    }

    const evidence = requireList(
      check.evidence,
      brainConfig.analysis.maxEvidencePerRequirement,
    ).map((value) => parseCitation(value, code, excerpts));
    if (outcome !== 'insufficient' && evidence.length === 0) {
      fail('Result has no code evidence.');
    }

    return {
      requirementId: requireText(
        check.requirementId,
        brainConfig.analysis.maxRequirementIdCharacters,
      ),
      outcome,
      explanation: requireText(check.explanation),
      evidence,
    };
  });

  requireExactRequirementIds(checks, requirements);
  return checks;
}

export function parseArbitrationDossiers(
  value: unknown,
  requirements: Requirement[],
): ArbitrationDossier[] {
  const dossiers = requireList(value).map((value) => {
    const dossier = requireObject(value);
    return {
      requirementId: requireText(
        dossier.requirementId,
        brainConfig.analysis.maxRequirementIdCharacters,
      ),
      title: requireText(dossier.title, brainConfig.analysis.maxTitleCharacters),
      question: dossier.question === '' ? '' : requireText(dossier.question),
      limitation: requireText(dossier.limitation),
    };
  });

  requireExactRequirementIds(dossiers, requirements);
  return dossiers;
}
