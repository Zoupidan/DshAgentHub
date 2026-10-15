/**
 * harness-hub client bundle 验收测试。
 *
 * 测试对象 = **真实产物** `lib/client.js`（不是源代码的副本）：以伪宿主捕获
 * `window.__ModuleLoader__.load` 的注册，再用「hook 运行时」做浅渲染。
 *
 * 可证边界（诚实登记）：
 *   - 可证：模块注册形态 / 壳注册描述符（id·order·locale·label·inject·children）/
 *     hooks.tabs 数据面（排序·兜底·缓存引用·双订阅解绑）/ 标签行渲染与切页 /
 *     单标签/零标签退化 / CSS 去重 / 常量同步 / 跨包子槽名一致。
 *   - 不可证（留真机目验）：真机 React 渲染、slot dispatch、与兄弟包卡片同屏显示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NS, PACKAGE_NAME, SECTION_ID, SECTION_ORDER, TAB_SLOT } from '../src/shared/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, '..');
const CLIENT_PATH = join(PACKAGE_DIR, 'lib', 'client.js');
const HOST_PATH = join(PACKAGE_DIR, 'lib', 'index.js');
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const SIBLING_BUNDLES = [
  { path: join(PACKAGE_DIR, '..', 'plugin-workbuddy', 'lib', 'client.js'), tabId: 'workbuddy', tabOrder: 10 },
  { path: join(PACKAGE_DIR, '..', 'plugin-opencode', 'lib', 'client.js'), tabId: 'opencode', tabOrder: 20 },
];

let importNonce = 0;

// ───────────────────────── 伪宿主 ─────────────────────────

/** 伪 React：真 hook 语义的极小子集（cells 跨渲染保留；effect 在 render 后回放，deps 相同则跳过）。 */
function makeFakeReact() {
  const cells = [];
  /** @type {number[]} */
  let scheduled = [];
  const React = {
    Fragment: Symbol('Fragment'),
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
    useRef(init) {
      const cursor = React.__cursor++;
      if (!(cursor in cells)) cells[cursor] = { value: { current: init } };
      return cells[cursor].value;
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

/**
 * 伪 ctx：服务访问守卫（镜像 `dsh-cordis-client-runner/lib/client.js:320-322` —— 未声明即拒绝）。
 *
 * 与兄弟包测试的伪件差异（本壳没有配置面）：额外提供 slots 的
 * `getVersion/entries/subscribe` 与 locale 的 `getSnapshot/subscribe`（hooks.tabs 数据源所需）。
 */
function makeGuardedCtx(plugin) {
  const declared = new Set(plugin.inject);
  const verbs = new Set(['effect', 'on', 'get']);
  const slotsCalls = [];
  const registrations = [];
  const locales = [];
  const entries = [];
  const slotListeners = new Set();
  const localeListeners = new Set();
  let slotVersion = 1;
  let localeRevision = 1;
  const real = {
    effect: (fn, label) => fn(),
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
      getVersion: () => slotVersion,
      entries: () => entries,
      subscribe: (name, listener) => {
        slotListeners.add(listener);
        return () => slotListeners.delete(listener);
      },
    },
    locale: {
      bind: (ns) => {
        const entry = locales.find((l) => l.ns === ns);
        const dicts = entry?.dicts ?? {};
        return (key) => {
          for (const lang of Object.keys(dicts)) {
            if (Object.hasOwn(dicts[lang], key)) return dicts[lang][key];
          }
          return key;
        };
      },
      register: (ns, dicts) => {
        locales.push({ ns, dicts });
        return () => {};
      },
      getSnapshot: () => ({ revision: localeRevision }),
      subscribe: (listener) => {
        localeListeners.add(listener);
        return () => localeListeners.delete(listener);
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
  return {
    ctx,
    slotsCalls,
    registrations,
    locales,
    entries,
    bumpSlotVersion: () => {
      slotVersion += 1;
      for (const listener of slotListeners) listener();
    },
    bumpLocaleRevision: () => {
      localeRevision += 1;
      for (const listener of localeListeners) listener();
    },
    slotListeners,
    localeListeners,
  };
}

/** 在受控全局环境下加载 bundle 并捕获注册。 */
async function withBundle(env, fn) {
  const previous = { window: globalThis.window, document: globalThis.document };
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (registration) => { captured = registration; } } };
  if (env.document !== undefined) globalThis.document = env.document;
  else delete globalThis.document;
  try {
    await import(pathToFileURL(CLIENT_PATH).href + '?case=' + String(++importNonce));
    assert.ok(captured !== null, 'bundle 必须经 window.__ModuleLoader__.load 注册');
    return await fn(captured);
  } finally {
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  }
}

function makeRequire(React) {
  const requested = [];
  const fakeRequire = (name) => {
    requested.push(name);
    if (name === 'react') return React;
    throw new Error(`require("${name}") missed the module table（白名单仅 react）`);
  };
  return { fakeRequire, requested };
}

/** 全树搜集（嵌套数组展平；本壳树里没有嵌套函数组件 —— 壳组件已在 render 时展开）。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out);
    return out;
  }
  if (typeof node.type === 'function') return out;
  if (predicate(node)) out.push(node);
  const kids = node.children ?? [];
  for (const child of Array.isArray(kids) ? kids : [kids]) findAll(child, predicate, out);
  return out;
}

/** 节点文本（字符串子节点拼接）。 */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (node === null || node === undefined || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  const kids = node.children ?? [];
  return (Array.isArray(kids) ? kids : [kids]).map(textOf).join('');
}

/**
 * 装好一套宿主：apply → 注册表 → hooks.tabs 面 → 可渲染 props。
 * @param {object} [options]
 * @param {Array<{id:string,order:number,label:Function|string}>} [options.tabs] 子槽注册项（乱序亦可）。
 */
async function boot({ tabs = [] } = {}) {
  const runtime = makeFakeReact();
  const document = makeFakeDocument();
  let plugin = null;
  await withBundle({ document }, async (registration) => {
    const { fakeRequire } = makeRequire(runtime.React);
    plugin = registration.factory(fakeRequire);
  });
  const host = makeGuardedCtx(plugin);
  plugin.apply(host.ctx);
  assert.equal(host.slotsCalls.length, 1, '壳必须且只能注册一个 settings.section');
  assert.equal(host.slotsCalls[0].name, 'settings.section');
  await host.slotsCalls[0].factory();
  assert.equal(host.registrations.length, 1);
  const { options, component } = host.registrations[0];
  for (const tab of tabs) host.entries.push({ options: tab });
  const face = options.inject();
  const hookTabs = face.hooks.tabs;
  const t = (key) => {
    const entry = host.locales.find((l) => l.ns === NS);
    const dict = entry?.dicts?.zh ?? {};
    return Object.hasOwn(dict, key) ? dict[key] : key;
  };
  const renderSlotCalls = [];
  const renderSlot = (slotName, props, opts) => {
    renderSlotCalls.push({ slotName, only: opts?.only });
    return { type: 'fake-slot-view', props: { slotName, only: opts?.only }, children: [] };
  };
  const useTabs = (selector) => selector(hookTabs.getSnapshot());
  const render = () => runtime.render(component, { t, renderSlot, useTabs });
  return { runtime, document, plugin, host, options, component, t, renderSlot, render, renderSlotCalls, useTabs, hookTabs };
}

// ───────────────────────── 判据 ─────────────────────────

test('组成前提：package.json 契约（client 发现面）· host 空半 · cordis 行', async () => {
  assert.equal(PACKAGE_JSON.name, PACKAGE_NAME);
  assert.equal(PACKAGE_JSON.main, 'lib/index.js');
  assert.equal(PACKAGE_JSON.exports['./client'], './lib/client.js');
  assert.deepEqual(
    PACKAGE_JSON.dsh.client.inject,
    ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings'],
    '与前两个 harness 包同款发现面（真机实测可加载）',
  );
  assert.equal(PACKAGE_JSON.dsh.client.platform, 'web');
  assert.equal(PACKAGE_JSON.dsh.bundle.patch, 'cordis.patch.yml');

  const hostModule = await import(pathToFileURL(HOST_PATH).href);
  assert.equal(typeof hostModule.apply, 'function', '空宿主半也必须导出 apply（进 cordis 行）');

  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: dsh-plugin-harness-hub/);
  assert.match(patch, /name: 'dsh-plugin-harness-hub'/);
});

test('常量同步：bundle 手写字面量 = src/shared/constants.js（bundle 不能 import 它）', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(source.includes(`id: '${PACKAGE_NAME}'`), 'load id 必须等于包名（模块加载器硬校验）');
  assert.ok(source.includes(`const SECTION_ID = '${SECTION_ID}';`));
  assert.ok(source.includes(`const SECTION_ORDER = ${SECTION_ORDER};`));
  assert.ok(source.includes(`const TAB_SLOT = '${TAB_SLOT}';`));
  assert.ok(source.includes('const NS = PACKAGE_NAME;'));
});

test('跨包同步：兄弟 bundle（WorkBuddy/OpenCode）注册进同一子槽名与标签位', () => {
  for (const sibling of SIBLING_BUNDLES) {
    const source = readFileSync(sibling.path, 'utf8');
    assert.ok(
      source.includes(`const HUB_TAB_SLOT = '${TAB_SLOT}';`),
      `${sibling.path} 必须把子槽名写成常量并等于 ${TAB_SLOT}`,
    );
    assert.ok(
      source.includes(`const HUB_TAB_ID = '${sibling.tabId}';`),
      `${sibling.path} 的标签 id 必须是 ${sibling.tabId}`,
    );
    assert.ok(
      source.includes(`const HUB_TAB_ORDER = ${sibling.tabOrder};`),
      `${sibling.path} 的标签位次必须是 ${sibling.tabOrder}`,
    );
  }
});

test('判据①：壳注册 settings.section（id/order/locale/label/inject）并声明子槽 children', async () => {
  const app = await boot();
  const { options } = app.host.registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, SECTION_ID, '父条目 id 必须等于常量（= harness-hub）');
  assert.equal(options.order, SECTION_ORDER);
  assert.equal(typeof options.label, 'function', 'label 必须是 thunk（0.1.7 契约）');
  assert.equal(options.label(), 'Harness 接入', 'label thunk 必须求得出导航文案');
  assert.equal(options.locale, NS);
  assert.equal(typeof options.inject, 'function', '带子槽的壳必须给 inject 面（hooks.tabs）');
  const face = options.inject();
  assert.equal(typeof face.hooks.tabs.getSnapshot, 'function');
  assert.equal(typeof face.hooks.tabs.subscribe, 'function');
  assert.deepEqual(Object.keys(options.children), [TAB_SLOT], '子槽声明必须有且只有 TAB_SLOT');
  assert.deepEqual(options.children[TAB_SLOT], { kind: 'list', scope: 'root' });
  assert.equal(app.host.locales.length, 1, '字典必须注册（label thunk 的解析源）');
  assert.equal(app.host.locales[0].ns, NS);
});

