import type { ModelPrice } from '../../model-cost.js';
import type { PricingProvider } from './types.js';
import { fail } from '../analysis/validation.js';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const clean = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
const excluded =
  /\b(batch|priority|flex|fast|regional|residency|bedrock|vertex|cloud|third.party|fine.?tuning|audio|image)\b|long.context/i;
const million = /\bper\s+(?:one\s+million|million|1\s*m(?:illion)?)\s+tokens\b/i;

function identity(text: string, provider: PricingProvider) {
  const model = clean(text).toLowerCase();
  // Claude uses display names in its table, e.g. Claude Sonnet 4.6. Never strip dates/suffixes.
  return provider === 'anthropic' ? model.replace(/[ .]+/g, '-') : model;
}

function cells(line: string) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(clean);
}

function price(cell: string, units: string): number | undefined {
  const match = /^\$\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(MTok|1M\s+tokens))?$/i.exec(cell);
  if (!match || (!match[2] && !million.test(units))) {
    return;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

type Candidate = { rates: ModelPrice; evidence: string[] };

function tableRates(headers: string[], row: string[], units: string): ModelPrice | undefined {
  if (headers.length !== row.length || headers.some((header) => /^modality$/i.test(header))) {
    return;
  }
  const column = (pattern: RegExp) => {
    const matches = headers.flatMap((header, index) => (pattern.test(header) ? [index] : []));
    return matches.length === 1 ? matches[0] : -1;
  };
  const input = column(/^(?:short context |base )?input(?: tokens)?$/i);
  const output = column(/^(?:short context )?output(?: tokens)?$/i);
  const cached = column(/^(?:short context )?cached input$|^cache hits (?:and|&) refreshes$/i);
  if (input < 0 || output < 0) {
    return;
  }
  const inputPerMillionUsd = price(row[input], units);
  const outputPerMillionUsd = price(row[output], units);
  const cachedInputPerMillionUsd = cached < 0 ? undefined : price(row[cached], units);
  if (
    inputPerMillionUsd === undefined ||
    outputPerMillionUsd === undefined ||
    (cached >= 0 && cachedInputPerMillionUsd === undefined && !/^(?:-|—|N\/A)$/i.test(row[cached]))
  ) {
    return;
  }
  return {
    inputPerMillionUsd,
    outputPerMillionUsd,
    ...(cachedInputPerMillionUsd !== undefined ? { cachedInputPerMillionUsd } : {}),
  };
}

/** Independently bind model, tier, units and column values to the retrieved page. */
export function verifySourceRates(
  source: string,
  excerpts: string[],
  model: string,
  provider: PricingProvider,
  proposed: ModelPrice,
) {
  const candidates: Candidate[] = [];
  const headings: Array<{ level: number; text: string }> = [];
  let tier = '';
  let units = '';
  let currency = '';
  let table: { headers: string[]; line: string; standard: boolean } | undefined;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      while (headings.at(-1) && headings.at(-1)!.level >= heading[1].length) {
        headings.pop();
      }
      headings.push({ level: heading[1].length, text: heading[2] });
      tier = '';
    }
    if (!line.includes('|')) {
      if (line) {
        table = undefined;
      }
      if (
        /^(?:Standard|Batch|Priority|Flex|Fast)[.:]?$|^[a-z][a-z -]*\s(?:pricing|prices|mode)(?: data)?[.:]?$/i.test(
          line,
        )
      ) {
        tier = line;
      }
      if (/^(?:Standard|Batch|Priority|Flex|Fast)\s+(?:pricing|prices)\s*[·:—-]/i.test(line)) {
        tier = line;
      }
      // The closest stated unit/currency wins; a per-1K table must not inherit per-1M units.
      if (/\bper\s+.+?tokens\b/i.test(line)) {
        units = line;
      }
      if (/\b(?:USD|EUR|GBP|CAD|AUD)\b|[€£]/.test(line)) {
        currency = line;
      }
      // Accept a self-contained labelled text record as well as provider tables.
      const prose =
        /^([^:]+): input \$(\d+(?:\.\d+)?), output \$(\d+(?:\.\d+)?)(?:, cached input \$(\d+(?:\.\d+)?))? per (?:million|1M) tokens, USD standard\.$/i.exec(
          line,
        );
      if (
        prose &&
        identity(prose[1], provider) === identity(model, provider) &&
        !excluded.test(headings.map((entry) => entry.text).join(' ') + ' ' + tier)
      ) {
        candidates.push({
          rates: {
            inputPerMillionUsd: Number(prose[2]),
            outputPerMillionUsd: Number(prose[3]),
            ...(prose[4] ? { cachedInputPerMillionUsd: Number(prose[4]) } : {}),
          },
          evidence: [line],
        });
      }
      continue;
    }
    const row = cells(line);
    if (row.some((cell) => /^model$/i.test(cell))) {
      const scope = [...headings.map((entry) => entry.text), tier].join(' ');
      const section = tier || headings.at(-1)?.text || '';
      const standard =
        !excluded.test(scope) &&
        !/\b(?:EUR|GBP|CAD|AUD)\b|[€£]/.test(currency) &&
        (/^standard(?: (?:pricing|prices)(?: data)?)?(?:\s*[·:—-]\s*USD per 1M tokens)?\.?$/i.test(
          section,
        ) ||
          (provider === 'anthropic' &&
            /^model pricing$/i.test(section) &&
            row.some((cell) => /^base input tokens$/i.test(cell))));
      table = { headers: row, line, standard };
      continue;
    }
    if (!table?.standard) {
      continue;
    }
    const modelIndex = table.headers.findIndex((header) => /^model$/i.test(header));
    if (identity(row[modelIndex] ?? '', provider) !== identity(model, provider)) {
      continue;
    }
    const rates = tableRates(table.headers, row, units);
    if (rates) {
      candidates.push({ rates, evidence: [table.line, line] });
    }
  }
  const sameRates = (a: ModelPrice, b: ModelPrice) =>
    a.inputPerMillionUsd === b.inputPerMillionUsd &&
    a.outputPerMillionUsd === b.outputPerMillionUsd &&
    a.cachedInputPerMillionUsd === b.cachedInputPerMillionUsd;
  const quoted = excerpts.map(normalize);
  if (
    !candidates.length ||
    candidates.some((entry) => !sameRates(entry.rates, proposed)) ||
    !candidates.some((entry) =>
      entry.evidence.every((line) => quoted.some((quote) => quote.includes(normalize(line)))),
    )
  ) {
    fail(
      'The quoted source does not verify these standard USD prices for this exact model. Review the official page or enter prices manually; saved prices are unchanged.',
    );
  }
}
