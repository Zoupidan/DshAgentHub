/**
 * Qoder 上游（CN-only）：PAT→jobToken、sash 用量/活动/领取。
 *
 * 移植/裁剪自 MIT 项目 dingminhua/dsh-connect-qoder (src/upstream.ts)，
 * 仅保留 CN 区域与本插件所需的 exchange/usage/campaigns/claim 路径；
 * 国内版 requiresDeviceRisk=false，不引入 UMID 设备风控。
 *
 * @module host/signin/upstream
 */
import {
  COSY_CLIENT_TYPE,
  COSY_VERSION_HEADER,
  currentRfc1123Date,
  deriveFingerprint,
  identityFromJobToken,
  jobTokenBody,
  newCosySession,
  signLegacy,
} from './cosy.js';

const CN = Object.freeze({
  region: 'cn',
  gateway: 'https://gateway.qoder.com.cn',
  openapi: 'https://openapi.qoder.com.cn',
  jobTokenPath: '/algo/api/v3/user/jobToken?Encode=1',
  campaignsPath: '/sash/api/v1/me/campaigns',
  usagePath: '/sash/api/v2/me/usage',
  sashTokenPath: '/api/v1/jobToken/exchange',
  requiresDeviceRisk: false,
});

const SASH_CLIENT_TYPE = '10';
const SASH_USER_AGENT = 'Qoder';
const CAMPAIGNS_QUERY = '?forceRefresh=true';

export class QoderSigninError extends Error {
  constructor(kind, message, status = 0, code = '') {
    super(message);
    this.name = 'QoderSigninError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function classifyFailure(status, detail) {
  const t = String(detail ?? '');
  if (/TOKEN_EXPIRE|TOKEN_INVALID|token is not active|invalid token|personal token is invalid|UNAUTHORIZED/i.test(t)) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'transient';
  return 'unknown';
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

function readBucket(value) {
  if (!value || typeof value !== 'object') return undefined;
  const v = value;
  return { total: num(v.total), used: num(v.used), remaining: num(v.remaining), percentage: num(v.percentage) };
}

export function parseUsage(data) {
  if (!data || typeof data !== 'object') return undefined;
  const qoderUsage = data.qoderUsage && typeof data.qoderUsage === 'object' ? data.qoderUsage : undefined;
  const source = qoderUsage ?? data;
  const out = {
    userType: typeof source.userType === 'string' ? source.userType : undefined,
    expiresAt: num(source.expiresAt),
    upgradeUrl: typeof source.upgradeUrl === 'string' ? source.upgradeUrl : undefined,
    isQuotaExceeded: source.isQuotaExceeded === true,
  };
  const userQuota = readBucket(source.userQuota);
  if (userQuota) out.userQuota = userQuota;
  if (source.addOnQuota && typeof source.addOnQuota === 'object') {
    out.addOnQuota = { ...readBucket(source.addOnQuota), detailUrl: typeof source.addOnQuota.detailUrl === 'string' ? source.addOnQuota.detailUrl : undefined };
  }
  if (source.orgResourcePackage && typeof source.orgResourcePackage === 'object') {
    const org = source.orgResourcePackage;
    out.orgResourcePackage = { used: num(org.used), cap: num(org.cap), remaining: num(org.remaining), percentage: num(org.percentage), available: org.available === true };
  }
  return out;
}

function projectCampaignEntry(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  const raw = entry;
  const campaignId = typeof raw.campaignId === 'string' ? raw.campaignId : '';
  if (campaignId === '') return undefined;
  const benefit = typeof raw.benefit === 'object' && raw.benefit !== null ? raw.benefit : {};
  const validity = typeof benefit.validity === 'object' && benefit.validity !== null ? benefit.validity : {};
  return {
    campaignId,
    actionType: typeof raw.actionType === 'string' ? raw.actionType : '',
    claimStatus: typeof raw.claimStatus === 'string' ? raw.claimStatus : '',
    ...(typeof raw.campaignKey === 'string' && raw.campaignKey !== '' ? { campaignKey: raw.campaignKey } : {}),
    ...(typeof benefit.amount === 'number' ? { amount: benefit.amount } : {}),
    ...(typeof validity.days === 'number' && (validity.mode === undefined || validity.mode === 'RELATIVE_DAYS') ? { validityDays: validity.days } : {}),
    ...(typeof raw.startAt === 'number' ? { startAt: raw.startAt } : {}),
    ...(typeof raw.endAt === 'number' ? { endAt: raw.endAt } : {}),
  };
}

export class QoderCnSigninClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.logger = options.logger ?? (() => {});
    this.holders = new Map();
  }

