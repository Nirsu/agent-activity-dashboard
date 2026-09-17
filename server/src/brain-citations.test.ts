import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSource } from './brain/sources.js';
import { parseComparisonChecks, parseRequirements } from './brain/analysis/validation.js';

const source = makeSource(
  'notion',
  'spec.md',
  '# Rules\nSend summaries only;\nnever send raw arguments.\n',
);
const citation = {
  sourceId: source.id,
  line: 2,
  endLine: 3,
  quote: 'Send summaries only;\nnever send raw arguments.',
};
const requirement = {
  id: 'R1',
  statement: 'Do not send raw arguments.',
  scope: 'Activity payload',
  citation,
};

test('citations preserve complete passages and reject altered or invalid ranges', () => {
  const [parsed] = parseRequirements([requirement], [source]);
  assert.deepEqual(parsed.citation, citation);
  const { endLine, ...legacy } = citation;
  assert.equal(
    parseRequirements(
      [{ ...requirement, citation: { ...legacy, quote: 'Send summaries only;' } }],
      [source],
    )[0].citation.endLine,
    2,
  );
  for (const override of [
    { endLine: 1 },
    { endLine: 100 },
    { endLine: 2.5 },
    { endLine: null },
    { line: 0 },
    { quote: 'Send summaries only; never send raw arguments.' },
    { quote: 'Send summaries only;\n  never send raw arguments.' },
  ]) {
    assert.throws(
      () =>
        parseRequirements([{ ...requirement, citation: { ...citation, ...override } }], [source]),
      /Citation rejected/,
    );
  }
});

test('a citation cannot bridge a gap in retrieved evidence', () => {
  assert.throws(
    () =>
      parseRequirements(
        [requirement],
        [source],
        [
          { sourceId: source.id, startLine: 1, endLine: 2 },
          { sourceId: source.id, startLine: 4, endLine: 4 },
        ],
      ),
    /not included in the retrieved excerpts/,
  );
  assert.equal(
    parseRequirements(
      [requirement],
      [source],
      [
        { sourceId: source.id, startLine: 2, endLine: 2 },
        { sourceId: source.id, startLine: 3, endLine: 3 },
      ],
    ).length,
    1,
  );
});

test('comparison evidence preserves the whole data flow and rejects omitted lines', () => {
  const code = makeSource(
    'code',
    'hook.js',
    'const payload = {\n  tool: summary(input.tool),\n};\nsend(payload);',
  );
  const check = {
    requirementId: 'R1',
    outcome: 'aligned',
    explanation: 'The summarized value is the value sent.',
    evidence: [{ sourceId: code.id, line: 1, endLine: 4, quote: code.content }],
  };
  assert.deepEqual(
    parseComparisonChecks([check], [code], [requirement])[0].evidence,
    check.evidence,
  );
  assert.throws(
    () =>
      parseComparisonChecks(
        [
          {
            ...check,
            evidence: [{ ...check.evidence[0], quote: 'const payload = {\n};\nsend(payload);' }],
          },
        ],
        [code],
        [requirement],
      ),
    /Citation rejected/,
  );
});
