/**
 * plugin-qoder client bundle 验收测试（真实产物 lib/client.js）。
 * 验证：模块注册、harness-hub 子标签常量、基本渲染骨架。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HUB_TAB_ID, HUB_TAB_ORDER, HUB_TAB_SLOT, NS, PACKAGE_NAME } from '../src/shared/constants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js');
let importNonce = 0;

function makeFakeReact() {
  const cells = [];
  let scheduled = [];
  const React = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props ?? {}, children };
      const ref = node.props.ref;
      if (ref && typeof ref === 'object' && 'current' in ref) { ref.current = node; delete node.props.ref; }
      return node;
    },
    useState(init) {
      const cursor = React.__cursor++;
      if (!(cursor in cells)) cells[cursor] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[cursor];
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useRef(init) {
      const cursor = React.__cursor++;
      if (!(cursor in cells)) cells[cursor] = { value: { current: init } };
      return cells[cursor].value;
    },
    useEffect(fn, deps) {
      const cursor = React.__cursor++;
      const prev = cells[cursor];
      const same = prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]));
      if (!same) { if (prev?.cleanup) try { prev.cleanup(); } catch {} cells[cursor] = { deps, fn, cleanup: undefined }; scheduled.push(cursor); }
    },
    __cursor: 0,
  };
  return {
    React,
    render(Component, props) { React.__cursor = 0; return Component(props); },
    flushEffects() { const p = scheduled; scheduled = []; for (const c of p) { try { const cl = cells[c].fn(); cells[c].cleanup = typeof cl === 'function' ? cl : undefined; } catch {} } },
  };
}

async function withBundle(fn) {
  const prev = { window: globalThis.window, document: globalThis.document };
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (r) => { captured = r; } } };
  globalThis.document = { head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, textContent: '' }), querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };
  try {
    await import(pathToFileURL(CLIENT_PATH).href + '?t=' + (++importNonce));
    assert.ok(captured, 'bundle must register via __ModuleLoader__.load');
    return await fn(captured);
  } finally {
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
  }
}

function makeCtx(plugin) {
  const declared = new Set(plugin.inject);
  const slotsCalls = [];
  const locales = [];
  const registrations = [];
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: false, cdpPort: 9333, model: '' }, writable: true }),
    subscribe: () => () => {},
    set: async () => {},
  };
  const real = {
    effect: (fn) => { try { const d = fn(); return () => { try { typeof d === 'function' ? d() : d?.dispose?.(); } catch {} }; } catch { return () => {}; } },
    slots: {
      inject: (name, factory) => { slotsCalls.push({ name, factory }); return () => {}; },
      register: (opts, component) => { registrations.push({ opts, component }); return () => {}; },
    },
    locale: {
      bind: (ns) => (key) => key,
      register: (ns, dicts) => { locales.push({ ns, dicts }); return () => {}; },
    },
    configForms: { get: () => scope },
  };
  const ctx = new Proxy({}, { get(_t, p) { if (typeof p !== 'string') return undefined; if (!declared.has(p) && !['effect', 'get'].includes(p)) throw new Error('undeclared: ' + p); return real[p]; } });
  return { ctx, slotsCalls, locales, registrations, scope };
}

test('bundle constants are synced (hub cross-check contract)', () => {
  const src = readFileSync(CLIENT_PATH, 'utf8');
  assert.ok(src.includes(`const HUB_TAB_SLOT = '${HUB_TAB_SLOT}';`));
  assert.ok(src.includes(`const HUB_TAB_ID = '${HUB_TAB_ID}';`));
  assert.ok(src.includes(`const HUB_TAB_ORDER = ${HUB_TAB_ORDER};`));
  assert.ok(src.includes(`id: '${PACKAGE_NAME}'`));
  assert.ok(src.includes("name: HUB_TAB_SLOT"));
});

test('bundle registers hub tab and renders without throwing', async () => {
  await withBundle(async (reg) => {
    const rt = makeFakeReact();
    const plugin = reg.factory((name) => { if (name === 'react') return rt.React; if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconChevronDownOutlineRegular: (p) => rt.React.createElement('svg', p) }; throw new Error('unknown dep ' + name); });
    assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms']);
    const host = makeCtx(plugin);
    plugin.apply(host.ctx);
    assert.equal(host.slotsCalls.length, 1);
    assert.equal(host.slotsCalls[0].name, HUB_TAB_SLOT);
    await host.slotsCalls[0].factory();
    assert.equal(host.registrations.length, 1);
    assert.equal(host.registrations[0].opts.id, HUB_TAB_ID);
    assert.equal(host.registrations[0].opts.order, HUB_TAB_ORDER);
    const tree = rt.render(host.registrations[0].component, {});
    assert.ok(tree && typeof tree === 'object');
  });
});

test('client bundle does not contain obvious credential echo patterns', () => {
  const src = readFileSync(CLIENT_PATH, 'utf8');
  assert.equal(/console\.(log|info|debug)\([^)]*pat(Input)?\b/i.test(src), false);
  assert.ok(src.includes("type: 'password'"), 'PAT input should be password type');
});