  log(msg) { try { this.logger(`qoder-signin: ${msg}`); } catch {} }

  async exchangeJobToken(credential) {
    const fingerprint = deriveFingerprint('', credential, undefined);
    const body = jobTokenBody(credential);
    const date = currentRfc1123Date();
    const sig = signLegacy(date);
    const url = `${CN.gateway}${CN.jobTokenPath}`;
    const headers = {
      'cosy-machinetoken': fingerprint.machineToken,
      'cosy-machinetype': fingerprint.machineType,
      'login-version': 'v2',
      appcode: 'cosy',
      accept: 'application/json',
      'accept-encoding': 'identity',
      'cosy-version': COSY_VERSION_HEADER,
      'cosy-clienttype': COSY_CLIENT_TYPE,
      date,
      signature: sig,
      'content-type': 'application/json',
      'cosy-machineid': fingerprint.machineId,
      'user-agent': 'Go-http-client/2.0',
    };
    const resp = await this.fetchImpl(url, { method: 'POST', headers, body });
    const text = await resp.text();
    if (resp.status !== 200) {
      throw new QoderSigninError(classifyFailure(resp.status, text), `jobToken 交换失败: HTTP ${resp.status} ${truncate(text, 160)}`, resp.status);
    }
    const data = parseJson(text);
    if (!data || typeof data !== 'object') throw new QoderSigninError('unknown', `jobToken 响应不是 JSON: ${truncate(text, 160)}`, resp.status);
    const jobToken = {
      id: String(data.id ?? ''),
      name: String(data.name ?? ''),
      expireTime: Number(data.expireTime ?? 0),
      securityOauthToken: String(data.securityOauthToken ?? ''),
      refreshToken: String(data.refreshToken ?? ''),
      userType: String(data.userType ?? 'personal_standard'),
    };
    if (!jobToken.id && !jobToken.securityOauthToken) {
      throw new QoderSigninError('auth', `jobToken 响应缺少身份字段: ${truncate(text, 160)}`, resp.status);
    }
    const identity = identityFromJobToken(jobToken);
    const session = newCosySession(identity, fingerprint.machineId, fingerprint.machineToken, fingerprint.machineType);
    const holder = { session, fingerprint, jobToken, expireAtMs: jobToken.expireTime > 0 ? jobToken.expireTime : 0, sashToken: '', sashExpireAtMs: 0 };
    await this.refreshSashToken(credential, holder);
    this.holders.set(credential, holder);
    return holder;
  }

