// Start the routing proxy as an INDEPENDENT process, outside the harness.
//
// This is the fallback path, for use before the harness is running (e.g. from a
// Startup folder). While the harness runs, the plugin hosts the proxy on its own
// event loop instead -- see index.js for why that is the reliable mode.
//
// Safe to run repeatedly: exits early when the port already answers.
//
// Run: node ensure-proxy.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { probeProxy, loadConfig, DEFAULT_PORT, HERE } from './proxy.mjs';

const PROXY_SCRIPT = path.join(HERE, 'proxy.mjs');

/** Node executables to try, most explicit first. */
function nodeCandidates() {
  const out = [process.execPath];
  if (process.platform === 'win32') {
    out.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  } else {
    out.push('/usr/bin/node', '/usr/local/bin/node');
  }
  return out;
}

function pickNode() {
  for (const p of nodeCandidates()) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * @returns {'already-running'|'started'|'launch-failed'|'no-node'|'no-script'}
 */
export async function ensureStandaloneProxy(port = (loadConfig().port || DEFAULT_PORT)) {
  if (await probeProxy(port)) return 'already-running';
  const node = pickNode();
  if (!node) return 'no-node';
  if (!fs.existsSync(PROXY_SCRIPT)) return 'no-script';

  try {
    const child = spawn(node, [PROXY_SCRIPT], {
      cwd: HERE,
      detached: true,
      windowsHide: process.platform === 'win32',
      stdio: 'ignore',   // proxy.mjs writes its own log file
    });
    child.unref();
  } catch {
    return 'launch-failed';
  }

  // Wait using probeProxy's DEFAULT timeout, never a shorter one: the status handler
  // probes upstreams before replying, so a client timeout near that budget races the
  // handler and reports a healthy proxy as failed.
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await probeProxy(port)) return 'started';
  }
  return 'launch-failed';
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch { return false; }
})();

if (invokedDirectly) {
  ensureStandaloneProxy()
    .then((r) => {
      console.log(r);
      process.exit(r === 'already-running' || r === 'started' ? 0 : 1);
    })
    .catch((e) => {
      console.log(`error: ${String(e && e.message ? e.message : e)}`);
      process.exit(1);
    });
}
