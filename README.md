# dsh-hindsight-remote

Reach your [Hindsight](https://github.com/vectorize-io/hindsight) memory server from **any** network — home LAN, dorm LAN, or a VPN mesh — without ever editing your harness config again.

A DSH plugin that runs a small **loopback routing proxy** on `127.0.0.1:18888` and a **settings panel** that shows which route is live.

```
DSH ──► http://127.0.0.1:18888 ──┬──► LAN        192.168.x.x:8888   (fastest, preferred)
       (apiUrl never changes)    └──► Tailscale  100.x.x.x:8888     (works anywhere)
```

Your `apiUrl` stays a single fixed loopback value. The proxy probes every configured upstream **in parallel** and forwards to the fastest reachable one, so moving between networks needs no config edit and no restart.

---

## Why this exists

If your memory server lives on a NAS and you move between a LAN and a VPN, you have three bad options: edit `apiUrl` and restart every time, expose the server publicly, or give up remote memory. This plugin makes the address stable and the routing automatic.

It also solves a specific, non-obvious problem: **a proxy that outlives the harness is hard to build on Windows.** DSH manages its children with a Win32 Job Object (`kill-on-close`) and broadcasts `CTRL_C_EVENT` to its console process group on restart, so a child proxy dies with the harness — and `IsProcessInJob` reports *inconsistent* results for identical launch paths, so "just detach it properly" is not a reliable answer. This plugin sidesteps the whole problem by hosting the proxy **on the harness's own event loop**: no child process, lifetime exactly matches the window in which anything reads the memory endpoint.

---

## Install

1. **Copy the plugin** into your harness plugins directory:

   ```
   ~/.dsh/plugins/dsh-hindsight-remote/
   ```

2. **Create the config** from the example:

   ```bash
   cp config.example.json config.json
   ```

   Then edit `upstreams` to your real addresses. `config.json` is gitignored — your
   network addresses never end up in a commit.

3. **Register it** in your profile. Add a dependency, a bundle entry, and a loader row.

   `~/.dsh/profiles/<profile>/package.json`:

   ```json
   {
     "dependencies": {
       "@local/dsh-hindsight-remote": "link:C:/Users/you/.dsh/plugins/dsh-hindsight-remote"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@local/dsh-hindsight-remote"
         ]
       }
     }
   }
   ```

   `~/.dsh/plugins/dsh-hindsight-remote/cordis.patch.yml` is already provided; the
   bundle entry picks it up.

4. **Point the harness at the proxy.** In `~/.hindsight/coding-agent.json` (and any
   other bridge config), set:

   ```json
   { "apiUrl": "http://127.0.0.1:18888" }
   ```

5. **Restart the harness.** The panel appears in Settings as **Memory network**.

> DSH reads the bridge config **once at startup**. Changing `apiUrl` needs a restart.

---

## Configuration

`config.json` (copy `config.example.json`):

| Field | Meaning |
|---|---|
| `host` | Proxy bind address. Keep it `127.0.0.1`. |
| `port` | Proxy port. Default `18888`. |
| `upstreams[]` | Addresses to route to. Probed in parallel. |
| `upstreams[].name` | Label shown in the panel. Any name works. |
| `upstreams[].host` / `.port` | Where the memory server actually listens. |
| `upstreams[].priority` | Lower wins ties. Give your fastest network `0`. |
| `tailscaleExe` | Optional. Enables the panel's **Start VPN** button. |

A lower-priority-number upstream wins when it is reachable within **25 ms** of the fastest one, so your LAN is used whenever it is available and the VPN takes over the moment it is not.

---

## The settings panel

| Row | Meaning |
|---|---|
| **Proxy entry** | The fixed loopback address the harness dials. |
| **Active upstream** | Which route is actually in use right now. |
| Every configured upstream | 🟢 reachable (+ latency) / 🔴 unreachable |
| **VPN service** | Whether the VPN daemon is running (only if `tailscaleExe` is set) |

**One green dot is enough** — the proxy only needs a single reachable upstream, and it picks it automatically.

Polling adapts: every 10 s while healthy, every 2 s while down, so a recovery shows up almost immediately.

---

## HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `GET /__status` | JSON health: proxy, active upstream, per-upstream reachability and latency. Cached 5 s. |
| `POST /__vpn/up` | Start the VPN. **Loopback callers only.** |
| anything else | Forwarded to the active upstream. |

CORS allows custom application schemes (desktop shells serve their UI from e.g. `dsh-app://`) plus this machine's own loopback / LAN / Tailscale addresses. It is deliberately **not** `*`: any page open in your browser could otherwise read the link status or trigger VPN startup through localhost.

---

## Standalone use

The proxy also runs without the harness, for the window between boot and harness start:

```bash
node ensure-proxy.mjs     # prints already-running | started | launch-failed | no-node | no-script
node proxy.mjs            # run in the foreground
```

`ensure-proxy.mjs` is idempotent — safe to call from a Startup script on every logon.

---

## ⚠️ Do not "restart the proxy" by killing the port owner

This is the one operational trap worth reading.

While the harness is running, the proxy lives **inside the harness process** — that is
the whole point of the design (see *Why this exists*). So the process listening on your
proxy port **is the harness**:

```
> Get-NetTCPConnection -LocalPort 18888 -State Listen | Select OwningProcess

OwningProcess
-------------
        10340        # <- this is DeepSeek Harness.exe
```

Killing it to "bounce the proxy" **terminates the harness**, which the user sees as
*"应用无法启动或已意外停止"* / *"the app failed to start or stopped unexpectedly"*.

`/__status` reports which kind of instance is answering, so check before acting:

```bash
curl -s http://127.0.0.1:18888/__status | grep -o '"mode":"[a-z-]*"'
```

| `mode` | The port owner is | To restart the proxy |
|---|---|---|
| `in-process` | the harness process | **restart the harness** (tray → Restart) |
| `standalone` | a dedicated `node proxy.mjs` | stop that node process |

---

## Testing

Two suites, both runnable without a memory server:

```bash
node test-isolated.mjs      # config parsing, routing, failover, hygiene
node test-host-plugin.mjs   # simulates the harness's plugin load path
```

`test-isolated.mjs` is the one to run while the harness is up: it spins up **complete
second instances** of the proxy on their own ports with their own temp config files, so
it never touches the instance your harness is using. It covers what the other suite
cannot — a live upstream, a dead one, failover, `EADDRINUSE`, malformed config, empty
upstream lists, and hygiene checks (no top-level await, ASCII-only client, no private
addresses in shipped files).

`test-host-plugin.mjs` needs the default port, and reports a missing memory server as
`SKIP` rather than `FAIL` so it passes on any machine.

To point either suite at a different config, set `HINDSIGHT_REMOTE_CONFIG`.

---

## Security

- The proxy binds **loopback only**.
- `/__vpn/up` is restricted to loopback callers.
- CORS reflects only trusted origins (see above).
- **This plugin adds no authentication of its own.** If your Hindsight instance has no auth either, do not expose it publicly — reach it over a VPN instead. That is the point of the Tailscale upstream.

---

## Files

| File | Role |
|---|---|
| `proxy.mjs` | The routing proxy. Config-driven; also runnable standalone. |
| `index.js` | Host half: starts the proxy on the harness event loop. |
| `client.js` | Settings panel (pure ASCII — CJK strings are `\u` escapes so a code page cannot mangle them). |
| `ensure-proxy.mjs` | Start the proxy as an independent process. |
| `test-isolated.mjs` | Starts throwaway proxy instances on separate ports. Safe to run anytime. |
| `test-host-plugin.mjs` | Simulates harness plugin loading on the default port. |
| `config.example.json` | Configuration template. |

---

## Troubleshooting

Run `node test-isolated.mjs` first — it is safe to run while the harness is up and checks
the most. Then `node test-host-plugin.mjs` for the real load path.

| Symptom | Cause |
|---|---|
| Panel shows **Proxy not running** | The proxy is down. The plugin restarts it within seconds; if not, restart the harness. |
| Panel shows **No upstream configured** | `config.json` is missing, malformed, or lists no usable upstreams. |
| Panel shows **Failed to fetch** | CORS: the panel's origin is not in the allowed set. |
| All upstreams 🔴, panel fine | The proxy is up but cannot reach the memory server. Check the addresses, then start the VPN. |
| Memory tools fail but panel is green | `apiUrl` does not point at the proxy, or the harness was not restarted after changing it. |

### Gotchas worth knowing

Three real bugs this plugin hit, in case you are writing a similar one:

1. **Top-level `await` in an imported module.** A module containing top-level `await` becomes asynchronous *for every importer*, and the harness's loader then silently skipped activation. `proxy.mjs` deliberately uses a floating promise instead.
2. **A `Config` that is not a schema.** Exporting a plain object literal as `Config` makes activation fail **while the module still loads** — so a load-time probe fires and `apply()` never runs. Use a real `schemastery` schema, or export no `Config` at all.
3. **A custom-scheme origin.** A desktop shell may serve its UI from e.g. `dsh-app://`, which an http(s)-only CORS allowlist rejects — the panel reports `Failed to fetch` while the proxy is perfectly healthy.

---

## License

MIT
