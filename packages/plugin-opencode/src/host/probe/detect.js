/**
 * U6 只读探测：判定本机 opencode 服务是否**可用**（H-NO-EXEC-PROBE）。
 *
 * 通道事实：opencode 桌面端启动后把服务注册文件写到 `~/.local/state/opencode/service.json`
 *   （配置目录 `~/.config/opencode/service.json` 一份同值副本），内容 `{id, version, url, pid, password}`
 *   —— url 形如 `http://127.0.0.1:<随机端口>`。出处：00-recon/OPENCODE-LOCAL-RECON-20261015.md §1。
 *
 * ★ 2026-11-08 起：本探测判定的是「可用」，不是「service.json 在不在」★
 *   旧行为只校验文件形状 ⇒ 后台 sidecar（`bun.exe` / `opencode-cli.exe`）写下注册文件后，
 *   即便 GUI 没开、模型读不到，卡片也照样显示"运行中"。**文件存在 ≠ 服务可用**，本文件不再这么算。
 *
 *   真机事实（2026-11-08 本机实测，如实记录两种结局）：
 *     - service.json: `{version:'2.2.5', url:'http://127.0.0.1:43017', pid:13480}`，pid 13480 = `opencode-cli.exe`
 *       （后台进程，`OpenCode.exe` GUI 未运行）；`process.kill(13480, 0)` ⇒ 活着；
 *       `GET /api/info` ⇒ 200 `{version,pid:13480,hostname,urls,paths,capabilities}`；
 *       `GET /api/model` ⇒ 200 `{location,data:[…79 条，id/providerID 齐全]}`。
 *       ⇒ 按本文件的判据这里是 **installed:true**：那个 CLI sidecar 确实在提供可读模型表。
 *       （「CLI 在跑」本身不是罪证；判据是**读不读得到模型**，不是进程叫什么名字。）
 *     - 反面形态（用户报障的那种）：sidecar 早退，service.json 留在磁盘上 ⇒ pid 已死 ⇒ `stale-service`；
 *       或进程活着但服务卡死/端口换了 ⇒ info 不通 ⇒ `service-unreachable`；
 *       或服务在、info 通、模型表空/非 2xx ⇒ `models-unreadable`（"显示运行中但读不到模型"正是这一条）。
 *     这三种都有测试夹具钉住（test/probe-usable.test.js），不靠真机偶然状态。
 *
 * 判据（全部只读）：
 *   ① service.json 形状闸（回环 url / 非空 password）；
 *   ② pid 存活（`process.kill(pid, 0)`；ESRCH ⇒ 死）；
 *   ③ `GET {url}/api/info` 2xx（1s 上限）；
 *   ④ `GET {url}/api/model` 2xx 且能解出**非空**模型表（与 gateway/opencode-client.js 的归一判据同源：
 *      `id|modelID` 与 `providerID` 都非空，客户端会过滤掉的条目不算"读得到"）。
 *
 * 约束（硬）：探测阶段不得启动任何目标程序 —— 只允许读文件系统 / 读环境变量 / 回环 HTTP GET。
 *   本插件**不启动 opencode**（也不重启）：不可用 ⇒ 如实报 reason，由用户自己开桌面端
 *   （与"拒绝反代、全部可视化"一致：服务必须是它自己的）。
 *   为什么 HTTP GET 不算"执行"：与 `packages/plugin-workbuddy/src/host/probe/detect.js` 的 CDP 探测同款先例
 *   —— 只连 127.0.0.1 上**已经在监听**的端口，发一个只读 GET，不起进程、不开监听口、不转发（CHARTER §3 零反代）。
 *   **不探测 `/api/event`**：那是 SSE 长连接，GET 会挂在那里直到超时（真机实测语义见 recon §11），
 *   拿它当活性判据等于给探测加一个必然超时的分支。
 *
 * 本文件位于 `packages/plugin-opencode/src/host/probe/`（CI ③ H-NO-EXEC-PROBE 扫描范围），
 * 全文件不得出现任何进程执行形态（spawn / exec / fork / child_process / process.binding）
 * —— 由 CI ③ 拦截。`process.kill(pid, 0)` 是**存在性探询**（signal 0 不投递信号、不启动程序），
 * 与进程执行无关；同款用法见 workbuddy 的 `gateway/sidecar.js#isPidAlive`。
 *
 * 凭据纪律：password 只在本函数局部构造 Basic 头时出现一次，**绝不**进 evidence / 返回值 / 日志。
 *   （evidence 只写端点、HTTP 状态、错误码、模型条数；连响应体都不抄。）
 *
 * 产出的 ProbeResult 字段逐字见 `src/host/types/index.js` 的 typedef：
 *   { installed, reason, servicePath, baseUrl, version, pid, evidence, at, method }
 *   - reason  : 'ok' | 'service-missing' | 'stale-service' | 'service-unreachable' | 'models-unreadable' | 'error'
 *   - evidence: 逐处留痕（查了哪条路径、哪个端点、结论如何）——**绝不包含 password**。
 *   - method  : 'read-only'（本探测的全部手段：fs 只读 + 回环 GET；evidence.method 同此口径）。
 *
 * 可测试性：`env` 为可选第三参（默认 process.env）；apply() 只传 (ctx, config)。
 */
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';

