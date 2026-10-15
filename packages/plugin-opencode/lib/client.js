/**
 * client 端 bundle —— 手写单文件（本仓库无构建器，承 plugin-workbuddy 同款形态，见
 * 04-docs/RECON-T03-RESULT.md §4 D-1）。
 *
 * Implements: 00-recon/OPENCODE-LOCAL-RECON-20261015.md（通道事实）· src/host/types/index.js（载荷契约，
 *             字段名即契约）· CHARTER §4 八步流程契约之「设置卡片」与「审批面」（八步之 8）。
 *
 * 形态依据（与 plugin-workbuddy/lib/client.js 同源，全部为本机 dsh 安装体只读实测）：
 *   - 加载形态 `window.__ModuleLoader__.load({ id, factory })`；id 必须 === package.json 的 name
 *     （`dsh-client-modules/lib/client.js` 对不上即抛 "loaded without registering"）；
 *   - factory 返回的 module.exports 即 cordis 插件对象（`{ apply, inject }`）；
 *   - require 白名单 = app bundle 内联 seed 表；本 bundle 只用 react + primitives；
 *   - 卡片槽 = 「Harness 接入」父条目（dsh-plugin-harness-hub）的**子标签槽**
 *     `settings.harness-hub.tab`（list 槽；2026-10-15 前为 `settings.section` 独立条目）：
 *     注册项 `{ name, id, order, label thunk, locale }`，**无 inject** —— 壳渲染处只递空 props，
 *     配置面（scope）走**闭包**；
 *   - settings 读写 = `ctx.configForms.get(NS)` → `{ getSnapshot, subscribe, set, … }`；
 *   - CSS 去重注入（tagId + `style[data-plugin-css]` 查询）；
 *   - 状态 bridge = 同源 fetch 相对路径（ROUTE_STATUS，host 侧 fail-closed 只回环）。
 *
 * 卡片内容（本包自己的形状 —— 与 WorkBuddy 卡互不共享、不伪造能力）：
 *   ① 头：标题 + 三态徽标（未探测 / 服务缺失 / 已就绪）+ chevron；收起态只留这一行（无摘要）。
 *   ② 任务：在途计数（>0 才画）+ 最近一轮下发摘要（会话/亲和键/新建或复用/结果/回执/原因/模型/成本/时间）。
 *   ③ 配置：总闸（enabled）+ 模型（文本框 + 候选目录下拉）+ 推理档位 + 工作目录/绑定会话/服务目录/
 *      服务地址/等待上限。
 *   ④ 状态：设置读取态 + 注册（原样）+ 探测结论（原样）+ 审批面 + 诊断折叠（默认收起）。
 *
 * ★ 两处与 WorkBuddy 卡的**故意**差异（写在这里，免得下一位把它们当回归修掉）：
 *   1. `注册：REGISTERED` / `探测结论：pid-dead` **原样上主视图** —— 本包把这两串定义为可核对的
 *      读数（八步之 1/2 的验收面），按需求明示展示；WorkBuddy 那条"主视图禁内部串"纪律在本包
 *      收窄为"路径/编号明细只进折叠"（servicePath / 证据逐条 / 各类 id 仍不进主视图）。
 *   2. 审批面（八步之 8）是本包独有：`pendingCount > 0` 时主视图有一行醒目警告，点名
 *      `opencode_approvals` 工具（文案里的工具名由 TOOL_APPROVALS 常量拼出，不另写一份字面量）。
 *
 * ⚠️ [待验] 真机 React 渲染 / slot dispatch / 设置写穿透到 host 落盘（受控窗口 W-11）——
 *    本文件级验收以 test/client.test.js 的伪宿主断言到注册与浅渲染层。
 * ⚠️ [待验] 桌面端 GUI 对"经 API 新建的会话"是否自动刷新 —— 本卡片**不假装**有实时性：
 *    只在挂载与手动「刷新状态」时拉 ROUTE_STATUS。
 * ⚠️ [待验] `variant.source` 的真机取值域（'service' / 'config' / 'unavailable:<reason>' / 'pending:<reason>'，
 *    见 src/host/routes/status/get.js 的 variantCapability）—— 本卡片**不消费**它（只消费 values），
 *    等受控窗口里对过真机载荷再决定是否可视化。
 * ⚠️ [待验] `approvals.items[]` 的明细形状（{sessionID, requestID, action, at}）—— **刻意不渲染**，
 *    只渲染 pendingCount；列明细/回复走 opencode_approvals 工具（那也是唯一的回复通道）。
 *
 * 约束：本文件属于各包的 lib 目录（CI ② 进程出口审计 + ⑤ 凭据形状扫描范围）——
 *       不得出现裸进程出口字样，也不得出现任何凭据字面形状（本卡也不设凭据输入框：
 *       服务鉴权材料始终来自 service.json，不经设置树，见 src/host/config/schema.js）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-opencode',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    // primitives 为 9 个 seed 模块之一（前端 staticModules 表实测：`@deepseek-ai/dsh-client-ui-primitives`）。
    // ★ 图标名必须是该包**公开导出表**里的名字：`IconChevronDownOutlineRegular`
    //   （`…Artwork` 是内部实现、`…14` 只是它自己的 size 默认值 —— 写 `…14` 会让
    //   `h(undefined)` 在渲染期抛错，被宿主 SlotErrorBoundary 吞成一张全白的卡片，见 WorkBuddy 事故复盘）。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useState } = React;
    const IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular;

    // ───────────────────── 常量（与 src/shared/constants.js 同步；bundle 不能 import 它） ─────────────────────
    const PACKAGE_NAME = 'dsh-plugin-opencode';
    /** settings namespace（= 包名；须匹配 lowercase hyphenated identifier）。 */
    const NS = PACKAGE_NAME;
    /** 状态 bridge 路由（host 注册 · client 消费 —— 与 src/shared/constants.js 逐字一致）。 */
    const ROUTE_STATUS = '/plugin-opencode/status';
    /** 诊断路由：卡片的诊断折叠里**印出**它（人工查障入口），不 fetch —— 避免卡片轮询打服务。 */
    const ROUTE_DIAGNOSTICS = '/plugin-opencode/diagnostics';
    /** 审批工具名（模型面工具；pendingCount>0 的醒目行里点名它）。 */
    const TOOL_APPROVALS = 'opencode_approvals';
    /**
     * ★ 2026-10-15 hub 合并：设置导航栏不再由本包占**独立条目** —— 父条目「Harness 接入」
     *   由 `dsh-plugin-harness-hub` 注册（id=`harness-hub`，order=18），本卡片注册进它的
     *   **子标签槽**（list 槽）。三处同步（改名即三处一起改）：本文件 /
     *   本包 src/shared/constants.js / hub 包 src/shared/constants.js。
     *   · 标签位次：workbuddy=10、opencode=20 ⇒ 标签行顺序 WorkBuddy → OpenCode。
     *   · 壳（hub）不在场 ⇒ 子槽未声明 ⇒ 本注册静默不发生（父条目是唯一入口）。
     */
    const HUB_TAB_SLOT = 'settings.harness-hub.tab';
    const HUB_TAB_ID = 'opencode';
    const HUB_TAB_ORDER = 20;
    /** lastRun.reply 在主视图里的摘录上限（超出截断并以 `…` 标注 —— 不假装是全文）。 */
    const REPLY_EXCERPT_LIMIT = 80;

    /**
     * 文案字典（两段式约定，承接 WorkBuddy 同款）：
     *   · **顶层键**（`nav`）→ 走 `ctx.locale.bind(NS)`，消费方是注册项的 `label` thunk；
     *   · **`detail` 子表** → 卡内文案的**唯一来源**，按卡内区块分组。组件直接读 `DICT.zh.detail.*`
     *     （标签渲染只递空 props，不注入 locale prop）。
     *     ⭐ 故意只读 `zh`：本包只有一份中文界面，读 `zh` 是"取当前语言"而非"忽略 en"。
     *   · 新增一条文案 = 在 `detail` 里加一个键，然后引用它 —— 不许就地写中文字面量。
     */
    const DICT = {
      zh: {
        nav: 'OpenCode',
        detail: {
          /** 卡片标题与描述行（官方卡片同款槽位）。归属注明 DshAgentHub。 */
          card: {
            desc: 'DshAgentHub 插件 · 在这里把本机 OpenCode 配成 dsh 工具，看下发记录与待批审批',
          },
          /** 三态徽标（未探测 / 服务缺失 / 已就绪）—— 判定见 badgeOf()。 */
          badge: {
            unknown: '… 未探测',
            serviceMissing: '○ 服务缺失',
            ready: '● 已就绪',
          },
          /** 模型行（文本框 + 候选目录）。 */
          model: {
            rowLabel: '模型',
            /** 哨兵选项：'' 的语义是"不固定"（建会话时不带 model，用服务默认）。 */
            unsetOption: '未固定（用服务默认）',
            /** 当前值不在候选目录里时的附加项后缀（不折叠成空值，也不静默改写用户设置）。 */
            notInCatalog: '（不在候选目录）',
            /** 计费三态标签 —— `isFree === null` **不得**折进免费/付费任一侧（契约见 StatusPayload.models）。 */
            freeTag: '（免费）',
            paidTag: '（付费）',
            priceUnknownTag: '（计费未知）',
            /** 下拉的 aria-label（不可见文案；行的可见标签在文本框上）。 */
            catalogLabel: '模型候选目录',
            hint: '格式 providerID/id（如 opencode/deepseek-v4.1-flash-free）；留空 = 用服务默认。',
          },
          /** 推理档位行（值域是服务实况，下列候选仅作提示 —— 真实取值以 host 载荷 variant.values 为准）。 */
          variant: {
            rowLabel: '推理档位',
            placeholder: '留空 = 模型默认档',
            hint: '档位名随模型而变（候选来自服务实况）。',
            availablePrefix: '可用档位：',
          },
          /** 配置块标题。 */
          config: {
            blockTitle: '配置',
          },
          /** 其余配置行（工作目录 / 绑定会话 / 服务目录 / 服务地址 / 等待上限）。 */
          form: {
            workspaceLabel: '工作目录',
            workspaceHint: '新建会话时的默认目录；留空 = 不上报，用服务端默认（复用既有会话时不生效）。',
            boundSessionLabel: '绑定会话',
            boundSessionHint: '固定在一条会话上下发（ses_ 开头）；留空 = 按亲和键自动复用或新建。',
            serviceDirLabel: '服务目录',
            serviceDirHint: 'service.json 所在目录覆盖；留空 = 自动发现。',
            baseUrlLabel: '服务地址',
            baseUrlHint: '覆盖 service.json 里通告的地址（如 http://127.0.0.1:49374）；留空 = 用它通告的地址。',
            waitTimeoutLabel: '等待上限',
            waitTimeoutHint: '单轮等待上限（毫秒）；超时不中断任务，只把在途态如实回传。',
          },
          /** 总闸开关行。 */
          toggle: {
            rowLabel: '启用',
          },
          /** 任务块（在途 + 最近一轮下发摘要）。 */
          task: {
            blockTitle: '任务',
            inFlightSome: (n) => '在途作业：' + n + ' 个运行中',
            /** 无下发记录的空态（有记录但字段缺 ⇒ 该行不渲染，见 TaskBlock）。 */
            empty: '暂无下发记录',
            sessionPrefix: '会话：',
            keyPrefix: '亲和键：',
            reused: '复用上次会话',
            newSession: '新建会话',
            outcomePrefix: '结果：',
            /** outcome → 人话（未知值走 L.shell.unknownText，不把枚举印给用户）。 */
            outcomes: {
              succeeded: '成功',
              failed: '失败',
              interrupted: '已中断',
            },
            replyPrefix: '回执：',
            replyNone: '（无正文）',
            replyMore: '…',
            reasonPrefix: '原因：',
            reasonCodePrefix: '原因码：',
            modelPrefix: '模型：',
            variantJoin: ' · 档位 ',
            costPrefix: '成本：',
            timePrefix: '时间：',
            none: '未知',
            /** 详情折叠（排障用）：摘录/投递/时刻/等待结论/用量/审批计数/判据证据。 */
            detailsSummary: '下发详情（排障用，默认收起）',
            promptPrefix: '下发文本：',
            deliveryPrefix: '投递方式：',
            acceptedPrefix: '受理时刻：',
            idlePrefix: '空闲时刻：',
            waitPrefix: '等待结论：',
            tokensPrefix: '本轮用量：',
            tokensIn: (n) => '输入 ' + n,
            tokensOut: (n) => '输出 ' + n,
            tokensReasoning: (n) => '推理 ' + n,
            approvalsPrefix: '审批请求：',
            approvalsCount: (n) => n + ' 条',
            evidencePrefix: '判据证据：',
          },
          /** 审批面（八步之 8）—— 唯一说"要不要人动手"的地方。 */
          approvals: {
            label: '审批：',
            loading: '读取中',
            none: '无待处理',
            unknown: '状态未知',
            /** 醒目行：点名工具（TOOL_APPROVALS 常量拼出，两处不各写一份字面量）。 */
            pendingSome: (n) => '有 ' + n + ' 条审批待处理 —— 用 ' + TOOL_APPROVALS + ' 工具列出/回复',
          },
          /** 状态块。 */
          status: {
            blockTitle: '状态',
            settingsPrefix: '设置：',
            /** settingsScope 快照的 status → 人话（未知值走 L.shell.unknownText）。 */
            settings: {
              loading: '读取中…',
              ready: '已就绪',
              unavailable: '不可用（设置服务未连接）',
            },
            readonly: ' · 只读，当前页面无法保存',
            routeDown: '状态读取失败：',
            runtimeLoading: '运行状态：读取中…',
            /** 原始读数两行（本包故意上主视图；见文件头"两处故意差异"）。 */
            registryPrefix: '注册：',
            probeReasonPrefix: '探测结论：',
            serviceMissing: '本机没找到可用的 OpenCode 服务（service.json 未命中或已失效）—— 先启动 OpenCode 桌面端，再点刷新。',
            diagnosticsSummary: '诊断信息（排障用，默认收起）',
          },
          /** 诊断折叠内部行。 */
          diag: {
            servicePathPrefix: '探测路径：',
            baseUrlPrefix: '服务地址：',
            versionPrefix: '服务版本：',
            pidPrefix: '服务 PID：',
            endpointPrefix: '诊断接口：',
          },
          /** 卡片外壳与操作面。 */
          shell: {
            refresh: '刷新状态',
            refreshHint: '重新拉取运行状态（不改配置）',
            collapse: '收起设置',
            expand: '展开设置',
            /** 无 scope 兜底（configForms.get 返回空时）—— 不写宿主服务名，用户查不到这个符号。 */
            scopeMissing: 'OpenCode：设置服务不可用。',
            /** 加载骨架：载荷未到达时的**唯一**占位（各行不再各自报"读取中"）。 */
            skeleton: '加载中…',
            /** 写失败 Toast 前缀（scope.set 被拒时如实说出来，不静默吞掉）。 */
            toastPrefix: '保存失败：',
            toastDismiss: '关闭',
            /** 等待上限输入非法：只提示、不回写（不把 NaN 写进设置树）。 */
            numberInvalid: '不是有效数字，未保存',
            /** 枚举值不认识时的统一兜底（宁可说"未知"，也不把机器标识符印给用户）。 */
            unknownText: '未知',
          },
        },
      },
      en: { nav: 'OpenCode' },
    };

    /**
     * 卡内文案的取用点：`L.<group>.<key>`。
     * 只读 `zh` 子表（理由见 DICT 头注）；缺段时按"读不到"处理（本文件按组引用，不做空段兜底钩子）。
     */
    const L = DICT.zh.detail;

    /**
     * 枚举 → 界面文案时的**兜底**（承接 WorkBuddy 纪律）：
     * 宿主一旦新增/改名枚举值（老插件对新宿主），`TABLE[value] ?? String(value)` 会把机器标识符
     * 直接印到卡上 —— 用户既看不懂也没法据此判断。未知就老老实实说"未知"；真值在载荷里。
     * @param {Record<string, string>} table
     * @param {unknown} value
     * @param {string} fallback
     */
    function enumText(table, value, fallback) {
      return Object.hasOwn(table, value) ? table[value] : fallback;
    }

    /**
     * 三态徽标判定 —— 卡片上回答"服务到底在不在"的那一个符号。
     *
     * 判定顺序（与需求逐条对应）：
     *   ① `probe.installed === false` 或 `registry === 'SERVICE_MISSING'` ⇒ 服务缺失；
     *      （installed 优先于 registry 文字：探测结论是证据，registry 是注册流程的账。）
     *   ② `REGISTERED` / `UNREGISTERED` / `DEGRADED` ⇒ 已就绪
     *      （UNREGISTERED 多半只是总闸没开、DEGRADED 是带残缺可用 —— 都是"服务在"）；
     *   ③ 载荷未到达 / registry 未知值 ⇒ 未探测 —— **不**在没证据时宣称"已就绪"。
     *
     * @param {object|null|undefined} status StatusPayload（未到达为 null）
     * @returns {{slug: 'unknown'|'service-missing'|'ready', text: string}}
     */
    function badgeOf(status) {
      if (status === null || status === undefined) {
        return { slug: 'unknown', text: L.badge.unknown };
      }
      const registry = typeof status.registry === 'string' ? status.registry : '';
      const probe = status.probe !== null && typeof status.probe === 'object' ? status.probe : null;
      if (registry === 'SERVICE_MISSING' || (probe !== null && probe.installed === false)) {
        return { slug: 'service-missing', text: L.badge.serviceMissing };
      }
      if (registry === 'REGISTERED' || registry === 'UNREGISTERED' || registry === 'DEGRADED') {
        return { slug: 'ready', text: L.badge.ready };
      }
      return { slug: 'unknown', text: L.badge.unknown };
    }

    /**
     * `providerID/id` 引用合成（缺哪半用另一半；两半都缺 ⇒ ''，调用方据此不渲染该行）。
     * 单一来源：候选目录、当前值回显、lastRun 模型行都走它 —— 两处各拼一遍必然漂。
     */
    function refText(providerID, id) {
      if (providerID !== '' && id !== '') return providerID + '/' + id;
      return id !== '' ? id : providerID;
    }

    /** 计费三态 → 选项后缀（`null` 是"未知"，既不折成免费也不折成付费）。 */
    function priceTag(isFree) {
      if (isFree === true) return L.model.freeTag;
      if (isFree === false) return L.model.paidTag;
      return L.model.priceUnknownTag;
    }

    /**
     * 候选目录（payload.models[]）→ 下拉选项行。
     * 契约：`{id, providerID, label, variants, isFree: boolean|null, …}`；选项文本 = `providerID/id` + 计费标签。
     * 去重只按合成后的引用；`isFree === null` 的三态在该行文本里如实成"（计费未知）"。
     * @param {Array<object>|null|undefined} models payload.models
     */
    function buildModelOptions(models) {
      const seen = new Set();
      const rows = [];
      for (const m of Array.isArray(models) ? models : []) {
        const providerID = m && typeof m.providerID === 'string' ? m.providerID : '';
        const id = m && typeof m.id === 'string' ? m.id : '';
        const ref = refText(providerID, id);
        if (ref === '' || seen.has(ref)) continue;
        seen.add(ref);
        rows.push({ ref, label: ref + priceTag(m.isFree) });
      }
      return rows;
    }

    /**
     * 状态 bridge 读取（同源相对路径；非 2xx 抛错 —— 不把失败当数据）。
     * @param {AbortSignal} [signal]
     */
    async function fetchStatus(signal) {
      const response = await fetch(ROUTE_STATUS, { signal });
      if (!response.ok) throw new Error('status HTTP ' + String(response.status));
      return await response.json();
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /** 数值 → 显示字符串（非有限数 ⇒ ''，调用方据此走"未知"分支，不谎报 0）。 */
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
      try {
        return new Date(ms).toLocaleString();
      } catch {
        // 时间印不出就不印（返回 '' ⇒ 调用方写"未知"），不挡其余行。
        return '';
      }
    }

    /**
     * 回执摘录：折叠空白 → 截断（>REPLY_EXCERPT_LIMIT 加 `…`）→ 空正文说"（无正文）"。
     * ★ 三种结果都不留给用户空白（空正文与没读到正文不是同一件事，但都必须说出来）。
     */
    function replyExcerpt(reply) {
      const one = String(reply ?? '').replace(/\s+/g, ' ').trim();
      if (one === '') return L.task.replyNone;
      return one.length > REPLY_EXCERPT_LIMIT ? one.slice(0, REPLY_EXCERPT_LIMIT) + L.task.replyMore : one;
    }

    /** lastRun.model（{id, providerID, variant}|null）→ 人话（缺字段 ⇒ "未知"，不编造）。 */
    function modelRefText(model) {
      if (model === null || typeof model !== 'object') return L.task.none;
      const providerID = typeof model.providerID === 'string' ? model.providerID : '';
      const id = typeof model.id === 'string' ? model.id : '';
      const ref = refText(providerID, id);
      if (ref === '') return L.task.none;
      const variant = typeof model.variant === 'string' && model.variant !== ''
        ? L.task.variantJoin + model.variant
        : '';
      return ref + variant;
    }

    /**
     * 成本（USD）→ `$0.1234` 形态（去尾零；非有限数 ⇒ "未知"）。
     * ★ `$` 挂在**有值**分支上：前缀里带 `$` 会把未知印成 `成本：$未知`
     *   （"$未知"读起来像一笔 0 元账 —— 正是"缺数据不许写成数值"的反面）。
     */
    function costText(cost) {
      if (typeof cost !== 'number' || !Number.isFinite(cost)) return L.task.none;
      return '$' + String(Number(cost.toFixed(4)));
    }

    // ───────────────────────── CSS（去重注入；iOS 克制风 · token 化） ─────────────────────────
    // 基线 = plugin-workbuddy 卡的同一套克制原则：浅色 12px 圆角描边、控件去边框化（灰底 pill / iOS 开关）、
    // 层级靠字号与字色（15/600 · 13 · 12 tertiary）、颜色全部走 dsh token（--dsw-alias-*，深浅主题自动跟随）。
    // ★ 两个 token 名是实测真名（写错会静默落 fallback、深浅色不受控）：
    //   警告色 = `--dsw-alias-state-warn-primary`（**不存在** `--dsw-alias-state-warning-primary`）；
    //   开关拇指 = `--dsw-alias-switch-thumb`（浅色=白 / 深色=中性蓝灰）。
    const CARD_CSS =
      '.dsh-oc-card{list-style:none;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}' +
      '.dsh-oc-card:hover{border-color:var(--dsw-alias-label-dimmed)}' +
      '.dsh-oc-card--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.dsh-oc-card__head{display:flex;align-items:center}' +
      '.dsh-oc-card__toggle{appearance:none;flex:1;min-width:0;display:flex;align-items:center;gap:12px;background:0 0;border:0;border-radius:10px;padding:12px 14px;font:inherit;color:inherit;text-align:left;cursor:pointer}' +
      '.dsh-oc-card__toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dsh-oc-card__toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}' +
      '.dsh-oc-card__head-text{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}' +
      '.dsh-oc-card__title-row{display:flex;align-items:center;gap:8px;min-width:0}' +
      '.dsh-oc-card__title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.dsh-oc-card__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.45}' +
      '.dsh-oc-card__chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:flex;transition:transform .16s}' +
      '.dsh-oc-card__chevron--open{transform:rotate(180deg)}' +
      '.dsh-oc-card__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 14px;padding:14px 0;display:flex;flex-direction:column;gap:14px}' +
      '.dsh-oc-block-title{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;line-height:1.5}' +
      '.dsh-oc-task{display:flex;flex-direction:column;gap:5px}' +
      '.dsh-oc-group{display:flex;flex-direction:column;gap:10px}' +
      '.dsh-oc-card__actions{display:flex;justify-content:flex-end}' +
      '.dsh-oc-card__refresh{appearance:none;border:0;background:0 0;font:inherit;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-state-business-primary);cursor:pointer;padding:4px 8px;border-radius:6px;transition:background-color .15s}' +
      '.dsh-oc-card__refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dsh-oc-card__refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}' +
      '.dsh-oc-skeleton{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}' +
      '.dsh-oc-toast{display:flex;align-items:center;gap:8px;border-radius:8px;padding:8px 10px;background:var(--dsw-alias-fill-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:1.5;cursor:pointer}' +
      '.dsh-oc-badge{flex:none;padding:1px 8px;border-radius:999px;white-space:nowrap;background:var(--dsw-alias-fill-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}' +
      '.dsh-oc-badge--ready{color:var(--dsw-alias-state-business-primary)}' +
      '.dsh-oc-badge--service-missing{color:var(--dsw-alias-state-warn-primary)}' +
      '.dsh-oc-row{display:grid;grid-template-columns:5.5em minmax(0,1fr);align-items:center;column-gap:12px;row-gap:3px;font-size:13px;line-height:1.5}' +
      '.dsh-oc-row__label{color:var(--dsw-alias-label-secondary)}' +
      '.dsh-oc-row__hint{grid-column:1/-1;color:var(--dsw-alias-label-tertiary);font-size:12px}' +
      '.dsh-oc-row>.dsh-oc-warn{grid-column:1/-1}' +
      '.dsh-oc-switch{appearance:none;-webkit-appearance:none;justify-self:end;flex:none;width:36px;height:22px;margin:0;border-radius:11px;background:var(--dsw-alias-border-l4);position:relative;cursor:pointer;transition:background-color .2s ease}' +
      '.dsh-oc-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s ease}' +
      '.dsh-oc-switch:checked{background:var(--dsw-alias-state-business-primary)}' +
      '.dsh-oc-switch:checked::after{transform:translateX(14px)}' +
      '.dsh-oc-switch:disabled{opacity:.38;cursor:default}' +
      '.dsh-oc-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.dsh-oc-input,.dsh-oc-select{font:inherit;font-size:13px;width:100%;min-width:0;max-width:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-border-l1,rgba(0,0,0,.04));border:0;border-radius:8px;padding:5px 10px}' +
      '.dsh-oc-select option{padding:5px 8px}' +
      '.dsh-oc-row--model,.dsh-oc-row--variant{grid-template-columns:minmax(0,1fr);row-gap:6px}' +
      '.dsh-oc-warn{color:var(--dsw-alias-state-warn-primary)}' +
      '.dsh-oc-status{display:flex;flex-direction:column;gap:5px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}' +
      '.dsh-oc-status .dsh-oc-status__line{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}' +
      '.dsh-oc-status .dsh-oc-diag .dsh-oc-status__line{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}' +
      '.dsh-oc-approvals{font-size:13px;line-height:1.55}' +
      '.dsh-oc-status .dsh-oc-approvals--pending{color:var(--dsw-alias-state-warn-primary);font-weight:500}' +
      '.dsh-oc-status__mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}' +
      '.dsh-oc-status__line[data-kv]{padding-left:6.5em;text-indent:-6.5em}' +
      '.dsh-oc-evidence{margin:0;padding-left:18px;font-size:12px}' +
      '.dsh-oc-diag{margin-top:6px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));padding-top:4px}' +
      '.dsh-oc-diag__summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-tertiary);list-style:none}' +
      '.dsh-oc-diag__summary::-webkit-details-marker{display:none}' +
      '.dsh-oc-diag__summary::before{content:"▸ ";color:var(--dsw-alias-label-tertiary)}' +
      '.dsh-oc-diag[open]>.dsh-oc-diag__summary::before{content:"▾ "}' +
      '.dsh-oc-diag__body{padding-top:2px}';

    const CSS_TAG_ID = PACKAGE_NAME + '/ConfigCard.css';
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null
    ) {
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_NAME;
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }

    // ───────────────────────── 组件（单文件内合并；纯展示组件无内部状态） ─────────────────────────

    /**
     * 折叠 chevron（open 时旋转 180°）。
     * 用 primitives 公开导出的 `IconChevronDownOutlineRegular`，按 dsh 自身用法只传 `{}`
     * （尺寸默认 14 由图形自身兜底；**不存在** `…14` 这个名字）。
     */
    function Chevron(props) {
      return h(
        'span',
        { className: 'dsh-oc-card__chevron' + (props.open ? ' dsh-oc-card__chevron--open' : '') },
        h(IconChevronDownOutlineRegular, {}),
      );
    }

    /** 三态徽标（判定见 badgeOf；类名 slug 供样式区分语气）。 */
    function StatusBadge(props) {
      const decided = badgeOf(props.status);
      return h('span', { className: 'dsh-oc-badge dsh-oc-badge--' + decided.slug }, decided.text);
    }

    /** 总闸开关行（iOS 式开关；语义仍是 checkbox input）。 */
    function SwitchRow(props) {
      return h('label', { className: 'dsh-oc-row dsh-oc-row--switch' }, [
        h('span', { className: 'dsh-oc-row__label', key: 'label' }, props.label),
        h('input', {
          key: 'input',
          type: 'checkbox',
          className: 'dsh-oc-switch',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: props.onChange,
        }),
        props.hint ? h('span', { className: 'dsh-oc-row__hint', key: 'hint' }, props.hint) : null,
      ]);
    }

    /** 文本/数字输入行（标签列 + 控件 + 提示行；只读时禁用）。 */
    function FieldRow(props) {
      return h('div', { className: 'dsh-oc-row dsh-oc-row--field' }, [
        h('label', { className: 'dsh-oc-row__label', key: 'label', htmlFor: props.id }, props.label),
        h('input', {
          key: 'input',
          id: props.id,
          type: props.type === 'number' ? 'number' : 'text',
          className: 'dsh-oc-input',
          value: props.value,
          spellCheck: false,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.hint ? h('span', { className: 'dsh-oc-row__hint', key: 'hint' }, props.hint) : null,
      ]);
    }

    /**
     * 模型行：文本框（真源，可手输任意 `providerID/id`）+ 候选目录下拉（只做投递，不替代文本框）
     * + 说明行。哨兵选项 `''` = "未固定（用服务默认）"；当前值不在目录里时**附加**一个
     * `值（不在候选目录）` 选项 —— 既不丢用户设置，也不假装它在目录里。
     */
    function ModelRow(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      const value = typeof props.value === 'string' ? props.value : '';
      const missing = value !== '' && !options.some((m) => m.ref === value);
      return h('div', { className: 'dsh-oc-row dsh-oc-row--model' }, [
        h('label', { className: 'dsh-oc-row__label', key: 'label', htmlFor: 'dsh-oc-model' }, L.model.rowLabel),
        h('input', {
          key: 'input',
          id: 'dsh-oc-model',
          type: 'text',
          className: 'dsh-oc-input',
          value,
          spellCheck: false,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }),
        h(
          'select',
          {
            key: 'select',
            id: 'dsh-oc-model-catalog',
            className: 'dsh-oc-select',
            'aria-label': L.model.catalogLabel,
            value,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.value),
          },
          [
            h('option', { key: '__unset', value: '' }, L.model.unsetOption),
            ...(missing
              ? [h('option', { key: '__current', value }, value + L.model.notInCatalog)]
              : []),
            ...options.map((m) => h('option', { key: m.ref, value: m.ref }, m.label)),
          ],
        ),
        h('span', { className: 'dsh-oc-row__hint', key: 'hint' }, L.model.hint),
      ]);
    }

    /**
     * 推理档位行：文本框 + 候选提示行（`variant.values` 来自服务实况；空数组 ⇒ 不渲染提示行
     * —— "没有候选"不是"候选为空字符串"，宁可少一行也不印一句空的"可用档位："）。
     */
    function VariantRow(props) {
      const values = Array.isArray(props.values)
        ? props.values.filter((v) => typeof v === 'string' && v !== '')
        : [];
      return h('div', { className: 'dsh-oc-row dsh-oc-row--variant' }, [
        h('label', { className: 'dsh-oc-row__label', key: 'label', htmlFor: 'dsh-oc-variant' }, L.variant.rowLabel),
        h('input', {
          key: 'input',
          id: 'dsh-oc-variant',
          type: 'text',
          className: 'dsh-oc-input',
          value: typeof props.value === 'string' ? props.value : '',
          spellCheck: false,
          placeholder: L.variant.placeholder,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }),
        h('span', { className: 'dsh-oc-row__hint', key: 'hint' }, L.variant.hint),
        values.length > 0
          ? h('span', { className: 'dsh-oc-row__hint', key: 'candidates' }, L.variant.availablePrefix + values.join('、'))
          : null,
      ]);
    }

    /**
     * 任务块：在途计数 + 最近一轮下发摘要 —— 主视图全是人话/可核对读数。
     *
     * 纪律：
     *   · 只在 `status` 非空时由卡片渲染（载荷未到达 ⇒ 不编造任何一行）；
     *   · 缺字段 ⇒ 不渲染该行（未知不编造；"有字段才上屏"）；
     *   · 详情（摘录/投递/时刻/等待结论/用量/证据）收进默认收起的 `<details>`。
     *
     * ★ 本包与 WorkBuddy 的字段表**不同**（LastRunRecord 见 src/host/types/index.js）：
     *   没有退出码/旗标/argv；成败只认 `outcome`（服务端结构化终态）+ `reasonCode`/`reasonText`。
     */
    function TaskBlock(props) {
      const status = props.status;
      const t = L.task;
      const lines = [];
      const fold = [];
      // ① 在途：>0 才有这一行（空态不写"在途作业：无"—— 少一行不构成隐瞒，多一行空话才是噪音）。
      const inFlight = Array.isArray(status.inFlight) ? status.inFlight.length : 0;
      if (inFlight > 0) {
        lines.push(
          h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'inflight' }, t.inFlightSome(String(inFlight))),
        );
      }
      const lastRun = status.lastRun !== null && typeof status.lastRun === 'object' ? status.lastRun : null;
      if (lastRun === null) {
        lines.push(h('div', { className: 'dsh-oc-status__line', key: 'empty' }, t.empty));
      } else {
        // ② 定位三行：会话 / 亲和键 / 本轮是新建还是复用（字段缺失则整行不渲染）。
        if (typeof lastRun.sessionId === 'string' && lastRun.sessionId !== '') {
          lines.push(h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'session' }, t.sessionPrefix + lastRun.sessionId));
        }
        if (typeof lastRun.sessionKey === 'string' && lastRun.sessionKey !== '') {
          lines.push(h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'session-key' }, t.keyPrefix + lastRun.sessionKey));
        }
        if (lastRun.resumed === true) {
          lines.push(h('div', { className: 'dsh-oc-status__line', key: 'resumed' }, t.reused));
        } else if (lastRun.resumed === false) {
          lines.push(h('div', { className: 'dsh-oc-status__line', key: 'resumed' }, t.newSession));
        }
        // ③ 结果（outcome → 人话；未知值说"未知"，不印枚举）。
        lines.push(
          h(
            'div',
            { className: 'dsh-oc-status__line', 'data-kv': '', key: 'outcome' },
            t.outcomePrefix + enumText(t.outcomes, lastRun.outcome, L.shell.unknownText),
          ),
        );
        // ④ 回执（成功也要有正文 —— 摘录见 replyExcerpt；全文在工具面）。
        lines.push(
          h(
            'div',
            { className: 'dsh-oc-status__line', 'data-kv': '', key: 'reply' },
            t.replyPrefix + replyExcerpt(lastRun.reply),
          ),
        );
        // ⑤ 原因（人话，`''` 不渲染）；原因码原样呈现（非 'ok' 才画 —— 'ok' 是"没有原因"的机器写法）。
        const reasonText = typeof lastRun.reasonText === 'string' ? lastRun.reasonText : '';
        const reasonCode = typeof lastRun.reasonCode === 'string' ? lastRun.reasonCode : '';
        if (reasonText !== '') {
          lines.push(h('div', { className: 'dsh-oc-status__line dsh-oc-warn', key: 'reason' }, t.reasonPrefix + reasonText));
        }
        if (reasonCode !== '' && reasonCode !== 'ok') {
          lines.push(h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'reason-code' }, t.reasonCodePrefix + reasonCode));
        }
        // ⑥ 是否了结：模型 / 成本 / 时间（缺 ⇒ 未知，不编造）。
        lines.push(
          h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'model' }, t.modelPrefix + modelRefText(lastRun.model)),
        );
        lines.push(
          h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'cost' }, t.costPrefix + costText(lastRun.cost)),
        );
        lines.push(
          h(
            'div',
            { className: 'dsh-oc-status__line', 'data-kv': '', key: 'at' },
            t.timePrefix + (formatTime(lastRun.at) || L.shell.unknownText),
          ),
        );
        // ⑦ 详情折叠（排障用；缺字段逐行跳过）。
        if (typeof lastRun.promptExcerpt === 'string' && lastRun.promptExcerpt !== '') {
          fold.push(h('div', { className: 'dsh-oc-status__line', key: 'fold-prompt' }, t.promptPrefix + lastRun.promptExcerpt));
        }
        if (typeof lastRun.delivery === 'string' && lastRun.delivery !== '') {
          fold.push(h('div', { className: 'dsh-oc-status__line', key: 'fold-delivery' }, t.deliveryPrefix + lastRun.delivery));
        }
        {
          const acceptedAt = formatTime(lastRun.acceptedAt);
          if (acceptedAt !== '') {
            fold.push(h('div', { className: 'dsh-oc-status__line', key: 'fold-accepted' }, t.acceptedPrefix + acceptedAt));
          }
          const idleAt = formatTime(lastRun.idleAt);
          if (idleAt !== '') {
            fold.push(h('div', { className: 'dsh-oc-status__line', key: 'fold-idle' }, t.idlePrefix + idleAt));
          }
        }
        if (typeof lastRun.waitStatus === 'string' && lastRun.waitStatus !== '') {
          fold.push(h('div', { className: 'dsh-oc-status__line', key: 'fold-wait' }, t.waitPrefix + lastRun.waitStatus));
        }
        {
          // 本轮用量：三项各自判定，有数才印（服务端 assistant 消息的 tokens）。
          const tokens = lastRun.tokens !== null && typeof lastRun.tokens === 'object' ? lastRun.tokens : null;
          const parts = [];
          if (tokens !== null) {
            if (typeof tokens.input === 'number' && Number.isFinite(tokens.input)) parts.push(t.tokensIn(String(tokens.input)));
            if (typeof tokens.output === 'number' && Number.isFinite(tokens.output)) parts.push(t.tokensOut(String(tokens.output)));
            if (typeof tokens.reasoning === 'number' && Number.isFinite(tokens.reasoning)) parts.push(t.tokensReasoning(String(tokens.reasoning)));
          }
          if (parts.length > 0) {
            fold.push(h('div', { className: 'dsh-oc-status__line', key: 'fold-tokens' }, t.tokensPrefix + parts.join(' · ')));
          }
        }
        // 审批请求**只报条数**：明细形状 [待验]，列/回走 opencode_approvals（审批面别处同样点名）。
        const permissionRequests = Array.isArray(lastRun.permissionRequests) ? lastRun.permissionRequests : [];
        if (permissionRequests.length > 0) {
          fold.push(
            h(
              'div',
              { className: 'dsh-oc-status__line', key: 'fold-approvals' },
              t.approvalsPrefix + t.approvalsCount(String(permissionRequests.length)),
            ),
          );
        }
        if (typeof lastRun.reasonEvidence === 'string' && lastRun.reasonEvidence !== '') {
          fold.push(
            h('div', { className: 'dsh-oc-status__line dsh-oc-status__mono', key: 'fold-evidence' }, t.evidencePrefix + lastRun.reasonEvidence),
          );
        }
      }
      const details = fold.length === 0
        ? null
        : h(
          'details',
          { className: 'dsh-oc-diag', key: 'details' },
          h('summary', { className: 'dsh-oc-diag__summary' }, t.detailsSummary),
          h('div', { className: 'dsh-oc-diag__body' }, fold),
        );
      return h('div', { className: 'dsh-oc-task' }, [
        h('div', { className: 'dsh-oc-block-title', key: 'title' }, t.blockTitle),
        ...lines,
        ...(details === null ? [] : [details]),
      ]);
    }

    /**
     * 审批面行（八步之 8 的可见性落点；判定顺序见注释）：
     *   · 载荷未到达 ⇒ 「读取中」（不猜"无审批"—— 那会把"不知道"说成"没事"）；
     *   · pendingCount 非有限数（老宿主缺字段）⇒ 「状态未知」；
     *   · pendingCount > 0 ⇒ **醒目警告行**（点名 opencode_approvals）—— 审批卡住 = 任务没坏但走不下去，
     *     这是整张卡最需要人动手的一件事；
     *   · 0 ⇒ 「无待处理」。
     * 明细 items[] 刻意不渲染（[待验]，见文件头）。
     */
    function approvalsLines(status) {
      const a = L.approvals;
      if (status === null || status === undefined) {
        return [h('div', { className: 'dsh-oc-status__line', key: 'approvals' }, a.label + a.loading)];
      }
      const approvals = status.approvals !== null && typeof status.approvals === 'object' ? status.approvals : null;
      const count = approvals !== null && typeof approvals.pendingCount === 'number' && Number.isFinite(approvals.pendingCount)
        ? approvals.pendingCount
        : null;
      if (count === null) {
        return [h('div', { className: 'dsh-oc-status__line', key: 'approvals' }, a.label + a.unknown)];
      }
      if (count > 0) {
        return [
          h(
            'div',
            { className: 'dsh-oc-approvals dsh-oc-approvals--pending', key: 'approvals' },
            a.pendingSome(String(count)),
          ),
        ];
      }
      return [h('div', { className: 'dsh-oc-status__line', key: 'approvals' }, a.label + a.none)];
    }

    /**
     * 状态块：设置读取态 + 注册（原样）+ 探测结论（原样）+ 审批面 + 诊断折叠。
     *
     * ★ 折叠纪律（本包口径）：本机路径（servicePath）/ 候选地址 / 探测证据逐条**只进折叠**；
     *   `注册` 与 `探测结论` 两串按需求上主视图（可核对读数，见文件头"两处故意差异"）。
     */
    function StatusBlock(props) {
      const snap = props.snap ?? {};
      const status = props.status;
      const s = L.status;
      const d = L.diag;
      const lines = [];
      const diag = [];

      lines.push(
        h(
          'div',
          { className: 'dsh-oc-status__line', 'data-kv': '', key: 'settings' },
          s.settingsPrefix
            + enumText(s.settings, snap.status, L.shell.unknownText)
            + (snap.writable === false ? s.readonly : ''),
        ),
      );
      if (status !== null && status !== undefined) {
        // 原始读数两行（registry / probe.reason）—— 判定依据对用户可见，才谈得上"可核对"。
        if (typeof status.registry === 'string' && status.registry !== '') {
          lines.push(h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'registry' }, s.registryPrefix + status.registry));
        }
        const probe = status.probe !== null && typeof status.probe === 'object' ? status.probe : null;
        if (probe !== null && typeof probe.reason === 'string' && probe.reason !== '') {
          lines.push(h('div', { className: 'dsh-oc-status__line', 'data-kv': '', key: 'probe-reason' }, s.probeReasonPrefix + probe.reason));
        }
      }
      if (props.failure !== '') {
        lines.push(h('div', { className: 'dsh-oc-status__line dsh-oc-warn', key: 'failure' }, s.routeDown + props.failure));
      }
      if (status === null || status === undefined) {
        lines.push(h('div', { className: 'dsh-oc-status__line', key: 'loading' }, s.runtimeLoading));
      } else if (badgeOf(status).slug === 'service-missing') {
        // 服务缺失时给一句可执行的话（唯一动作：把桌面端打开）。
        lines.push(h('div', { className: 'dsh-oc-status__line', key: 'missing' }, s.serviceMissing));
      }
      lines.push(...approvalsLines(status));
      // 诊断折叠：只在载荷到达后画（里面至少有一条"诊断接口"；不 fetch —— 人工查障入口）。
      if (status !== null && status !== undefined) {
        const probe = status.probe !== null && typeof status.probe === 'object' ? status.probe : null;
        const pushMono = (key, text) => {
          if (text !== '') diag.push(h('div', { className: 'dsh-oc-status__line dsh-oc-status__mono', key }, text));
        };
        if (probe !== null) {
          pushMono('diag-service-path', typeof probe.servicePath === 'string' && probe.servicePath !== '' ? d.servicePathPrefix + probe.servicePath : '');
          pushMono('diag-base-url', typeof probe.baseUrl === 'string' && probe.baseUrl !== '' ? d.baseUrlPrefix + probe.baseUrl : '');
          pushMono('diag-version', typeof probe.version === 'string' && probe.version !== '' ? d.versionPrefix + probe.version : '');
          if (typeof probe.pid === 'number' && Number.isFinite(probe.pid)) {
            pushMono('diag-pid', d.pidPrefix + String(probe.pid));
          }
          const evidence = Array.isArray(probe.evidence) ? probe.evidence : [];
          if (evidence.length > 0) {
            diag.push(
              h(
                'ul',
                { className: 'dsh-oc-evidence', key: 'diag-evidence' },
                // 逐条印 `target · detail`（探测留痕）；**不**印 method（恒为 'read-only'，零信息量）。
                evidence.map((e, i) =>
                  h(
                    'li',
                    { key: String(i) },
                    (typeof e.target === 'string' ? e.target : '') + ' · ' + (typeof e.detail === 'string' ? e.detail : ''),
                  ),
                ),
              ),
            );
          }
        }
        diag.push(h('div', { className: 'dsh-oc-status__line dsh-oc-status__mono', key: 'diag-endpoint' }, d.endpointPrefix + ROUTE_DIAGNOSTICS));
      }
      const diagnostics = diag.length === 0
        ? null
        : h(
          'details',
          { className: 'dsh-oc-diag', key: 'diag' },
          h('summary', { className: 'dsh-oc-diag__summary' }, s.diagnosticsSummary),
          h('div', { className: 'dsh-oc-diag__body' }, diag),
        );
      return h('div', { className: 'dsh-oc-status' }, [
        h('div', { className: 'dsh-oc-block-title', key: 'title' }, s.blockTitle),
        ...lines,
        ...(diagnostics === null ? [] : [diagnostics]),
      ]);
    }

    /**
     * 配置卡片主体（scope 走**闭包** —— 子标签槽的渲染处只递空 props，
     * 注册项上的 `inject` 在本槽被忽略；组件拿不到 scope，必须闭进来）。
     *
     * ★ 取值口径（本卡自己的投影规则，测试两个方向都钉住）：
     *   · `enabled`：**只认**快照（总闸是本页写的，快照就是真源；不拿载荷回灌）；
     *   · 文本字段：快照值是字符串 ⇒ 用它（含用户清空的 ''）；否则用 `status.config[name]`
     *     投影（StatusPayload.config —— 让"设置服务还在读"时也能看到生效配置）；
     *   · `waitTimeoutMs`：快照/载荷里的有限数按序取，都没有 ⇒ 显示空（不发明默认值）。
     *   写入一律 `scope.set(field, value)`（不做本地乐观改写 —— 快照是唯一回显来源）。
     *
     * @param {object|undefined} scope `ctx.configForms.get(NS)` 的返回面
     */
    const makeConfigCard = (scope) => function ConfigCard(props) {
      void props;
      const [snap, setSnap] = useState(() => (scope ? scope.getSnapshot() : { status: 'unavailable', value: undefined, writable: false }));
      useEffect(() => (scope ? scope.subscribe(() => setSnap(scope.getSnapshot())) : undefined), [scope]);

      const [status, setStatus] = useState(null);
      const [failure, setFailure] = useState('');
      const [refreshNonce, setRefreshNonce] = useState(0);
      // 收纳语义沿用宿主惯例：状态 null = "用户尚未表态" ⇒ 落到本区默认值（本卡是主内容 ⇒ 默认展开）。
      const [open, setOpen] = useState(null);
      const effectiveOpen = open ?? true;
      // 写失败/非法输入的 Toast：点按关闭；成功写入不碰它。
      const [toast, setToast] = useState('');
      // [待验] 卡片的实时性：只在挂载 + 手动刷新时拉一次（不轮询；桌面端对 API 新建会话的
      // 自动刷新行为未在真机核对过，所以这里也不假装"会被推送"）。
      useEffect(() => {
        if (!scope) return undefined;
        let live = true;
        const controller = new AbortController();
        fetchStatus(controller.signal)
          .then((payload) => {
            if (!live) return;
            setStatus(payload);
            setFailure('');
          })
          .catch((error) => {
            // 过期/被中止的请求不写失败（刷新竞态下旧的失败会盖掉新的成功）。
            if (live && !controller.signal.aborted) setFailure(errorText(error));
          });
        return () => {
          live = false;
          controller.abort();
        };
      }, [scope, refreshNonce]);

      if (!scope) {
        return h('div', { className: 'dsh-oc-card' }, L.shell.scopeMissing);
      }

      const value = snap && typeof snap.value === 'object' && snap.value !== null ? snap.value : {};
      const writable = snap.status === 'ready' && snap.writable === true;
      const cfg = status && status.config !== null && typeof status.config === 'object' ? status.config : null;
      /** 文本字段投影：快照字符串优先，载荷 `status.config[name]` 兜底。 */
      const fieldText = (name) => {
        const raw = value ? value[name] : undefined;
        if (typeof raw === 'string') return raw;
        const fromPayload = cfg ? cfg[name] : undefined;
        return typeof fromPayload === 'string' ? fromPayload : '';
      };
      /** 数值字段投影（waitTimeoutMs）：快照有限数优先，载荷兜底，没有 ⇒ ''。 */
      const waitValue = (() => {
        const raw = value ? value.waitTimeoutMs : undefined;
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        const fromPayload = cfg ? cfg.waitTimeoutMs : undefined;
        return typeof fromPayload === 'number' && Number.isFinite(fromPayload) ? fromPayload : '';
      })();
      const models = status && Array.isArray(status.models) ? status.models : [];
      const modelOptions = buildModelOptions(models);
      const variantValues = status && status.variant !== null && typeof status.variant === 'object' && Array.isArray(status.variant.values)
        ? status.variant.values
        : [];

      // 写失败由 Toast 如实说出来（scope.set 被拒时不静默吞掉 —— 用户点了开关没动静只会再点一次）。
      const write = (field, next) => {
        scope.set(field, next).catch((error) => setToast(L.shell.toastPrefix + errorText(error)));
      };
      // 等待上限：只回写有限非负数（parseInt 语义）；非法输入 ⇒ 提示，不动设置树。
      const onWaitTimeout = (next) => {
        const parsed = Number.parseInt(String(next), 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setToast(L.shell.numberInvalid);
          return;
        }
        write('waitTimeoutMs', parsed);
      };

      // 加载骨架：载荷未到达**且**没有失败时，内容区只有**一个**骨架占位；
      // 路由失败时不走这里 —— 失败有明确来由，必须显式上屏（见 StatusBlock）。
      const body = status === null && failure === ''
        ? h('div', { className: 'dsh-oc-card__body', key: 'body' }, [
          h('div', { className: 'dsh-oc-skeleton', key: 'skeleton' }, L.shell.skeleton),
        ])
        : h('div', { className: 'dsh-oc-card__body', key: 'body' }, [
          toast !== ''
            ? h('div', {
              key: 'toast',
              className: 'dsh-oc-toast',
              role: 'alert',
              title: L.shell.toastDismiss,
              onClick: () => setToast(''),
            }, toast)
            : null,
          // ② 任务块：只在载荷到达后画（未到达 = 不编造任何一行；骨架/失败行已由别处承担）。
          status === null || status === undefined ? null : h(TaskBlock, { key: 'task', status }),
          // ③ 配置组：总闸 + 模型 + 档位 + 五个字段行。
          h('div', { className: 'dsh-oc-group', key: 'controls' }, [
            h('div', { className: 'dsh-oc-block-title', key: 'title' }, L.config.blockTitle),
            // ★ 总闸只在**不可写**时置灰 —— 服务缺失**不**禁用开关：enabled 是授权总闸，
            //   "开了但服务没起来"是合法状态（reason-codes.js 里 service_missing 就是为此存在的），
            //   禁用反而让用户没法提前配好。
            h(SwitchRow, {
              key: 'switch',
              label: L.toggle.rowLabel,
              checked: value.enabled === true,
              disabled: !writable,
              onChange: () => write('enabled', value.enabled !== true),
            }),
            h(ModelRow, {
              key: 'model',
              value: fieldText('model'),
              options: modelOptions,
              disabled: !writable,
              onChange: (next) => write('model', next),
            }),
            h(VariantRow, {
              key: 'variant',
              value: fieldText('variant'),
              values: variantValues,
              disabled: !writable,
              onChange: (next) => write('variant', next),
            }),
            h(FieldRow, {
              key: 'workspace',
              id: 'dsh-oc-workspace',
              label: L.form.workspaceLabel,
              hint: L.form.workspaceHint,
              value: fieldText('workspace'),
              disabled: !writable,
              onChange: (next) => write('workspace', next),
            }),
            h(FieldRow, {
              key: 'bound-session',
              id: 'dsh-oc-bound-session',
              label: L.form.boundSessionLabel,
              hint: L.form.boundSessionHint,
              value: fieldText('boundSessionId'),
              disabled: !writable,
              onChange: (next) => write('boundSessionId', next),
            }),
            h(FieldRow, {
              key: 'service-dir',
              id: 'dsh-oc-service-dir',
              label: L.form.serviceDirLabel,
              hint: L.form.serviceDirHint,
              value: fieldText('serviceDir'),
              disabled: !writable,
              onChange: (next) => write('serviceDir', next),
            }),
            h(FieldRow, {
              key: 'base-url',
              id: 'dsh-oc-base-url',
              label: L.form.baseUrlLabel,
              hint: L.form.baseUrlHint,
              value: fieldText('baseUrl'),
              disabled: !writable,
              onChange: (next) => write('baseUrl', next),
            }),
            h(FieldRow, {
              key: 'wait-timeout',
              id: 'dsh-oc-wait-timeout',
              label: L.form.waitTimeoutLabel,
              hint: L.form.waitTimeoutHint,
              type: 'number',
              value: waitValue === '' ? '' : String(waitValue),
              disabled: !writable,
              onChange: onWaitTimeout,
            }),
          ]),
          h(StatusBlock, { key: 'status', snap, status, failure }),
          // ④ 操作区："刷新状态"只重拉状态区（按钮 title 明确说不碰配置）。
          h('div', { className: 'dsh-oc-card__actions', key: 'actions' }, [
            h(
              'button',
              {
                className: 'dsh-oc-card__refresh',
                key: 'refresh',
                type: 'button',
                title: L.shell.refreshHint,
                onClick: () => {
                  setFailure('');
                  setRefreshNonce((n) => n + 1);
                },
              },
              L.shell.refresh,
            ),
          ]),
        ]);

      return h('section', { className: 'dsh-oc-card' + (effectiveOpen ? ' dsh-oc-card--open' : '') }, [
        h('header', { className: 'dsh-oc-card__head', key: 'head' }, [
          h(
            'button',
            {
              className: 'dsh-oc-card__toggle',
              key: 'toggle',
              type: 'button',
              'aria-expanded': effectiveOpen,
              'aria-label': (effectiveOpen ? L.shell.collapse : L.shell.expand) + ': OpenCode',
              onClick: () => setOpen(!effectiveOpen),
            },
            [
              h('span', { className: 'dsh-oc-card__head-text', key: 'text' }, [
                h('span', { className: 'dsh-oc-card__title-row', key: 'title-row' }, [
                  h('span', { className: 'dsh-oc-card__title', key: 'title' }, 'OpenCode'),
                  // 收起态**只有**这一行（标题 + 徽标 + chevron），不画摘要 —— 摘要要证明的
                  // "现在能不能用"已由徽标说清，再抄一遍配置就成了第二份要维护的真相。
                  // 收起态判定的 registry 未知值先说"未知"（badgeOf 的兜底），不悬空。
                  h(StatusBadge, { status, key: 'badge' }),
                ]),
                effectiveOpen ? h('span', { className: 'dsh-oc-card__desc', key: 'desc' }, L.card.desc) : null,
              ]),
              h(Chevron, { open: effectiveOpen, key: 'chevron' }),
            ],
          ),
        ]),
        effectiveOpen ? body : null,
      ]);
    };

    // ───────────────────────── 装配（cordis 插件对象形态） ─────────────────────────

    /**
     * @param {object} ctx 浏览器插件上下文（fiber inject 保证三服务就绪后才回调）。
     */
    function apply(ctx) {
      // 0.1.7 迁移三处（与 plugin-workbuddy 同款，事故见该文件头注）：
      //   ① `ctx.settingsScope.bind({namespace})` → `ctx.configForms.get(NS)`；
      //   ② 槽 `settings.plugin.item`（已删）→（2026-10-15 起）「Harness 接入」父条目的
      //      子标签槽 `settings.harness-hub.tab`（更早先落在 `settings.section` 独立条目）；
      //   ③ `locale` 是必需 inject（`t` 靠注册项的 `locale` 选项获得）。
      const scope = ctx.configForms.get(NS);
      ctx.effect(() => ctx.locale.register(NS, DICT), PACKAGE_NAME + ': dictionaries');
      // ★ 2026-10-15 hub 合并：从「设置导航栏独立条目」迁移到「Harness 接入」（dsh-plugin-
      //   harness-hub）父条目的**子标签槽**。父条目注册时以 children 声明该槽（kind=list）；
      //   槽未声明时注册会抛 SlotCore 的 "not declared" ⇒ 用 `slots.inject` 等声明出现再注册
      //   （父条目不在场 ⇒ 本回调不触发 = 本条目不出现 —— 父是唯一入口）。
      ctx.slots.inject(HUB_TAB_SLOT, () =>
        ctx.slots.register(
          {
            name: HUB_TAB_SLOT,
            id: HUB_TAB_ID,
            order: HUB_TAB_ORDER,
            // 0.1.7 的列表注册项用 `label` thunk + `locale`，不用 `key`。
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            // ★ **没有 `inject`**：标签由壳以 `renderSlot(HUB_TAB_SLOT, {}, { only })` 渲染，
            //   只递空 props；配置面（scope）走**闭包**（见 makeConfigCard 头注）。
          },
          makeConfigCard(scope),
        ),
      );
    }

    /**
     * 必需服务（cordis fiber inject）—— **硬依赖门限**：任何一项在当前宿主里不存在，
     * 该插件就永远 `pending`，web boot 完整性校验失败会拒绝启动整个 DSH（2026-10-01 真机事故）。
     *   - `slots`       = ui-renderer
     *   - `locale`      = ui-locale（0.1.7 新增）
     *   - `configForms` = ui-settings（0.1.7 原 settingsScope）
     */
    const inject = ['slots', 'locale', 'configForms'];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
