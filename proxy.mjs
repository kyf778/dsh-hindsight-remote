/**
 * Routing proxy for a Hindsight memory server.
 *
 * Listens on a loopback port and forwards to whichever configured upstream is
 * reachable, so the harness's `apiUrl` can stay a single fixed value while the
 * machine moves between networks (e.g. a home LAN and a VPN mesh).
 *
 * Two upstreams are probed IN PARALLEL and the fastest reachable one wins, with an
 * optional preferred one winning ties. Probing in parallel rather than in order
 * matters: when a network interface goes down, an OS may keep a stale address for a
 * while, and a sequential connect to it can hang for tens of seconds.
 *
 * Runnable two ways:
 *   - in-process, started by the plugin's apply() -> lifetime == harness lifetime
 *   - standalone (`node proxy.mjs`) -> for use before the harness is up
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 18888;

/** Tie-break window: a preferred upstream within this many ms of the fastest wins. */
const PREFER_MARGIN_MS = 25;
const PROBE_TIMEOUT_MS = 1500;
const PROBE_TTL_MS = 45_000;
const FAIL_TTL_MS = 10_000;
const STATUS_CACHE_MS = 5_000;

// ---------------------------------------------------------------------------
// Configuration
//
// Upstream addresses are deployment-specific, so none are hardcoded here. They come
// from config.json beside this file (see config.example.json); when it is absent the
// proxy has nothing to route to and reports that clearly instead of guessing.
// ---------------------------------------------------------------------------

export const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CONFIG_FILE = path.join(HERE, 'config.json');

/** Alternate config path, for running a second instance or an isolated test. */
export function configPath() {
  const override = process.env.HINDSIGHT_REMOTE_CONFIG;
  return override ? path.resolve(override) : CONFIG_FILE;
}

const DEFAULT_CONFIG = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  /** Optional Tailscale executable, used by the "start VPN" endpoint. */
  tailscaleExe: null,
  upstreams: [],
};

/** Read config.json; never throws, and reports why when it cannot be used. */
export function loadConfig(file = configPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...DEFAULT_CONFIG, configError: `${path.basename(file)} not found` };
  }
  try {
    const parsed = JSON.parse(raw);
    const upstreams = Array.isArray(parsed.upstreams)
      ? parsed.upstreams
          .filter((u) => u && typeof u.host === 'string' && u.host)
          .map((u, i) => ({
            name: typeof u.name === 'string' && u.name ? u.name : `upstream${i + 1}`,
            host: u.host,
            port: Number(u.port) || 8888,
            priority: Number.isFinite(Number(u.priority)) ? Number(u.priority) : i,
          }))
          .sort((a, b) => a.priority - b.priority)
      : [];
    return {
      host: typeof parsed.host === 'string' && parsed.host ? parsed.host : DEFAULT_HOST,
      port: Number(parsed.port) || DEFAULT_PORT,
      tailscaleExe: typeof parsed.tailscaleExe === 'string' ? parsed.tailscaleExe : null,
      upstreams,
      configError: upstreams.length ? null : 'config.json lists no usable upstreams',
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG, configError: `config.json is not valid JSON: ${e.message}` };
  }
}

/** Non-internal IPv4 addresses of this machine. */
export function localAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * Browser origins allowed to read the status endpoint.
 *
 * A harness desktop shell may serve its UI from a custom scheme rather than http
 * (`dsh-app://` for DeepSeek Harness), and a custom-scheme origin is rejected by an
 * http(s)-only pattern -- the browser then blocks the response and the panel shows
 * "Failed to fetch" while the proxy is perfectly healthy. So custom schemes are
 * allowed, alongside this machine's own http(s) addresses.
 *
 * Deliberately not "*": any page open in the user's browser could otherwise read
 * the link status, or trigger VPN startup, through localhost.
 */
function originAllowed(origin) {
  if (typeof origin !== 'string' || !origin) return false;

  // This machine's own addresses over http(s). Checked FIRST, because http/https are
  // themselves valid custom-scheme syntax -- a permissive custom-scheme test written
  // first would accept every http origin, including a public attacker's.
  if (/^https?:\/\/[^/?#]*$/i.test(origin)) {
    return /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(?::\d+)?$/i.test(origin);
  }

  // A harness desktop shell may serve its UI from a custom scheme (`dsh-app://` for
  // DeepSeek Harness). Such an origin is rejected by an http(s)-only pattern, and the
  // browser then blocks the response -- the panel shows "Failed to fetch" while the
  // proxy is perfectly healthy. Accept those schemes, but never http/https (handled
  // above) and never `file`/`null`, which any local page could claim.
  const m = /^([a-z][a-z0-9+.-]*):\/\/([A-Za-z0-9._-]+)$/i.exec(origin);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  return scheme !== 'http' && scheme !== 'https' && scheme !== 'file';
}

function probe(host, port, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const t0 = Date.now();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0 });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

