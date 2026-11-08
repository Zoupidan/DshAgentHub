/**
 * 启动项管理：写入/撤销 Startup .cmd（带 --remote-debugging-port）；注册表 Run 键只报告不修改。
 * 插件不代拉起/不代关闭/不代重启 Qoder。
 * @module host/startup/manager
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CDP_PORT } from '../../shared/constants.js';

const STARTUP_FILENAME = 'Qoder CN (dsh).cmd';

function startupDir() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function startupPath() { return join(startupDir(), STARTUP_FILENAME); }

function defaultQoderExe() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(local, 'Programs', 'Qoder CN', 'Qoder CN.exe');
}

function escapeCmdPath(p) {
  return `"${String(p).replace(/"/g, '')}"`;
}

export function inspectStartup(config = {}) {
  const port = Number.isFinite(config.cdpPort) ? Math.floor(config.cdpPort) : DEFAULT_CDP_PORT;
  const path = startupPath();
  const exists = existsSync(path);
  let content = '';
  let matches = false;
  if (exists) {
    try {
      content = readFileSync(path, 'utf8');
      matches = content.includes(`--remote-debugging-port=${port}`) || content.includes(`--remote-debugging-port ${port}`);
    } catch { content = ''; }
  }
  return {
    path,
    exists,
    matches,
    port,
    filename: STARTUP_FILENAME,
    // 注册表 Run 键检测：不执行 reg.exe/不读注册表（避免进程出口）；如实报告。
    registryRunKey: {
      checked: false,
      detected: 'unknown',
      note: '插件未检查注册表 Run 键（避免进程执行）；若 Qoder 仍由注册表自启，请用户手动关闭该自启项，避免与 Startup .cmd 冲突。插件不会修改注册表。',
    },
  };
}

export function applyStartup(config = {}) {
  const port = Number.isFinite(config.cdpPort) ? Math.floor(config.cdpPort) : DEFAULT_CDP_PORT;
  const dir = startupDir();
  const path = startupPath();
  const exe = defaultQoderExe();
  mkdirSync(dir, { recursive: true });
  const body = [
    '@echo off',
    'REM Managed by dsh-plugin-qoder: launch Qoder CN with CDP for local dsh integration.',
    'REM Revoke by deleting this file or using the plugin settings card.',
    `start "" ${escapeCmdPath(exe)} --remote-debugging-port=${port}`,
    '',
  ].join('\r\n');
  writeFileSync(path, body, 'utf8');
  return { ok: true, path, port, exe, note: '已写入启动项（.cmd）。插件不会启动/关闭/重启 Qoder；请由用户手动重启 Qoder 使参数生效。' };
}

export function revokeStartup() {
  const path = startupPath();
  if (existsSync(path)) {
    try { unlinkSync(path); } catch (e) { return { ok: false, path, error: String(e?.message ?? e) }; }
  }
  return { ok: true, path, removed: true };
}
