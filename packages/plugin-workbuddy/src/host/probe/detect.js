/**
 * U6 只读探测：判定 WorkBuddy 桌面端是否可用（H-NO-EXEC-PROBE）。
 *
 * Implements: 02-design/DESIGN-v3.md §7.1（探测原则）/ §7.2（撤回 L3 的修正）
 * 约束（硬）：探测阶段不得启动任何目标程序 —— 只允许读文件系统 / 读环境变量 / 回环 HTTP 探测。
 *   完全废除 18488 端口与 TCP 探测（F7 / 2026-10-09）。
 *
 * 本文件位于 `packages/plugin-workbuddy/src/host/probe/`（CI ③ H-NO-EXEC-PROBE 扫描范围），
 * 全文件不得出现任何进程执行形态（spawn / exec / fork / child_process / process.binding）
 * —— 由 CI ③ 拦截。
 *
 * 判据优先级：
 *   L-D0  desktop-cdp  ：CDP 调试端口（默认 9222）回环 /json/version 与 /json/list 探测有效
 *         —— 运行态主判据（命中即 installed === true, method: 'desktop-cdp'）。
 *   L-D1  desktop-cache：`~/.workbuddy/cache/acc-product-config-v3*.json` 存在且可解析
 *         —— 磁盘态主判据（命中即 installed === true, method: 'desktop-cache'）。
 *   L-D2  desktop-exe  ：桌面端可执行文件已知安装位（resolvedPath 的兜底来源）。
 *
 * 产出 ProbeResult（§7.2 逐字字段）：
 *   { target, installed, reason, resolvedPath, evidence, at, method }
 *   - evidence: Array<{ kind, value, found }> —— 让用户可复核"查了哪些地方"
 *   - method  : 'desktop-cdp'（CDP 命中）/'desktop-cache'（缓存命中）/'desktop-probe'（未命中）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PROBE_TARGET } from '../config/constants.js';

/** 桌面产品配置缓存的相对路径段（`~/.workbuddy/cache/acc-product-config-v3.json`）。 */
const DESKTOP_CACHE_SEGMENTS = ['.workbuddy', 'cache', 'acc-product-config-v3.json'];

/**
 * 桌面端可执行文件已知安装位（env 变量 → 相对路径）。
 * 与 `gateway/desktop.js` 的 `DESKTOP_KNOWN_PATHS` 同物（那份找 Electron 主程序，本份只做只读判定）。
 * 找不到不是致命错误 —— 只影响 resolvedPath 的兜底值。
 */
const DESKTOP_EXE_KNOWN_PATHS = [
  { envs: ['ProgramFiles', 'ProgramW6432'], rel: 'WorkBuddy/WorkBuddy.exe' },
  { envs: ['ProgramFiles(x86)'], rel: 'WorkBuddy/WorkBuddy.exe' },
  { envs: ['LOCALAPPDATA'], rel: 'Programs/WorkBuddy/WorkBuddy.exe' },
];

/** 纯读判定：路径存在且为文件。任何异常（含拒绝访问）一律记 false，不抛。 */
function isReadonlyFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 解析 JSON：任何异常/非对象一律 null，不抛。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 枚举桌面端可执行文件路径（纯读，不启动）。
 * @param {Record<string, string | undefined>} env
 * @returns {{path: string, source: string}|null}
 */
function findDesktopExe(env) {
  const seen = new Set();
  for (const tpl of DESKTOP_EXE_KNOWN_PATHS) {
    let base = null;
    for (const name of tpl.envs) {
      const v = env[name];
      if (typeof v === 'string' && v !== '') {
        base = v;
        break;
      }
    }
    if (base === null) continue;
    const candidate = join(base, tpl.rel);
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isReadonlyFile(candidate)) return { path: candidate, source: `knownPath:${tpl.envs[0]}` };
  }
  return null;
}

/**
 * 校验 target 是否符合 WorkBuddy 指纹。
 * @param {any} t
 * @returns {boolean}
 */
function looksLikeWorkBuddyTarget(t) {
  if (!t || typeof t !== 'object') return false;
  const url = String(t.url ?? '').toLowerCase();
  const title = String(t.title ?? '').toLowerCase();
  const isPage = t.type === 'page' || t.type === 'app';
  const hasWorkBuddyUrl = url.includes('app.asar') || url.includes('workbuddy')
    || url.startsWith('file:///') || url.startsWith('wb-cover:') || url.startsWith('vscode-file:');
  const hasWorkBuddyTitle = title.includes('workbuddy');
  return isPage && (hasWorkBuddyUrl || hasWorkBuddyTitle);
}

/**
 * 单次 HTTP JSON GET 请求（127.0.0.1 回环）。
 * 永不抛：异常/超时/解析失败收敛为 { ok: false, code }。
 * @param {number} port
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, data?: any, code?: string }>}
 */
function fetchCdpJson(port, path, timeoutMs = 100) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          finish({ ok: true, data: JSON.parse(data) });
        } catch {
          finish({ ok: false, code: 'INVALID_JSON' });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, code: 'ETIMEDOUT' });
    });
    req.on('error', (err) => {
      finish({ ok: false, code: err?.code ?? 'ECONNREFUSED' });
    });
  });
}

/**
 * 探测指定端口的 CDP 是否为有效 WorkBuddy 实例。
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, userAgent?: string, matchedTarget?: any, reason?: string }>}
 */
