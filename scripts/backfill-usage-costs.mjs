// Explicit local PostgreSQL maintenance. Build the server first. By default this
// prints a preview; --apply requires a new backup file and a stopped dashboard.
// The catalogue file is a snapshot of GET /api/brain/pricing, not a secret file.
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import '../server/dist/config.js';
import { estimateModelCost, usePricingCatalogue } from '../server/dist/model-cost.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    catalogue: { type: 'string' },
    backup: { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
if (!values.model || !values.catalogue || (values.apply && !values.backup)) {
  throw new Error('Provide --model and --catalogue; --apply also requires --backup.');
}
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) {
  throw new Error('This maintenance script only supports a local PostgreSQL database.');
}
const catalogue = JSON.parse(readFileSync(values.catalogue, 'utf8'));
const model = catalogue.models.find((entry) => entry.model === values.model);
const version = model?.versions.at(-1);
if (model?.ignored || !version?.rates) {
  throw new Error('The selected model must have configured rates and must not be ignored.');
}
const releaseCatalogue = usePricingCatalogue(() => version.rates);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(values.apply ? 'BEGIN' : 'BEGIN READ ONLY');
  const result = await client.query(
    `SELECT * FROM aad_history_usage
     WHERE source='codex_logs' AND data->>'model'=$1 AND d_usd IS NULL
       AND ts < $2
     ORDER BY ts, usage_id ${values.apply ? 'FOR UPDATE' : ''}`,
    [values.model, version.at],
  );
  const at = new Date().toISOString();
  const changes = [];
  for (const row of result.rows) {
    const amount = estimateModelCost({
      model: values.model,
      inputTokens: row.d_tokens_in === null ? undefined : Number(row.d_tokens_in),
      outputTokens: row.d_tokens_out === null ? undefined : Number(row.d_tokens_out),
      cachedInputTokens: row.data.cachedInputTokens,
    });
    if (amount === null) {
      continue;
    }
    changes.push({
      original: row,
      amount,
      estimate: {
        at,
        method: 'configured-rate-backfill',
        priceVersion: version,
        historicalRateVerified: false,
        missingCacheAssumedZero: row.data.cachedInputTokens === undefined,
      },
    });
  }
  if (values.apply && changes.length > 0) {
    // Exclusive creation prevents overwriting the original rollback evidence.
    // No database changes happen unless this backup is successfully written.
    await writeFile(values.backup, JSON.stringify({ model: values.model, at, changes }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    for (const change of changes) {
      const updated = await client.query(
        `UPDATE aad_history_usage SET d_usd=$1, cost_status='estimated', data=data || $2::jsonb
         WHERE source=$3 AND usage_id=$4 AND d_usd IS NULL`,
        [
          change.amount,
          JSON.stringify({
            dUsd: change.amount,
            costStatus: 'estimated',
            costOrigin: 'historical_estimate',
            costEstimate: change.estimate,
          }),
          change.original.source,
          change.original.usage_id,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error('An observation changed unexpectedly; rolling back the entire backfill.');
      }
    }
  }
  await client.query(values.apply ? 'COMMIT' : 'ROLLBACK');
  console.log(
    JSON.stringify(
      {
        applied: values.apply,
        model: values.model,
        observations: changes.length,
        skipped: result.rows.length - changes.length,
        estimatedCostUsd: Number(
          changes.reduce((sum, change) => sum + change.amount, 0).toFixed(9),
        ),
        missingCacheAssumedZero: changes.filter((change) => change.estimate.missingCacheAssumedZero)
          .length,
        backup: values.apply && changes.length > 0 ? values.backup : undefined,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  releaseCatalogue();
  await client.end();
}