  async refreshSashToken(credential, holder) {
    try {
      const resp = await this.fetchImpl(`${CN.openapi}${CN.sashTokenPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ personal_token: credential }),
      });
      const text = await resp.text();
      if (resp.status !== 200) { this.log(`sash token exchange HTTP ${resp.status}`); return; }
      const data = parseJson(text);
      const raw = data && typeof data === 'object' ? data : {};
      const token = typeof raw.token === 'string' && raw.token ? raw.token
        : typeof raw.job_token === 'string' && raw.job_token ? raw.job_token
        : typeof raw.jobToken === 'string' && raw.jobToken ? raw.jobToken : '';
      if (token) {
        holder.sashToken = token;
        const expiry = typeof raw.expires_at === 'string' ? Date.parse(raw.expires_at) : Number.NaN;
        holder.sashExpireAtMs = Number.isFinite(expiry) ? expiry : 0;
      }
    } catch (e) {
      this.log(`sash token exchange error: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  sashBearer(holder) {
    if (typeof holder?.sashToken === 'string' && holder.sashToken !== '') return holder.sashToken;
    return holder?.jobToken?.securityOauthToken ?? '';
  }

  isSessionValid(credential, nowMs = Date.now()) {
    const holder = this.holders.get(credential);
    if (!holder) return false;
    return holder.expireAtMs - nowMs > 5 * 60_000;
  }

  async ensureSession(credential) {
    if (this.isSessionValid(credential)) return this.holders.get(credential);
    return this.exchangeJobToken(credential);
  }

  async sashRequest(method, holder, url, body, signal) {
    const oauthToken = this.sashBearer(holder);
    if (oauthToken === '') throw new QoderSigninError('auth', '没有可用令牌（PAT→jobToken/sash token 均未取得）', 401);
    const headers = {
      authorization: `Bearer ${oauthToken}`,
      'cosy-clienttype': SASH_CLIENT_TYPE,
      accept: 'application/json',
      'accept-language': 'zh-CN',
      'user-agent': SASH_USER_AGENT,
      ...(method === 'POST' ? { 'content-type': 'application/json', origin: CN.openapi } : {}),
    };
    const resp = await this.fetchImpl(url, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await resp.text();
    if (resp.status !== 200 && resp.status !== 201) {
      throw new QoderSigninError(classifyFailure(resp.status, text), `请求失败: HTTP ${resp.status} ${truncate(text, 160)}`, resp.status);
    }
    const data = parseJson(text);
    if (!data || typeof data !== 'object') throw new QoderSigninError('unknown', `响应不是 JSON: ${truncate(text, 160)}`, resp.status);
    return data;
  }

  async fetchUsage(credential, signal) {
    const holder = await this.ensureSession(credential);
    const data = await this.sashRequest('GET', holder, `${CN.openapi}${CN.usagePath}`, undefined, signal);
    return parseUsage(data);
  }

  async fetchCampaigns(credential, signal) {
    const holder = await this.ensureSession(credential);
    const data = await this.sashRequest('GET', holder, `${CN.openapi}${CN.campaignsPath}${CAMPAIGNS_QUERY}`, undefined, signal);
    const rows = Array.isArray(data.campaigns) ? data.campaigns
      : Array.isArray(data?.data?.campaigns) ? data.data.campaigns : [];
    return rows.map(projectCampaignEntry).filter(Boolean);
  }

  async claimDailyCredits(credential, signal) {
    const campaigns = await this.fetchCampaigns(credential, signal);
    const daily = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT');
    const claimable = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE');
    const nextRefreshAtMs = daily?.endAt === undefined ? undefined : daily.endAt * 1000;
    if (claimable === undefined) {
      if (daily?.claimStatus === 'CLAIMED') return { status: 'already-claimed', ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }) };
      return { status: 'unavailable', message: '上游今日没有下发可领取的签到活动', ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }) };
    }
    const holder = await this.ensureSession(credential);
    const url = `${CN.openapi}${CN.campaignsPath}/${encodeURIComponent(claimable.campaignId)}/claim`;
    try {
      const data = await this.sashRequest('POST', holder, url, {}, signal);
      if (String(data.status ?? '') === 'CLAIMED') {
        return {
          status: 'claimed',
          ...(claimable.amount === undefined ? {} : { amount: claimable.amount }),
          ...(claimable.validityDays === undefined ? {} : { validityDays: claimable.validityDays }),
          ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }),
        };
      }
      return { status: 'unavailable', message: `签到未完成（上游状态 ${String(data.status ?? '未知')}）` };
    } catch (error) {
      if (error instanceof QoderSigninError && error.status === 409) {
        return { status: 'already-claimed', ...(nextRefreshAtMs === undefined ? {} : { nextRefreshAtMs }) };
      }
      throw error;
    }
  }
}

export { CN as QODER_CN_REGION };