function run(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ code, stdout: out, stderr: err }); } };
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch { finish(-1); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(-2); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? 0); });
  });
}

async function serviceRunning(name) {
  const r = await run('sc.exe', ['query', name], 8_000);
  return /RUNNING/i.test(r.stdout || '');
}

/**
 * Poll until tailscaled answers the LocalAPI, so the caller does not race a
 * daemon that is still starting up. A reply carrying BackendState proves the
 * daemon is reachable; anything else (connection refused, timeout) does not.
 */
async function waitForDaemon(exe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await run(exe, ['status', '--json'], 8_000);
    if (r.code === 0 && /"BackendState"/.test(r.stdout || '')) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** BackendState of the running daemon, or null when it cannot be read. */
async function backendState(exe) {
  const r = await run(exe, ['status', '--json'], 10_000);
  const m = /"BackendState"\s*:\s*"([^"]*)"/.exec(r.stdout || '');
  return m ? m[1] : null;
}

/**
 * Unattended-mode (ForceDaemon) setting: true, false, or null when unknown.
 *
 * `tailscale debug prefs` OMITS the ForceDaemon field entirely when the setting
 * is off, so a missing field on a successful read means false -- not "unknown".
 * Treating the omission as unknown is what previously made this check silently
 * skip itself.
 */
async function unattendedEnabled(exe) {
  const r = await run(exe, ['debug', 'prefs'], 10_000);
  if (r.code !== 0 || !/"ControlURL"/.test(r.stdout || '')) return null;
  const m = /"ForceDaemon"\s*:\s*(true|false)/.exec(r.stdout || '');
  return m ? m[1] === 'true' : false;
}

/**
 * Start the proxy on this event loop.
 *
 * Resolves to `{ ok:false, error:'EADDRINUSE', ... }` when the port is already
 * served, which is a fine outcome rather than a failure.
 */
