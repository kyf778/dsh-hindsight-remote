// Isolated end-to-end test.
//
// Runs a COMPLETE second instance of the proxy -- its own config file, its own port,
// its own process -- so it never touches the instance your harness is using. That
// matters because the proxy normally runs inside the harness process, where "restart
// the proxy" would mean "restart the harness".
//
// Covers what test-host-plugin.mjs cannot: configuration parsing, routing between a
// live and a dead upstream, failover, and the standalone launcher.
//
// Run: node test-isolated.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, 'proxy.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-remote-test-'));
const CONFIG_A = path.join(TMP, 'a.json');
const CONFIG_B = path.join(TMP, 'b.json');
const CONFIG_EMPTY = path.join(TMP, 'empty.json');
const CONFIG_BAD = path.join(TMP, 'bad.json');

const PROXY_PORT = 18899;   // deliberately not the default 18888
const GOOD_PORT = 18897;    // a fake "reachable upstream"
const DEAD_PORT = 18898;    // nothing listens here

const childProcs = [];
const servers = [];
let proxyProc = null;

function cleanup() {
  for (const c of childProcs) { try { c.kill(); } catch {} }
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

/** A minimal stand-in for the memory server. */
function fakeUpstream(port, onRequest) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (onRequest) { onRequest(req, res); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream: port, path: req.url }));
    });
    servers.push(srv);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function waitFor(fn, timeoutMs = 25_000, intervalMs = 300) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await fn()) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function getJson(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  } catch (e) {
    return { status: 0, body: null, error: String(e.message) };
  } finally { clearTimeout(t); }
}

