#!/usr/bin/env node
// POC paired time-log. Captures, per task: estimate WITHOUT AI vs actual WITH
// AI, plus friction. This paired estimate/actual is the only causal signal that
// AI moved delivery — and this POC week is the only time it can be captured.
//
//   node timelog.mjs add --task "Membership form validation" \
//        --est 180 --actual 95 --ticket ABC-412 --who dev1 \
//        --friction "hallucinated a deprecated API; 15min to catch"
//   node timelog.mjs summary
//
// Estimates/actuals are in MINUTES. Data lands in ./timelog.csv (git-ignored).
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(__dirname, 'timelog.csv');
const HEADER = 'timestamp,who,ticket,task,est_no_ai_min,actual_with_ai_min,ratio,friction';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function add() {
  const task = arg('--task');
  const est = Number(arg('--est'));
  const actual = Number(arg('--actual'));
  if (!task || !Number.isFinite(est) || !Number.isFinite(actual)) {
    console.error('add requires --task, --est <min>, --actual <min>. Optional: --ticket --who --friction');
    process.exit(1);
  }
  if (!existsSync(CSV)) writeFileSync(CSV, HEADER + '\n');
  const ratio = est > 0 ? +(actual / est).toFixed(3) : '';
  const row = [
    new Date().toISOString(),
    arg('--who', ''),
    arg('--ticket', ''),
    task,
    est,
    actual,
    ratio,
    arg('--friction', ''),
  ].map(esc).join(',');
  appendFileSync(CSV, row + '\n');
  const pct = est > 0 ? Math.round((1 - actual / est) * 100) : 0;
  console.log(`Logged: "${task}" — est ${est}m vs actual ${actual}m (${pct >= 0 ? pct + '% faster' : -pct + '% slower'} with AI)`);
}

function parseCsv(text) {
  // minimal CSV parse handling quoted fields
  const rows = [];
  const lines = text.split('\n').filter((l) => l.length);
  for (let i = 1; i < lines.length; i++) {
    const out = [];
    let cur = '', q = false;
    for (const ch of lines[i]) {
      if (q) {
        if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    rows.push(out);
  }
  return rows;
}

function median(a) {
  const s = a.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summary() {
  if (!existsSync(CSV)) return console.log('No entries yet. Add some with: node timelog.mjs add …');
  const rows = parseCsv(readFileSync(CSV, 'utf8'));
  const est = rows.map((r) => Number(r[4]));
  const act = rows.map((r) => Number(r[5]));
  const ratios = rows.map((r) => Number(r[6])).filter(Number.isFinite);
  const totalEst = est.reduce((a, b) => a + (b || 0), 0);
  const totalAct = act.reduce((a, b) => a + (b || 0), 0);
  const medRatio = median(ratios);
  console.log(`Entries: ${rows.length}`);
  console.log(`Total estimated (no AI): ${(totalEst / 60).toFixed(1)}h`);
  console.log(`Total actual (with AI):  ${(totalAct / 60).toFixed(1)}h`);
  console.log(`Aggregate speedup: ${totalEst ? Math.round((1 - totalAct / totalEst) * 100) : 0}% faster`);
  console.log(`Median per-task ratio (actual/est): ${medRatio ?? '—'} (${medRatio ? Math.round((1 - medRatio) * 100) + '% faster' : ''})`);
  const frictions = rows.map((r) => r[7]).filter((f) => f && f.trim());
  if (frictions.length) {
    console.log(`\nFriction points (${frictions.length}):`);
    for (const f of frictions) console.log('  - ' + f);
  }
}

const cmd = process.argv[2];
if (cmd === 'add') add();
else if (cmd === 'summary') summary();
else console.log('Usage: node timelog.mjs add --task … --est <min> --actual <min> [--ticket --who --friction]\n       node timelog.mjs summary');
