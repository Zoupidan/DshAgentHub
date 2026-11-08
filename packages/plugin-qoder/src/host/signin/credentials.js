/**
 * 凭据存储（CN，PAT 粘贴）。不读 auth.v1.dat、不做 DPAPI、不拉进程。
 * vault 落在 DSH_HOME（或 os.homedir()/.dsh）下；文件权限尽力 0600；日志/回执只存掩码。
 *
 * 账号 id 派生与掩码规则参考 MIT 项目 dingminhua/dsh-connect-qoder (src/credentials.ts)。
 *
 * @module host/signin/credentials
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PAT_PATTERN } from '../../shared/constants.js';

export function isValidPat(value) {
  return typeof value === 'string' && PAT_PATTERN.test(value.trim());
}

export function qoderAccountId(pat) {
  return `pat-${createHash('sha256').update(String(pat), 'utf8').digest('hex').slice(0, 16)}`;
}

export function maskPat(pat) {
  const s = String(pat ?? '');
  if (s.length <= 10) return '…';
  return `${s.slice(0, 5)}…${s.slice(-4)}`;
}

function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return join(homedir(), '.dsh');
}

export function vaultPath() {
  return join(dshHome(), 'qoder-cn-signin.json');
}

function readVault() {
  const p = vaultPath();
  if (!existsSync(p)) return { version: 1, region: 'cn', pat: '' };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return typeof raw === 'object' && raw !== null ? raw : { version: 1, region: 'cn', pat: '' };
  } catch {
    return { version: 1, region: 'cn', pat: '', corrupt: true };
  }
}

export function getCredentialMeta() {
  const v = readVault();
  const pat = typeof v.pat === 'string' ? v.pat.trim() : '';
  if (!isValidPat(pat)) return { configured: false, region: 'cn', accountId: '', masked: '', path: vaultPath() };
  return {
    configured: true,
    region: 'cn',
    accountId: qoderAccountId(pat),
    masked: maskPat(pat),
    path: vaultPath(),
  };
}

/** 仅供同进程内 signin 模块读取；调用方不得把返回值写入日志/回执/设置。 */
export function readPatSecret() {
  const v = readVault();
  const pat = typeof v.pat === 'string' ? v.pat.trim() : '';
  return isValidPat(pat) ? pat : '';
}

export function savePat(pat) {
  const s = String(pat ?? '').trim();
  if (!isValidPat(s)) return { ok: false, reason: 'invalid-pat', message: 'PAT 形态无效（需以 pt- 开头）' };
  const dir = dshHome();
  mkdirSync(dir, { recursive: true });
  const p = vaultPath();
  const payload = {
    version: 1,
    region: 'cn',
    pat: s,
    accountId: qoderAccountId(s),
    masked: maskPat(s),
    savedAt: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  try { chmodSync(p, 0o600); } catch { /* Windows 上可能不生效；不视为失败 */ }
  return { ok: true, ...getCredentialMeta() };
}

export function clearPat() {
  const dir = dshHome();
  mkdirSync(dir, { recursive: true });
  const p = vaultPath();
  writeFileSync(p, JSON.stringify({ version: 1, region: 'cn', pat: '', clearedAt: new Date().toISOString() }, null, 2), 'utf8');
  try { chmodSync(p, 0o600); } catch {}
  return { ok: true, configured: false, path: p };
}
