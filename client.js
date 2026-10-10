window.__ModuleLoader__.load({
  id: '@local/dsh-hindsight-remote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const NS = 'dsh-hindsight-remote';

    // Text uses \u escapes so the file stays pure ASCII and cannot be mangled by an
    // editor or a Windows code page. Do not replace these with literal CJK glyphs.
    const zh = {
      nav: '\u8bb0\u5fc6\u7f51\u7edc',
      title: '\u8bb0\u5fc6\u7f51\u7edc\u72b6\u6001',
      desc: '\u663e\u793a\u5230\u8bb0\u5fc6\u670d\u52a1\u7684\u5b9e\u9645\u8def\u7531\u3002\u4ee3\u7406\u4f1a\u81ea\u52a8\u9009\u62e9\u53ef\u7528\u7684\u4e0a\u6e38\u3002',
      proxy: '\u4ee3\u7406\u5165\u53e3',
      active: '\u5f53\u524d\u4e0a\u6e38',
      reachable: '\u53ef\u8fbe',
      unreachable: '\u4e0d\u53ef\u8fbe',
      ok: '\u6b63\u5e38',
      down: '\u672a\u8fde\u63a5',
      refresh: '\u5237\u65b0',
      startVpn: '\u542f\u52a8 VPN',
      starting: '\u6b63\u5728\u542f\u52a8\u2026',
      proxyDown: '\u4ee3\u7406\u672a\u8fd0\u884c',
      proxyDownHint: '\u672c\u673a\u4ee3\u7406\u672a\u54cd\u5e94\u3002\u63d2\u4ef6\u4f1a\u5728\u6570\u79d2\u5185\u81ea\u52a8\u91cd\u542f\u5b83\uff1b\u82e5\u6301\u7eed\u4e0d\u6062\u590d\uff0c\u8bf7\u91cd\u542f DSH\u3002',
      noUpstream: '\u672a\u914d\u7f6e\u4e0a\u6e38',
      noUpstreamHint: '\u672a\u627e\u5230 config.json\uff0c\u6216\u5176\u4e2d\u6ca1\u6709\u53ef\u7528\u7684 upstreams\u3002\u8bf7\u53c2\u7167 config.example.json \u521b\u5efa\u914d\u7f6e\u3002',
      activeHint: '\u5f53\u524d\u8d70 {name}\uff0c\u8bb0\u5fc6\u94fe\u8def\u6b63\u5e38\u3002',
      noneHint: '\u6240\u6709\u4e0a\u6e38\u90fd\u4e0d\u53ef\u8fbe\u3002\u82e5\u5728\u5916\u7f51\uff0c\u8bf7\u5148\u542f\u52a8 VPN\u3002',
      vpnRunning: 'VPN \u670d\u52a1\uff1a\u8fd0\u884c\u4e2d',
      vpnStopped: 'VPN \u670d\u52a1\uff1a\u672a\u8fd0\u884c',
      lastCheck: '\u6700\u540e\u68c0\u67e5',
    };
    const en = {
      nav: 'Memory network',
      title: 'Memory network status',
      desc: 'Shows the actual route to the memory service. The proxy picks a reachable upstream automatically.',
      proxy: 'Proxy entry',
      active: 'Active upstream',
      reachable: 'reachable',
      unreachable: 'unreachable',
      ok: 'OK',
      down: 'not connected',
      refresh: 'Refresh',
      startVpn: 'Start VPN',
      starting: 'Starting\u2026',
      proxyDown: 'Proxy not running',
      proxyDownHint: 'The local proxy is not responding. The plugin restarts it within seconds; if it stays down, restart DSH.',
      noUpstream: 'No upstream configured',
      noUpstreamHint: 'config.json was not found, or it lists no usable upstreams. Create one from config.example.json.',
      activeHint: 'Currently routing over {name}. The memory link is up.',
      noneHint: 'No upstream is reachable. If you are away from the LAN, start the VPN first.',
      vpnRunning: 'VPN service: running',
      vpnStopped: 'VPN service: stopped',
      lastCheck: 'Last check',
    };

    // Port matches config.json's default; the proxy reports its real port, and the
    // panel prefers that once it has answered.
    const DEFAULT_PORT = 18888;
    let PROXY = 'http://127.0.0.1:' + DEFAULT_PORT;

    const styles = `
      .dsh-hr-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 8px; }
      .dsh-hr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .dsh-hr-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-text-1, #1f2329); }
      .dsh-hr-desc { margin-top: 4px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-text-3, #646a73); }
      .dsh-hr-card { border: 1px solid var(--dsw-alias-border-1, #dee0e3); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-2, #fff); }
      .dsh-hr-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; font-size: 13px; }
      .dsh-hr-row + .dsh-hr-row { border-top: 1px solid var(--dsw-alias-border-1, #f0f1f3); }
      .dsh-hr-k { color: var(--dsw-alias-text-3, #646a73); }
      .dsh-hr-v { color: var(--dsw-alias-text-1, #1f2329); font-weight: 500; }
      .dsh-hr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .dsh-hr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
      .dsh-hr-ok { background: #34c759; }
      .dsh-hr-bad { background: #f5483b; }
      .dsh-hr-warn { background: #ff9500; }
      .dsh-hr-btns { display: flex; gap: 8px; flex-wrap: wrap; }
      .dsh-hr-btn { appearance: none; border: 1px solid var(--dsw-alias-border-1, #dee0e3); background: var(--dsw-alias-bg-2, #fff); color: var(--dsw-alias-text-1, #1f2329); border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
      .dsh-hr-btn:hover { background: var(--dsw-alias-bg-3, #f5f6f7); }
      .dsh-hr-btn:disabled { opacity: .5; cursor: default; }
      .dsh-hr-btn-primary { background: #2477ff; border-color: #2477ff; color: #fff; }
      .dsh-hr-btn-primary:hover { background: #1a66e0; }
      .dsh-hr-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-text-3, #646a73); }
      .dsh-hr-msg { font-size: 12px; color: var(--dsw-alias-text-3, #646a73); white-space: pre-wrap; word-break: break-all; }
    `;

    function StatusPanel(props) {
      const t = (props && props.t) || ((k) => k);
      const [state, setState] = useState({ loading: true, error: null, data: null, at: null });
      const [starting, setStarting] = useState(false);
      const [startMsg, setStartMsg] = useState('');

      const load = useCallback(async () => {
        try {
          const r = await fetch(PROXY + '/__status', { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          // Follow the proxy's own reported port, so a non-default config works.
          if (data && data.proxy && data.proxy.port && data.proxy.port !== DEFAULT_PORT) {
            PROXY = 'http://127.0.0.1:' + data.proxy.port;
          }
          setState({ loading: false, error: null, data, at: new Date() });
          return true;
        } catch (e) {
          setState({ loading: false, error: String((e && e.message) || e), data: null, at: new Date() });
          return false;
        }
      }, []);

      useEffect(() => {
        let alive = true;
        let timer = null;
        // Poll faster while the proxy is down so a restart shows up quickly, and
        // slowly once it is healthy to keep the panel cheap.
        const schedule = (ms) => {
          if (!alive) return;
          timer = setTimeout(tick, ms);
        };
        const tick = async () => {
          if (!alive) return;
          const ok = await load();
          schedule(ok ? 10000 : 2000);
        };
        tick();
        return () => { alive = false; if (timer) clearTimeout(timer); };
      }, [load]);

      const startVpn = useCallback(async () => {
        setStarting(true);
        setStartMsg(t('starting'));
        try {
          const r = await fetch(PROXY + '/__vpn/up', { method: 'POST', cache: 'no-store' });
          const j = await r.json().catch(() => ({}));
          setStartMsg(j && j.ok ? 'OK' : ((j && (j.detail || j.stderr || j.stdout)) || 'failed'));
          await load();
        } catch (e) {
          setStartMsg(String((e && e.message) || e));
        } finally {
          setStarting(false);
        }
      }, [load, t]);

      const data = state.data;
      const ups = (data && data.upstreams) || [];
      const vpn = data && data.vpn;
      const vpnRunning = vpn && vpn.serviceRunning;
      const noUpstream = data && (!ups.length || data.configError);

      const fmtUp = (u) => {
        const dot = u.reachable ? 'dsh-hr-ok' : 'dsh-hr-bad';
        const lat = u.latencyMs != null ? ' \u00b7 ' + u.latencyMs + ' ms' : '';
        return h('span', null,
          h('span', { className: 'dsh-hr-dot ' + dot }),
          (u.reachable ? t('reachable') : t('unreachable')) + lat);
      };

      let hint = '';
      if (state.error) hint = t('proxyDownHint');
      else if (noUpstream) hint = t('noUpstreamHint');
      else if (data) {
        const any = ups.some((u) => u.reachable);
        hint = any
          ? t('activeHint').replace('{name}', (data.active && data.active.name) || '')
          : t('noneHint');
      }

      const body = state.error
        ? h('div', { className: 'dsh-hr-card' },
            h('div', { className: 'dsh-hr-row' },
              h('span', { className: 'dsh-hr-k' }, t('proxy')),
              h('span', { className: 'dsh-hr-v' },
                h('span', { className: 'dsh-hr-dot dsh-hr-bad' }), t('proxyDown'))),
            h('div', { className: 'dsh-hr-msg' }, state.error))
        : noUpstream
          ? h('div', { className: 'dsh-hr-card' },
              h('div', { className: 'dsh-hr-row' },
                h('span', { className: 'dsh-hr-k' }, t('proxy')),
                h('span', { className: 'dsh-hr-v' },
                  h('span', { className: 'dsh-hr-dot dsh-hr-warn' }), t('noUpstream'))),
              h('div', { className: 'dsh-hr-msg' }, (data && data.configError) || ''))
          : h('div', { className: 'dsh-hr-card' },
              h('div', { className: 'dsh-hr-row' },
                h('span', { className: 'dsh-hr-k' }, t('proxy')),
                h('span', { className: 'dsh-hr-v dsh-hr-mono' },
                  data && data.proxy ? data.proxy.host + ':' + data.proxy.port : '')),
              h('div', { className: 'dsh-hr-row' },
                h('span', { className: 'dsh-hr-k' }, t('active')),
                h('span', { className: 'dsh-hr-v' },
                  data && data.active
                    ? data.active.name + ' \u00b7 ' + data.active.host + ':' + data.active.port
                    : '\u2014')),
              // One row per configured upstream, so any naming works.
              ups.map((u) => h('div', { className: 'dsh-hr-row', key: u.name },
                h('span', { className: 'dsh-hr-k' }, u.name + ' ' + u.host + ':' + u.port),
                h('span', { className: 'dsh-hr-v' }, fmtUp(u)))),
              vpn
                ? h('div', { className: 'dsh-hr-row' },
                    h('span', { className: 'dsh-hr-k' }, vpnRunning ? t('vpnRunning') : t('vpnStopped')),
                    h('span', { className: 'dsh-hr-v' },
                      h('span', { className: 'dsh-hr-dot ' + (vpnRunning ? 'dsh-hr-ok' : 'dsh-hr-warn') }),
                      vpnRunning ? t('ok') : t('down')))
                : null);

      return h('div', { className: 'dsh-hr-wrap' },
        h('style', null, styles),
        h('div', { className: 'dsh-hr-head' },
          h('div', null,
            h('div', { className: 'dsh-hr-title' }, t('title')),
            h('div', { className: 'dsh-hr-desc' }, t('desc'))),
          h('div', { className: 'dsh-hr-btns' },
            h('button', { className: 'dsh-hr-btn', type: 'button', onClick: load }, t('refresh')),
            vpn
              ? h('button', {
                  className: 'dsh-hr-btn dsh-hr-btn-primary', type: 'button',
                  disabled: starting, onClick: startVpn,
                }, starting ? t('starting') : t('startVpn'))
              : null)),

        body,
        hint ? h('div', { className: 'dsh-hr-hint' }, hint) : null,
        startMsg ? h('div', { className: 'dsh-hr-msg' }, startMsg) : null,
        state.at ? h('div', { className: 'dsh-hr-hint' }, t('lastCheck') + ': ' + state.at.toLocaleTimeString()) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-hindsight-remote',
          order: 40,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
          inject: () => ({ t: ctx.locale.bind(NS) }),
        }, StatusPanel));
      },
    };
  },
});
