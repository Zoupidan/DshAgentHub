/**
 * plugin-opencode client bundle 验收测试（设置卡片 v0.1.0）。
 *
 * 测试对象 = **真实产物** `lib/client.js`（不是源代码的副本）：以伪宿主捕获
 * `window.__ModuleLoader__.load` 的注册，再用「hook 运行时」做浅渲染 + 效果回放。
 *
 * ★ 本卡与 WorkBuddy 卡的两个**故意**差异（产物文件头有同名登记，改动前先读那边）：
 *   1. `注册：REGISTERED` / `探测结论：pid-dead` **原样上主视图** —— 本包把这两串定义为
 *      可核对的读数（八步之 1/2 的验收面）。折叠纪律在本包收窄为"本机路径 / 证据逐条 /
 *      各类 id 明细只进折叠"。
 *   2. 审批面（八步之 8）是本包独有：`pendingCount > 0` 时主视图一行醒目警告，点名
 *      `opencode_approvals`（文案由 TOOL_APPROVALS 常量拼出）。
 *
 * 取值口径（本卡自己的投影规则，两个方向都钉住）：
 *   · 总闸 `enabled` **只认**快照（本页写的，快照即真源；不拿载荷回灌）；
 *   · 文本字段：快照字符串优先（含用户清空的 ''），`status.config[name]` 兜底投影；
 *   · `waitTimeoutMs`：快照/载荷里的有限数按序取，都没有 ⇒ 显示空（不发明默认值）。
 *
 * 可证边界（诚实登记，真机项留受控窗口）：
 *   - 可证：模块注册形态 / 卡片注册描述符 / 读路径（configForms 快照 → 树）/ 写路径
 *     （交互回调 → scope.set → 快照变更 → 重渲染）/ 三态徽标与状态区文案 / CSS 去重 / 常量同步。
 *   - 不可证（本文件不假装覆盖）：真机 React 渲染、slot dispatch、设置写穿透到 host 落盘、
 *     桌面端对"经 API 新建的会话"的自动刷新行为（产物内以 `// [待验]` 标注，与本文件同口径）。
 *
 * ★ 本文件属于各包的 test 目录（不在 CI ②/⑤ 的扫描面内），但仍按同一卫生纪律书写：
 *   凭据形状与进程出口字样的**字面量**一律以片段拼出（见文末卫生用例），
 *   免得日后有人把扫描面扩到 test/ 时这份文件先把自己拦下。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HUB_TAB_ID,
  HUB_TAB_ORDER,
  HUB_TAB_SLOT,
  NS,
  PACKAGE_NAME,
  ROUTE_DIAGNOSTICS,
  ROUTE_STATUS,
  TOOL_APPROVALS,
} from '../src/shared/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');
const CLIENT_PATH = join(PACKAGE_DIR, 'lib', 'client.js');
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const CSS_TAG_ID = PACKAGE_NAME + '/ConfigCard.css';

let importNonce = 0;

// ───────────────────────── 伪宿主 ─────────────────────────

/** 伪 React：真 hook 语义的极小子集（cells 跨渲染保留；effect 在 render 后回放，deps 相同则跳过）。 */
function makeFakeReact() {
  const cells = [];
  /** @type {number[]} */
  let scheduled = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(init) {
      const cursor = React.__cursor++;
      if (!(cursor in cells)) cells[cursor] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[cursor];
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next;
        },
      ];
    },
    useEffect(fn, deps) {
      const cursor = React.__cursor++;
      const prev = cells[cursor];
      const same =
        prev !== undefined &&
        Array.isArray(deps) &&
        Array.isArray(prev.deps) &&
        deps.length === prev.deps.length &&
        deps.every((dep, i) => Object.is(dep, prev.deps[i]));
      if (prev === undefined || !same) {
        if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup();
        cells[cursor] = { deps, fn, cleanup: undefined };
        scheduled.push(cursor);
      }
    },
    __cursor: 0,
  };
  return {
    React,
    render(Component, props) {
      React.__cursor = 0;
      return Component(props);
    },
    /** 回放本次渲染排定的 effect（返回其 cleanup 供断言）。 */
    flushEffects() {
      const pending = scheduled;
      scheduled = [];
      for (const cursor of pending) {
        const cell = cells[cursor];
        const cleanup = cell.fn();
        cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      }
    },
  };
}

/** 伪 configForms 面（镜像真机契约：getSnapshot / subscribe / set / unset + 快照字段）。 */
function makeScope(initialValue = {}, { writable = true, status = 'ready' } = {}) {
  let snapshot = {
    status,
    value: { ...initialValue },
    base: {},
    user: {},
    revision: 1,
    writable,
    mode: 'host',
  };
  const listeners = new Set();
  const commits = [];
  let failNextSet = false;
  const commit = (field, value) => {
    snapshot = {
      ...snapshot,
      value: { ...snapshot.value, [field]: value },
      user: { ...snapshot.user, [field]: value },
      revision: snapshot.revision + 1,
    };
    for (const listener of listeners) listener();
  };
  return {
    commits,
    listenerCount: () => listeners.size,
    failNextSet: () => {
      failNextSet = true;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: async (field, value) => {
      commits.push({ op: 'set', field, value });
      if (failNextSet) {
        failNextSet = false;
        throw new Error('settings write failed (fake)');
      }
      commit(field, value);
    },
    unset: async (field) => {
      commits.push({ op: 'unset', field });
      commit(field, undefined);
    },
  };
}

/** 伪 ctx：服务访问守卫（未声明即拒绝 —— 与真机 runner 同款）。 */
function makeGuardedCtx(plugin, { scope, onEffect } = {}) {
  const declared = new Set(plugin.inject);
  const verbs = new Set(['effect', 'on', 'get']);
  const slotsCalls = [];
  const registrations = [];
  const bindSpecs = [];
  const locales = [];
  const real = {
    effect: (fn, label) => {
      const disposer = fn();
      if (onEffect) onEffect({ label, disposer });
      return disposer;
    },
    get: (name) => real[name],
    slots: {
      inject: (name, factory) => {
        slotsCalls.push({ name, factory });
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    // 0.1.7 迁移：`settingsScope` 已消失，配置面改走 `ctx.configForms.get(NS)`；
    // 宿主服务未绑定时 `get()` 返回 undefined（降级路径据此渲染兜底文案）。
    configForms: {
      get: (entryId) => {
        bindSpecs.push({ namespace: entryId });
        return scope;
      },
    },
    // locale 是必需 inject：注册项的 `label` thunk 走 `ctx.locale.bind(NS)` 取值。
    // 用 bundle 自己注册的那份字典解析 ⇒ t 与产物同源。
    locale: {
      bind: (ns) => {
        const entry = locales.find((l) => l.ns === ns);
        const dicts = entry?.dicts ?? {};
        return (key) => {
          for (const lang of Object.keys(dicts)) {
            const group = key.includes('.') ? key.split('.')[0] : null;
            const leaf = group === null ? key : key.slice(group.length + 1);
            const table = dicts[lang][group];
            if (table && Object.hasOwn(table, leaf)) {
              return typeof table[leaf] === 'function' ? table[leaf]() : table[leaf];
            }
            if (Object.hasOwn(dicts[lang], key)) return dicts[lang][key];
          }
          return key;
        };
      },
      register: (ns, dicts) => {
        locales.push({ ns, dicts });
        return () => {};
      },
    },
  };
  const ctx = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (!declared.has(prop) && !verbs.has(prop)) {
          throw new Error(`undeclared service access: ${prop}（须在 plugin.inject 声明）`);
        }
        return real[prop];
      },
    },
  );
  return { ctx, slotsCalls, registrations, bindSpecs };
}

/** 伪 document（仅 CSS 去重所需面）。 */
function makeFakeDocument() {
  const created = [];
  return {
    created,
    head: { appendChild: (tag) => created.push(tag) },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: (selector) => {
      const match = /^style\[data-plugin-css="(?<id>.+)"\]$/.exec(selector);
      if (match === null) return null;
      const id = match.groups.id;
      return created.find((tag) => tag.dataset.pluginCss === id) ?? null;
    },
  };
}

// ───────────────────────── 载荷夹具（字段名 = 契约，见 src/host/types/index.js） ─────────────────────────