export function startProxy(opts = {}) {
  const cfg = opts.config || loadConfig();
  const host = opts.host || cfg.host;
  const port = opts.port || cfg.port;
  const upstreams = opts.upstreams || cfg.upstreams;
  const tailscaleExe = opts.tailscaleExe ?? cfg.tailscaleExe;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  // Reported in /__status so a caller can tell whether the process serving this port
  // is the harness itself (killing it kills the harness) or a standalone instance.
  const mode = opts.mode === 'standalone' ? 'standalone' : 'in-process';

  let active = null;
  let activeAt = 0;
  let statusCache = null;
  let statusCacheAt = 0;
  let statusInflight = null;
  let tsCache = null;
  let tsCacheAt = 0;
  let tsInflight = null;

  async function pickUpstream(force = false) {
    if (!upstreams.length) return null;
    const now = Date.now();
    const ttl = active ? PROBE_TTL_MS : FAIL_TTL_MS;
    if (!force && active && now - activeAt < ttl) return active;

    const results = await Promise.all(
      upstreams.map(async (up) => ({ up, ...(await probe(up.host, up.port)) })),
    );
    const alive = results.filter((r) => r.ok);
    let chosen;
    if (alive.length) {
      alive.sort((a, b) => a.ms - b.ms);
      const fastest = alive[0];
      const preferred = alive.find(
        (r) => r.up.priority < fastest.up.priority && r.ms <= fastest.ms + PREFER_MARGIN_MS,
      );
      chosen = preferred || fastest;
    } else {
      chosen = { up: upstreams[0] };
    }
    if (!active || active.name !== chosen.up.name) {
      const detail = alive.map((r) => `${r.up.name}=${r.ms}ms`).join(' ') || 'none alive';
      log(`upstream -> ${chosen.up.name} (${detail})`);
    }
    active = chosen.up;
    activeAt = Date.now();
    return active;
  }

  function statusProbes() {
    if (!upstreams.length) return Promise.resolve([]);
    const now = Date.now();
    if (statusCache && now - statusCacheAt < STATUS_CACHE_MS) return Promise.resolve(statusCache);
    if (statusInflight) return statusInflight;
    statusInflight = Promise.all(
      upstreams.map(async (up) => ({ up, ...(await probe(up.host, up.port)) })),
    ).then((probes) => {
      statusCache = probes;
      statusCacheAt = Date.now();
      statusInflight = null;
      return probes;
    }).catch(() => {
      statusInflight = null;
      return upstreams.map((up) => ({ up, ok: false, ms: 0 }));
    });
    return statusInflight;
  }

  function cachedVpnRunning() {
    const name = tailscaleExe ? 'Tailscale' : null;
    if (!name) return Promise.resolve(null);
    const now = Date.now();
    if (tsCache !== null && now - tsCacheAt < STATUS_CACHE_MS) return Promise.resolve(tsCache);
    if (tsInflight) return tsInflight;
    tsInflight = serviceRunning(name).then((v) => {
      tsCache = v;
      tsCacheAt = Date.now();
      tsInflight = null;
      return v;
    }).catch(() => { tsInflight = null; return false; });
    return tsInflight;
  }

  function statusBody(probes, vpnRunning) {
    return {
      proxy: {
        host,
        port,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        // 'in-process' means this port is served BY the harness process: restart the
        // harness to restart the proxy. Do not kill the port owner to "restart the
        // proxy" -- that terminates the harness. See README.
        mode,
      },
      active: active ? { name: active.name, host: active.host, port: active.port } : null,
      upstreams: probes.map((p) => ({
        name: p.up.name,
        host: p.up.host,
        port: p.up.port,
        reachable: p.ok,
        latencyMs: p.ok ? p.ms : null,
      })),
      vpn: tailscaleExe
        ? { kind: 'tailscale', exe: tailscaleExe, serviceRunning: vpnRunning }
        : null,
      localAddrs: localAddrs(),
      configError: cfg.configError || null,
      at: new Date().toISOString(),
    };
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (originAllowed(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
    }

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/__status' || req.url === '/__status/') {
      const probes = await statusProbes();
      const vpnRunning = await cachedVpnRunning();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(statusBody(probes, vpnRunning)));
      return;
    }

    if (req.url === '/__vpn/up') {
      const remote = req.socket.remoteAddress || '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' ||
                      remote.startsWith('127.') || remote.startsWith('::ffff:127.');
      if (!isLocal) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'loopback only' }));
        return;
      }
      if (!tailscaleExe) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, detail: 'no vpn configured' }));
        return;
      }
      const before = await serviceRunning('Tailscale');
      if (!before) {
        await run('sc.exe', ['start', 'Tailscale'], 20_000);
      }
      // Wait for the daemon to answer LocalAPI. Without this, the bare "up"
      // below can run against a daemon that is still starting and silently do
      // nothing (it reports success while BackendState stays NoState).
      const daemonUp = await waitForDaemon(tailscaleExe, 30_000);

      // Windows tailscaled stays in NoState without a GUI user session, and
      // "tailscale up" then exits 0 while nothing connects. Unattended mode
      // (ForceDaemon) is what lets it run headless, so the endpoint is only
      // usable at all on a machine with no GUI session if it ensures the
      // setting. `set` -- unlike `up` -- changes only what is named, so this
      // cannot revert any of the user's other preferences; it is idempotent.
      const unattendedBefore = await unattendedEnabled(tailscaleExe);
      let unattendedSet = false;
      if (daemonUp && unattendedBefore === false) {
        const setRes = await run(tailscaleExe, ['set', '--unattended'], 20_000);
        unattendedSet = setRes.code === 0;
      }

      // Use the BARE "tailscale up" -- not a single flag.
      // "tailscale up" only takes its no-op "just bring the network up" path when
      // the flag set is completely empty. Passing ANY flag -- including prefless
      // ones like --timeout -- defeats that path and re-enables the
      // "must mention every non-default setting" check, which then fails with
      // "changing settings via 'tailscale up' requires mentioning all
      // non-default flags" on any machine with a non-default preference (e.g. a
      // custom --hostname). Preferences are the user's own; this endpoint only
      // brings the network up, so it must not restate or reset them.
      // run()'s own timeout bounds this call.
      const up = await run(tailscaleExe, ['up'], 45_000);
      const state = await backendState(tailscaleExe);
      const ok = up.code === 0 && state === 'Running';
      activeAt = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok,
        serviceWasRunning: before,
        daemonReady: daemonUp,
        unattendedBefore,
        unattendedSet,
        backendState: state,
        code: up.code,
        // Report the real outcome rather than trusting the exit code: without
        // unattended mode "up" can exit 0 while the backend never leaves
        // NoState, because tailscaled then waits for a GUI user session.
        detail: ok ? undefined
          : !daemonUp ? 'tailscaled did not become reachable'
          : state !== 'Running'
            ? `tailscaled did not reach Running (BackendState=${state ?? 'unknown'}). If this machine has no Tailscale GUI session, enable unattended mode once: tailscale set --unattended`
            : undefined,
        stdout: (up.stdout || '').slice(0, 3000),
        stderr: (up.stderr || '').slice(0, 3000),
      }));
      return;
    }

    const up = await pickUpstream();
    if (!up) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: cfg.configError || 'no upstream configured' }));
      return;
    }

    const forward = (target) =>
      new Promise((resolve) => {
        const headers = { ...req.headers, host: `${target.host}:${target.port}` };
        delete headers['proxy-connection'];
        delete headers['connection'];
        const preq = http.request(
          { host: target.host, port: target.port, method: req.method, path: req.url, headers },
          (pres) => {
            res.writeHead(pres.statusCode, pres.headers);
            pres.pipe(res);
            resolve(true);
          },
        );
        // 上游是 Hindsight：LLM 提取/整理/反思可能长时间静默（compose 里
        // HINDSIGHT_API_LLM_TIMEOUT=600）。原来的 30s 空闲超时会误杀这类慢
        // 请求，并把代理误判成 "lan failed" 切到不通的备线。这里对齐到 600s。
        preq.setTimeout(600_000, () => preq.destroy(new Error('upstream timeout')));
        preq.on('error', () => resolve(false));
        req.pipe(preq);
      });

    if (await forward(up)) return;

    log(`${up.name} failed; re-routing`);
    const alt = await pickUpstream(true);
    if (!alt || alt.name === up.name) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: `upstream ${up.name} unreachable` }));
      return;
    }
    if (!(await forward(alt)) && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'all upstreams unreachable' }));
    }
  });

  return new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') {
        log(`port ${port} already served; leaving it alone`);
        resolve({ ok: false, error: 'EADDRINUSE', status: () => null, stop: () => {} });
        return;
      }
      log(`listen failed: ${err && err.message}`);
      resolve({ ok: false, error: String((err && err.code) || err), status: () => null, stop: () => {} });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      log(`listening on http://${host}:${port} (pid ${process.pid})`);
      if (cfg.configError) log(`config problem: ${cfg.configError}`);
      log(`upstreams: ${upstreams.map((u) => `${u.name}=${u.host}:${u.port}`).join(', ') || '(none)'}`);
      log(`local IPv4: ${localAddrs().join(', ') || '(none)'}`);
      pickUpstream(true).then((u) => log(`initial upstream: ${u ? u.name : '(none)'}`));
      resolve({
        ok: true,
        port,
        config: cfg,
        status: () => ({ active, upstreams, localAddrs: localAddrs() }),
        stop: () => { try { server.close(); } catch {} },
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * True when something already answers on the proxy port.
 *
 * The timeout must exceed the server's own upstream-probe budget, because the
 * status handler probes before replying: a client timeout at or below that value
 * races the handler and reports a healthy proxy as down.
 */
export function probeProxy(port = DEFAULT_PORT, timeoutMs = PROBE_TIMEOUT_MS + 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.get(`http://127.0.0.1:${port}/__status`, { timeout: timeoutMs }, (res) => {
        res.resume();
        done(res.statusCode === 200);
      });
    } catch { done(false); return; }
    req.on('timeout', () => { try { req.destroy(); } catch {} done(false); });
    req.on('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Standalone mode: `node proxy.mjs`
//
// Deliberately no top-level await: this module is imported by index.js, and a module
// containing top-level await becomes async for every importer, which makes the
// harness's plugin activation depend on how its loader handles that. A floating
// promise keeps the import synchronous, and the server keeps the process alive.
// ---------------------------------------------------------------------------
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch { return false; }
})();

if (invokedDirectly) {
  const LOG_FILE = path.join(HERE, 'proxy.out.log');
  const PID_FILE = path.join(HERE, 'proxy.pid');
  const writeLog = (line) => {
    const msg = `${new Date().toISOString()} [proxy] ${line}`;
    try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch { try { process.stdout.write(msg + '\n'); } catch {} }
  };

  startProxy({ log: writeLog, mode: 'standalone' })
    .then((r) => {
      if (!r.ok) process.exit(0);   // EADDRINUSE: another instance is serving
      try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
      const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
      // Ignore the console Ctrl+C a parent harness may broadcast to its process
      // group; an explicit SIGTERM still stops the proxy.
      process.on('SIGINT', () => {});
      process.on('SIGBREAK', () => {});
      process.on('SIGTERM', () => { cleanup(); r.stop(); process.exit(0); });
      process.on('exit', cleanup);
    })
    .catch((e) => {
      try { writeLog(`fatal: ${String(e && e.message ? e.message : e)}`); } catch {}
      process.exit(1);
    });
}
