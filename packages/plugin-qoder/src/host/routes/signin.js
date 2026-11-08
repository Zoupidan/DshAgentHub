/**
 * 签到/积分路由（CN；loopback-only）。绝不回显 PAT/令牌。
 * @module host/routes/signin
 */
import { ROUTE_SIGNIN, ROUTE_SIGNOUT, ROUTE_USAGE, ROUTE_CLAIM } from '../../shared/constants.js';
import { isLoopback, isLoopbackHost } from '../loopback.js';
import { savePat, clearPat, getCredentialMeta, readPatSecret } from '../signin/credentials.js';
import { QoderCnSigninClient, QoderSigninError } from '../signin/upstream.js';
import { redact, oneLine } from '../launch/reason-codes.js';

function sendJson(res, status, payload) {
  try { res.statusCode = status; res.setHeader?.('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)); } catch {}
}

async function readBody(req) {
  return await new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += String(c); if (buf.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function guard(req, res) {
  if (!isLoopback(req) || !isLoopbackHost(req)) { sendJson(res, 403, { error: 'loopback-only' }); return false; }
  return true;
}

function safeError(e) {
  if (e instanceof QoderSigninError) return { kind: e.kind, status: e.status, message: oneLine(redact(e.message)).slice(0, 240) };
  return { kind: 'unknown', message: oneLine(redact(String(e?.message ?? e))).slice(0, 240) };
}

export function makeSigninRoutes(runtime) {
  const client = new QoderCnSigninClient({ logger: () => {} });

  async function refreshCredits() {
    const pat = readPatSecret();
    if (!pat) { runtime.setCredits({ claimState: 'unconfigured', checkedAt: Date.now() }); return runtime.credits(); }
    try {
      const [usage, campaigns] = await Promise.all([client.fetchUsage(pat), client.fetchCampaigns(pat)]);
      const daily = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT');
      const claimable = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
      const claimState = claimable ? 'claimable' : daily?.claimStatus === 'CLAIMED' ? 'claimed' : daily ? 'unknown' : 'no-campaign';
      runtime.setCredits({ usage, campaigns, claimState, checkedAt: Date.now(), region: 'cn' });
    } catch (e) {
      runtime.setCredits({ ...(runtime.credits() ?? {}), claimState: 'error', error: safeError(e), checkedAt: Date.now(), region: 'cn' });
    }
    return runtime.credits();
  }

  return [
    { kind: 'exact', path: ROUTE_SIGNIN, handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method === 'GET') return sendJson(res, 200, { ...getCredentialMeta(), credits: runtime.credits(), region: 'cn', attribution: '协议参考 dingminhua/dsh-connect-qoder (MIT)' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const pat = typeof body?.pat === 'string' ? body.pat : typeof body?.personalToken === 'string' ? body.personalToken : '';
        const saved = savePat(pat);
        if (!saved.ok) return sendJson(res, 400, { ok: false, reason: saved.reason, message: saved.message });
        const credits = await refreshCredits().catch((e) => ({ claimState: 'error', error: safeError(e) }));
        return sendJson(res, 200, { ok: true, signin: getCredentialMeta(), credits });
      }
      sendJson(res, 405, { error: 'method-not-allowed' });
    }},
    { kind: 'exact', path: ROUTE_SIGNOUT, handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'POST' && req.method !== 'DELETE') return sendJson(res, 405, { error: 'method-not-allowed' });
      clearPat();
      runtime.setCredits(null);
      sendJson(res, 200, { ok: true, configured: false });
    }},
    { kind: 'exact', path: ROUTE_USAGE, handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' });
      const pat = readPatSecret();
      if (!pat) return sendJson(res, 200, { configured: false, claimState: 'unconfigured', region: 'cn' });
      const credits = await refreshCredits();
      sendJson(res, 200, { configured: true, signin: getCredentialMeta(), credits, region: 'cn' });
    }},
    { kind: 'exact', path: ROUTE_CLAIM, handler: async (req, res) => {
      if (!guard(req, res)) return;
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' });
      const pat = readPatSecret();
      if (!pat) return sendJson(res, 400, { ok: false, reason: 'unconfigured', message: '请先粘贴 pt- PAT' });
      try {
        const result = await client.claimDailyCredits(pat);
        await refreshCredits().catch(() => {});
        sendJson(res, 200, { ok: true, result, credits: runtime.credits(), signin: getCredentialMeta() });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: safeError(e), credits: runtime.credits(), signin: getCredentialMeta() });
      }
    }},
  ];
}