test('判据②：hooks.tabs 数据面 —— 排序 / thunk 求值 / 兜底 / 引用缓存 / 双订阅解绑', async () => {
  const app = await boot({
    tabs: [
      { id: 'opencode', order: 20, label: () => 'OpenCode' },
      { id: 'workbuddy', order: 10, label: () => 'WorkBuddy' },
      { id: 'broken', order: 30, label: () => { throw new Error('boom'); } },
    ],
  });
  const tabs = app.hookTabs;
  const rows = tabs.getSnapshot();
  assert.deepEqual(rows.map((row) => row.id), ['workbuddy', 'opencode', 'broken'], '必须按 order 升序');
  assert.deepEqual(rows.map((row) => row.label), ['WorkBuddy', 'OpenCode', ''], 'thunk 求值；抛错兜底空串');
  assert.equal(tabs.getSnapshot(), rows, '同版本同语言 ⇒ 必须返回同一引用（useSyncExternalStore 硬要求）');
  app.host.bumpSlotVersion();
  assert.notEqual(tabs.getSnapshot(), rows, '槽版本变化 ⇒ 新快照');

  const listener = () => {};
  const off = tabs.subscribe(listener);
  assert.equal(app.host.slotListeners.has(listener), true, '必须订阅槽账本');
  assert.equal(app.host.localeListeners.has(listener), true, '必须订阅语言修订（切语言要重解析标签）');
  off();
  assert.equal(app.host.slotListeners.has(listener), false);
  assert.equal(app.host.localeListeners.has(listener), false);
});