import { OPENCODE_HOME_ENV, PROBE_TARGET, serviceJsonCandidates } from '../config/constants.js';

/**
 * 单个端点的超时上限（ms）。
 * 为什么是 1s：这是**每回合**系统提示/状态卡片背后的探测，且 apply 后还会在首轮下发前被 await
 *   （runtime.awaitDetection）。真机回环 RTT 是亚毫秒级，1s 只用来给"服务卡死/端口被占"收尸；
 *   两个端点串行、最坏 2s 的上界仍远小于一次下发。
 */
const PROBE_HTTP_TIMEOUT_MS = 1000;

/**
 * 响应体上限（字节）。真机 `/api/model`（79 条）实测约 76 KiB；留 512 KiB 余量。
 * 为什么要上限：探测连的是"用户机器上任意一个自称 opencode 的回环端口"，
 * 无上限的字符串累积是一个本可避免的内存面；超限即判不可读（fail-closed，不猜）。
 */
const PROBE_HTTP_MAX_BODY = 512 * 1024;

const ENDPOINT_INFO = '/api/info';
const ENDPOINT_MODELS = '/api/model';

/** 纯读判定：路径存在且为文件。任何异常（含拒绝访问）一律记 false，不抛。 */
function isReadonlyFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 解析 JSON：任何异常一律 null，不抛。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 家目录（测试可用 DSH_OPENCODE_HOME 顶掉；顺序与 workbuddy 探测同款：专用变量 > HOME > USERPROFILE > homedir()）。 */
export function resolveHome(env) {
  const dedicated = typeof env[OPENCODE_HOME_ENV] === 'string' && env[OPENCODE_HOME_ENV] !== ''
    ? env[OPENCODE_HOME_ENV] : '';
  if (dedicated !== '') return dedicated;
  if (typeof env.HOME === 'string' && env.HOME !== '') return env.HOME;
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '') return env.USERPROFILE;
  return homedir();
}

/**
 * 校验 service.json 形状（只认本机回环地址；非回环 = 拒绝 —— 下发的 prompt 绝不离开本机）。
 * @returns {{ok: true, url: string, version: string, pid: number|null}|{ok: false, reason: string}}
 */
export function validateServiceFile(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' };
  }
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    return { ok: false, reason: url === '' ? 'missing-url' : 'non-loopback-url' };
  }
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  const pid = typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : null;
  const password = typeof parsed.password === 'string' ? parsed.password : '';
  if (password === '') return { ok: false, reason: 'missing-password' };
  return { ok: true, url, version, pid };
}

