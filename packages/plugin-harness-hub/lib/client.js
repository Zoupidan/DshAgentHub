/**
 * client 端 bundle —— 手写单文件（本仓库无构建器，见 04-docs/RECON-T03-RESULT.md §4 D-1）。
 *
 * 角色：设置导航栏里的**父条目**「Harness 接入」。壳只做三件事 ——
 *   ① 注册 `settings.section`（id=`harness-hub`，order=18）；
 *   ② 声明**子标签槽** `settings.harness-hub.tab`（kind=list / scope=root）；
 *   ③ 渲染标签行与标签面板（**≥2 个标签才出现标签行**；1 个直接当整页；0 个显示空态）。
 * 各 harness 的能力/配置/状态**一概不经过本壳**：它们各自把配置卡片注册进子槽
 * （一 harness 一包、互不共享状态的落点）。
 *
 * 形态依据（全部为本机 dsh 0.2.0-rc.2 安装体只读实测；官方同款壳 = @deepseek-ai/dsh-client-ui-settings-plugins）：
 *   - 壳组件结构：`dsh-client-ui-settings-plugins/lib/client.js:37-129`
 *     （tabsId / tabRefs / useTabs / activeId / visitedIds / 键盘导航 / renderSlot 的 only 过滤）；
 *   - 子槽声明：同文件壳注册项的 `children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } }`；
 *   - 子标签注册样例：`dsh-client-ui-settings-plugin-inventory/lib/client.js:792-799`
 *     （`ctx.slots.inject(槽, () => ctx.slots.register({ name, id, order, label, locale }, 组件))`）；
 *   - `inject` 面 hooks：`dsh-client-ui-renderer/lib/client.js`（`hooks.tabs` → 组件 prop `useTabs`，
 *     `standardHookPropName`；`renderSlot` 由壳注册项的 children 声明授权——越权即 SlotOwnershipError，
 *     `dsh-client-ui-slots/lib/index.js:10-17`）；
 *   - 宿主渲染点：`dsh-client-ui-settings-general/lib/client.js:337`
 *     （`renderSlot("settings.section", { close }, { only: active })`）。
 *
 * 约束：本文件属于 packages/*​/lib（CI ② 进程出口审计 + C3 扫描范围）——
 *       不得出现任何进程出口字样。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-harness-hub',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;

    // ───────────────────────── 常量（与 src/shared/constants.js 同步；bundle 不能 import 它） ─────────────────────────
    const PACKAGE_NAME = 'dsh-plugin-harness-hub';
    const NS = PACKAGE_NAME;

    /** 设置导航栏父条目 id（settings.section 的 list id）。 */
    const SECTION_ID = 'harness-hub';

    /**
     * 父条目排序位次（2026-10-15 落位依据，只读实测本机各 section 的 order）：
     *   账号与余额=-10 · 通用设置=0 · 模型=10 · 内置插件=15 · 技能=17 ·【本条目=18】·
     *   Agent 预设=20 · 插件市场=40。
     * 取 18：正好坐在原 OpenCode/WorkBuddy 两个独立条目所在的位置（技能之后、Agent 预设之前），
     * 且**不与该位置上的 Agent 预设=20 撞号**（同号排序不可预期）。
     */
    const SECTION_ORDER = 18;

    /** 子标签槽名（list 槽；kind/scope 由本文件的壳注册项 children 表声明）。 */
    const TAB_SLOT = 'settings.harness-hub.tab';

    /**
     * 本壳自己的文案（zh 单份 —— 与兄弟包同款纪律：本部署只有一份中文界面，
     * 读 zh 是"取当前语言"而非"忽略 en"）。
     */
    const DICT = {
      zh: {
        nav: 'Harness 接入',
        title: 'Harness 接入',
        intro: '本机接入的 harness：一个 harness 一个标签页，各自独立配置、独立状态。',
        tabs: 'Harness 列表',
        empty: '本部署尚未接入任何 harness。',
      },
    };

    // ───────────────────────── CSS（去重注入；类名 dsh-hh- 前缀） ─────────────────────────

    // 标签行/标签页样式对齐官方壳（dsh-client-ui-settings-plugins 的 tabs/tab 原样，换前缀）。
    const HUB_CSS =
      '.dsh-hh-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}' +
      '.dsh-hh-heading{margin:0;font-size:18px;font-weight:600}' +
      '.dsh-hh-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}' +
      '.dsh-hh-tabs{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:flex-end;gap:22px;margin-top:2px;display:flex}' +
      '.dsh-hh-tab{color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;position:relative}' +
      '.dsh-hh-tab:hover,.dsh-hh-tab[data-active=true]{color:var(--dsw-alias-label-primary)}' +
      '.dsh-hh-tab[data-active=true]:after,.dsh-hh-tab:focus-visible:after{background:var(--dsw-alias-label-primary);bottom:-1px;content:"";height:2px;left:0;position:absolute;right:0}' +
      '.dsh-hh-panel{min-width:0}' +
      '.dsh-hh-panel[hidden]{display:none}' +
      '.dsh-hh-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}';

    const CSS_TAG_ID = PACKAGE_NAME + '/HubSection.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_NAME;
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = HUB_CSS;
      document.head.appendChild(tag);
    }

    // ───────────────────────── 标签数据源（hooks.tabs ⇒ 组件 prop useTabs） ─────────────────────────

    /**
     * 解析 list 注册项的 `label`（可能为 thunk；thunk 在读取时才求值 —— 跟随当前语言）。
     * 求值失败（如字典尚未注册）返回 undefined，由调用侧兜底为空串：标签坏掉不得拖垮整页。
     * @param {string|Function|undefined} label
     * @returns {string|undefined}
     */
    function resolveLabel(label) {
      if (typeof label === 'function') {
        try {
          const value = label();
          return typeof value === 'string' ? value : undefined;
        } catch {
          return undefined;
        }
      }
      return typeof label === 'string' ? label : undefined;
    }

    /**
     * 构造 `hooks.tabs` 数据源（getSnapshot/subscribe 对）。
     *
     * ★ getSnapshot 必须幂等（缓存引用）：`useSyncExternalStore` 在值不变时要求返回同一引用，
     *   否则 React 直接报 "The result of getSnapshot should be cached"。
     *   失效键 = 槽版本号（注册/注销）∨ 语言修订号（切语言后标签文案要重解析）——
     *   与官方壳同款双失灵（`dsh-client-ui-settings-plugins/lib/client.js` 的 sectionInjected）。
     *
     * @param {object} ctx 浏览器插件上下文（slots/locale 已就绪）。
     * @returns {{ getSnapshot: () => Array<{id:string,order:number,label:string}>, subscribe: (fn:Function) => Function }}
     */
    function makeTabsHookSource(ctx) {
      let ledgerVersion = -1;
      let localeRevision = -1;
      let rows = [];
      return {
        getSnapshot: () => {
          const version = ctx.slots.getVersion(TAB_SLOT);
          const revision = ctx.locale.getSnapshot().revision;
          if (version !== ledgerVersion || revision !== localeRevision) {
            ledgerVersion = version;
            localeRevision = revision;
            rows = ctx.slots
              .entries(TAB_SLOT)
              .map((entry) => ({
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveLabel(entry.options.label) ?? '',
              }))
              .sort((left, right) => left.order - right.order);
          }
          return rows;
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe(TAB_SLOT, listener);
          const offLocale = ctx.locale.subscribe(listener);
          return () => {
            offLedger();
            offLocale();
          };
        },
      };
    }

    // ───────────────────────── 壳组件（结构逐行对齐官方壳；文案/槽名/文案位为本壳自己的） ─────────────────────────

    /**
     * Harness 接入页：标签行 + 标签面板；一个贡献当整页；零贡献显示空态。
     *
     * props 来源（宿主注入，非本文件调用）：
     *   - `t`         ← 注册项 `locale: NS` 的绑定；
     *   - `renderSlot`← 壳注册项 children 声明授权后的绑定（only=标签 id）；
     *   - `useTabs`   ← 注册项 `inject` 面的 `hooks.tabs`（> 见 makeTabsHookSource）。
     *
     * @param {{ t: Function, renderSlot: Function, useTabs: Function }} props
     */
    function HarnessHubSection({ t, renderSlot, useTabs }) {
      // 本壳全局单实例（settings 页同一时刻只渲染一个 section）⇒ 固定前缀即可，无需 useId。
      const tabsId = 'dsh-hh-tabs';
      const tabRefs = useRef([]);
      const rows = useTabs((value) => value);
      const [activeId, setActiveId] = useState(undefined);
      const [visitedIds, setVisitedIds] = useState(() => new Set());
      const active = rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id;
      const single = rows.length === 1 ? rows[0] : undefined;

      // 已访问集合：切过一次的标签保持挂载（hidden），避免来回切时重复拉状态。
      useEffect(() => {
        if (active === undefined) return;
        setVisitedIds((previous) => (previous.has(active) ? previous : new Set([...previous, active])));
      }, [active]);

      return h('div', { className: 'dsh-hh-section' }, [
        h('h2', { className: 'dsh-hh-heading', key: 'heading' }, t('title')),
        h('p', { className: 'dsh-hh-intro', key: 'intro' }, t('intro')),
        rows.length === 0
          ? h('p', { className: 'dsh-hh-empty', key: 'empty' }, t('empty'))
          : single !== undefined
            ? h(
                'div',
                { className: 'dsh-hh-panel', key: 'single' },
                renderSlot(TAB_SLOT, {}, { only: single.id }),
              )
            : h(React.Fragment, { key: 'tabs' }, [
                h(
                  'div',
                  { className: 'dsh-hh-tabs', role: 'tablist', 'aria-label': t('tabs'), key: 'tablist' },
                  rows.map((row, index) => {
                    const selected = row.id === active;
                    return h(
                      'button',
                      {
                        ref: (element) => {
                          tabRefs.current[index] = element;
                        },
                        id: tabsId + '-tab-' + row.id,
                        type: 'button',
                        role: 'tab',
                        className: 'dsh-hh-tab',
                        'aria-selected': selected,
                        'aria-controls': tabsId + '-panel-' + row.id,
                        'data-active': selected ? 'true' : undefined,
                        tabIndex: selected ? 0 : -1,
                        key: row.id,
                        onClick: () => {
                          setActiveId(row.id);
                        },
                        onKeyDown: (event) => {
                          let nextIndex;
                          switch (event.key) {
                            case 'ArrowRight':
                              nextIndex = (index + 1) % rows.length;
                              break;
                            case 'ArrowLeft':
                              nextIndex = (index - 1 + rows.length) % rows.length;
                              break;
                            case 'Home':
                              nextIndex = 0;
                              break;
                            case 'End':
                              nextIndex = rows.length - 1;
                              break;
                            default:
                              return;
                          }
                          event.preventDefault();
                          const nextRow = rows[nextIndex];
                          const nextTab = tabRefs.current[nextIndex];
                          setActiveId(nextRow.id);
                          if (nextTab !== undefined && nextTab !== null && typeof nextTab.focus === 'function') {
                            nextTab.focus();
                          }
                        },
                      },
                      row.label,
                    );
                  }),
                ),
              ]
                .concat(
                  rows
                    .filter((row) => row.id === active || visitedIds.has(row.id))
                    .map((row) =>
                      h(
                        'div',
                        {
                          id: tabsId + '-panel-' + row.id,
                          className: 'dsh-hh-panel',
                          role: 'tabpanel',
                          'aria-labelledby': tabsId + '-tab-' + row.id,
                          hidden: row.id !== active,
                          key: row.id,
                        },
                        renderSlot(TAB_SLOT, {}, { only: row.id }),
                      ),
                    ),
                )),
      ]);
    }

    // ───────────────────────── 装配（cordis 插件对象形态） ─────────────────────────

    /**
     * @param {object} ctx 浏览器插件上下文（fiber inject 保证两服务就绪后才回调）。
     */
    function apply(ctx) {
      // 注册字典：`label` thunk 通过 `ctx.locale.bind(NS)` 取值（slot renderer 不注入 locale prop）。
      ctx.effect(() => ctx.locale.register(NS, DICT), PACKAGE_NAME + ': dictionaries');
      const tabs = makeTabsHookSource(ctx);
      const sectionInjected = () => ({ hooks: { tabs } });
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            // ★ 与兄弟包（无子槽的卡片）**不同**：本壳是"带子槽的 section"——
            //   inject 面提供 hooks.tabs（组件里是 useTabs prop），外壳渲染授权 renderSlot。
            inject: sectionInjected,
            // ★ 子槽声明：子侧（WorkBuddy/OpenCode 的 bundle）注册进 TAB_SLOT；
            //   未声明即注册会抛 SlotCore 的 "not declared"（父声明是唯一入口）。
            children: { [TAB_SLOT]: { kind: 'list', scope: 'root' } },
          },
          HarnessHubSection,
        ),
      );
    }

    /**
     * 必需服务（cordis fiber inject）—— **硬依赖门限**（少一个 = 本插件永远 pending，
     * web boot 完整性校验失败会拒绝启动整个 DSH，2026-10-01 真机事故）。
     *   - `slots`  = ui-renderer
     *   - `locale` = ui-locale（注册项的 `t` 靠 `locale: NS` 选项获得）
     * 本壳**没有**配置面 ⇒ 不声明 `configForms`。
     */
    const inject = ['slots', 'locale'];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