/**
 * 探测结果夹具（`StatusPayload.probe`）。
 *
 * ⚠️ `baseUrl` 用 `…:51234`，与上方表单 hint 里的**示例地址**（`…:49374`）刻意不同：
 * 这样"主视图不得出现载荷地址 / 折叠里必须可核对"两条断言互相独立，不会因为
 * 某处出现一个 127.0.0.1 就被含糊带过。
 */
function probePayload(overrides = {}) {
  return {
    installed: true,
    reason: 'ok',
    servicePath: 'C:/Users/example/.local/state/opencode/service.json',
    baseUrl: 'http://127.0.0.1:51234',
    version: '2.0.28',
    pid: 4321,
    evidence: [
      { at: 1, method: 'read-only', target: 'C:/Users/example/.local/state/opencode/service.json', detail: '命中 service.json（含 url）' },
      { at: 1, method: 'read-only', target: 'PID 4321', detail: '进程存活' },
    ],
    at: 2,
    method: 'read-only',
    ...overrides,
  };
}

/**
 * 状态载荷夹具（`StatusPayload`）。
 *
 * ★ 三态计费目录刻意给全三态：m1 免费 / m2 付费 / m3 **计费未知**（`isFree === null`）
 *   —— 后者是判别点：任何把 null 折进免费或付费的写法都会让 `（计费未知）` 断言变红。
 */
function statusPayload(overrides = {}) {
  const base = {
    pluginId: 'plugin-opencode',
    registry: 'REGISTERED',
    probe: probePayload(),
    config: {
      enabled: true,
      model: 'local/m1',
      variant: 'low',
      workspace: 'C:/Users/example/projects/demo',
      boundSessionId: 'ses_bound01',
      serviceDir: 'C:/Users/example/.config/opencode',
      baseUrl: 'http://127.0.0.1:51234',
      waitTimeoutMs: 900000,
    },
    variant: { model: 'local/m1', values: ['auto', 'low', 'high'], source: 'service' },
    models: [
      { id: 'm1', providerID: 'local', label: 'Local One', variants: ['auto', 'low', 'high'], isFree: true, status: 'ready', enabled: true },
      { id: 'm2', providerID: 'remote', label: 'Remote Two', variants: ['auto'], isFree: false, status: 'ready', enabled: true },
      { id: 'm3', providerID: 'remote', label: 'Remote Three', variants: [], isFree: null, status: 'ready', enabled: true },
    ],
    modelsSource: 'service',
    inFlight: [],
    lastRun: null,
    approvals: { pendingCount: 0, items: [] },
    at: 3,
  };
  return { ...base, ...overrides };
}

/** `LastRunRecord` 夹具（成功轮；缺字段/异常分支由用例逐条覆盖）。 */
function lastRunPayload(overrides = {}) {
  return {
    sessionId: 'ses_run01',
    sessionKey: 'demo-key',
    resumed: true,
    promptExcerpt: '把 README 的标题改掉',
    delivery: 'queue',
    acceptedAt: 1727846400000,
    idleAt: 1727846500000,
    waitStatus: 'idle-204',
    outcome: 'succeeded',
    reply: '已改好：README 标题更新为「演示」',
    permissionRequests: [],
    model: { id: 'm1', providerID: 'local', variant: 'low' },
    cost: 0.1234,
    tokens: { input: 10, output: 20, reasoning: 5 },
    reasonCode: 'ok',
    reasonText: '',
    reasonEvidence: '',
    at: 1727846500000,
    ...overrides,
  };
}

/**
 * 在受控全局环境下加载 bundle 并捕获注册（**不**保留全局覆盖；只适合不需要回放 effect 的用例）。
 * @param {{ document?: object, fetch?: Function }} env
 */
async function withBundle(env, fn) {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  if (env.document !== undefined) globalThis.document = env.document;
  else delete globalThis.document;
  if (env.fetch !== undefined) globalThis.fetch = env.fetch;
  try {
    await import(pathToFileURL(CLIENT_PATH).href + '?case=' + String(++importNonce));
    assert.ok(captured !== null, 'bundle 必须经 window.__ModuleLoader__.load 注册');
    return await fn(captured);
  } finally {
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
  }
}

/**
 * 伪 primitives（seed 模块之一）；图标渲染为可断言的 svg 节点。
 *
 * ★ 两条硬约束（沿用 WorkBuddy 的事故复盘）：① 只镜像真机**同名**成员 ——
 *   `IconChevronDownOutlineRegular`（`…14` 不存在，写错会让 h(undefined) 在渲染期抛错
 *   → 被宿主边界吞成白卡）；② 读未知成员立刻抛错，名字对不上时测试必红。
 */
function makeFakePrimitives(React) {
  const { createElement: h } = React;
  const exportsTable = {
    IconChevronDownOutlineRegular: (props) =>
      h('svg', {
        className: 'fake-primitives-icon-chevron-down-regular',
        'data-size': props && props.size,
        'aria-hidden': 'true',
      }),
  };
  return new Proxy(exportsTable, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return target[prop];
      if (!Object.prototype.hasOwnProperty.call(target, prop)) {
        throw new Error(
          `primitives.${String(prop)} 在真机导出表里不存在（伪件只镜像真机成员；` +
            '新增成员前先核对 primitives/lib/index.js 的导出表）',
        );
      }
      return target[prop];
    },
  });
}

function makeRequire(React) {
  const requested = [];
  const primitives = makeFakePrimitives(React);
  const fakeRequire = (name) => {
    requested.push(name);
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`require("${name}") missed the module table（白名单仅 9 个 seed）`);
  };
  return { fakeRequire, requested, primitives };
}

/** 展开函数组件后的全树搜集（子组件均为纯函数，可安全调用；嵌套数组展平）。 */
function collect(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 60) return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') {
    if (typeof node === 'string' || typeof node === 'number') visit(node);
    return;
  }
  visit(node);
  if (typeof node.type === 'function') {
    collect(node.type(node.props), visit, depth + 1);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collect(child, visit, depth + 1);
  }
  if (node.props !== null && node.props !== undefined) {
    for (const value of Object.values(node.props)) {
      if (value !== null && typeof value === 'object') collect(value, visit, depth + 1);
    }
  }
}

function findAll(tree, predicate) {
  const found = [];
  collect(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function textOf(tree) {
  const parts = [];
  collect(tree, (node) => {
    if (typeof node === 'string') parts.push(node);
    else if (typeof node === 'number') parts.push(String(node));
  });
  return parts.join('|');
}

/**
 * 主视图文本：`textOf` 减去**所有折叠子树**（`<details>` 整体跳过，含其 summary）。
 * 折叠纪律的判定口径：折叠内的字符串在 `mainText()` 里必须缺席、在 `foldText()` 里必须出现。
 */
function mainText(tree) {
  const parts = [];
  const walk = (node, inDetails, depth = 0) => {
    if (node === null || node === undefined || depth > 60) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inDetails, depth + 1);
      return;
    }
    if (typeof node !== 'object') {
      if (!inDetails && (typeof node === 'string' || typeof node === 'number')) parts.push(String(node));
      return;
    }
    const isDetails = node.type === 'details';
    const inside = inDetails || isDetails;
    if (typeof node.type === 'function') {
      walk(node.type(node.props), inside, depth + 1);
      return;
    }
    if (node.type === 'summary' && !inDetails) {
      // summary 是折叠的"门"（可见但属折叠内容的一部分）：主视图不取它，折叠文本取它。
      if (Array.isArray(node.children)) for (const child of node.children) walk(child, false, depth + 1);
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, inside, depth + 1);
    }
    if (node.props !== null && node.props !== undefined) {
      for (const value of Object.values(node.props)) {
        if (value !== null && typeof value === 'object') walk(value, inside, depth + 1);
      }
    }
  };
  walk(tree, false);
  return parts.join('|');
}

/** 折叠文本：所有 `<details>` 子树（含其 summary）的文本。 */
function foldText(tree) {
  const details = findAll(tree, (n) => n.type === 'details');
  return details.map((d) => textOf(d)).join('||');
}

/** 元素自身子文本（伪 createElement 把 variadic children 存于 node.children）。 */
function labelText(node) {
  return Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join('') : '';
}

/**
 * 起一套完整宿主：注册（apply）→ 卡片 props（inject 面）→ 渲染。
 *
 * ⚠️ 与 withBundle 不同，boot 会在**整个用例生命周期内**保留全局覆盖（fetch 在 effect 回放时
 *    才被调用 ⇒ 不能在导入后立即还原）；每次 boot 覆盖上一例，进程随测试结束退出。
 */
