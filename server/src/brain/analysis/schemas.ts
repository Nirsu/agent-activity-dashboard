function recordSchema(properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function arraySchema(items: unknown) {
  return { type: 'array', items };
}

const stringSchema = { type: 'string' };

const citationSchema = recordSchema({
  sourceId: stringSchema,
  line: { type: 'integer' },
  quote: stringSchema,
});

export const readingSchema = recordSchema({
  summary: stringSchema,
  requirements: arraySchema(
    recordSchema({
      id: stringSchema,
      statement: stringSchema,
      scope: stringSchema,
      citation: citationSchema,
    }),
  ),
});

export const comparisonSchema = recordSchema({
  checks: arraySchema(
    recordSchema({
      requirementId: stringSchema,
      outcome: {
        type: 'string',
        enum: ['difference', 'aligned', 'insufficient'],
      },
      explanation: stringSchema,
      evidence: arraySchema(citationSchema),
    }),
  ),
});

export const arbitrationSchema = recordSchema({
  dossiers: arraySchema(
    recordSchema({
      requirementId: stringSchema,
      title: stringSchema,
      question: stringSchema,
      limitation: stringSchema,
    }),
  ),
});
