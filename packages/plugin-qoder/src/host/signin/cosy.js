/**
 * Qoder cosy 协议：加密与签名原语（CN 签到/用量链路用）。
 *
 * 移植自 MIT 项目 dingminhua/dsh-connect-qoder (src/cosy.ts)；
 * 协议来源见该仓库注释（fengyinxia/qoder2api、x_Zhengyuuuui/qoder2api）。
 * 本文件只做无状态纯函数，不触网。
 *
 * @module host/signin/cosy
 */
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';

export const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const CUSTOM_PAD = '$';

const s2c = new Map();
const c2s = new Map();
for (let i = 0; i < 64; i += 1) {
  s2c.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i]);
  c2s.set(CUSTOM_ALPHABET[i], STD_ALPHABET[i]);
}
s2c.set('=', CUSTOM_PAD);
c2s.set(CUSTOM_PAD, '=');

export function cosyEncode(plaintext) {
  const std = Buffer.from(plaintext).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) {
    const mapped = s2c.get(ch);
    if (mapped === undefined) throw new Error(`cosy encode: char out of alphabet: ${ch}`);
    out += mapped;
  }
  return out;
}

export function currentRfc1123Date() {
  return new Date().toUTCString();
}

export function md5Hex(input) {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

export function sha512Base64Url(input) {
  return createHash('sha512').update(input, 'utf8').digest('base64url');
}

export const COSY_APPCODE = 'cosy';
export const COSY_SECRET_B64 = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
export const COSY_VERSION = '0.1.43';
export const COSY_CLIENT_TYPE = '10';
export const COSY_VERSION_HEADER = '1.1.69';

export function signLegacy(date) {
  return md5Hex(`${COSY_APPCODE}&${COSY_SECRET_B64}&${date}`);
}

export const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function aesCbcEncrypt(plain, key) {
  const iv = key;
  const blockSize = 16;
  const padLen = blockSize - (plain.length % blockSize);
  const padded = new Uint8Array(plain.length + padLen);
  padded.set(plain);
  padded.fill(padLen, plain.length);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]));
}

export function rsaEncrypt(plain) {
  return new Uint8Array(publicEncrypt({ key: SERVER_PUBKEY_PEM, padding: 1 }, Buffer.from(plain)));
}

function identityPayload(identity) {
  return {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yx_uid,
    organization_id: identity.organization_id,
    organization_name: identity.organization_name,
    user_type: identity.user_type,
    security_oauth_token: identity.security_oauth_token,
    refresh_token: identity.refresh_token,
  };
}

export function identityFromJobToken(jt) {
  return {
    name: String(jt.name ?? ''),
    aid: String(jt.id ?? ''),
    uid: String(jt.id ?? ''),
    yx_uid: '',
    organization_id: '',
    organization_name: '',
    user_type: String(jt.userType ?? 'personal_standard'),
    security_oauth_token: String(jt.securityOauthToken ?? ''),
    refresh_token: String(jt.refreshToken ?? ''),
  };
}

export function newCosySession(identity, machineId, machineToken, machineType) {
  const tempKey = new Uint8Array(Buffer.from(randomBytes(16).toString('hex').slice(0, 16), 'utf8'));
  const cosyKey = Buffer.from(rsaEncrypt(tempKey)).toString('base64');
  const payload = JSON.stringify(identityPayload(identity));
  const info = Buffer.from(aesCbcEncrypt(new Uint8Array(Buffer.from(payload, 'utf8')), tempKey)).toString('base64');
  return { tempKey, cosyKey, info, identity, machineId, machineToken, machineType };
}

export function buildPayloadB64(info) {
  const payload = { cosyVersion: COSY_VERSION, ideVersion: '', info, requestId: randomUUID(), version: 'v1' };
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1)));
  return Buffer.from(JSON.stringify(sorted)).toString('base64');
}

export function signRequest(payloadB64, cosyKey, cosyDate, body, pathSig) {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`);
}

export function composeBearer(payloadB64, sig) {
  return `Bearer COSY.${payloadB64}.${sig}`;
}

export function pathSigFrom(fullUrl) {
  let p;
  try { p = new URL(fullUrl).pathname; } catch { p = fullUrl; }
  return p.startsWith('/algo') ? p.slice('/algo'.length) : p;
}

function deriveId(seed, salt, installSalt) {
  const salted = installSalt ? `${seed}|salt:${installSalt}` : seed;
  return md5Hex(`${salt}:${salted}`);
}

export function deriveFingerprint(uid, credential, installSalt) {
  const seed = uid !== '' ? uid : `cred:${credential}`;
  return {
    machineId: deriveId(seed, 'machine', installSalt),
    machineType: deriveId(seed, 'machinetype', installSalt).slice(0, 18),
    machineToken: sha512Base64Url(`machinetoken:${installSalt ? `${seed}|salt:${installSalt}` : seed}`).slice(0, 43),
  };
}

export function jobTokenBody(credential) {
  const isRefresh = typeof credential === 'string' && credential.startsWith('drt-');
  const inner = {
    personalToken: isRefresh ? '' : credential,
    securityOauthToken: '',
    refreshToken: isRefresh ? credential : '',
    needRefresh: isRefresh,
    authInfo: {},
  };
  const outer = { payload: JSON.stringify(inner), encodeVersion: '1' };
  return cosyEncode(new TextEncoder().encode(JSON.stringify(outer)));
}