async function boot({ scopeValue = {}, scopeOptions = {}, status = statusPayload(), fetchImpl } = {}) {
  const runtime = makeFakeReact();
  const scope = makeScope(scopeValue, scopeOptions);
  const fetches = [];
  const fetchFn =
    fetchImpl ??
    (async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, status: 200, json: async () => status };
    });
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  globalThis.document = makeFakeDocument();
  globalThis.fetch = fetchFn;
  await import(pathToFileURL(CLIENT_PATH).href + '?case=' + String(++importNonce));
  assert.ok(captured !== null, 'bundle 必须经 window.__ModuleLoader__.load 注册');

  const { fakeRequire, requested } = makeRequire(runtime.React);
  const plugin = captured.factory(fakeRequire);
  const effects = [];
  const host = makeGuardedCtx(plugin, { scope, onEffect: (e) => effects.push(e) });
  plugin.apply(host.ctx);
  const slotCall = host.slotsCalls[0];
  slotCall.factory(); // 槽已声明 ⇒ 工厂触发注册（真机由 slots.inject 在声明期回调）
  const registrationEntry = host.registrations[0];
  /**
   * 注册项**不带 `inject`** —— 宿主渲染处只递空 props（2026-10-15 hub 合并后壳以
   * `renderSlot(HUB_TAB_SLOT, {}, { only: 标签id })` 渲染；`settings.section` 时代只递 `{ close }`），
   * 配置面（scope）由**闭包**注入组件。这里照真机传空 props；
   * 若日后注册项真带上 `inject`，优先采用它（两种都合规）。
   */
  const cardProps =
    typeof registrationEntry.options.inject === 'function'
      ? registrationEntry.options.inject()
      : { close: () => {} };
  const render = () => runtime.render(registrationEntry.component, cardProps);
  /** 幂等展开（默认已展开 ⇒ 退化为纯 render，同时充当"折叠头必须存在"的断言）。 */
  const expand = () => {
    const tree = render();
    const toggle = findAll(tree, (n) => n.type === 'button' && n.props.className === 'dsh-oc-card__toggle')[0];
    assert.ok(toggle !== undefined, '卡片必须渲染折叠头（dsh-oc-card__toggle）');
    if (toggle.props['aria-expanded'] === true) return tree;
    toggle.props.onClick();
    return render();
  };
  return {
    registration: captured,
    plugin,
    requested,
    runtime,
    scope,
    fetches,
    host,
    slotCall,
    registrationEntry,
    cardProps,
    render,
    expand,
    flushEffects: () => runtime.flushEffects(),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 载荷 → 展开后的卡片（沿用既有 boot + effect 回放机制，不另造渲染入口）。 */
async function bootFromStatus(statusOverrides, { scopeValue = {} } = {}) {
  const app = await boot({ scopeValue, status: statusPayload(statusOverrides) });
  app.expand();
  app.flushEffects();
  await settle();
  return app;
}

/** 卡片里的字段输入（按 id 取；不渲染则断言失败）。 */
function fieldInput(app, id) {
  const input = findAll(app.expand(), (n) => n.type === 'input' && n.props.id === id)[0];
  assert.ok(input !== undefined, `字段 ${id} 必须渲染`);
  return input;
}

/** 字段当前回显值。 */
function fieldValue(app, id) {
  return fieldInput(app, id).props.value;
}

/** 模型下拉的 option 节点（含 value='' 的哨兵项）。 */
function modelOptionNodes(tree) {
  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-oc-model-catalog')[0];
  assert.ok(select !== undefined, '模型候选下拉必须渲染');
  return findAll(select, (n) => n.type === 'option');
}

/** 取 value=ref 的 option 文本。 */
function optionText(tree, ref) {
  const node = modelOptionNodes(tree).find((o) => o.props.value === ref);
  assert.ok(node !== undefined, `必须存在 value=${ref} 的 option`);
  return labelText(node);
}

// ───────────────────────── 判据 + 组成前提 ─────────────────────────

test('组成前提：bundle id = 包名，dsh.client.platform=web，exports["./client"] 文件真实存在', async () => {
  await withBundle({}, async (registration) => {
    assert.equal(registration.id, PACKAGE_JSON.name, 'load id 必须 === package.json name（对不上即抛 "loaded without registering"）');
    assert.equal(registration.id, PACKAGE_NAME);
    assert.equal(PACKAGE_JSON.dsh.client.platform, 'web', 'platform !== web 会被静默跳过');
    const clientRel = PACKAGE_JSON.exports['./client'];
    assert.equal(typeof clientRel, 'string');
    assert.ok(existsSync(join(PACKAGE_DIR, clientRel)), 'exports["./client"] 指向的文件必须存在（缺失 = 启动期 loud 失败）');
    assert.ok(PACKAGE_JSON.files.includes(clientRel.replace(/^\.\//, '')), 'files 白名单必须含 client 产物');
    assert.deepEqual(PACKAGE_JSON.dsh.client.inject, [
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
    ]);
  });
});

test('判据①：★ 卡片注册进「Harness 接入」子槽 settings.harness-hub.tab（2026-10-15 hub 合并）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    const plugin = registration.factory(fakeRequire);
    const scope = makeScope();
    const host = makeGuardedCtx(plugin, { scope });
    plugin.apply(host.ctx);

    assert.equal(host.slotsCalls.length, 1);
    // ★ 2026-10-15 hub 合并：设置导航栏不再由本包占独立条目 —— 父条目「Harness 接入」
    //   由 dsh-plugin-harness-hub 注册（settings.section，id=harness-hub），本条注册进它的
    //   子标签槽。槽未声明时注册会抛 SlotCore 的 "not declared" ⇒ 必须走 slots.inject。
    assert.equal(host.slotsCalls[0].name, HUB_TAB_SLOT, '必须挂「Harness 接入」的子标签槽');
    assert.equal(host.bindSpecs.length, 1);
    assert.deepEqual(host.bindSpecs[0], { namespace: NS }, 'configForms.get 必须用与 loader 行 id 相同的 namespace');

    await host.slotsCalls[0].factory();
    assert.equal(host.registrations.length, 1);
    const { options } = host.registrations[0];
    assert.equal(options.name, HUB_TAB_SLOT);
    assert.equal(options.id, HUB_TAB_ID, '标签 id 必须是短名 opencode（与 workbuddy 区分）');
    assert.equal(options.order, HUB_TAB_ORDER, '标签位次必须是 20（标签行顺序 WorkBuddy → OpenCode）');
    assert.equal(typeof options.label, 'function', '★ label 必须是 thunk：壳在读取时才求值');
    assert.equal(options.label(), 'OpenCode', 'label thunk 必须真的求得出字符串（否则标签行里是空标题）');
    assert.equal(options.locale, NS, '★ locale 选项决定 t 从哪个命名空间解析（slot renderer 不注入 locale prop）');
    assert.equal(options.inject, undefined, '★ 子标签槽不收 inject：壳只递空 props，配置面走闭包');
    assert.equal(typeof host.registrations[0].component, 'function');

    const runtime = makeFakeReact();
    const tree = runtime.render(host.registrations[0].component, { close: () => {} });
    assert.ok(!textOf(tree).includes('设置服务不可用'), '★ 闭包必须已绑定 scope：掉进降级分支 = 配置面没接上');
  });
});

test('service 声明守卫：apply 只触达声明过的服务（未声明即抛，镜像真机 guard）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    const plugin = registration.factory(fakeRequire);
    // ★ 这条判据是**启动级**的：inject 是硬依赖门限，少一个服务不是"这插件不显示"，
    //   而是 web boot 完整性校验失败 ⇒ 整个 DSH 起不来（2026-10-01 真机事故同款）。
    assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms']);
    assert.equal(typeof plugin.apply, 'function');
    const host = makeGuardedCtx(plugin, { scope: makeScope() });
    assert.doesNotThrow(() => plugin.apply(host.ctx), 'apply 触达未声明服务会被守卫拒绝');
  });
});

test('require 白名单：factory 只 require("react") + primitives（均为 seed 表内模块）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire, requested } = makeRequire(makeFakeReact().React);
    assert.doesNotThrow(() => registration.factory(fakeRequire));
    assert.deepEqual([...new Set(requested)].sort(), [
      '@deepseek-ai/dsh-client-ui-primitives',
      'react',
    ]);
  });
});