async function probeCdpWorkBuddy(port, timeoutMs = 100) {
  try {
    const [versionRes, listRes] = await Promise.all([
      fetchCdpJson(port, '/json/version', timeoutMs),
      fetchCdpJson(port, '/json/list', timeoutMs),
    ]);
    if (!versionRes.ok && !listRes.ok) {
      return { ok: false, reason: 'unreachable' };
    }
    const version = versionRes.ok && versionRes.data && typeof versionRes.data === 'object' ? versionRes.data : {};
    const targets = listRes.ok && Array.isArray(listRes.data) ? listRes.data : [];

    const userAgent = typeof version['User-Agent'] === 'string' ? version['User-Agent'] : '';
    const uaIsWorkBuddy = userAgent.includes('WorkBuddy/');
    const matchedTarget = targets.find((t) => looksLikeWorkBuddyTarget(t)) ?? null;

    if (uaIsWorkBuddy || matchedTarget !== null) {
      return { ok: true, userAgent, matchedTarget };
    }
    return { ok: false, reason: 'non-workbuddy' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 只读探测 WorkBuddy 桌面端。永不抛：一切异常收敛为 reason:'error' 的结果对象。
 *
 * @param {object} _ctx 宿主 ctx（桌面端探测为纯只读 fs 与回环 HTTP，不启动子进程）
 * @param {object} _config 生效配置（读取 followupCdpPort / timeoutMs）
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<import('../types/index.js').ProbeResult>}
 */
export async function detectWorkBuddy(_ctx, _config, env = process.env) {
  const evidence = [];
  const at = Date.now();
  const whome = typeof env.WORKBUDDY_HOME === 'string' && env.WORKBUDDY_HOME !== '' ? env.WORKBUDDY_HOME : '';
  const home = whome !== ''
    ? whome
    : (typeof env.HOME === 'string' && env.HOME !== ''
      ? env.HOME
      : (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir()));

  try {
    // ── L-D2：查找本地桌面可执行文件 ─────────────────────────────
    const exe = findDesktopExe(env);

    // ── L-D0：CDP 端口探测（首选运行态判据，默认 9222）──────────────
    const cdpPortRaw = _config?.followupCdpPort ?? env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
    let cdpPort = 9222;
    if (cdpPortRaw !== undefined && cdpPortRaw !== null && cdpPortRaw !== '') {
      const p = Number(cdpPortRaw);
      if (Number.isFinite(p)) cdpPort = p;
    }
    const probeTimeoutMs = Number.isFinite(Number(_config?.timeoutMs)) && Number(_config?.timeoutMs) > 0
      ? Number(_config.timeoutMs)
      : 100;

    if (cdpPort > 0) {
      const cdpResult = await probeCdpWorkBuddy(cdpPort, probeTimeoutMs);
      if (cdpResult.ok) {
        evidence.push({ kind: 'desktop-cdp', value: `http://127.0.0.1:${cdpPort}`, found: true });
        if (exe !== null) evidence.push({ kind: 'desktop-exe', value: exe.path, found: true });
        return {
          target: PROBE_TARGET,
          installed: true,
          reason: 'ok',
          resolvedPath: exe?.path || `http://127.0.0.1:${cdpPort}`,
          evidence,
          at,
          method: 'desktop-cdp',
        };
      }
      evidence.push({ kind: 'desktop-cdp', value: `http://127.0.0.1:${cdpPort}`, found: false });
    }

    // ── L-D1：桌面产品配置缓存（次选磁盘判据，支持通配扫描）────────────
    const cacheDir = join(home, '.workbuddy', 'cache');
    const staticCachePath = join(home, ...DESKTOP_CACHE_SEGMENTS);
    let cacheOk = false;
    let cachePath = staticCachePath;
    let cacheState = 'missing';

    if (isReadonlyFile(staticCachePath)) {
      let text = null;
      try {
        text = readFileSync(staticCachePath, 'utf8');
      } catch {
        text = null;
      }
      if (text === null) {
        cacheState = 'unreadable';
      } else {
        const parsed = parseJson(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          cacheState = 'invalid-json';
        } else {
          cacheOk = true;
        }
      }
    }

    // 通配扫描：支持动态 acc-product-config-v3*.json（如 PID-uuid 后缀文件）
    if (!cacheOk) {
      try {
        const entries = readdirSync(cacheDir, { withFileTypes: true });
        const candidates = entries
          .filter((e) => e.isFile() && /^acc-product-config-v3.*\.json$/i.test(e.name))
          .map((e) => join(cacheDir, e.name));

        for (const candidate of candidates) {
          let text = null;
          try {
            text = readFileSync(candidate, 'utf8');
          } catch {
            text = null;
          }
          if (text !== null) {
            const parsed = parseJson(text);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              cacheOk = true;
              cachePath = candidate;
              break;
            }
          }
        }
      } catch {
        // cacheDir 不存在或不可读，保持 cacheOk = false
      }
    }

    evidence.push({ kind: 'desktop-cache', value: cachePath, found: cacheOk });
    if (!cacheOk) evidence.push({ kind: 'desktop-cache-state', value: cacheState, found: false });

    // ── 记录本地可执行文件证据 ───────────────────────────────────
    if (exe !== null) evidence.push({ kind: 'desktop-exe', value: exe.path, found: true });

    if (cacheOk) {
      return {
        target: PROBE_TARGET,
        installed: true,
        reason: 'ok',
        resolvedPath: cachePath,
        evidence,
        at,
        method: 'desktop-cache',
      };
    }

    // ── 严格回退（CDP 与 Cache 均未成功）─────────────────────────
    return {
      target: PROBE_TARGET,
      installed: false,
      reason: 'not_found',
      resolvedPath: exe === null ? null : exe.path,
      evidence,
      at,
      method: 'desktop-probe',
    };
  } catch (err) {
    evidence.push({ kind: 'error', value: err instanceof Error ? err.message : String(err), found: false });
    return {
      target: PROBE_TARGET,
      installed: false,
      reason: 'error',
      resolvedPath: null,
      evidence,
      at,
      method: 'desktop-probe',
    };
  }
}