test('判据③：≥2 标签 ⇒ 标签行出现；默认选首个；点击/键盘切页；renderSlot only 过滤', async () => {
  const app = await boot({
    tabs: [
      { id: 'workbuddy', order: 10, label: () => 'WorkBuddy' },
      { id: 'opencode', order: 20, label: () => 'OpenCode' },
    ],
  });

  let tree = app.render();
  app.runtime.flushEffects();
  tree = app.render();

  const buttons = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons.length, 2, '两个标签 ⇒ 标签行两个按钮');
  assert.deepEqual(buttons.map(textOf), ['WorkBuddy', 'OpenCode'], '顺序必须跟随 order（workbuddy=10 在前）');
  assert.equal(buttons[0].props['aria-selected'], true, '默认选中首个');
  assert.equal(buttons[1].props['aria-selected'], false);
  const tablist = findAll(tree, (node) => node.props?.role === 'tablist');
  assert.equal(tablist.length, 1);
  assert.equal(tablist[0].props['aria-label'], 'Harness 列表');
  assert.equal(app.renderSlotCalls[0].only, 'workbuddy', '首个面板必须只渲染自己（only 过滤）');

  // 点击第二个标签 → 选中态与面板可见性切换
  buttons[1].props.onClick();
  tree = app.render();
  app.runtime.flushEffects();
  tree = app.render();
  const buttons2 = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons2[1].props['aria-selected'], true);
  assert.equal(buttons2[0].props['aria-selected'], false);
  const panels = findAll(tree, (node) => node.type === 'div' && node.props.role === 'tabpanel');
  assert.deepEqual(
    panels.map((panel) => ({ id: panel.props.id, hidden: panel.props.hidden })),
    [
      { id: 'dsh-hh-tabs-panel-workbuddy', hidden: true },
      { id: 'dsh-hh-tabs-panel-opencode', hidden: false },
    ],
    '访问过的工作区保持挂载（hidden），当前页可见',
  );
  assert.deepEqual(
    app.renderSlotCalls.slice(-2).map((call) => call.only),
    ['workbuddy', 'opencode'],
    '两个面板分别只渲染自己',
  );

  // 键盘：首个标签 ArrowRight → 选中第二个（refs 缺省时跳过 focus，不得抛）
  buttons2[0].props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} });
  tree = app.render();
  const buttons3 = findAll(tree, (node) => node.type === 'button');
  assert.equal(buttons3[1].props['aria-selected'], true);
});