test('常量同步：bundle 内常量与 src/shared/constants.js 逐字对齐（不允许各写一份）', async () => {
  const text = readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(text.includes("const PACKAGE_NAME = '" + PACKAGE_NAME + "'"));
  assert.ok(text.includes("const ROUTE_STATUS = '" + ROUTE_STATUS + "'"), '状态 bridge 路由必须与共享常量逐字一致');
  // ★ 2026-10-15 hub 合并：子槽名/标签 id/位次必须与共享常量逐字一致（bundle 手写一份）。
  assert.ok(text.includes("const HUB_TAB_SLOT = '" + HUB_TAB_SLOT + "'"), '子槽名必须与共享常量逐字一致');
  assert.ok(text.includes("const HUB_TAB_ID = '" + HUB_TAB_ID + "'"), '标签 id 必须与共享常量逐字一致');
  assert.ok(text.includes('const HUB_TAB_ORDER = ' + HUB_TAB_ORDER + ';'), '标签位次必须与共享常量一致');
  assert.ok(text.includes("const ROUTE_DIAGNOSTICS = '" + ROUTE_DIAGNOSTICS + "'"), '诊断接口必须与共享常量逐字一致');
  assert.ok(text.includes("const TOOL_APPROVALS = '" + TOOL_APPROVALS + "'"), '审批工具名必须与共享常量逐字一致');
  assert.ok(text.includes('const NS = PACKAGE_NAME'), 'NS 必须与包名同源（行 id 判据：对不上则 settings.update 被拒）');
});

// ───────────────────────── 判据②：配置面读写 ─────────────────────────

test('判据②a：总闸开关读写 —— 快照 → 树；交互 → scope.set → 快照变更 → 重渲染', async () => {
  const app = await boot({ scopeValue: { enabled: false } });
  app.expand();
  app.flushEffects();
  await settle();
  let tree = app.expand();

  const switchOf = (t) => findAll(t, (n) => n.type === 'input' && n.props.className === 'dsh-oc-switch')[0];
  assert.equal(switchOf(tree).props.checked, false, '快照 false ⇒ 开关关闭');
  assert.equal(switchOf(tree).props.disabled, false);

  switchOf(tree).props.onChange(); // 用户拨 ON
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'enabled', value: true });
  assert.equal(app.scope.getSnapshot().value.enabled, true);

  tree = app.expand();
  assert.equal(switchOf(tree).props.checked, true, '写后 bridge 应反映新值（不做本地乐观改写）');

  switchOf(tree).props.onChange(); // 再拨 OFF
  await settle();
  assert.deepEqual(app.scope.commits[1], { op: 'set', field: 'enabled', value: false });
});

test('判据②b：总闸置灰只看可写性 —— 服务缺失**不**禁用开关（"开了但服务没起来"是合法状态）', async () => {
  const app = await boot({
    status: statusPayload({
      registry: 'SERVICE_MISSING',
      probe: probePayload({ installed: false, reason: 'service-missing', servicePath: '', baseUrl: '', version: '', pid: null, evidence: [] }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const input = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-oc-switch')[0];
  assert.equal(input.props.disabled, false, '★ 服务缺失不是"不可写"—— 禁用会让用户没法提前配好');
  assert.ok(mainText(tree).includes('○ 服务缺失'), '徽标仍需如实说服务缺失');
});

test('判据②c：门控 = 快照 ready **且** writable —— 任一不满足 ⇒ 全控件置灰 + 只读文案', async () => {
  for (const [label, scopeOptions] of [
    ['status=unavailable + writable=false', { status: 'unavailable', writable: false }],
    ['status=ready + writable=false', { status: 'ready', writable: false }],
    ['status=unavailable + writable=true（真机可达）', { status: 'unavailable', writable: true }],
  ]) {
    const app = await boot({ scopeOptions });
    app.expand();
    app.flushEffects();
    await settle();
    const tree = app.expand();
    const input = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-oc-switch')[0];
    assert.equal(input.props.disabled, true, `${label} ⇒ 开关必须置灰`);
    const selects = findAll(tree, (n) => n.type === 'select');
    assert.equal(selects.length, 1);
    assert.ok(selects.every((s) => s.props.disabled === true), `${label} ⇒ 模型下拉必须置灰`);
    const text = textOf(tree);
    if (scopeOptions.status === 'unavailable') {
      assert.ok(text.includes('不可用（设置服务未连接）'), '设置读取态如实说不可用');
    }
    if (scopeOptions.writable === false) {
      assert.ok(text.includes(' · 只读，当前页面无法保存'), '只读文案必须上屏（用户查得到为什么点不动）');
    }
  }
});

test('取值口径：文本字段快照优先（含清空的 \'\'）、payload.config 兜底；enabled 只认快照', async () => {
  // ① 空快照 ⇒ 全部由 status.config 投影（设置服务还没读到值时，用户也能看到生效配置）
  const projected = await boot({ scopeValue: {} });
  projected.expand();
  projected.flushEffects();
  await settle();
  assert.equal(fieldValue(projected, 'dsh-oc-model'), 'local/m1');
  assert.equal(fieldValue(projected, 'dsh-oc-variant'), 'low');
  assert.equal(fieldValue(projected, 'dsh-oc-workspace'), 'C:/Users/example/projects/demo');
  assert.equal(fieldValue(projected, 'dsh-oc-bound-session'), 'ses_bound01');
  assert.equal(fieldValue(projected, 'dsh-oc-service-dir'), 'C:/Users/example/.config/opencode');
  assert.equal(fieldValue(projected, 'dsh-oc-base-url'), 'http://127.0.0.1:51234');
  assert.equal(fieldValue(projected, 'dsh-oc-wait-timeout'), '900000');

  // ② 快照有值（含显式 ''）⇒ 快照优先，载荷不得回灌用户清空/改过的字段
  const snapFirst = await boot({
    scopeValue: { workspace: '', variant: 'high', boundSessionId: 'ses_me02', waitTimeoutMs: 1000 },
  });
  snapFirst.expand();
  snapFirst.flushEffects();
  await settle();
  assert.equal(fieldValue(snapFirst, 'dsh-oc-workspace'), '', '★ 用户清空的字段不得被载荷回灌');
  assert.equal(fieldValue(snapFirst, 'dsh-oc-variant'), 'high');
  assert.equal(fieldValue(snapFirst, 'dsh-oc-bound-session'), 'ses_me02');
  assert.equal(fieldValue(snapFirst, 'dsh-oc-wait-timeout'), '1000', '快照有限数优先于载荷');
  assert.equal(fieldValue(snapFirst, 'dsh-oc-service-dir'), 'C:/Users/example/.config/opencode', '未在快照里的字段仍走载荷投影');
});

test('判据②d：模型行 —— 目录三态计费标签（null 不得折进免费/付费）+ 哨兵 + 说明行', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();

  const options = modelOptionNodes(tree);
  assert.deepEqual(
    options.map((o) => o.props.value),
    ['', 'local/m1', 'remote/m2', 'remote/m3'],
    '★ 目录 3 条 ⇒ 下拉必须有 3 条（+1 个哨兵行），一条不少',
  );
  assert.equal(labelText(options[0]), '未固定（用服务默认）');
  assert.equal(optionText(tree, 'local/m1'), 'local/m1（免费）');
  assert.equal(optionText(tree, 'remote/m2'), 'remote/m2（付费）');
  assert.equal(optionText(tree, 'remote/m3'), 'remote/m3（计费未知）', '★ isFree === null 走"计费未知"，不折进免费/付费任一侧');
  assert.notEqual(optionText(tree, 'remote/m3'), optionText(tree, 'local/m1'), '未知与免费必须是两句可区分的话');
  assert.notEqual(optionText(tree, 'remote/m3'), optionText(tree, 'remote/m2'), '未知与付费同样必须可区分');
  assert.equal(options.every((o) => o.props.disabled !== true), true, '计费标签是标注，不是门禁（任何候选都不得 disabled）');
  assert.ok(textOf(tree).includes('格式 providerID/id'), '说明行必须讲清值形态与留空语义');
  assert.ok(findAll(tree, (n) => n.type === 'input' && n.props.id === 'dsh-oc-model').length === 1, '文本框（真源）与下拉并存');
});

test('判据②e：当前模型不在候选目录 ⇒ 附加"（不在候选目录）"项，不丢用户设置、不静默改写', async () => {
  const app = await boot({ scopeValue: { model: 'ghost/model-7' } });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();

  assert.deepEqual(
    modelOptionNodes(tree).map((o) => o.props.value),
    ['', 'ghost/model-7', 'local/m1', 'remote/m2', 'remote/m3'],
    '★ 当前值必须占一行（附加项），目录条目同样一条不少',
  );
  assert.equal(optionText(tree, 'ghost/model-7'), 'ghost/model-7（不在候选目录）', '既不假装在目录里，也不丢用户设置');
  const select = findAll(tree, (n) => n.type === 'select' && n.props.id === 'dsh-oc-model-catalog')[0];
  assert.equal(select.props.value, 'ghost/model-7');
  assert.equal(app.scope.commits.length, 0, '显示层不得改写设置');
});

test('判据②f：模型写入 —— 文本框手输与下拉投递都走 scope.set；写后回显新值', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();

  const input = fieldInput(app, 'dsh-oc-model');
  input.props.onChange({ target: { value: 'remote/m2' } });
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'model', value: 'remote/m2' });

  const select = findAll(app.expand(), (n) => n.type === 'select' && n.props.id === 'dsh-oc-model-catalog')[0];
  assert.equal(select.props.value, 'remote/m2', '写后下拉回显新值（快照是唯一回显来源）');
  select.props.onChange({ target: { value: '' } });
  await settle();
  assert.deepEqual(app.scope.commits[1], { op: 'set', field: 'model', value: '' }, '哨兵项 = 回到"未固定"');
});

test('判据②g：推理档位行 —— 候选提示来自载荷 variant.values；空候选不印空行；写回 scope', async () => {
  const withValues = await boot({});
  withValues.expand();
  withValues.flushEffects();
  await settle();
  const tree = withValues.expand();
  const row = findAll(tree, (n) => n.type === 'div' && String(n.props.className).includes('dsh-oc-row--variant'))[0];
  assert.ok(row !== undefined, '档位行必须渲染');
  assert.ok(textOf(row).includes('可用档位：auto、low、high'), '候选来自服务实况（variant.values）');
  const input = fieldInput(withValues, 'dsh-oc-variant');
  assert.equal(input.props.placeholder, '留空 = 模型默认档');
  input.props.onChange({ target: { value: 'high' } });
  await settle();
  assert.deepEqual(withValues.scope.commits[0], { op: 'set', field: 'variant', value: 'high' });

  const empty = await boot({
    status: statusPayload({ variant: { model: '', values: [], source: 'unavailable:no-model' } }),
  });
  empty.expand();
  empty.flushEffects();
  await settle();
  assert.equal(textOf(empty.expand()).includes('可用档位：'), false, '★ 空候选不印一句空的"可用档位："（宁可少一行）');
});

test('判据②h：其余四个文本字段的写回 —— 交互 → scope.set(字段, 原样值)', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();

  const cases = [
    ['dsh-oc-workspace', 'workspace', 'C:/Users/example/projects/other'],
    ['dsh-oc-bound-session', 'boundSessionId', 'ses_next01'],
    ['dsh-oc-service-dir', 'serviceDir', 'D:/opencode-state'],
    ['dsh-oc-base-url', 'baseUrl', 'http://127.0.0.1:59000'],
  ];
  for (const [id, field, value] of cases) {
    fieldInput(app, id).props.onChange({ target: { value } });
    await settle();
    assert.deepEqual(app.scope.commits.at(-1), { op: 'set', field, value }, `${id} ⇒ ${field}`);
  }
});

