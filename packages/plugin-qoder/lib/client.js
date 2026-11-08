/**
 * client 端 bundle —— 手写单文件（无构建器），注册进「Harness 接入」父条目的子标签槽。
 *
 * 功能（按用户合同）：A1 自动刷新 + 只读会话列表；模型/思考/上下文观测；签到/积分（CN，粘贴 pt- PAT 一次，
 * 余额+今日领取状态+一键领取；不回显凭据）；启动项状态/写入/撤销 + 注册表 Run 键仅报告。Qoder 无计划任务 ⇒ 无任务列表/无删除。
 *
 * 约束：lib 目录受 CI 扫描 —— 不得出现裸进程出口字样；不得回显凭据。
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
      zh: {
        nav: 'Qoder',
        detail: {
          card: { desc: 'DshAgentHub 插件 · 本机 Qoder CN（CDP+applicationInvoke）：下发/回执/模型观测/签到积分；零反代、零 CLI、零 GUI 自动化' },
          badge: { unknown: '… 未探测', off: '○ 未开启', dispatching: '◐ 任务下发中', working: '◐ 工作中', notStarted: '○ 未启动', ready: '● 已启动' },
          shell: { collapse: '收起设置', expand: '展开设置', scopeMissing: 'Qoder：设置服务不可用。', skeleton: '加载中…', toastPrefix: '操作失败：', toastDismiss: '关闭', unknownText: '未知' },
          config: { blockTitle: '配置' },
          form: {
            cdpPortLabel: 'CDP 端口', cdpPortHint: '默认 9333（9222 为 WorkBuddy 保留）；Qoder 需用 --remote-debugging-port 启动（插件不代启动）。',
            modelLabel: '模型', modelHint: 'modelKey（来自 listChatModels）；留空=服务默认。',
            effortLabel: '思考强度', effortHint: '仅当模型 efforts 含该档时下发；submitRich 入参待验（unknown 时不发送，仅报告）。',
            contextLabel: '上下文窗口', contextHint: '0=不指定；仅当模型 availableContextWindows 含该档时下发。',
            workspaceLabel: '工作目录', workspaceHint: '新会话需要可解析 workspace；解析失败会如实报错，不猜测。',
            workspaceIdLabel: 'workspaceId', workspaceIdHint: '留空=按目录/cwd 推断（推断失败报错）。',
            boundSessionLabel: '绑定会话', boundSessionHint: '固定 UUID；留空=按 session_key 复用/新建。',
            waitTimeoutLabel: '等待上限(ms)', waitTimeoutHint: '超时不解除 Qoder 中的任务，只回传在途态。',
          },
          toggle: { rowLabel: '启用' },
          status: { blockTitle: '状态', settingsPrefix: '设置：', registryPrefix: '注册：', probeReasonPrefix: '探测结论：', serviceMissing: '未连接到 Qoder CDP 目标。请用 --remote-debugging-port=9333 启动 Qoder（可在下方写入启动项），插件不会代启动。', diagnosticsSummary: '详情（排障用）' },
          task: { blockTitle: '任务/会话', inFlightSome: (n) => `在途作业：${n}`, empty: '暂无下发记录', sessionsTitle: '会话列表（只读）', noSessions: '暂无会话映射' },
          signin: {
            blockTitle: '签到与积分（CN）', patLabel: '个人令牌 (PAT)', patPlaceholder: '粘贴 pt-…（只存本机 DSH vault，不回显）', save: '保存并刷新', logout: '清除凭据', refresh: '刷新余额',
            claim: '一键领取今日签到', claimable: '可领取', claimed: '今日已领取', noCampaign: '当前无活动', unconfigured: '未配置（粘贴 pt- PAT）', error: '读取失败',
            attribution: '协议参考 dingminhua/dsh-connect-qoder (MIT)；CN 首版，global 不支持/unknown。',
          },
          startup: {
            blockTitle: '启动项（CDP 端口）', apply: '写入启动项', revoke: '撤销启动项', refresh: '刷新',
            note: '写入 %APPDATA%\\…\\Startup\\Qoder CN (dsh).cmd，参数 --remote-debugging-port=<端口>。插件不会启动/关闭/重启 Qoder；写入后需用户手动重启 Qoder 生效。',
            regNote: '注册表 Run 键：仅报告、不修改。插件未自动检查注册表（避免进程执行）；若存在冲突自启项请用户手动关闭。',
          },
        },
      },
      en: { nav: 'Qoder' },
    };
    const L = DICT.zh.detail;

    function errorText(e) { return e instanceof Error ? e.message : String(e); }
    function fmtTime(ms) { if (!Number.isFinite(ms) || ms <= 0) return ''; try { return new Date(ms).toLocaleString(); } catch { return ''; } }
    function claimLabel(state) {
      if (state === 'claimable') return L.signin.claimable;
      if (state === 'claimed') return L.signin.claimed;
      if (state === 'no-campaign') return L.signin.noCampaign;
      if (state === 'unconfigured') return L.signin.unconfigured;
      if (state === 'error') return L.signin.error;
      return L.shell.unknownText;
    }

    const CSS_TAG_ID = PACKAGE_NAME + '/ConfigCard.css';
    const CARD_CSS =
      '.dsh-qc-card{list-style:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px}' +
      '.dsh-qc-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.dsh-qc-head{display:flex}.dsh-qc-toggle{appearance:none;flex:1;display:flex;align-items:center;gap:12px;background:0 0;border:0;padding:12px 14px;font:inherit;color:inherit;text-align:left;cursor:pointer}' +
      '.dsh-qc-title-row{display:flex;align-items:center;gap:8px}.dsh-qc-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.dsh-qc-desc{font-size:13px;color:var(--dsw-alias-label-tertiary)}.dsh-qc-chevron{margin-left:auto;color:var(--dsw-alias-label-tertiary);transition:transform .16s}.dsh-qc-chevron--open{transform:rotate(180deg)}' +
      '.dsh-qc-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 14px;padding:14px 0;display:flex;flex-direction:column;gap:14px}' +
      '.dsh-qc-block-title{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500}' +
      '.dsh-qc-group,.dsh-qc-task,.dsh-qc-status{display:flex;flex-direction:column;gap:6px}' +
      '.dsh-qc-row{display:grid;grid-template-columns:6.5em minmax(0,1fr);align-items:center;gap:8px;font-size:13px}.dsh-qc-row__label{color:var(--dsw-alias-label-secondary)}.dsh-qc-row__hint{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:12px}' +
      '.dsh-qc-input,.dsh-qc-select{font:inherit;font-size:13px;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-border-l1,rgba(0,0,0,.04));border:0;border-radius:8px;padding:5px 10px}' +
      '.dsh-qc-switch{appearance:none;width:36px;height:22px;border-radius:11px;background:var(--dsw-alias-border-l4);position:relative;cursor:pointer;justify-self:end}.dsh-qc-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .2s}.dsh-qc-switch:checked{background:var(--dsw-alias-state-business-primary)}.dsh-qc-switch:checked::after{transform:translateX(14px)}' +
      '.dsh-qc-badge{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-fill-tertiary);font-size:12px}.dsh-qc-badge--ready,.dsh-qc-badge--working{color:var(--dsw-alias-state-business-primary)}.dsh-qc-badge--not-started{color:var(--dsw-alias-state-warn-primary)}' +
      '.dsh-qc-btn{font:inherit;font-size:13px;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;background:var(--dsw-alias-fill-tertiary);color:var(--dsw-alias-label-primary)}.dsh-qc-btn--primary{background:var(--dsw-alias-state-business-primary);color:#fff}.dsh-qc-btn:disabled{opacity:.5;cursor:default}' +
      '.dsh-qc-btnrow{display:flex;flex-wrap:wrap;gap:8px}.dsh-qc-toast{border-radius:8px;padding:8px 10px;background:var(--dsw-alias-fill-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:13px;cursor:pointer}' +
      '.dsh-qc-line{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.5;word-break:break-all}.dsh-qc-warn{color:var(--dsw-alias-state-warn-primary)}.dsh-qc-diag{font-size:12px;color:var(--dsw-alias-label-tertiary)}.dsh-qc-list{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary)}';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style'); tag.dataset.plugin = PACKAGE_NAME; tag.dataset.pluginCss = CSS_TAG_ID; tag.textContent = CARD_CSS; document.head.appendChild(tag);
    }

    function Chevron(props) { return h('span', { className: 'dsh-qc-chevron' + (props.open ? ' dsh-qc-chevron--open' : '') }, h(IconChevronDownOutlineRegular, {})); }
    function badgeOf(status) {
      if (!status) return { slug: 'unknown', text: L.badge.unknown };
      const cfg = status.config && typeof status.config === 'object' ? status.config : null;
      if (cfg && cfg.enabled === false) return { slug: 'off', text: L.badge.off };
      const inflight = Array.isArray(status.inFlight) ? status.inFlight.length : 0;
      if (inflight > 0) return { slug: 'working', text: L.badge.working };
      const probe = status.probe && typeof status.probe === 'object' ? status.probe : null;
      if (probe && probe.installed === false) return { slug: 'not-started', text: L.badge.notStarted };
      if (status.registry === 'REGISTERED' || status.registry === 'DEGRADED') return { slug: 'ready', text: L.badge.ready };
      return { slug: 'unknown', text: L.badge.unknown };
    }
    function StatusBadge(props) { const d = badgeOf(props.status); return h('span', { className: 'dsh-qc-badge dsh-qc-badge--' + d.slug }, d.text); }
    function FieldRow(props) {
      return h('div', { className: 'dsh-qc-row' }, [
        h('label', { className: 'dsh-qc-row__label', key: 'l', htmlFor: props.id }, props.label),
        h('input', { key: 'i', id: props.id, type: props.type || 'text', className: 'dsh-qc-input', value: props.value ?? '', disabled: props.disabled, onChange: (e) => props.onChange(props.type === 'number' ? Number(e.target.value) : e.target.value) }),
        props.hint ? h('span', { className: 'dsh-qc-row__hint', key: 'h' }, props.hint) : null,
      ]);
    }
    function SwitchRow(props) {
      return h('label', { className: 'dsh-qc-row' }, [
        h('span', { className: 'dsh-qc-row__label', key: 'l' }, props.label),
        h('input', { key: 'i', type: 'checkbox', className: 'dsh-qc-switch', checked: props.checked === true, disabled: props.disabled, onChange: props.onChange }),
      ]);
    }

    async function fetchJson(url, init) {
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 200) }; }
      if (!res.ok && json && typeof json === 'object') json._httpStatus = res.status;
      return json;
    }

    const makeConfigCard = (scope) => (props) => {
      const rootRef = useRef(null);
      const [open, setOpen] = useState(false);
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState('');
      const [toast, setToast] = useState('');
      const [busy, setBusy] = useState(false);
      const [patInput, setPatInput] = useState(''); // never echoed back from server; local only until saved
      const [startup, setStartup] = useState(null);
      const [inView, setInView] = useState(true);
      const timerRef = useRef(null);
      const abortRef = useRef(null);

      const snap = scope ? scope.getSnapshot() : { status: 'unavailable', value: {}, writable: false };
      const [, force] = useState(0);
      useEffect(() => {
        if (!scope) return undefined;
        return scope.subscribe(() => force((n) => n + 1));
      }, [scope]);

      const value = (snap && snap.value && typeof snap.value === 'object') ? snap.value : {};
      const disabled = !scope || snap.writable === false;

      async function save(patch) {
        if (!scope || typeof scope.set !== 'function') return;
        try {
          setToast('');
          await scope.set(patch);
        } catch (e) { setToast(L.shell.toastPrefix + errorText(e)); }
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

      async function savePat() {
        const pat = String(patInput || '').trim();
        if (!pat) return;
        setBusy(true); setToast('');
        try {
          const res = await fetchJson(ROUTE_SIGNIN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pat }) });
          if (res && res.ok === false) setToast(L.shell.toastPrefix + (res.message || res.reason || '保存失败'));
          setPatInput(''); // never keep/echo
          await pullStatus();
        } catch (e) { setToast(L.shell.toastPrefix + errorText(e)); }
        finally { setBusy(false); }
      }
      async function clearPat() {
        setBusy(true); setToast('');
        try { await fetchJson(ROUTE_SIGNOUT, { method: 'POST' }); setPatInput(''); await pullStatus(); }
        catch (e) { setToast(L.shell.toastPrefix + errorText(e)); }
        finally { setBusy(false); }
      }
      async function claim() {
        setBusy(true); setToast('');
        try {
          const res = await fetchJson(ROUTE_CLAIM, { method: 'POST' });
          if (res && res.ok === false) setToast(L.shell.toastPrefix + (res?.error?.message || res?.result?.message || '领取失败'));
          await pullStatus();
        } catch (e) { setToast(L.shell.toastPrefix + errorText(e)); }
        finally { setBusy(false); }
      }
      async function refreshCredits() { setBusy(true); try { await fetchJson(ROUTE_CREDITS, { method: 'POST' }); await pullStatus(); } catch (e) { setToast(L.shell.toastPrefix + errorText(e)); } finally { setBusy(false); } }
      async function loadStartup() { try { setStartup(await fetchJson(ROUTE_STARTUP)); } catch (e) { setStartup({ error: errorText(e) }); } }
      async function applyStartup() { setBusy(true); try { setStartup(await fetchJson(ROUTE_STARTUP, { method: 'POST' })); } catch (e) { setToast(L.shell.toastPrefix + errorText(e)); } finally { setBusy(false); } }
      async function revokeStartup() { setBusy(true); try { setStartup(await fetchJson(ROUTE_STARTUP, { method: 'DELETE' })); } catch (e) { setToast(L.shell.toastPrefix + errorText(e)); } finally { setBusy(false); } }
      useEffect(() => { if (open) loadStartup(); }, [open]);

      if (!scope) return h('section', { className: 'dsh-qc-card' }, h('div', { className: 'dsh-qc-body' }, L.shell.scopeMissing));

      const cfg = value;
      const inflight = Array.isArray(status?.inFlight) ? status.inFlight : [];
      const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
      const models = Array.isArray(status?.models) ? status.models : [];
      const modelOptions = models.map((m) => String(m?.modelKey ?? m?.id ?? '')).filter(Boolean);
      const signinMeta = status?.signin ?? { configured: false };
      const credits = status?.credits ?? null;
      const claimState = credits?.claimState || (signinMeta.configured ? 'unknown' : 'unconfigured');
      const usage = credits?.usage ?? null;
      const claimable = claimState === 'claimable';

      const body = h('div', { className: 'dsh-qc-body', key: 'body' }, [
        toast ? h('div', { className: 'dsh-qc-toast', key: 'toast', role: 'alert', onClick: () => setToast('') }, toast + ' (' + L.shell.toastDismiss + ')') : null,
        h('div', { className: 'dsh-qc-group', key: 'cfg' }, [
          h('div', { className: 'dsh-qc-block-title', key: 't' }, L.config.blockTitle),
          h(SwitchRow, { key: 'en', label: L.toggle.rowLabel, checked: cfg.enabled === true, disabled, onChange: (e) => save({ enabled: e.target.checked }) }),
          h(FieldRow, { key: 'port', id: 'dsh-qc-port', type: 'number', label: L.form.cdpPortLabel, value: Number(cfg.cdpPort ?? 9333), disabled, onChange: (v) => save({ cdpPort: Number(v) || 9333 }), hint: L.form.cdpPortHint }),
          h('div', { className: 'dsh-qc-row', key: 'model' }, [
            h('label', { className: 'dsh-qc-row__label', key: 'l' }, L.form.modelLabel),
            h('select', { key: 's', className: 'dsh-qc-select', value: String(cfg.model ?? ''), disabled, onChange: (e) => save({ model: e.target.value }) }, [
              h('option', { key: '__', value: '' }, '(服务默认)'),
              ...modelOptions.map((m) => h('option', { key: m, value: m }, m)),
            ]),
            h('span', { className: 'dsh-qc-row__hint', key: 'h' }, L.form.modelHint + (status?.modelsSource ? ` · source=${status.modelsSource}` : '')),
          ]),
          h(FieldRow, { key: 'eff', id: 'dsh-qc-eff', label: L.form.effortLabel, value: String(cfg.reasoningEffort ?? ''), disabled, onChange: (v) => save({ reasoningEffort: String(v ?? '') }), hint: L.form.effortHint }),
          h(FieldRow, { key: 'ctxw', id: 'dsh-qc-ctxw', type: 'number', label: L.form.contextLabel, value: Number(cfg.contextWindow ?? 0), disabled, onChange: (v) => save({ contextWindow: Number(v) || 0 }), hint: L.form.contextLabel ? L.form.contextHint : '' }),
          h(FieldRow, { key: 'ws', id: 'dsh-qc-ws', label: L.form.workspaceLabel, value: String(cfg.workspace ?? ''), disabled, onChange: (v) => save({ workspace: String(v ?? '') }), hint: L.form.workspaceHint }),
          h(FieldRow, { key: 'wsid', id: 'dsh-qc-wsid', label: L.form.workspaceIdLabel, value: String(cfg.workspaceId ?? ''), disabled, onChange: (v) => save({ workspaceId: String(v ?? '') }), hint: L.form.workspaceIdHint }),
          h(FieldRow, { key: 'bound', id: 'dsh-qc-bound', label: L.form.boundSessionLabel, value: String(cfg.boundSessionId ?? ''), disabled, onChange: (v) => save({ boundSessionId: String(v ?? '') }), hint: L.form.boundSessionHint }),
          h(FieldRow, { key: 'wt', id: 'dsh-qc-wt', type: 'number', label: L.form.waitTimeoutLabel, value: Number(cfg.waitTimeoutMs ?? 900000), disabled, onChange: (v) => save({ waitTimeoutMs: Number(v) || 900000 }), hint: L.form.waitTimeoutHint }),
        ]),
        h('div', { className: 'dsh-qc-task', key: 'task' }, [
          h('div', { className: 'dsh-qc-block-title', key: 't' }, L.task.blockTitle),
          inflight.length ? h('div', { className: 'dsh-qc-line', key: 'if' }, L.task.inFlightSome(inflight.length)) : null,
          status?.lastRun ? h('div', { className: 'dsh-qc-line', key: 'lr' }, `最近：session=${status.lastRun.sessionId || '-'} reason=${status.lastRun.reasonCode || '-'} wait=${status.lastRun.waitStatus || '-'}`) : h('div', { className: 'dsh-qc-line', key: 'lr' }, L.task.empty),
          h('div', { className: 'dsh-qc-line', key: 'st' }, L.task.sessionsTitle),
          sessions.length ? h('ul', { className: 'dsh-qc-list', key: 'sl' }, sessions.slice(0, 20).map((s) => h('li', { key: s.sessionId + ':' + s.sessionKey }, `${s.sessionKey} → ${s.sessionId} [${s.state}] ${s.title || ''}`))) : h('div', { className: 'dsh-qc-line', key: 's0' }, L.task.noSessions),
          h('div', { className: 'dsh-qc-line dsh-qc-diag', key: 'sch' }, 'scheduled_tasks: 不支持（count=0）；审批接力: unknown/unverified（不编造）。'),
        ]),
        h('div', { className: 'dsh-qc-group', key: 'signin' }, [
          h('div', { className: 'dsh-qc-block-title', key: 't' }, L.signin.blockTitle),
          h('div', { className: 'dsh-qc-line', key: 'meta' }, signinMeta.configured ? `已配置 ${signinMeta.masked || ''} (${signinMeta.accountId || 'cn'})` : L.signin.unconfigured),
          h('div', { className: 'dsh-qc-line', key: 'claim' }, `今日签到：${claimLabel(claimState)}${credits?.checkedAt ? ` · 刷新于 ${fmtTime(credits.checkedAt)}` : ''}`),
          usage?.userQuota ? h('div', { className: 'dsh-qc-line', key: 'uq' }, `额度：remaining=${usage.userQuota.remaining ?? '?'} / total=${usage.userQuota.total ?? '?'} used=${usage.userQuota.used ?? '?'}`) : null,
          usage?.addOnQuota ? h('div', { className: 'dsh-qc-line', key: 'aq' }, `附加额度：remaining=${usage.addOnQuota.remaining ?? '?'} / total=${usage.addOnQuota.total ?? '?'}`) : null,
          credits?.error ? h('div', { className: 'dsh-qc-line dsh-qc-warn', key: 'err' }, `错误：${credits.error.kind || ''} ${credits.error.message || ''}`) : null,
          h('div', { className: 'dsh-qc-row', key: 'pat' }, [
            h('label', { className: 'dsh-qc-row__label', key: 'l' }, L.signin.patLabel),
            h('input', { key: 'i', type: 'password', className: 'dsh-qc-input', value: patInput, placeholder: L.signin.patPlaceholder, autoComplete: 'off', onChange: (e) => setPatInput(e.target.value) }),
            h('span', { className: 'dsh-qc-row__hint', key: 'h' }, 'PAT 不回显、不进日志/回执；清空输入框不影响已保存凭据。'),
          ]),
          h('div', { className: 'dsh-qc-btnrow', key: 'btns' }, [
            h('button', { key: 'save', type: 'button', className: 'dsh-qc-btn dsh-qc-btn--primary', disabled: busy || !String(patInput || '').trim(), onClick: savePat }, L.signin.save),
            h('button', { key: 'claim', type: 'button', className: 'dsh-qc-btn', disabled: busy || !signinMeta.configured, onClick: claim }, claimable ? L.signin.claim : (claimState === 'claimed' ? L.signin.claimed : L.signin.claim)),
            h('button', { key: 'ref', type: 'button', className: 'dsh-qc-btn', disabled: busy, onClick: refreshCredits }, L.signin.refresh),
            h('button', { key: 'out', type: 'button', className: 'dsh-qc-btn', disabled: busy, onClick: clearPat }, L.signin.logout),
          ]),
          h('div', { className: 'dsh-qc-line dsh-qc-diag', key: 'attr' }, L.signin.attribution),
        ]),
        h('div', { className: 'dsh-qc-group', key: 'startup' }, [
          h('div', { className: 'dsh-qc-block-title', key: 't' }, L.startup.blockTitle),
          h('div', { className: 'dsh-qc-line', key: 'note' }, L.startup.note),
          startup ? h('div', { className: 'dsh-qc-line', key: 'path' }, `路径：${startup.path || ''} · exists=${String(startup.exists)} · matches=${String(startup.matches)} · port=${startup.port || ''}`) : h('div', { className: 'dsh-qc-line', key: 'path' }, '（未加载）'),
          startup?.registryRunKey ? h('div', { className: 'dsh-qc-line dsh-qc-warn', key: 'reg' }, L.startup.regNote + ` [checked=${startup.registryRunKey.checked} detected=${startup.registryRunKey.detected}]`) : null,
          h('div', { className: 'dsh-qc-btnrow', key: 'btns' }, [
            h('button', { key: 'a', type: 'button', className: 'dsh-qc-btn dsh-qc-btn--primary', disabled: busy, onClick: applyStartup }, L.startup.apply),
            h('button', { key: 'r', type: 'button', className: 'dsh-qc-btn', disabled: busy, onClick: revokeStartup }, L.startup.revoke),
            h('button', { key: 'f', type: 'button', className: 'dsh-qc-btn', disabled: busy, onClick: loadStartup }, L.startup.refresh),
          ]),
        ]),
        h('details', { className: 'dsh-qc-diag', key: 'diag' }, [
          h('summary', { key: 's' }, L.status.diagnosticsSummary),
          h('div', { key: 'd' }, [
            h('div', { key: 'r' }, `${L.status.registryPrefix}${status?.registry ?? L.shell.unknownText}`),
            h('div', { key: 'p' }, `${L.status.probeReasonPrefix}${status?.probe?.reason ?? L.shell.unknownText}`),
            statusError ? h('div', { className: 'dsh-qc-warn', key: 'e' }, statusError) : null,
            status?.probe?.installed === false ? h('div', { className: 'dsh-qc-warn', key: 'm' }, L.status.serviceMissing) : null,
            h('div', { key: 'at' }, `at=${fmtTime(status?.at) || ''}`),
          ]),
        ]),
      ]);

      return h('section', { className: 'dsh-qc-card' + (open ? ' dsh-qc-card--open' : ''), ref: rootRef }, [
        h('header', { className: 'dsh-qc-head', key: 'head' }, [
          h('button', { className: 'dsh-qc-toggle', key: 'toggle', type: 'button', 'aria-expanded': open, 'aria-label': (open ? L.shell.collapse : L.shell.expand) + ': Qoder', onClick: () => setOpen(!open) }, [
            h('span', { key: 'text' }, [
              h('span', { className: 'dsh-qc-title-row', key: 'tr' }, [
                h('span', { className: 'dsh-qc-title', key: 'title' }, 'Qoder'),
                h(StatusBadge, { status, key: 'badge' }),
              ]),
              open ? h('span', { className: 'dsh-qc-desc', key: 'desc' }, L.card.desc) : null,
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