test('判据③b：单标签 ⇒ 无标签行直接当整页；零标签 ⇒ 空态', async () => {
  const single = await boot({ tabs: [{ id: 'workbuddy', order: 10, label: () => 'WorkBuddy' }] });
  const tree = single.render();
  assert.equal(findAll(tree, (node) => node.props?.role === 'tablist').length, 0, '单标签不画标签行');
  assert.deepEqual(single.renderSlotCalls.map((call) => call.only), ['workbuddy']);
  assert.ok(textOf(tree).includes('Harness 接入'), '标题必须来自本壳字典');

  const empty = await boot();
  const emptyTree = empty.render();
  assert.equal(findAll(emptyTree, (node) => node.props?.role === 'tablist').length, 0);
  assert.equal(empty.renderSlotCalls.length, 0);
  assert.ok(textOf(emptyTree).includes('本部署尚未接入任何 harness。'), '零标签必须显示空态文案');
});

test('service 声明守卫：inject = [slots, locale]；apply 只触达声明过的服务', async () => {
  const runtime = makeFakeReact();
  await withBundle({ document: makeFakeDocument() }, async (registration) => {
    const { fakeRequire } = makeRequire(runtime.React);
    const plugin = registration.factory(fakeRequire);
    assert.deepEqual(plugin.inject, ['slots', 'locale'], '本壳无配置面 ⇒ 不声明 configForms');
    assert.equal(typeof plugin.apply, 'function');
    const host = makeGuardedCtx(plugin);
    assert.throws(() => host.ctx.configForms, /undeclared service access/, '未声明服务访问必须被拒绝');
    assert.doesNotThrow(() => plugin.apply(host.ctx), 'apply 触达未声明服务会被守卫拒绝');
  });
});

test('require 白名单：factory 只 require("react")（seed 表内模块）', async () => {
  const runtime = makeFakeReact();
  await withBundle({ document: makeFakeDocument() }, async (registration) => {
    const { fakeRequire, requested } = makeRequire(runtime.React);
    assert.doesNotThrow(() => registration.factory(fakeRequire));
    assert.deepEqual([...new Set(requested)].sort(), ['react']);
  });
});

test('CSS 去重注入：同 tagId 只插一次', async () => {
  const document = makeFakeDocument();
  await withBundle({ document }, async (registration) => {
    const runtime = makeFakeReact();
    registration.factory(makeRequire(runtime.React).fakeRequire);
    registration.factory(makeRequire(runtime.React).fakeRequire);
    assert.equal(document.created.length, 1, '重放两次 factory 也必须只有一个 style 标签');
    assert.equal(document.created[0].dataset.pluginCss, PACKAGE_NAME + '/HubSection.css');
  });
});