test('判据②i：等待上限 —— 只回写有限非负整数；非法输入只提示（不动设置树）', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();

  const input = fieldInput(app, 'dsh-oc-wait-timeout');
  assert.equal(input.props.type, 'number');
  input.props.onChange({ target: { value: '1500' } });
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'waitTimeoutMs', value: 1500 });
  assert.equal(typeof app.scope.getSnapshot().value.waitTimeoutMs, 'number', '写进设置树的必须是数，不是字符串');
  assert.equal(fieldValue(app, 'dsh-oc-wait-timeout'), '1500', '写后回显');

  input.props.onChange({ target: { value: '' } });
  await settle();
  assert.equal(app.scope.commits.length, 1, '空串不是回写理由（不把 NaN 写进设置树）');
  let toast = findAll(app.render(), (n) => n.props && n.props.className === 'dsh-oc-toast')[0];
  assert.ok(toast !== undefined && labelText(toast).includes('不是有效数字，未保存'));

  input.props.onChange({ target: { value: '-5' } });
  await settle();
  assert.equal(app.scope.commits.length, 1, '负数同样不回写（等待上限没有负值语义）');
});

// ───────────────────────── 判据④：三态徽标与状态区 ─────────────────────────

test('判据④a：三态徽标之"已就绪" —— REGISTERED / UNREGISTERED / DEGRADED 都是"服务在"', async () => {
  for (const registry of ['REGISTERED', 'UNREGISTERED', 'DEGRADED']) {
    const app = await boot({ status: statusPayload({ registry }) });
    app.expand();
    app.flushEffects();
    await settle();
    const tree = app.expand();
    assert.ok(mainText(tree).includes('● 已就绪'), `${registry} ⇒ ● 已就绪`);
    const badge = findAll(tree, (n) => n.type === 'span' && String(n.props.className).startsWith('dsh-oc-badge'))[0];
    assert.ok(String(badge.props.className).includes('dsh-oc-badge--ready'), `${registry} ⇒ badge slug = ready`);
  }
});

test('判据④b：服务缺失判定 —— SERVICE_MISSING 或 probe.installed===false（探测结论优先于注册文字）', async () => {
  const cases = [
    ['registry=SERVICE_MISSING（探测在）', statusPayload({ registry: 'SERVICE_MISSING' })],
    ['registry=REGISTERED 但探测说没装', statusPayload({ probe: probePayload({ installed: false, reason: 'service-missing' }) })],
  ];
  for (const [label, status] of cases) {
    const app = await boot({ status });
    app.expand();
    app.flushEffects();
    await settle();
    const tree = app.expand();
    const main = mainText(tree);
    assert.ok(main.includes('○ 服务缺失'), `${label} ⇒ ○ 服务缺失`);
    assert.ok(
      main.includes('本机没找到可用的 OpenCode 服务（service.json 未命中或已失效）—— 先启动 OpenCode 桌面端，再点刷新。'),
      '服务缺失必须给一句可执行的话（唯一动作：把桌面端打开）',
    );
    const badge = findAll(tree, (n) => n.type === 'span' && String(n.props.className).startsWith('dsh-oc-badge'))[0];
    assert.ok(String(badge.props.className).includes('dsh-oc-badge--service-missing'));
    const input = findAll(tree, (n) => n.type === 'input' && n.props.className === 'dsh-oc-switch')[0];
    assert.equal(input.props.disabled, false, '服务缺失不禁用总闸（可提前配好）');
  }
});

