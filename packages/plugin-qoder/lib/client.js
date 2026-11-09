/**
 * client 端 bundle —— 手写单文件（无构建器），注册进「Harness 接入」子标签槽。
 * 功能：连接状态/会话(只读)/模型/签到积分(CN) + 启动项(CDP)。不回显凭据。
 * 约束：lib 受 CI 扫描 —— 不得出现裸进程出口字样；不得回显凭据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-qoder',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useRef, useState } = React;
    const IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular;

    const PACKAGE_NAME = 'dsh-plugin-qoder';
    const NS = PACKAGE_NAME;
    const ROUTE_STATUS = '/plugin-qoder/status';
    const ROUTE_SIGNIN = '/plugin-qoder/signin';
    const ROUTE_SIGNOUT = '/plugin-qoder/signin/logout';
    const ROUTE_CLAIM = '/plugin-qoder/claim';
    const ROUTE_CREDITS = '/plugin-qoder/credits';
    const ROUTE_STARTUP = '/plugin-qoder/startup';
    const HUB_TAB_SLOT = 'settings.harness-hub.tab';
    const HUB_TAB_ID = 'qoder';
    const HUB_TAB_ORDER = 30;

    const POLL_BUSY_MS = 3000;
    const POLL_IDLE_MS = 15000;
    function pollJitter(base) { return Math.round(base * (0.85 + Math.random() * 0.3)); }
    function pageHidden() { return typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden'; }

    const DICT = {
      zh: { nav: 'Qoder' },
      en: { nav: 'Qoder' },
    };
    const T = {
      cardDesc: '本机 Qoder CN 接入。启用自动写入启动项，关闭自动清理。',
      badge: { unknown: '…', off: '未启用', working: '工作中', notStarted: '未连接', ready: '已连接' },
      collapse: '收起', expand: '展开',
      scopeMissing: '设置服务不可用，请重启 DSH 后重试。',
      loading: '加载中…',
      enabled: '启用 Qoder 接入',
      status: '状态',
      signin: '签到与积分',
      startup: '启动项',
      pat: '个人令牌 (pt-)',
      patHint: '仅本机保存，不回显。未配置时粘贴一次即可。',
      save: '保存',
      claim: '领取今日签到',
      claimed: '今日已领取',
      refresh: '刷新',
      logout: '清除凭据',
      applyStartup: '写入启动项',
      revokeStartup: '撤销',
      unconfigured: '未配置令牌',
      notConnected: '未连接到 Qoder。启用后会写入启动项；用带 CDP 端口的方式启动/重启 Qoder 后自动连接。',
      models: '模型',
      sessions: '会话（只读）',
      empty: '暂无',
      fail: '操作失败：',
      cdpPort: 'CDP 端口',
    };

    function errorText(e) { return e instanceof Error ? e.message : String(e); }
    function fmtTime(ms) { if (!Number.isFinite(ms) || ms <= 0) return ''; try { return new Date(ms).toLocaleString(); } catch { return ''; } }
    function claimLabel(state) {
      if (state === 'claimable') return '可领取';
      if (state === 'claimed') return T.claimed;
      if (state === 'no-campaign') return '当前无活动';
      if (state === 'unconfigured') return T.unconfigured;
      if (state === 'error') return '读取失败';
      return '—';
    }

    const CSS_TAG_ID = PACKAGE_NAME + '/ConfigCard.css';
    const CARD_CSS =
      '.dsh-qc-card{list-style:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px}' +
      '.dsh-qc-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.dsh-qc-head{display:flex}.dsh-qc-toggle{appearance:none;flex:1;display:flex;align-items:center;gap:12px;background:0 0;border:0;padding:12px 14px;font:inherit;color:inherit;text-align:left;cursor:pointer}' +
      '.dsh-qc-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-qc-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.dsh-qc-desc{font-size:13px;color:var(--dsw-alias-label-tertiary);line-height:1.45}.dsh-qc-chevron{margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .16s}.dsh-qc-chevron--open{transform:rotate(180deg)}' +
      '.dsh-qc-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 14px;padding:14px 0;display:flex;flex-direction:column;gap:12px}' +
      '.dsh-qc-block{display:flex;flex-direction:column;gap:6px}.dsh-qc-bt{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500}' +
      '.dsh-qc-row{display:grid;grid-template-columns:6.5em minmax(0,1fr);align-items:center;gap:8px;font-size:13px}.dsh-qc-row__label{color:var(--dsw-alias-label-secondary)}.dsh-qc-hint{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:12px}' +
      '.dsh-qc-input,.dsh-qc-select{font:inherit;font-size:13px;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-border-l1,rgba(0,0,0,.04));border:0;border-radius:8px;padding:6px 10px;box-sizing:border-box}' +
      '.dsh-qc-switch{appearance:none;width:40px;height:24px;border-radius:12px;background:var(--dsw-alias-border-l4);position:relative;cursor:pointer;justify-self:end;flex:none}.dsh-qc-switch::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .2s}.dsh-qc-switch:checked{background:var(--dsw-alias-state-business-primary)}.dsh-qc-switch:checked::after{transform:translateX(16px)}.dsh-qc-switch:disabled{opacity:.45;cursor:not-allowed}' +
      '.dsh-qc-badge{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-fill-tertiary);font-size:12px}.dsh-qc-badge--ready,.dsh-qc-badge--working{color:var(--dsw-alias-state-business-primary)}.dsh-qc-badge--not-started{color:var(--dsw-alias-state-warn-primary)}' +
      '.dsh-qc-btn{font:inherit;font-size:13px;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;background:var(--dsw-alias-fill-tertiary);color:var(--dsw-alias-label-primary)}.dsh-qc-btn--p{background:var(--dsw-alias-state-business-primary);color:#fff}.dsh-qc-btn:disabled{opacity:.5;cursor:default}' +
      '.dsh-qc-btns{display:flex;flex-wrap:wrap;gap:8px}.dsh-qc-toast{border-radius:8px;padding:8px 10px;background:var(--dsw-alias-fill-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:13px;cursor:pointer}' +
      '.dsh-qc-line{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.5;word-break:break-word}.dsh-qc-warn{color:var(--dsw-alias-state-warn-primary)}.dsh-qc-diag{font-size:12px;color:var(--dsw-alias-label-tertiary)}';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style'); tag.dataset.plugin = PACKAGE_NAME; tag.dataset.pluginCss = CSS_TAG_ID; tag.textContent = CARD_CSS; document.head.appendChild(tag);
    }

    function Chevron(props) { return h('span', { className: 'dsh-qc-chevron' + (props.open ? ' dsh-qc-chevron--open' : '') }, h(IconChevronDownOutlineRegular, {})); }
    function badgeOf(status, enabled) {
      if (enabled === false) return { slug: 'off', text: T.badge.off };
      if (!status) return { slug: 'unknown', text: T.badge.unknown };
      const inflight = Array.isArray(status.inFlight) ? status.inFlight.length : 0;
      if (inflight > 0) return { slug: 'working', text: T.badge.working };
      const probe = status.probe && typeof status.probe === 'object' ? status.probe : null;
      if (probe && probe.installed === false) return { slug: 'not-started', text: T.badge.notStarted };
      if (status.registry === 'REGISTERED' || status.registry === 'DEGRADED') return { slug: 'ready', text: T.badge.ready };
      return enabled ? { slug: 'not-started', text: T.badge.notStarted } : { slug: 'unknown', text: T.badge.unknown };
    }
    function StatusBadge(props) { const d = badgeOf(props.status, props.enabled); return h('span', { className: 'dsh-qc-badge dsh-qc-badge--' + d.slug }, d.text); }

    async function fetchJson(url, init) {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: String(text || '').slice(0, 200) }; }
      if (!res.ok && json && typeof json === 'object') json._httpStatus = res.status;
      return json;
    }

    const makeConfigCard = (scope) => (props) => {
      const rootRef = useRef(null);
      const [open, setOpen] = useState(true);
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState('');
      const [toast, setToast] = useState('');
      const [busy, setBusy] = useState(false);
      const [patInput, setPatInput] = useState('');
      const [startup, setStartup] = useState(null);
      const [inView, setInView] = useState(true);
      const timerRef = useRef(null);
      const abortRef = useRef(null);

      const [snap, setSnap] = useState(() => (scope ? scope.getSnapshot() : { status: 'unavailable', value: {}, writable: false }));
      useEffect(() => {
        if (!scope) return undefined;
        return scope.subscribe(() => setSnap(scope.getSnapshot()));
      }, [scope]);

      const value = (snap && snap.value && typeof snap.value === 'object') ? snap.value : {};
      const disabled = !scope || typeof scope.set !== 'function' || snap.writable === false;

      async function save(patch) {
        if (!scope || typeof scope.set !== 'function') return false;
        try {
          setToast('');
          if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
            for (const k of Object.keys(patch)) await scope.set(k, patch[k]);
          } else {
            return false;
          }
          return true;
        } catch (e) { setToast(T.fail + errorText(e)); return false; }
      }

      async function pullStatus() {
        try { abortRef.current?.abort?.(); } catch {}
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        abortRef.current = ac;
        try {
          const s = await fetchJson(ROUTE_STATUS, { signal: ac?.signal });
          setStatus(s && typeof s === 'object' ? s : null); setStatusError('');
        } catch (e) { if (e?.name !== 'AbortError') setStatusError(errorText(e)); }
      }

      function scheduleNext() {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (!inView || pageHidden()) return;
        const inflight = Array.isArray(status?.inFlight) ? status.inFlight.length : 0;
        timerRef.current = setTimeout(async () => { await pullStatus(); scheduleNext(); }, pollJitter(inflight > 0 ? POLL_BUSY_MS : POLL_IDLE_MS));
      }

      useEffect(() => {
        if (!open) return undefined;
        pullStatus();
        return () => { try { abortRef.current?.abort?.(); } catch {} if (timerRef.current) clearTimeout(timerRef.current); };
      }, [open]);

      useEffect(() => { if (!open) return; scheduleNext(); return () => { if (timerRef.current) clearTimeout(timerRef.current); }; }, [open, inView, status?.inFlight?.length]);

      useEffect(() => {
        const node = rootRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') return undefined;
        const obs = new IntersectionObserver((entries) => {
          const vis = entries.some((e) => e.isIntersecting);
          setInView(vis);
          if (vis && open) pullStatus();
        });
        obs.observe(node);
        return () => obs.disconnect();
      }, [open]);

      useEffect(() => {
        function onVis() { if (!pageHidden() && inView && open) pullStatus(); }
        function onFocus() { if (inView && open) pullStatus(); }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
          if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
        };
      }, [open, inView]);

      async function loadStartup() { try { setStartup(await fetchJson(ROUTE_STARTUP)); } catch (e) { setStartup({ error: errorText(e) }); } }

      async function refreshCredits() {
        setBusy(true);
        setToast('');
        try {
          const res = await fetchJson(ROUTE_CREDITS, { method: 'POST' });
          if (res && res.credits && res.credits.error) setToast(T.fail + String(res.credits.error.message || res.credits.error.kind || '刷新失败'));
          await pullStatus();
        }
        catch (e) { setToast(T.fail + errorText(e)); }
        finally { setBusy(false); }
      }

      useEffect(() => { if (open) loadStartup(); }, [open]);

      async function onToggleEnabled(e) {
        const next = e && e.target ? e.target.checked === true : false;
        const ok = await save({ enabled: next });
        if (!ok) return;
        setBusy(true);
        try {
          if (next) {
            // 启用：自动写入启动项 + 刷新状态/积分（已配置则刷新）
            try { await fetchJson(ROUTE_STARTUP, { method: 'POST' }); } catch {}
            await loadStartup();
            await pullStatus();
            try {
              const meta = (await fetchJson(ROUTE_STATUS))?.signin;
              if (meta && meta.configured) await fetchJson(ROUTE_CREDITS, { method: 'POST' });
            } catch {}
            await pullStatus();
          } else {
            // 关闭：自动清理启动项
            try { await fetchJson(ROUTE_STARTUP, { method: 'DELETE' }); } catch {}
            await loadStartup();
            await pullStatus();
          }
        } finally { setBusy(false); }
      }

      async function savePat() {
        const pat = String(patInput || '').trim();
        if (!pat) return;
        setBusy(true); setToast('');
        try {
          const res = await fetchJson(ROUTE_SIGNIN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pat }) });
          if (res && res.ok === false) {
            setToast(T.fail + (res.message || res.reason || '保存失败'));
          } else if (res && res.credits && res.credits.error) {
            setToast(T.fail + String(res.credits.error.message || res.credits.error.kind || '凭据已保存，但刷新余额失败'));
          }
          setPatInput('');
          await pullStatus();
        } catch (e) { setToast(T.fail + errorText(e)); }
        finally { setBusy(false); }
      }
      async function clearPat() {
        setBusy(true); setToast('');
        try { await fetchJson(ROUTE_SIGNOUT, { method: 'POST' }); setPatInput(''); await pullStatus(); }
        catch (e) { setToast(T.fail + errorText(e)); }
        finally { setBusy(false); }
      }
      async function claim() {
        setBusy(true); setToast('');
        try {
          const res = await fetchJson(ROUTE_CLAIM, { method: 'POST' });
          if (res && res.ok === false) setToast(T.fail + (res?.error?.message || res?.result?.message || '领取失败'));
          await pullStatus();
        } catch (e) { setToast(T.fail + errorText(e)); }
        finally { setBusy(false); }
      }

      if (!scope) return h('section', { className: 'dsh-qc-card' }, h('div', { className: 'dsh-qc-body' }, T.scopeMissing));

      const cfg = value;
      const enabled = cfg.enabled === true;
      const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
      const models = Array.isArray(status?.models) ? status.models : [];
      const modelOptions = models.map((m) => String(m?.modelKey ?? m?.id ?? '')).filter(Boolean);
      const signinMeta = status?.signin ?? { configured: false };
      const configured = signinMeta.configured === true;
      const rawCredits = status?.credits ?? null;
      const credits = configured ? rawCredits : (rawCredits && rawCredits.error ? { claimState: 'unconfigured', region: 'cn', error: rawCredits.error } : { claimState: 'unconfigured', region: 'cn' });
      const claimState = configured ? (credits?.claimState || 'unknown') : 'unconfigured';
      const usage = configured ? (credits?.usage ?? null) : null;
      const claimable = configured && claimState === 'claimable';
      const probe = status?.probe && typeof status.probe === 'object' ? status.probe : null;
      const showConnectHint = enabled && probe && probe.installed === false;

      const body = h('div', { className: 'dsh-qc-body', key: 'body' }, [
        toast ? h('div', { className: 'dsh-qc-toast', key: 'toast', role: 'alert', onClick: () => setToast('') }, toast) : null,

        h('label', { className: 'dsh-qc-row', key: 'en' }, [
          h('span', { className: 'dsh-qc-row__label', key: 'l' }, T.enabled),
          h('input', { key: 'i', type: 'checkbox', className: 'dsh-qc-switch', checked: enabled, disabled: disabled || busy, onChange: onToggleEnabled }),
        ]),
        showConnectHint ? h('div', { className: 'dsh-qc-line dsh-qc-warn', key: 'conn' }, T.notConnected) : null,

        h('div', { className: 'dsh-qc-block', key: 'status' }, [
          h('div', { className: 'dsh-qc-bt', key: 't' }, T.status),
          h('div', { className: 'dsh-qc-line', key: 'r' }, `注册 ${status?.registry || '—'} · 探测 ${probe?.reason || '—'}${statusError ? ` · ${statusError}` : ''}`),
          status?.lastRun ? h('div', { className: 'dsh-qc-line', key: 'lr' }, `最近: ${status.lastRun.reasonCode || '—'} ${status.lastRun.sessionId ? '· ' + status.lastRun.sessionId : ''}`) : null,
          h('div', { className: 'dsh-qc-row', key: 'model' }, [
            h('label', { className: 'dsh-qc-row__label', key: 'l' }, T.models),
            h('select', { key: 's', className: 'dsh-qc-select', value: String(cfg.model ?? ''), disabled: disabled || busy, onChange: (e) => save({ model: e.target.value }) }, [
              h('option', { key: '__', value: '' }, '(默认)'),
              ...modelOptions.map((m) => h('option', { key: m, value: m }, m)),
            ]),
          ]),
          sessions.length ? h('div', { className: 'dsh-qc-line dsh-qc-diag', key: 's' }, T.sessions + ': ' + sessions.slice(0, 8).map((x) => x.sessionKey || x.sessionId).join(' · ')) : null,
        ]),

        h('div', { className: 'dsh-qc-block', key: 'signin' }, [
          h('div', { className: 'dsh-qc-bt', key: 't' }, T.signin),
          h('div', { className: 'dsh-qc-line', key: 'meta' }, signinMeta.configured ? `已配置 ${signinMeta.masked || ''}` : T.unconfigured),
          h('div', { className: 'dsh-qc-line', key: 'claim' }, `签到: ${claimLabel(claimState)}${credits?.checkedAt ? ' · ' + fmtTime(credits.checkedAt) : ''}`),
          usage?.userQuota ? h('div', { className: 'dsh-qc-line', key: 'uq' }, `额度: ${usage.userQuota.remaining ?? '?'} / ${usage.userQuota.total ?? '?'}`) : null,
          credits?.error ? h('div', { className: 'dsh-qc-line dsh-qc-warn', key: 'err' }, String(credits.error.message || credits.error.kind || '读取失败')) : null,
          !signinMeta.configured ? h('div', { className: 'dsh-qc-line dsh-qc-diag', key: 'how' }, T.patHow) : null,
          h('div', { className: 'dsh-qc-row', key: 'pat' }, [
            h('label', { className: 'dsh-qc-row__label', key: 'l' }, T.pat),
            h('input', { key: 'i', type: 'password', className: 'dsh-qc-input', value: patInput, placeholder: 'pt-…（仅需一次）', autoComplete: 'off', onChange: (e) => setPatInput(e.target.value) }),
            h('span', { className: 'dsh-qc-hint', key: 'h' }, T.patHint),
          ]),
          h('div', { className: 'dsh-qc-btns', key: 'btns' }, [
            h('button', { key: 'save', type: 'button', className: 'dsh-qc-btn', disabled: busy || !String(patInput || '').trim(), onClick: savePat }, T.save),
            h('button', { key: 'claim', type: 'button', className: 'dsh-qc-btn' + (claimable ? ' dsh-qc-btn--p' : ''), disabled: busy || !signinMeta.configured, onClick: claim }, claimable ? T.claim : (claimState === 'claimed' ? T.claimed : T.claim)),
            h('button', { key: 'ref', type: 'button', className: 'dsh-qc-btn', disabled: busy, onClick: refreshCredits }, T.refresh),
            signinMeta.configured ? h('button', { key: 'out', type: 'button', className: 'dsh-qc-btn', disabled: busy, onClick: clearPat }, T.logout) : null,
          ]),
        ]),

        h('div', { className: 'dsh-qc-block', key: 'startup' }, [
          h('div', { className: 'dsh-qc-bt', key: 't' }, T.startup),
          h('div', { className: 'dsh-qc-line', key: 'p' }, startup ? `端口 ${startup.port || cfg.cdpPort || 9333} · ${startup.exists ? (startup.matches ? '已写入' : '端口不一致') : '未写入'}（启用自动写入/关闭自动清理）` : T.loading),
          h('div', { className: 'dsh-qc-line dsh-qc-diag', key: 'n' }, '变更后需手动重启 Qoder 生效。'),
        ]),

        h('details', { className: 'dsh-qc-diag', key: 'adv' }, [
          h('summary', { key: 's' }, '高级'),
          h('div', { key: 'd', style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } }, [
            h('div', { className: 'dsh-qc-row', key: 'port' }, [
              h('label', { className: 'dsh-qc-row__label', key: 'l' }, T.cdpPort),
              h('input', { key: 'i', type: 'number', className: 'dsh-qc-input', value: Number(cfg.cdpPort ?? 9333), disabled: disabled || busy, onChange: (e) => save({ cdpPort: Number(e.target.value) || 9333 }) }),
            ]),
            h('div', { className: 'dsh-qc-row', key: 'ws' }, [
              h('label', { className: 'dsh-qc-row__label', key: 'l' }, '工作目录'),
              h('input', { key: 'i', type: 'text', className: 'dsh-qc-input', value: String(cfg.workspace ?? ''), disabled: disabled || busy, onChange: (e) => save({ workspace: e.target.value }) }),
            ]),
            h('div', { className: 'dsh-qc-row', key: 'wsid' }, [
              h('label', { className: 'dsh-qc-row__label', key: 'l' }, 'workspaceId'),
              h('input', { key: 'i', type: 'text', className: 'dsh-qc-input', value: String(cfg.workspaceId ?? ''), disabled: disabled || busy, onChange: (e) => save({ workspaceId: e.target.value }) }),
            ]),
            h('div', { className: 'dsh-qc-row', key: 'bound' }, [
              h('label', { className: 'dsh-qc-row__label', key: 'l' }, '绑定会话'),
              h('input', { key: 'i', type: 'text', className: 'dsh-qc-input', value: String(cfg.boundSessionId ?? ''), disabled: disabled || busy, onChange: (e) => save({ boundSessionId: e.target.value }) }),
            ]),
            h('div', { className: 'dsh-qc-line dsh-qc-diag', key: 'meta' }, `已刷新 ${fmtTime(status?.at) || '—'} · ${status?.modelsSource ? 'models=' + status.modelsSource : ''}`),
          ]),
        ]),
      ]);

      return h('section', { className: 'dsh-qc-card' + (open ? ' dsh-qc-card--open' : ''), ref: rootRef }, [
        h('header', { className: 'dsh-qc-head', key: 'head' }, [
          h('button', { className: 'dsh-qc-toggle', key: 'toggle', type: 'button', 'aria-expanded': open, 'aria-label': (open ? T.collapse : T.expand) + ': Qoder', onClick: () => setOpen(!open) }, [
            h('span', { key: 'text' }, [
              h('span', { className: 'dsh-qc-title-row', key: 'tr' }, [
                h('span', { className: 'dsh-qc-title', key: 'title' }, 'Qoder'),
                h(StatusBadge, { status, enabled, key: 'badge' }),
              ]),
              open ? h('span', { className: 'dsh-qc-desc', key: 'desc' }, T.cardDesc) : null,
            ]),
            h(Chevron, { open, key: 'chevron' }),
          ]),
        ]),
        open ? body : null,
      ]);
    };

    function apply(ctx) {
      const scope = ctx.configForms.get(NS);
      ctx.effect(() => ctx.locale.register(NS, DICT), PACKAGE_NAME + ': dictionaries');
      ctx.slots.inject(HUB_TAB_SLOT, () =>
        ctx.slots.register(
          {
            name: HUB_TAB_SLOT,
            id: HUB_TAB_ID,
            order: HUB_TAB_ORDER,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
          },
          makeConfigCard(scope),
        ),
      );
    }

    const inject = ['slots', 'locale', 'configForms'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