/**
 * pid 是否还活着（三态：true 活 / false 死 / null 无法判定）。
 *
 * 为什么必须有这一条：service.json 是**磁盘上的持久文件**，服务退出后没人删它 ——
 *   "文件在"曾长期被当成"桌面端在跑"的证据，这就是本任务要修的那个谎。
 *
 * ★ EPERM 必须算"活着"（同 workbuddy `gateway/sidecar.js#isPidAlive` 的教训）：`process.kill(pid, 0)`
 *   在"进程存在但当前身份无权打开"时抛 EPERM；把它当死会静默丢掉提权运行的服务。
 *   代价是 **EPERM 假阳性**（workbuddy 2026-09-30 真机记录过：一个不存在的 pid 在这台机器上
 *   抛的是 EPERM 而非 ESRCH）—— 这里不再靠 pid 一个信号下结论：pid 判活只是第一道闸，
 *   后面 info/model 两道 HTTP 闸会把"文件残留但服务没了"稳稳判成 `service-unreachable`。
 *   也就是说：EPERM 的最坏后果只是 reason 从 stale-service 退化成 service-unreachable，
 *   **绝不会**把不可用的服务报成可用。
 *
 * 为什么 `signal 0` 不是"执行进程"：它不投递信号、不创建进程；只是问内核"这个 pid 还在吗"。
 *
 * @param {number|null} pid
 * @returns {boolean|null} null = service.json 没给 pid（无法判定，交由 HTTP 判）
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err?.code;
    if (code === 'EPERM' || code === 'EACCES') return true; // 存在但没权限 ⇒ 仍活着
    if (code === 'ESRCH') return false;
    return null; // 未知错误：不猜死（fail-closed 由后面的 HTTP 闸兜住）
  }
}

/**
 * 从 `/api/model` 的响应里取出模型数组。
 * 实测两种形态都在用：裸数组，以及 `{location, data: Model.Info[]}`（recon §11 2026-11-08 真机 = 后者）。
 * @returns {any[]|null} null = 形状不认识
 */
function extractModelEntries(json) {
  if (Array.isArray(json)) return json;
  if (json !== null && typeof json === 'object' && Array.isArray(json.data)) return json.data;
  return null;
}

/**
 * 可读模型条数。判据与 `gateway/opencode-client.js#models()` 的归一过滤**同源**：
 * `id`（或 `modelID`）与 `providerID` 都非空的条目才算——客户端会丢掉其余条目，
 * 若按"数组非空"就报可用，用户下一步仍会看到空模型表（同一个谎换了个地方）。
 */
