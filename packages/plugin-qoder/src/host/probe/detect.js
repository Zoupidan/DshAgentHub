/**
 * 只读探测：CDP 可达性 + Qoder renderer 命中（不启动/不修改 Qoder）。
 * @module host/probe/detect
 */
import { probeCdp } from '../gateway/cdp.js';
import { DEFAULT_CDP_PORT } from '../../shared/constants.js';

export async function detectProbe(config = {}) {
  const port = Number.isFinite(config.cdpPort) ? Math.floor(config.cdpPort) : DEFAULT_CDP_PORT;
  try {
    return await probeCdp(port);
  } catch (e) {
    return {
      installed: false, reason: 'error', baseUrl: `http://127.0.0.1:${port}`,
      targetId: '', targetUrl: '', targetTitle: '', endpointId: '',
      evidence: [{ at: Date.now(), method: 'cdp-http-readonly', target: `127.0.0.1:${port}`, detail: String(e?.message ?? e).slice(0, 200) }],
      at: Date.now(),
    };
  }
}
