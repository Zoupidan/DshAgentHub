/**
 * 会话映射（session key → Qoder sessionId）。精简实现，沿用 opencode 版纪律：
 * id 来自桥回执/目录，不猜文本；落盘走 ctx.settings.update（sessions volatile）。
 * Qoder sessionId 为 UUID。
 * @module host/session/map
 */
import { SESSION_ID_PATTERN } from '../../shared/constants.js';

export function isSessionId(v) {
  return typeof v === 'string' && SESSION_ID_PATTERN.test(v.trim());
}

function now() { return Date.now(); }

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sessionId = isSessionId(raw.sessionId) ? raw.sessionId.trim() : '';
  if (!sessionId) return null;
  return {
    sessionId,
    sessionKey: typeof raw.sessionKey === 'string' ? raw.sessionKey : '',
    workspace: typeof raw.workspace === 'string' ? raw.workspace : '',
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : 0,
    own: raw.own === true,
    state: typeof raw.state === 'string' ? raw.state : 'resumable',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
  };
}

export function createSessionMap(ctx, runtime) {
  async function readAll() {
    const cfg = runtime.current();
    const raw = cfg?.sessions;
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const rec = sanitizeRecord(v);
      if (rec) out[k] = { ...rec, sessionKey: k };
    }
    return out;
  }

  async function writeAll(map) {
    try {
      if (ctx?.settings?.update && typeof ctx.settings.update === 'function') {
        await ctx.settings.update({ sessions: map });
      }
    } catch (e) {
      try { ctx?.logger?.warn?.(`[qoder] sessions 落盘失败: ${String(e?.message ?? e)}`); } catch {}
    }
  }

  return {
    async get(key) {
      if (typeof key !== 'string' || !key) return null;
      const map = await readAll();
      return map[key] ?? null;
    },
    async set(key, patch) {
      if (typeof key !== 'string' || !key) return null;
      const map = await readAll();
      const prev = map[key] ?? {};
      const next = sanitizeRecord({ ...prev, ...patch, sessionKey: key, lastUsedAt: now() });
      if (!next) return null;
      map[key] = next;
      await writeAll(map);
      return next;
    },
    async touch(key, patch = {}) {
      if (typeof key !== 'string' || !key) return null;
      const map = await readAll();
      if (!map[key]) return null;
      map[key] = { ...map[key], ...patch, lastUsedAt: now() };
      await writeAll(map);
      return map[key];
    },
    async remove(key) {
      if (typeof key !== 'string' || !key) return false;
      const map = await readAll();
      if (!map[key]) return false;
      delete map[key];
      await writeAll(map);
      return true;
    },
    async list(limit = 20) {
      const map = await readAll();
      return Object.values(map).sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0)).slice(0, Math.max(0, limit));
    },
    async summary(limit = 20) {
      const rows = await this.list(limit);
      return rows.map((r) => ({
        sessionKey: r.sessionKey, sessionId: r.sessionId, title: r.title || '',
        workspacePath: r.workspace || '', lastUsedAt: r.lastUsedAt, own: !!r.own, state: r.state || 'resumable',
      }));
    },
    async sweep(maxAgeMs = 30 * 24 * 3600_000) {
      const map = await readAll();
      const cutoff = now() - maxAgeMs;
      let changed = false;
      for (const [k, v] of Object.entries(map)) {
        if ((v.lastUsedAt || 0) < cutoff && v.own) { delete map[k]; changed = true; }
      }
      if (changed) await writeAll(map);
      return changed;
    },
  };
}