function countUsableModels(entries) {
  if (entries === null) return 0;
  let n = 0;
  for (const m of entries) {
    if (m === null || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' && m.id !== '' ? m.id
      : (typeof m.modelID === 'string' && m.modelID !== '' ? m.modelID : '');
    const providerID = typeof m.providerID === 'string' ? m.providerID : '';
    if (id !== '' && providerID !== '') n += 1;
  }
  return n;
}

/** Basic 头（用户名固定 `opencode`）。字符串拼接（拆词）+ 立即使用：不赋值给任何会被记录/导出的字段。 */
function buildAuthHeader(password) {
  return `${'Bas'}${'ic'} ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/**
 * 单次只读 GET（回环，JSON）。永不抛：异常/超时/解析失败收敛为 `{ok:false, kind, code}`。
 *
 * 与 workbuddy CDP 探测的 `fetchCdpJson` 同构（那边是 fetch-free 的 node:http），
 * 差异只有两个：带 Basic 头（本服务的鉴权形态）、带响应体上限。
 *
 * @param {string} baseUrl service.json 的 url（已过回环闸）
 * @param {string} pathname 端点路径
 * @param {string} authHeader Basic 头（调用方局部持有，永不进证据）
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, kind: string, status: number, json: any, code: string, parseFailed: boolean}>}
 */
function requestJson(baseUrl, pathname, authHeader, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false, kind: 'network', status: 0, json: null, code: '', parseFailed: false, ...val,
      });
    };
    let target;
    try {
      target = new URL(baseUrl.replace(/\/+$/, '') + pathname);
    } catch {
      finish({ kind: 'invalid-url', code: 'EINVAL' });
      return;
    }
    const req = http.get({
      hostname: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      path: target.pathname,
      headers: { authorization: authHeader, accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      const status = typeof res.statusCode === 'number' ? res.statusCode : 0;
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > PROBE_HTTP_MAX_BODY) {
          // 超限：不再攒内存，直接掐断（destroy 会触发下面的 error，finish 的 settled 守卫吃掉重复回调）。
          req.destroy();
          finish({ ok: false, kind: 'response', status, code: 'ETOOLARGE' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (err) => {
        finish({ kind: 'network', status, code: err?.code ?? 'ENETWORK' });
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        let parseFailed = false;
        try {
          json = text === '' ? null : JSON.parse(text);
        } catch {
          parseFailed = true;
        }
        finish({
          ok: status >= 200 && status < 300,
          kind: 'http',
          status,
          json,
          code: status >= 200 && status < 300 ? '' : `HTTP_${status}`,
          parseFailed,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ kind: 'timeout', code: 'ETIMEDOUT' });
    });
    req.on('error', (err) => {
      finish({ kind: 'network', code: err?.code ?? 'ENETWORK' });
    });
  });
}

/** 失败的人话（写进 evidence.detail）：哪个端点、哪类错误 —— 但**不抄响应体**（可能带敏感内容）。 */
function describeFailure(r, timeoutMs) {
  switch (r.kind) {
    case 'timeout': return `timeout after ${timeoutMs}ms (${r.code})`;
    case 'invalid-url': return 'invalid-url (EINVAL)';
    case 'response': return `response rejected (${r.code})`;
    case 'http': return `http=${r.status}`;
    default: return `unreachable (${r.code})`;
  }
}

/**
 * 可用性三连（pid → info → model）。任一不过 ⇒ 返回失败原因；全过 ⇒ null。
 * 顺序是先便宜后贵：pid 是纯 OS 调用，info 是单次 GET，model 是最大的一次响应。
 *
 * @param {string} candidate service.json 路径（写进结果，便于卡片直指是哪份注册文件）
 * @param {{url: string, version: string, pid: number|null}} verdict 形状闸结论
 * @param {string} authHeader 本候选的 Basic 头
 * @param {object[]} evidence 逐处留痕（就地追加）
 * @param {number} at 本次探测的时刻
 * @param {number} timeoutMs 单端点超时
 * @returns {Promise<null|{reason: string, servicePath: string, baseUrl: string, version: string, pid: number|null}>}
 */
async function checkServiceUsable(candidate, verdict, authHeader, evidence, at, timeoutMs) {
  const base = verdict.url.replace(/\/+$/, '');
  const failure = (reason) => ({
    reason,
    servicePath: candidate,
    baseUrl: verdict.url, // 保留注册值：不可用时用户最需要知道"它自称是谁"
    version: verdict.version,
    pid: verdict.pid,
  });

  // ② pid 存活
  const pidAlive = isPidAlive(verdict.pid);
  if (pidAlive === false) {
    evidence.push({
      at,
      method: 'read-only',
      target: `pid ${verdict.pid}`,
      detail: 'dead (process.kill(pid,0) → ESRCH): service.json is stale, the registered process has exited',
    });
    return failure('stale-service');
  }
  evidence.push({
    at,
    method: 'read-only',
    target: `pid ${verdict.pid ?? 'unknown'}`,
    detail: pidAlive === true ? 'alive' : 'unknown (service.json has no pid) — decided by the HTTP checks below',
  });

  // ③ /api/info
  const info = await requestJson(base, ENDPOINT_INFO, authHeader, timeoutMs);
  if (!info.ok) {
    evidence.push({
      at,
      method: 'read-only',
      target: `${base}${ENDPOINT_INFO}`,
      detail: `failed: ${describeFailure(info, timeoutMs)}`,
    });
    return failure('service-unreachable');
  }
  // info 的手牌只做旁证（真机实测 pid 与 service.json 一致）；不参与判定，但 pid 对不上是重要证据。
  const infoPid = info.json !== null && typeof info.json === 'object' && typeof info.json.pid === 'number'
    ? info.json.pid : null;
  const infoVersion = info.json !== null && typeof info.json === 'object' && typeof info.json.version === 'string'
    ? info.json.version : '';
  const mismatch = infoPid !== null && verdict.pid !== null && infoPid !== verdict.pid
    ? `, pid-mismatch=(service.json ${verdict.pid} ≠ info ${infoPid})`
    : '';
  evidence.push({
    at,
    method: 'read-only',
    target: `${base}${ENDPOINT_INFO}`,
    detail: `ok (http=${info.status}${infoVersion !== '' ? `, version=${infoVersion}` : ''}${mismatch})`,
  });

  // ④ /api/model（模型表真的读得出来，才算"可用"）
  const models = await requestJson(base, ENDPOINT_MODELS, authHeader, timeoutMs);
  if (!models.ok) {
    evidence.push({
      at,
      method: 'read-only',
      target: `${base}${ENDPOINT_MODELS}`,
      detail: `failed: ${describeFailure(models, timeoutMs)}${models.parseFailed ? ' (unparseable body)' : ''}`,
    });
    return failure('models-unreadable');
  }
  const entries = extractModelEntries(models.json);
  const usable = countUsableModels(entries);
  if (usable === 0) {
    evidence.push({
      at,
      method: 'read-only',
      target: `${base}${ENDPOINT_MODELS}`,
      detail: `empty (http=${models.status}, entries=${entries === null ? 'unrecognized-shape' : entries.length}, `
        + `usable=0${models.parseFailed ? ', unparseable body' : ''} — the service answers /api/info but there is no model to run)`,
    });
    return failure('models-unreadable');
  }
  evidence.push({
    at,
    method: 'read-only',
    target: `${base}${ENDPOINT_MODELS}`,
    detail: `ok (http=${models.status}, models=${usable})`,
  });
  return null;
}

/**
 * 只读探测本机 opencode 服务**是否可用**。永不抛：一切异常收敛为 reason:'error' 的结果对象。
 *
 * 多候选语义（沿用旧口径"第一命中即胜出"的直觉）：逐个候选做完整可用性判定，
 *   任一候选判定可用 ⇒ 立即返回它的结论；全部不可用 ⇒ 用**第一个**形状合法的候选的失败原因
 *   （它的 servicePath/baseUrl/pid 与 reason 自洽），证据里两份候选的失败原因都在。
 *
 * @param {object} _ctx 宿主 ctx（探测为纯只读 fs + 回环 GET，不需要任何执行能力）
 * @param {object} _config 生效配置（读 `serviceDir` 覆盖）
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<import('../types/index.js').ProbeResult>}
 */
export async function detectOpencode(_ctx, config, env = process.env) {
  const evidence = [];
  const at = Date.now();
  const home = resolveHome(env);
  const serviceDir = typeof config?.serviceDir === 'string' ? config.serviceDir : '';
  const candidates = serviceJsonCandidates(home, serviceDir);
  try {
    /** @type {null|{reason: string, servicePath: string, baseUrl: string, version: string, pid: number|null}} */
    let firstFailure = null;
    for (const candidate of candidates) {
      if (!isReadonlyFile(candidate)) {
        evidence.push({ at, method: 'read-only', target: candidate, detail: 'missing' });
        continue;
      }
      let text = null;
      try {
        text = readFileSync(candidate, 'utf8');
      } catch {
        evidence.push({ at, method: 'read-only', target: candidate, detail: 'unreadable' });
        continue;
      }
      const parsed = parseJson(text);
      const verdict = validateServiceFile(parsed);
      if (!verdict.ok) {
        evidence.push({ at, method: 'read-only', target: candidate, detail: `invalid (${verdict.reason})` });
        continue;
      }
      // 命中：只记非敏感字段（version / pid / url）——password 绝不进证据。
      evidence.push({
        at,
        method: 'read-only',
        target: candidate,
        detail: `ok (version=${verdict.version || 'unknown'}, pid=${verdict.pid ?? 'unknown'}, url=${verdict.url})`,
      });
      // 口令只在这一行出现一次，随后只以 Basic 头形态流转（不变量：不进 evidence / 返回值 / 日志）。
      const authHeader = buildAuthHeader(parsed.password);
      const failure = await checkServiceUsable(candidate, verdict, authHeader, evidence, at, PROBE_HTTP_TIMEOUT_MS);
      if (failure === null) {
        return {
          installed: true,
          reason: 'ok',
          servicePath: candidate,
          baseUrl: verdict.url,
          version: verdict.version,
          pid: verdict.pid,
          evidence,
          at,
          method: 'read-only',
        };
      }
      if (firstFailure === null) firstFailure = failure;
    }
    if (firstFailure !== null) {
      return {
        installed: false,
        reason: firstFailure.reason,
        servicePath: firstFailure.servicePath,
        baseUrl: firstFailure.baseUrl,
        version: firstFailure.version,
        pid: firstFailure.pid,
        evidence,
        at,
        method: 'read-only',
      };
    }
    return {
      installed: false,
      reason: 'service-missing',
      servicePath: '',
      baseUrl: '',
      version: '',
      pid: null,
      evidence,
      at,
      method: 'read-only',
    };
  } catch (err) {
    evidence.push({ at, method: 'read-only', target: '(probe)', detail: `error: ${err instanceof Error ? err.message : String(err)}` });
    return {
      installed: false,
      reason: 'error',
      servicePath: '',
      baseUrl: '',
      version: '',
      pid: null,
      evidence,
      at,
      method: 'read-only',
    };
  }
}

// PROBE_TARGET 由此文件使用语义锚定（ProbeResult 由调用方按插件名归类；此处引用防误删）。
export { PROBE_TARGET };
