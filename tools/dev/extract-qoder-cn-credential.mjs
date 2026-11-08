#!/usr/bin/env node
/**
 * 一次性提取 Qoder CN 本地加密凭据中的 pt- PAT，写入 DSH vault（仅本机，不回显凭据）。
 *
 * 背景：Qoder CN 使用 Chromium os_crypt（Local State 的 DPAPI 保护主密钥 + v10 AES-256-GCM）。
 * 约束：本脚本位于 tools/（非 packages/插件源码），可在用户本机使用系统能力解密；绝不打印 PAT/密钥/明文凭据。
 * 用法：node tools/dev/extract-qoder-cn-credential.mjs [--dry-run] [--profile-dir <path>]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(msg) { process.stderr.write(`[extract-qoder-credential] ${msg}\n`); process.exit(1); }
function maskPat(pat) { const s = String(pat||''); return s.length <= 10 ? '…' : `${s.slice(0,5)}…${s.slice(-4)}`; }
function accountId(pat) { return `pat-${crypto.createHash('sha256').update(String(pat),'utf8').digest('hex').slice(0,16)}`; }
function isValidPat(v) { return typeof v === 'string' && /^pt-[A-Za-z0-9_-]{16,}$/.test(v.trim()); }

function parseArgs(argv) {
  const out = { dryRun: false, profileDir: '' };
  for (let i=2;i<argv.length;i++) {
    const a=argv[i];
    if (a==='--dry-run') out.dryRun=true;
    else if (a==='--profile-dir') out.profileDir=String(argv[++i]||'');
  }
  return out;
}

function findProfileDir(override) {
  if (override) return override;
  const candidates = [
    path.join(process.env.APPDATA || '', 'com.qodercn.app.stable'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'com.qodercn.app.stable'),
  ];
  for (const c of candidates) if (c && fs.existsSync(path.join(c,'Local State')) && fs.existsSync(path.join(c,'auth.v1.dat'))) return c;
  fail('未找到 Qoder CN profile（需要 Local State + auth.v1.dat）。可用 --profile-dir 指定。');
}

function dpapiUnprotectBase64(b64Cipher) {
  // 仅在 Windows 上运行；通过 PowerShell/.NET 调用 DPAPI。绝不输出密钥。
  if (process.platform !== 'win32') fail('当前仅支持 Windows DPAPI 解密。');
  const ps = `
$ErrorActionPreference='Stop'
$b=[Convert]::FromBase64String('${b64Cipher.replace(/'/g,"''")}')
$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($u)
`.trim();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (r.error) fail(`DPAPI 调用失败: ${r.error.message}`);
  if (r.status !== 0) fail(`DPAPI 解密失败（退出码 ${r.status}）。请确认在当前 Windows 用户、Qoder 已登录的环境运行。`);
  const out = String(r.stdout||'').trim();
  if (!out) fail('DPAPI 未返回密钥。');
  return Buffer.from(out, 'base64');
}

function getMasterKey(profileDir) {
  const localStatePath = path.join(profileDir, 'Local State');
  let localState;
  try { localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8')); } catch (e) { fail(`读取 Local State 失败: ${e.message}`); }
  const ek = localState?.os_crypt?.encrypted_key;
  if (typeof ek !== 'string' || !ek) fail('Local State 缺少 os_crypt.encrypted_key。');
  const buf = Buffer.from(ek, 'base64');
  // Chromium: "DPAPI" (5 bytes) + DPAPI blob
  const prefix = buf.subarray(0, 5).toString('utf8');
  if (prefix !== 'DPAPI') fail(`encrypted_key 前缀非 DPAPI（${prefix}），不支持的格式。`);
  return dpapiUnprotectBase64(buf.subarray(5).toString('base64'));
}

function decryptV10(masterKey, data) {
  if (data.subarray(0,3).toString('utf8') !== 'v10') fail('auth.v1.dat 不是 v10 格式。');
  // v10: 'v10'(3) + nonce(12) + ciphertext + tag(16)
  const nonce = data.subarray(3, 15);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(15, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain;
}

function extractPatFromPlain(plain) {
  const text = plain.toString('utf8');
  // 优先在 JSON 结构中找常见字段
  try {
    const j = JSON.parse(text);
    const candidates = [];
    const walk = (v) => {
      if (typeof v === 'string' && isValidPat(v)) candidates.push(v.trim());
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(j);
    if (candidates.length) return candidates[0];
  } catch {}
  // 回退：正则扫描（不打印匹配内容）
  const m = text.match(/\b(pt-[A-Za-z0-9_-]{16,})\b/);
  return m ? m[1] : '';
}

function writeVault(pat, dryRun) {
  const home = (process.env.DSH_HOME && String(process.env.DSH_HOME).trim()) || path.join(os.homedir(), '.dsh');
  const p = path.join(home, 'qoder-cn-signin.json');
  const payload = { version: 1, region: 'cn', pat, accountId: accountId(pat), masked: maskPat(pat), savedAt: new Date().toISOString(), source: 'local-encrypted-extract' };
  if (dryRun) return { path: p, ...payload, pat: undefined, dryRun: true };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  try { fs.chmodSync(p, 0o600); } catch {}
  return { path: p, accountId: payload.accountId, masked: payload.masked, savedAt: payload.savedAt };
}

function main() {
  const args = parseArgs(process.argv);
  const profileDir = findProfileDir(args.profileDir);
  const authPath = path.join(profileDir, 'auth.v1.dat');
  const masterKey = getMasterKey(profileDir);
  let data;
  try { data = fs.readFileSync(authPath); } catch (e) { fail(`读取 auth.v1.dat 失败: ${e.message}`); }
  let plain;
  try { plain = decryptV10(masterKey, data); } catch (e) { fail(`解密 auth.v1.dat 失败（格式不兼容或密钥不匹配）: ${e.message}`); }
  // 立刻丢弃密钥引用（尽力）
  masterKey.fill(0);
  const pat = extractPatFromPlain(plain);
  plain.fill(0);
  if (!isValidPat(pat)) fail('解密成功但未找到有效的 pt- PAT（Qoder 可能使用不同凭据形态）。未写入 vault。');
  const meta = writeVault(pat, args.dryRun);
  // 只输出脱敏信息
  process.stdout.write(JSON.stringify({ ok: true, dryRun: !!args.dryRun, accountId: meta.accountId, masked: meta.masked, vault: meta.path }) + '\n');
}

main();
