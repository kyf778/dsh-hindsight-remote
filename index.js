/**
 * Host half of the Hindsight remote bundle.
 *
 * The panel is Client-side. The Host half exists to run the routing proxy, because
 * the harness's memory `apiUrl` points at a fixed loopback port and something must
 * serve it.
 *
 * DESIGN NOTE -- why the proxy also starts from the module body:
 *   The proxy must not be a child process. A harness may manage its children with a
 *   Win32 Job Object (kill-on-close) and broadcast CTRL_C_EVENT to its console group
 *   on restart, so a child proxy dies with the harness and re-launching it from
 *   inside that job is unreliable. Hosting it on the harness's own event loop
 *   removes the problem.
 *
 *   The remaining question is *when* to start it. `apply()` is invoked by the plugin
 *   loader, and in at least one real profile it did not run -- a load-time probe
 *   fired on every restart while the proxy stayed down, because an invalid `Config`
 *   made activation fail silently. Module evaluation, by contrast, is demonstrably
 *   performed whenever the plugin is loaded at all. Starting the server from the
 *   module body therefore depends only on the step that is known to happen.
 *
 *   This is safe at module scope: startProxy() treats EADDRINUSE as "someone else is
 *   already serving", and every failure path is caught, so a problem here can never
 *   break harness startup.
 *
 * NO `Config` EXPORT, deliberately. A plugin may export one to declare settings the
 * harness renders and validates. Declaring one has two costs and no benefit here:
 * the settings it declares would duplicate config.json (one source of truth is
 * better), and an unusable `Config` makes activation fail *while the module still
 * loads* -- a silent failure mode this plugin has already been bitten by. Loaders
 * accept a plugin that exports only `apply`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startProxy, probeProxy, loadConfig, DEFAULT_PORT, HERE } from './proxy.mjs';

const HOST_LOG = path.join(HERE, 'host.out.log');

function hostLog(line) {
  const msg = `${new Date().toISOString()} [hindsight-remote] ${line}`;
  try { fs.appendFileSync(HOST_LOG, msg + '\n'); } catch { /* logging is best-effort */ }
}

// config.json is the single source of configuration (see config.example.json).
const CONFIG = loadConfig();
const PORT = CONFIG.port || DEFAULT_PORT;

let handle = null;
let starting = null;

/** Idempotent: starts the proxy once and reuses the same handle afterwards. */
export function ensureProxy(reason = 'call') {
  if (handle && handle.ok) return Promise.resolve(handle);
  if (starting) return starting;

  hostLog(`starting proxy (${reason})`);
  starting = startProxy({ port: PORT, log: hostLog, config: CONFIG })
    .then((r) => {
      starting = null;
      handle = r;
      if (r.ok) hostLog(`proxy listening on 127.0.0.1:${PORT}`);
      else if (r.error === 'EADDRINUSE') hostLog(`port ${PORT} already served by another instance`);
      else hostLog(`proxy failed to start: ${r.error}`);
      return r;
    })
    .catch((e) => {
      starting = null;
      const msg = String(e && e.message ? e.message : e);
      hostLog(`proxy start threw: ${msg}`);
      return { ok: false, error: msg, stop() {} };
    });
  return starting;
}

if (CONFIG.configError) hostLog(`config problem: ${CONFIG.configError}`);

// Start immediately at module evaluation -- see the DESIGN NOTE above.
ensureProxy('module-load');

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------
export function apply(ctx) {
  hostLog('apply() entered');

  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => {
        ensureProxy('effect');
        return () => {
          hostLog('disposer called');
          try { handle?.stop(); } catch { /* ignore */ }
          handle = null;
        };
      });
    } else {
      ensureProxy('apply-without-effect');
    }
  } catch (e) {
    hostLog(`effect registration failed: ${String(e && e.message ? e.message : e)}`);
  }

  // Optional service so other plugins can read the link state without loopback.
  try {
    if (typeof ctx?.set === 'function') {
      ctx.set('hindsightRemote', {
        probe: () => probeProxy(PORT),
        ensure: () => ensureProxy('service'),
        port: PORT,
      });
    }
  } catch { /* optional */ }
}
