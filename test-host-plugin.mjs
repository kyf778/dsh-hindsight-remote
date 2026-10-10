// Simulation of how the harness loads the plugin's Host half, so a mistake is caught
// before it can break plugin activation inside a real restart.
//
// Works whether or not a reachable memory server is configured: the checks that need
// one are reported as SKIP, not FAIL, so this suite is runnable on any machine.
//
// Run: node test-host-plugin.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadConfig, DEFAULT_PORT, HERE } from './proxy.mjs';

const PLUGIN = path.join(HERE, 'index.js');
const CONFIG = loadConfig();
const PORT = CONFIG.port || DEFAULT_PORT;
const STATUS_URL = `http://127.0.0.1:${PORT}/__status`;

let failures = 0;
let skips = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!ok) failures++;
}
function skip(name, why) {
  console.log(`  SKIP  ${name}  -- ${why}`);
  skips++;
}

async function statusOk(timeoutMs = 6000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(STATUS_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

console.log('=== 0. environment ===');
console.log(`  plugin dir : ${HERE}`);
console.log(`  port       : ${PORT}`);
if (CONFIG.configError) {
  console.log(`  config     : ${CONFIG.configError}`);
} else {
  console.log(`  upstreams  : ${CONFIG.upstreams.map((u) => `${u.name}=${u.host}:${u.port}`).join(' ')}`);
}

console.log('');
console.log('=== 1. module shape ===');
const mod = await import(pathToFileURL(PLUGIN).href);
check('exports apply()', typeof mod.apply === 'function');
check('exports ensureProxy()', typeof mod.ensureProxy === 'function');
// No Config by design -- see the note in index.js. Asserting its absence keeps a
// future edit from reintroducing the silent-activation-failure trap.
check('exports no Config (by design)', mod.Config === undefined,
  mod.Config === undefined ? '' : 'a Config export can make activation fail silently');

console.log('');
console.log('=== 2. apply() with a realistic ctx ===');
const disposers = [];
const services = new Map();

const ctx = {
  effect(fn) { const d = fn(); disposers.push(d); return d; },
  set(name, value) { services.set(name, value); },
  logger() { return { info() {}, warn() {}, error() {} }; },
};

let threw = null;
try { mod.apply(ctx, {}); } catch (e) { threw = e; }
check('apply() does not throw', threw === null, threw ? String(threw.message) : '');
check('registered an effect', disposers.length === 1);
check('registered hindsightRemote service', services.has('hindsightRemote'));

console.log('');
console.log('=== 3. the proxy is actually serving ===');
await new Promise((r) => setTimeout(r, 2500));
check('proxy answers /__status (started from module load alone)', await statusOk());

const svc = services.get('hindsightRemote');
check('service exposes probe()', typeof svc?.probe === 'function');
if (svc) check('service probe() returns true', (await svc.probe()) === true);

console.log('');
console.log('=== 4. status payload shape ===');
let payload = null;
try {
  payload = await fetch(STATUS_URL).then((r) => r.json());
  check('has proxy block', !!payload.proxy && typeof payload.proxy.port === 'number');
  check('proxy reports its mode', payload.proxy && (payload.proxy.mode === 'in-process' || payload.proxy.mode === 'standalone'),
    payload.proxy ? `mode=${payload.proxy.mode}` : '');
  check('has upstreams array', Array.isArray(payload.upstreams));
  check('has localAddrs array', Array.isArray(payload.localAddrs));
  check('configError is null or string', payload.configError === null || typeof payload.configError === 'string',
    String(payload.configError || ''));
  console.log(`         active=${payload.active ? payload.active.name : '(none)'} upstreams=${payload.upstreams.map((u) => `${u.name}:${u.reachable ? u.latencyMs + 'ms' : 'down'}`).join(' ') || '(none)'}`);
} catch (e) {
  check('status payload fetch', false, String(e.message));
}

if (payload && payload.upstreams.length) {
  const live = payload.upstreams.filter((u) => u.reachable);
  // A missing memory server is an environment fact, not a code defect.
  if (live.length) check('at least one upstream reachable', true, `${live.length}/${payload.upstreams.length}`);
  else skip('upstream reachability', 'no memory server reachable from here');
} else {
  skip('upstream reachability', 'no upstreams configured');
}

console.log('');
console.log('=== 5. CORS ===');
try {
  // A custom-scheme origin is what a desktop shell sends; it must be allowed.
  const r1 = await fetch(STATUS_URL, { headers: { Origin: 'dsh-app://app' } });
  check('custom-scheme origin allowed', r1.headers.get('access-control-allow-origin') === 'dsh-app://app');
  const r2 = await fetch(STATUS_URL, { headers: { Origin: 'http://127.0.0.1:19387' } });
  check('loopback origin allowed', r2.headers.get('access-control-allow-origin') === 'http://127.0.0.1:19387');
  const r3 = await fetch(STATUS_URL, { headers: { Origin: 'http://evil.example.com' } });
  check('foreign origin denied', r3.headers.get('access-control-allow-origin') === null);
  const r4 = await fetch(STATUS_URL, { method: 'OPTIONS', headers: { Origin: 'dsh-app://app' } });
  check('preflight returns 204', r4.status === 204, `status=${r4.status}`);
} catch (e) {
  check('CORS checks', false, String(e.message));
}

console.log('');
console.log('=== 6. /__vpn/up is loopback-only ===');
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/__vpn/up`, { method: 'POST' });
  // From loopback with no vpn configured it must be a clean 400, not a crash.
  check('answers (not 5xx)', r.status < 500, `status=${r.status}`);
} catch (e) {
  check('vpn endpoint reachable', false, String(e.message));
}

console.log('');
console.log('=== 7. apply() tolerates a bare ctx ===');
let threw2 = null;
try { mod.apply({}, {}); } catch (e) { threw2 = e; }
check('bare ctx does not throw', threw2 === null, threw2 ? String(threw2.message) : '');

console.log('');
console.log('=== 8. dispose ===');
try {
  for (const d of disposers) { if (typeof d === 'function') d(); }
  check('dispose does not throw', true);
} catch (e) {
  check('dispose does not throw', false, String(e.message));
}

console.log('');
const summary = [];
if (failures) summary.push(`${failures} CHECK(S) FAILED`);
if (skips) summary.push(`${skips} skipped`);
console.log(failures === 0 ? `ALL CHECKS PASSED${skips ? ` (${skips} skipped)` : ''}` : summary.join(', '));
process.exit(failures === 0 ? 0 : 1);
