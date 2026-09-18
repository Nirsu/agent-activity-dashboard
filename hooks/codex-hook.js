#!/usr/bin/env node
// Portable provider selection: no shell-specific environment assignment.
process.env.AAD_PROVIDER = 'codex';
await import('./hook.js');
