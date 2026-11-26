#!/usr/bin/env node
/**
 * Antigravity Plugin Lifecycle Hook Entrypoint for agyFrok (Scheme B + C Auto-Relay).
 * Reads camelCase hook payload from stdin, evaluates context pressure (<10ms, 0 tokens),
 * and emits official Antigravity hook JSON on stdout. Never crashes or blocks on error.
 */
import { evaluateRelayHook } from '../lib/auto-relay.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const raw = await readStdin();
  if (!raw) {
    process.stdout.write('{}\n');
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const eventName = String(payload?.hookEventName || process.argv[2] || '').trim();
  const result = evaluateRelayHook(eventName, payload, {
    pluginDataDir: process.env.PLUGIN_DATA || process.env.AGY_FORK_EXPLORER_DATA_DIR || '',
    appDataDir: process.env.AGY_APP_DATA_DIR || process.env.ANTIGRAVITY_APP_DATA_DIR || '',
  });

  process.stdout.write(`${JSON.stringify(result && typeof result === 'object' ? result : {})}\n`);
}

main().catch(() => {
  process.stdout.write('{}\n');
});
