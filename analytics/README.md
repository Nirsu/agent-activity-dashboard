# Analytics — baseline, DORA/cost metrics, time log

Three measurement pieces around the dashboard. The dashboard shows *what agents do
now*; these answer *did it change delivery, and at what cost*.

| Piece | What | When |
|---|---|---|
| [`baseline/`](./baseline) | 24-month frozen GitHub+Jira snapshot (the "before") | **run once, this week, before AI changes anything** |
| [`metrics-spec.md`](./metrics-spec.md) | the 5 metrics to track continuously (4 DORA + €/PR) | reference |
| [`timelog/`](./timelog) | paired estimate-without-AI vs actual-with-AI per task | **capture during the POC — only chance** |

## 1. Baseline extractor

Read-only. Needs a GitHub PAT (repo read) and a Jira API token. **No writes to
GitHub/Jira**, and identities are anonymized by default.

```bash
cd analytics/baseline
cp config.example.json config.json     # fill in org, Jira URL, project keys, statuses
export GITHUB_TOKEN=ghp_xxx
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=xxxx
node extract.mjs --config config.json   # Node ≥20, no build step
```

Outputs a **frozen, timestamped** dataset in `baseline/out/`:
- `baseline-dora-<ts>.json` — the computed DORA + cost metrics
- `baseline-raw-<ts>.json` — raw PRs + tickets (anonymized) for re-analysis
- `baseline-prs-<ts>.csv`, `baseline-tickets-<ts>.csv` — flat, for a spreadsheet
- `latest-dora.json` — pointer the dashboard serves at `GET /api/dora`
- a `manifest` (window, repos, config hash) so the snapshot is reproducible

Commit `baseline-dora-<ts>.json` (or archive it) — it is the immutable "before".

**Prod = merge to default branch.** **Failures = reverts + hotfix branches/labels +
Jira reopens.** MTTR uses incidents when configured, else revert/hotfix timing. Tune
status→phase mapping in `config.json` to your board's exact names.

## 2. Continuous metrics

Same tool, incremental: `node extract.mjs --config config.json --since 2026-07-20`.
Run it nightly; it refreshes `out/latest-dora.json`. **€ per PR** is joined from the
dashboard's cost ledger (`server/data/cost-ledger.jsonl`) by ticket key. Full
definitions and the code-volume caveat: [`metrics-spec.md`](./metrics-spec.md).

The current server defaults to **60 days** of normalized history (`RETENTION_DAYS`
in `server/src/config.ts`). The original measurement contract still mentions 30
days; that discrepancy needs a source-owner decision before deployment. This
operating guide does not amend the measurement contract or the frozen baseline.

The live board keeps metric labels visible, with tooltips for detail, so their
meaning remains accessible on touch devices. Code volume remains context only.

## 3. Time log

```bash
cd analytics/timelog
node timelog.mjs add --task "Membership form validation" --est 180 --actual 95 \
     --ticket ABC-412 --who dev1 --friction "hallucinated a deprecated API; 15m to catch"
node timelog.mjs summary
```

`--est` / `--actual` in minutes: estimate **without** AI vs actual **with** AI. Data
in `timelog.csv` (git-ignored). These pairs compare estimates with observed time;
they do not establish that AI caused a difference. Keep friction notes to explain
rework, interruptions and uncertainty in the original estimate.