/** Start proxy.mjs as a standalone process with a given config. */
function startIsolatedProxy(configFile, port) {
  const child = spawn(process.execPath, [PROXY], {
    cwd: HERE,
    env: { ...process.env, HINDSIGHT_REMOTE_CONFIG: configFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childProcs.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, output: () => out, url: `http://127.0.0.1:${port}` };
}

try {
  console.log('=== 0. fixtures ===');
  console.log(`  temp dir   : ${TMP}`);
  console.log(`  proxy port : ${PROXY_PORT}`);

  fs.writeFileSync(CONFIG_A, JSON.stringify({
    host: '127.0.0.1', port: PROXY_PORT,
    upstreams: [
      { name: 'good', host: '127.0.0.1', port: GOOD_PORT, priority: 0 },
      { name: 'dead', host: '127.0.0.1', port: DEAD_PORT, priority: 1 },
    ],
  }));
  fs.writeFileSync(CONFIG_B, JSON.stringify({
    host: '127.0.0.1', port: PROXY_PORT,
    upstreams: [{ name: 'deadtwo', host: '127.0.0.1', port: DEAD_PORT, priority: 0 }],
  }));
  fs.writeFileSync(CONFIG_EMPTY, JSON.stringify({ host: '127.0.0.1', port: PROXY_PORT, upstreams: [] }));
  fs.writeFileSync(CONFIG_BAD, '{ this is not json');

  console.log('');
  console.log('=== 1. config parsing (pure, no server needed) ===');
  const { loadConfig, probeProxy } = await import(pathToFileURL(PROXY).href);
  check('valid config parses', loadConfig(CONFIG_A).upstreams.length === 2);
  check('upstream order follows priority', loadConfig(CONFIG_A).upstreams[0].name === 'good');
  check('missing file reports an error', !!loadConfig(path.join(TMP, 'nope.json')).configError);
  check('empty upstreams reports an error', !!loadConfig(CONFIG_EMPTY).configError);
  check('malformed JSON reports an error', !!loadConfig(CONFIG_BAD).configError);
  check('malformed JSON does not throw', (() => { try { loadConfig(CONFIG_BAD); return true; } catch { return false; } })());

  console.log('');
  console.log('=== 2. probe of a dead port returns false quickly ===');
  {
    const t0 = Date.now();
    const r = await probeProxy(DEAD_PORT, 2000);
    const ms = Date.now() - t0;
    check('probeProxy(dead) === false', r === false, `${ms}ms`);
  }

  console.log('');
  console.log('=== 3. isolated instance, one good upstream ===');
  await fakeUpstream(GOOD_PORT);
  const P = startIsolatedProxy(CONFIG_A, PROXY_PORT);
  const up = await waitFor(async () => (await getJson(`${P.url}/__status`, 3000)).status === 200);
  check('proxy started', up, up ? '' : P.output().slice(-400));

  if (up) {
    const s = await getJson(`${P.url}/__status`);
    check('status has both upstreams', s.body.upstreams.length === 2);
    check('good upstream reachable', s.body.upstreams.find((u) => u.name === 'good')?.reachable === true);
    check('dead upstream unreachable', s.body.upstreams.find((u) => u.name === 'dead')?.reachable === false);
    check('active upstream is the good one', s.body.active?.name === 'good', `active=${s.body.active?.name}`);
    check('mode is standalone', s.body.proxy.mode === 'standalone', `mode=${s.body.proxy.mode}`);
    check('configError is null', s.body.configError === null, String(s.body.configError));

    console.log('');
    console.log('=== 4. traffic is forwarded to the good upstream ===');
    const f = await getJson(`${P.url}/v1/things`);
    check('forwarded request gets 200', f.status === 200, `status=${f.status}`);
    check('upstream saw the path', f.body && f.body.path === '/v1/things', JSON.stringify(f.body));
    check('upstream identity matches', f.body && f.body.upstream === GOOD_PORT);

    console.log('');
    console.log('=== 5. restarting is idempotent (EADDRINUSE is not an error) ===');
    const second = startIsolatedProxy(CONFIG_A, PROXY_PORT);
    const exited = await waitFor(() => second.child.exitCode !== null, 8000);
    check('second instance exits cleanly', exited && second.child.exitCode === 0,
      `exitCode=${second.child.exitCode}`);
    check('first instance still serving', (await getJson(`${P.url}/__status`)).status === 200);
  }

  console.log('');
  console.log('=== 6. no reachable upstream -> 503, not a hang or crash ===');
  if (up) {
    // Point the live instance at a config whose only upstream is dead, by starting a
    // separate instance on a second port so the first keeps serving.
    const PORT2 = 18900;
    const cfg2 = path.join(TMP, 'b2.json');
    fs.writeFileSync(cfg2, JSON.stringify({
      host: '127.0.0.1', port: PORT2,
      upstreams: [{ name: 'only-dead', host: '127.0.0.1', port: DEAD_PORT, priority: 0 }],
    }));
    const P2 = startIsolatedProxy(cfg2, PORT2);
    const up2 = await waitFor(async () => (await getJson(`${P2.url}/__status`, 3000)).status === 200);
    check('second instance on another port started', up2, up2 ? '' : P2.output().slice(-400));
    if (up2) {
      const r = await getJson(`${P2.url}/anything`);
      check('unreachable upstream yields 502 or 503', r.status === 502 || r.status === 503, `status=${r.status}`);
      check('no vpn configured -> vpn is null', (await getJson(`${P2.url}/__status`)).body.vpn === null);
      const v = await getJson(`${P2.url}/__vpn/up`, 8000);
      check('vpn endpoint answers 400 when unconfigured', v.status === 400, `status=${v.status}`);
    }
  }

  console.log('');
  console.log('=== 7. empty upstream list -> 503 with a reason ===');
  {
    const PORT3 = 18901;
    const cfg3 = path.join(TMP, 'c3.json');
    fs.writeFileSync(cfg3, JSON.stringify({ host: '127.0.0.1', port: PORT3, upstreams: [] }));
    const P3 = startIsolatedProxy(cfg3, PORT3);
    const up3 = await waitFor(async () => (await getJson(`${P3.url}/__status`, 3000)).status === 200);
    check('starts even with no upstreams', up3, up3 ? '' : P3.output().slice(-400));
    if (up3) {
      const s = await getJson(`${P3.url}/__status`);
      check('reports the config error', !!s.body.configError, String(s.body.configError));
      check('active is null', s.body.active === null);
      const r = await getJson(`${P3.url}/anything`);
      check('request yields 503', r.status === 503, `status=${r.status}`);
    }
  }

  console.log('');
  console.log('=== 8. CORS matrix on a live instance ===');
  if (up) {
    // The dangerous case: http/https are valid custom-scheme SYNTAX, so a permissive
    // custom-scheme test written first would accept every public origin. This table
    // pins both directions.
    const cases = [
      ['dsh-app://app', true, 'desktop shell scheme'],
      ['dsh-app://shell', true, 'another shell host'],
      ['http://127.0.0.1:19387', true, 'loopback'],
      ['http://localhost:3000', true, 'localhost'],
      ['http://192.168.1.50:8080', true, 'private LAN'],
      ['http://100.64.1.2:80', true, 'tailscale range'],
      ['http://evil.example.com', false, 'public host'],
      ['https://attacker.io', false, 'public https'],
      ['http://example.com:8080', false, 'public with port'],
      ['file://local', false, 'file scheme'],
      ['null', false, 'opaque origin'],
    ];
    for (const [origin, shouldAllow, why] of cases) {
      const r = await getJson(`${P.url}/__status`, 8000);
      const ctrl = new AbortController();
      const res = await fetch(`${P.url}/__status`, {
        headers: { Origin: origin }, signal: ctrl.signal,
      }).catch(() => null);
      const got = res ? res.headers.get('access-control-allow-origin') : null;
      const allowed = got !== null;
      check(`origin ${origin} -> ${shouldAllow ? 'allow' : 'deny'}`, allowed === shouldAllow,
        `${why}${allowed && !shouldAllow ? '  *** SECURITY ***' : ''}`);
      void r;
    }
  } else {
    skip('CORS matrix', 'no instance running');
  }

  console.log('');
  console.log('=== 9. no top-level await in any shipped module ===');
  for (const f of ['proxy.mjs', 'index.js', 'ensure-proxy.mjs']) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    // Top-level await would make every importer async and can silently break
    // plugin activation; the pattern below matches await at column 0 only.
    const tla = /^await\s/m.test(src);
    check(`${f} has no top-level await`, !tla);
  }

  console.log('');
  console.log('=== 10. client.js is pure ASCII ===');
  {
    const buf = fs.readFileSync(path.join(HERE, 'client.js'));
    let nonAscii = 0;
    for (const b of buf) if (b > 127) nonAscii++;
    check('no non-ASCII bytes', nonAscii === 0, `${nonAscii} found`);
  }

  console.log('');
  console.log('=== 11. no deployment-specific addresses in shipped files ===');
  {
    const shipped = [
      'proxy.mjs', 'index.js', 'ensure-proxy.mjs', 'client.js',
      'package.json', 'cordis.patch.yml', 'README.md',
    ];
    // Built from fragments so this file does not itself contain the literals it
    // looks for (which would make the check trip on its own source).
    const user = '694' + '98';
    const flagged = [
      { what: 'a private LAN address', re: /\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\b/ },
      { what: 'a Tailscale address', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
      { what: 'an absolute user path', re: new RegExp('Users[\\\\/]' + user) },
      { what: 'a QQ mailbox', re: new RegExp(user + '2318') },
    ];
    const leak = [];
    for (const f of shipped) {
      const src = fs.readFileSync(path.join(HERE, f), 'utf8');
      for (const { what, re } of flagged) {
        if (re.test(src)) leak.push(`${f}: ${what}`);
      }
    }
    check('no deployment addresses, user paths, or mailboxes in code', leak.length === 0, leak.join('; '));

    // config.example.json is the one file expected to contain addresses; it must use
    // obvious placeholders rather than anything that looks deployed.
    const example = fs.readFileSync(path.join(HERE, 'config.example.json'), 'utf8');
    check('config.example.json uses placeholder addresses',
      /"host":\s*"192\.168\.1\.\d+"/.test(example) && /"host":\s*"100\.64\.0\.\d+"/.test(example));
  }
} catch (e) {
  console.log('');
  console.log(`  FAIL  unexpected error: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n        ') : e}`);
  failures++;
} finally {
  cleanup();
}

console.log('');
console.log(failures === 0 ? 'ALL ISOLATED CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