test('判据④c：不认识的 registry ⇒ 徽标"未探测"（没证据就不宣称已就绪），原样读数仍可核对', async () => {
  const app = await boot({ status: statusPayload({ registry: 'PARTIAL_REGISTRATION' }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  assert.ok(main.includes('… 未探测'), '未知 registry ⇒ 三态之"未探测"');
  assert.ok(main.includes('注册：PARTIAL_REGISTRATION'), '★ 本包口径：原样读数上主视图（可核对），判定与显示分离');
  const badge = findAll(tree, (n) => n.type === 'span' && String(n.props.className).startsWith('dsh-oc-badge'))[0];
  assert.ok(String(badge.props.className).includes('dsh-oc-badge--unknown'));
});

test('状态读数：注册/探测结论原样上主视图；本机路径、候选地址与证据逐条只进折叠', async () => {
  const app = await boot({ status: statusPayload({ probe: probePayload({ reason: 'pid-dead' }) }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);

  assert.ok(main.includes('注册：REGISTERED'));
  assert.ok(main.includes('探测结论：pid-dead'), '★ 本包口径：探测结论（可核对读数）上主视图');

  // 折叠纪律（本包收窄版）：本机路径 / 地址明细 / 证据逐条只进折叠。
  assert.equal(main.includes('C:/Users/example/.local/state/opencode/service.json'), false, '★ 本机路径不得出现在主视图');
  assert.equal(main.includes('http://127.0.0.1:51234'), false, '★ 载荷地址不得出现在主视图');
  assert.ok(fold.includes('探测路径：C:/Users/example/.local/state/opencode/service.json'));
  assert.ok(fold.includes('服务地址：http://127.0.0.1:51234'));
  assert.ok(fold.includes('服务版本：2.0.28'));
  assert.ok(fold.includes('服务 PID：4321'));
  assert.ok(fold.includes('C:/Users/example/.local/state/opencode/service.json · 命中 service.json（含 url）'), '证据逐条（target · detail）');
  assert.ok(fold.includes('PID 4321 · 进程存活'));
  // 正控：主视图并非"见地址就藏"（表单 hint 里的示例地址就在主视图）——上方两条否定断言才有判别力。
  assert.ok(main.includes('http://127.0.0.1:49374'), '正控：示例地址在主视图（那是给用户的填写示例）');
});

test('状态块：设置读取态三值 + 只读文案；未知枚举说"未知"（不把机器标识符印上卡）', async () => {
  const ready = await boot({});
  ready.expand();
  ready.flushEffects();
  await settle();
  assert.ok(mainText(ready.expand()).includes('设置：已就绪'));

  const readonly = await boot({ scopeOptions: { status: 'unavailable', writable: false } });
  readonly.expand();
  readonly.flushEffects();
  await settle();
  const readonlyText = textOf(readonly.expand());
  assert.ok(readonlyText.includes('设置：不可用（设置服务未连接）'));
  assert.ok(readonlyText.includes(' · 只读，当前页面无法保存'));

  const weird = await boot({ scopeOptions: { status: 'warming_up' } });
  weird.expand();
  weird.flushEffects();
  await settle();
  const weirdText = textOf(weird.expand());
  assert.ok(weirdText.includes('设置：未知'), '★ 表外枚举一律说"未知"');
  assert.equal(weirdText.includes('warming_up'), false, '★ 机器标识符不得上屏（含折叠）');
});

test('判据④d：载荷未到达 ⇒ 单个加载骨架（不编造任务/审批行；徽标"未探测"）', async () => {
  const app = await boot({ fetchImpl: async () => new Promise(() => {}) }); // 永不 settle
  app.expand();
  app.flushEffects();
  const tree = app.render();
  assert.equal(
    findAll(tree, (n) => n.type === 'div' && n.props.className === 'dsh-oc-skeleton').length,
    1,
    '★ 加载态必须是**单个**骨架占位',
  );
  assert.equal(findAll(tree, (n) => n.type === 'select').length, 0, '骨架态不渲染任何下拉（不各自报"读取中"）');
  assert.equal(
    findAll(tree, (n) => String(n.props?.className ?? '').includes('dsh-oc-task')).length,
    0,
    '载荷未到达 ⇒ 任务块不渲染（不编造任何一行）',
  );
  assert.ok(mainText(tree).includes('… 未探测'), '未确认前徽标保持"未探测"（不打扰用户，也不虚报）');
});

test('降级路径：状态路由不可达 ⇒ 显式错误文案（不把失败当数据）；审批面说"读取中"', async () => {
  const app = await boot({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  assert.ok(main.includes('状态读取失败：status HTTP 500'), '★ 路由失败必须显式上屏');
  assert.ok(main.includes('运行状态：读取中…'), '状态块未拿到载荷 ⇒ 如实说读取中');
  assert.ok(main.includes('审批：读取中'), '★ 载荷没到达 ≠ 没有待审批（把"不知道"说成"没事"是谎报）');
  assert.equal(main.includes('审批：无待处理'), false);
  assert.equal(main.includes('暂无下发记录'), false, '载荷未到达 ≠ 没有下发记录（两个"空"不是一回事）');
  assert.equal(foldText(tree).includes('诊断接口'), false, '载荷未到达 ⇒ 诊断折叠不画（避免半张表）');
});

test('状态 bridge 调用面：同源相对路径 + AbortSignal；刷新按钮只重拉状态、不碰配置', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  assert.equal(app.fetches.length, 1);
  assert.equal(app.fetches[0].url, ROUTE_STATUS, '必须走共享常量里的同源相对路径');
  assert.ok(app.fetches[0].options.signal instanceof AbortSignal, '必须带中止信号（竞态下过期响应要能被放弃）');

  const button = findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-oc-card__refresh')[0];
  assert.equal(labelText(button), '刷新状态');
  assert.equal(button.props.title, '重新拉取运行状态（不改配置）', '★ 按钮必须明确"只重拉状态，不碰配置"');
  button.props.onClick();
  app.expand();
  app.flushEffects();
  await settle();
  assert.equal(app.fetches.length, 2, '刷新必须重新拉取状态');
  assert.equal(app.scope.commits.length, 0, '★ 刷新不得触发任何设置写入');
});

test('R1 补强：stale 响应竞态 —— 刷新后旧响应不得覆盖新值', async () => {
  let resolveSecond = null;
  const second = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  let calls = 0;
  const app = await boot({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => statusPayload({ registry: 'REGISTERED' }) };
      }
      if (calls === 2) {
        const payload = await second; // 第二次：慢
        return { ok: true, status: 200, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => statusPayload({ registry: 'SERVICE_MISSING' }) };
    },
  });
  app.expand();
  app.flushEffects();
  await settle();
  assert.ok(mainText(app.expand()).includes('注册：REGISTERED'), '前提：首次加载已完成');

  const clickRefresh = () =>
    findAll(app.expand(), (n) => n.type === 'button' && n.props.className === 'dsh-oc-card__refresh')[0].props.onClick();
  clickRefresh(); // 第二次 fetch（慢）开始
  app.expand();
  app.flushEffects();
  clickRefresh(); // 第三次 fetch（快）开始，第二次变旧
  app.expand();
  app.flushEffects();
  await settle();
  assert.ok(mainText(app.expand()).includes('注册：SERVICE_MISSING'), '新响应必须生效');

  resolveSecond(statusPayload({ registry: 'DEGRADED' })); // 旧响应此后才到
  await settle();
  const after = mainText(app.expand());
  assert.ok(after.includes('注册：SERVICE_MISSING'), '旧响应必须被丢弃');
  assert.equal(after.includes('注册：DEGRADED'), false, '旧响应不得覆盖新值');
});

// ───────────────────────── 判据④：任务块（在途 + 最近一轮下发） ─────────────────────────

test('判据④e：在途作业 —— >0 才有那一行（空态不印"在途作业：0"）', async () => {
  const busy = await boot({
    status: statusPayload({
      inFlight: [
        { sessionKey: 'k1', sessionId: '', startedAt: 1, phase: 'prompting' },
        { sessionKey: 'k2', sessionId: 'ses_live02', startedAt: 2, phase: 'waiting' },
      ],
    }),
  });
  busy.expand();
  busy.flushEffects();
  await settle();
  const busyMain = mainText(busy.expand());
  assert.ok(busyMain.includes('在途作业：2 个运行中'), '在途数必须显示');
  assert.equal(busyMain.includes('prompting'), false, '阶段枚举不上主视图（只报计数）');

  const idle = await boot({});
  idle.expand();
  idle.flushEffects();
  await settle();
  const idleMain = mainText(idle.expand());
  assert.equal(idleMain.includes('在途作业'), false, '在途为 0 ⇒ 整行不渲染（不印空话）');
  assert.ok(idleMain.includes('暂无下发记录'), '无 lastRun ⇒ 明确空态');
});

test('判据④f：最近一轮成功 —— 主视图人话全行；排障详情（摘录/投递/时刻/用量/证据）只进折叠', async () => {
  const app = await boot({
    scopeValue: { enabled: true },
    status: statusPayload({
      lastRun: lastRunPayload({
        permissionRequests: [{ requestID: 'req_hidden01', action: 'shell-x', source: 'user', state: 'pending', decision: '' }],
      }),
    }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  const fold = foldText(tree);

  assert.ok(main.includes('会话：ses_run01'));
  assert.ok(main.includes('亲和键：demo-key'));
  assert.ok(main.includes('复用上次会话'));
  assert.ok(main.includes('结果：成功'));
  assert.ok(main.includes('回执：已改好：README 标题更新为「演示」'), '成功也必须有正文（不可接受的形态是"成功了但没有回执"）');
  assert.ok(main.includes('模型：local/m1 · 档位 low'));
  assert.ok(main.includes('成本：$0.1234'));
  assert.ok(main.includes('时间：'));
  assert.equal(main.includes('时间：未知'), false);

  assert.ok(fold.includes('下发详情（排障用，默认收起）'));
  assert.ok(fold.includes('下发文本：把 README 的标题改掉'));
  assert.ok(fold.includes('投递方式：queue'));
  assert.ok(fold.includes('受理时刻：'));
  assert.ok(fold.includes('空闲时刻：'));
  assert.ok(fold.includes('等待结论：idle-204'));
  assert.ok(fold.includes('本轮用量：输入 10 · 输出 20 · 推理 5'));
  assert.ok(fold.includes('审批请求：1 条'), '本轮遇到的审批请求只报条数');

  // 折叠纪律：排障细节一律不上主视图；审批明细（含 requestID 与动作名）整卡不渲染。
  assert.equal(main.includes('把 README 的标题改掉'), false);
  assert.equal(main.includes('queue'), false);
  assert.equal(main.includes('idle-204'), false);
  assert.equal(textOf(tree).includes('req_hidden01'), false, '★ 审批明细不渲染（列/回走 opencode_approvals）');
  assert.equal(textOf(tree).includes('shell-x'), false);
});

test('判据④g：最近一轮失败 —— 原因人话上主视图；原因码照实；ok 不画原因（不造反义句）', async () => {
  const failed = await boot({
    status: statusPayload({
      lastRun: lastRunPayload({ outcome: 'failed', reasonCode: 'session_error', reasonText: '会话在服务端报错，本轮已停下。', reply: '（失败前的最后一句话）' }),
    }),
  });
  failed.expand();
  failed.flushEffects();
  await settle();
  const failedMain = mainText(failed.expand());
  assert.ok(failedMain.includes('结果：失败'));
  assert.ok(failedMain.includes('原因：会话在服务端报错，本轮已停下。'), '失败人话必须在主视图');
  assert.ok(failedMain.includes('原因码：session_error'), '原因码原样呈现（可核对；非 ok 才画）');

  const ok = await boot({ status: statusPayload({ lastRun: lastRunPayload() }) });
  ok.expand();
  ok.flushEffects();
  await settle();
  const okMain = mainText(ok.expand());
  assert.equal(okMain.includes('原因：'), false, '成功轮不画原因行');
  assert.equal(okMain.includes('原因码：'), false, '★ ok 是"没有原因"的机器写法，不印给用户');

  const noText = await boot({
    status: statusPayload({ lastRun: lastRunPayload({ outcome: 'interrupted', reasonCode: 'wait_timeout', reasonText: '' }) }),
  });
  noText.expand();
  noText.flushEffects();
  await settle();
  const noTextMain = mainText(noText.expand());
  assert.ok(noTextMain.includes('结果：已中断'));
  assert.equal(noTextMain.includes('原因：'), false, 'reasonText 为 \'\' ⇒ 不渲染原因行（缺字段不编造）');
  assert.ok(noTextMain.includes('原因码：wait_timeout'));
});

test('判据④h：边界 —— 空回执/未知模型/未知成本/未知结果/未知时间都如实说"未知"，不编造', async () => {
  const app = await boot({
    status: statusPayload({ lastRun: lastRunPayload({ reply: '   ', model: null, cost: null, outcome: 'weird', at: 0 }) }),
  });
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const main = mainText(tree);
  assert.ok(main.includes('回执：（无正文）'), '空正文与没读到正文必须说出来，不留白');
  assert.ok(main.includes('模型：未知'), 'model:null ⇒ 未知（不编造模型名）');
  assert.ok(main.includes('成本：未知'), 'cost:null ⇒ 未知（不写 $0 —— 那会让用户以为没花钱）');
  assert.ok(main.includes('结果：未知'), '表外 outcome ⇒ 未知');
  assert.ok(main.includes('时间：未知'), 'at 非有限正数 ⇒ 未知');
  assert.equal(main.includes('成本：$'), false);
  assert.equal(main.includes('weird'), false, '★ 未知枚举不印机器标识符');
});

test('判据④i：回执摘录 —— 超 80 字截断并标"…"（不假装是全文）；短正文原样上屏', async () => {
  const long = '甲'.repeat(120);
  const app = await boot({ status: statusPayload({ lastRun: lastRunPayload({ reply: long }) }) });
  app.expand();
  app.flushEffects();
  await settle();
  const main = mainText(app.expand());
  assert.ok(main.includes('回执：' + '甲'.repeat(80) + '…'), '超限摘要 = 前 80 字 + 省略号');
  assert.equal(main.includes('甲'.repeat(81)), false, '不得整段倾倒');

  const short = await boot({ status: statusPayload({ lastRun: lastRunPayload({ reply: '收到' }) }) });
  short.expand();
  short.flushEffects();
  await settle();
  assert.ok(mainText(short.expand()).includes('回执：收到'), '正控：短正文原样上屏（不带省略号）');
});

// ───────────────────────── 判据⑧：审批面 ─────────────────────────

test('判据⑧：审批面三态 + pendingCount>0 的醒目行点名工具；明细永不渲染', async () => {
  const none = await boot({});
  none.expand();
  none.flushEffects();
  await settle();
  assert.ok(mainText(none.expand()).includes('审批：无待处理'));

  const pending = await boot({
    status: statusPayload({
      approvals: {
        pendingCount: 3,
        items: [{ sessionID: 'ses_approval07', requestID: 'req_approval07', action: 'shell-x', at: 1 }],
      },
    }),
  });
  pending.expand();
  pending.flushEffects();
  await settle();
  const tree = pending.expand();
  const main = mainText(tree);
  assert.ok(
    main.includes('有 3 条审批待处理 —— 用 ' + TOOL_APPROVALS + ' 工具列出/回复'),
    '★ 醒目行必须点名工具（唯一回复通道），文案与共享常量同源',
  );
  const warn = findAll(tree, (n) => String(n.props?.className ?? '').includes('dsh-oc-approvals--pending'))[0];
  assert.ok(warn !== undefined, '醒目行必须带 dsh-oc-approvals--pending 语气类');
  assert.equal(textOf(tree).includes('req_approval07'), false, '★ 明细（requestID）刻意不渲染（[待验]：形状未在真机核过）');
  assert.equal(textOf(tree).includes('shell-x'), false, '动作名同样不渲染（只报条数）');

  const unknown = await boot({ status: statusPayload({ approvals: null }) });
  unknown.expand();
  unknown.flushEffects();
  await settle();
  assert.ok(mainText(unknown.expand()).includes('审批：状态未知'), 'approvals:null ⇒ 状态未知');

  const missing = await boot({ status: statusPayload({ approvals: {} }) });
  missing.expand();
  missing.flushEffects();
  await settle();
  assert.ok(mainText(missing.expand()).includes('审批：状态未知'), 'pendingCount 非数（老宿主缺字段）⇒ 状态未知');
});

// ───────────────────────── 状态区诊断折叠 + 收纳 + Toast ─────────────────────────

test('判据④j：诊断折叠 —— 探测留痕逐条 + 诊断接口印出；不打印 method、不 fetch 它', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  const tree = app.expand();
  const fold = foldText(tree);
  assert.ok(fold.includes('诊断信息（排障用，默认收起）'));
  assert.ok(fold.includes('诊断接口：' + ROUTE_DIAGNOSTICS), '诊断接口必须与共享常量逐字一致（人工查障入口）');
  assert.equal(textOf(tree).includes('read-only'), false, '探测 method 恒为 read-only（零信息量）⇒ 不印');
  assert.equal(app.fetches.length, 1, '诊断接口只印不拉（避免卡片轮询打服务）');
  assert.equal(app.fetches.some((f) => f.url === ROUTE_DIAGNOSTICS), false);
});

test('收纳：默认展开 → 收起只剩标题+徽标（无摘要行）→ 再展开', async () => {
  const app = await boot({});
  app.render();
  app.flushEffects();
  await settle();
  const opened = app.render();
  const toggle = findAll(opened, (n) => n.type === 'button' && n.props.className === 'dsh-oc-card__toggle')[0];
  assert.ok(toggle !== undefined, '折叠头（dsh-oc-card__toggle）必须存在');
  assert.equal(toggle.props['aria-expanded'], true, '默认必须展开（本卡是该设置页的主内容）');
  assert.equal(toggle.props['aria-label'], '收起设置: OpenCode');
  const chevron0 = findAll(opened, (n) => String(n.props?.className ?? '').includes('dsh-oc-card__chevron'))[0];
  assert.ok(chevron0.props.className.includes('--open'), '展开态 chevron 带 --open（旋转指示）');
  assert.ok(
    findAll(opened, (n) => n.type === 'svg' && n.props.className === 'fake-primitives-icon-chevron-down-regular').length >= 1,
    'chevron 必须由 primitives 图标渲染（不是自绘）',
  );
  assert.equal(findAll(opened, (n) => n.props && n.props.className === 'dsh-oc-card__body').length, 1, '默认展开 ⇒ 内容区已渲染');

  toggle.props.onClick();
  const collapsed = app.render();
  const text = textOf(collapsed);
  const toggle2 = findAll(collapsed, (n) => n.type === 'button' && n.props.className === 'dsh-oc-card__toggle')[0];
  assert.equal(toggle2.props['aria-expanded'], false, '收起后 aria-expanded=false');
  assert.equal(toggle2.props['aria-label'], '展开设置: OpenCode');
  assert.equal(findAll(collapsed, (n) => n.props && n.props.className === 'dsh-oc-card__body').length, 0, '收起后内容区必须消失');
  assert.equal(findAll(collapsed, (n) => n.type === 'input').length, 0, '收起后控件必须消失');
  assert.ok(text.includes('OpenCode') && text.includes('● 已就绪'), '★ 收起态仍留标题 + 徽标（"现在能不能用"是收起时最该看到的一件事）');
  assert.equal(text.includes('DshAgentHub 插件'), false, '收起态不印描述行');
  assert.equal(
    findAll(collapsed, (n) => /summary/i.test(String(n.props?.className ?? ''))).length,
    0,
    '★ 本包收起态不画摘要（标题 + 徽标 + chevron 一行即全部）—— 再抄一份配置就是第二份要维护的真相',
  );

  toggle2.props.onClick();
  const reopened = app.render();
  assert.equal(findAll(reopened, (n) => n.props && n.props.className === 'dsh-oc-card__body').length, 1, '再点必须重新展开');
});

test('写失败：scope.set reject ⇒ Toast 如实说出来（role=alert），点按可关闭', async () => {
  const app = await boot({});
  app.expand();
  app.flushEffects();
  await settle();
  const input = findAll(app.expand(), (n) => n.type === 'input' && n.props.className === 'dsh-oc-switch')[0];
  app.scope.failNextSet();
  input.props.onChange(); // write → set rejects → Toast
  await settle();
  assert.deepEqual(app.scope.commits[0], { op: 'set', field: 'enabled', value: true }, '写请求已发出');
  assert.equal(app.scope.getSnapshot().value.enabled, undefined, '失败 ⇒ 快照未被伪造更新');
  const toast = findAll(app.expand(), (n) => n.props && n.props.className === 'dsh-oc-toast')[0];
  assert.ok(toast !== undefined, '★ 写失败必须出 Toast（不静默吞掉）');
  assert.ok(labelText(toast).startsWith('保存失败：'), '★ Toast 必须说清是保存失败');
  assert.equal(toast.props.role, 'alert', '★ Toast 必须 role=alert（无障碍树可达）');
  assert.equal(toast.props.title, '关闭');

  toast.props.onClick();
  const after = app.render();
  assert.equal(findAll(after, (n) => n.props && n.props.className === 'dsh-oc-toast').length, 0, '点按关闭');
});

// ───────────────────────── CSS / 降级 / 卫生 ─────────────────────────

test('判据⑤：CSS 去重注入 —— 同页重复物化不叠加 <style>', async () => {
  const documentFake = makeFakeDocument();
  await withBundle({ document: documentFake }, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    registration.factory(fakeRequire);
    assert.equal(documentFake.created.length, 1, '首次物化注入 1 份样式');
    const tag = documentFake.created[0];
    assert.equal(tag.dataset.plugin, PACKAGE_NAME);
    assert.equal(tag.dataset.pluginCss, CSS_TAG_ID);
    assert.ok(tag.textContent.includes('.dsh-oc-card'));
    for (const cls of [
      '.dsh-oc-task',
      '.dsh-oc-skeleton',
      '.dsh-oc-toast',
      '.dsh-oc-badge',
      '.dsh-oc-switch',
      '.dsh-oc-status',
      '.dsh-oc-diag',
      '.dsh-oc-approvals--pending',
    ]) {
      assert.ok(tag.textContent.includes(cls), `★ 样式必须含 ${cls}（同一份里下发，不另起 style tag）`);
    }

    registration.factory(fakeRequire); // 模拟同页再次物化（HMR/重载路径）
    assert.equal(documentFake.created.length, 1, '去重查询命中 ⇒ 不追加第二份');
  });
});

test('CSS 注入对无 document 环境安全（bundle 不得在 Node 侧炸）', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    assert.doesNotThrow(() => registration.factory(fakeRequire));
  });
});

test('CSS token 纪律：不得引用宿主不存在的别名（会静默落到硬编码色）', async () => {
  const documentFake = makeFakeDocument();
  await withBundle({ document: documentFake }, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    registration.factory(fakeRequire);
    const css = documentFake.created[0].textContent;
    assert.equal(css.includes('--dsw-alias-state-warning-primary'), false, '★ 不得引用不存在的别名');
    assert.ok(css.includes('--dsw-alias-state-warn-primary'), '警告色走真名 token');
    assert.ok(css.includes('--dsw-alias-switch-thumb'), '开关拇指走 token（深浅主题自动跟随）');
  });
});

test('降级路径：无 scope（服务未绑定）⇒ 卡片渲染降级文案而非抛错', async () => {
  await withBundle({}, async (registration) => {
    const { fakeRequire } = makeRequire(makeFakeReact().React);
    const plugin = registration.factory(fakeRequire);
    const runtime = makeFakeReact();
    // 真契约：宿主服务未绑定时 `get()` 返回 undefined。显式不传 scope 才是这个场景。
    const host = makeGuardedCtx(plugin, { scope: undefined });
    plugin.apply(host.ctx);
    host.slotsCalls[0].factory();
    assert.equal(host.bindSpecs[0].namespace, NS, '仍应尝试解析 configForms（失败也不许抛）');
    const card = host.registrations[0].component;
    const tree = runtime.render(card, {});
    assert.ok(textOf(tree).includes('设置服务不可用'), '降级文案必须给出明确症状');
    assert.equal(textOf(tree).includes('configForms'), false, '★ 宿主服务名不得出现在界面上（用户查不到这个符号）');
    assert.ok(textOf(tree).includes('OpenCode'), '兜底卡片仍报自己的名字（用户知道是谁坏了）');
  });
});

test('产物卫生：不得出现凭据字面形状 / 直接进程出口字样（CI 红线的本文件副本）', async () => {
  const text = readFileSync(CLIENT_PATH, 'utf8');
  // ★ 关键形状一律用片段拼出：这份测试自身也不携带可被形状扫描命中的字面量。
  const apiKeyPrefix = ['s', 'k', '-'].join('');
  const authScheme = ['Be', 'arer'].join('');
  const jwtHead = ['e', 'yJ'].join('');
  const processModule = ['child', '_', 'process'].join('');
  assert.equal(text.includes(apiKeyPrefix), false, '不得出现 key 形状前缀');
  assert.equal(new RegExp(authScheme + '\\s+[A-Za-z0-9._-]{16,}').test(text), false, '不得出现长令牌形状');
  assert.equal(new RegExp(jwtHead + '[A-Za-z0-9_-]{16,}').test(text), false, '不得出现 JWT 前缀形状');
  assert.equal(new RegExp('[a-fA-F0-9]{40,}').test(text), false, '不得出现 40+ 位连续 hex');
  assert.equal(new RegExp('\\b' + processModule + '\\b').test(text), false, '不得引用进程出口模块');
  assert.equal(new RegExp('\\b' + ['spawn', '\\s*\\('].join('')).test(text), false, '不得出现裸 spawn 调用');
  // 本卡也不设凭据输入框：鉴权材料来自 service.json，不经设置树（schema 层另有约束）。
  assert.equal(text.includes('密码'), false);
});
