#!/usr/bin/env node
/**
 * 把仓库内各插件包的 `node_modules/@deepseek-ai` 以【目录 junction】指向本机 dsh 安装体的
 * `node_modules/@deepseek-ai` scope 目录。
 *
 * 【scope 来源与 2026-10-15 变更】DSH 0.2.0-rc.2 桌面端把框架包打包进 resources\app.asar
 * （旧 <Roaming>/<dist>/dependencies/… 明文布局随升级消失）⇒ 磁盘上无现成 scope 时，本脚本会先调用
 * tools/dev/extract-dsh-framework.mjs 把 asar 的 dsh/node_modules 物化到
 * %LOCALAPPDATA%\dsh-framework-scope\（幂等、离线、不执行 npm/pnpm），再建立 junction。
 * 候选来源顺序：DSH_DEPS_SCOPE > 抽取体（默认根内，新者优先）> 旧 Roaming 明文布局。
 *
 * 为什么需要（第一性）：T02 验收测试要求**真实的** `defineTool` / cordis 依赖（stub 无法证明
 * schema 编译、fiber 归属、effect 语义）。junction 使 `import '@deepseek-ai/dsh-tools'` 在仓库内可解析，
 * 而无需 `npm install`（该前提仍受 V24 数据根争用闭环约束，见 CONTRIBUTING）。
 *
 * 性质与边界：
 *   - **只读源**：绝不写入 dsh 安装体（仅 readdir/stat）。
 *   - 写入仅限本仓库 `packages/*​/node_modules/`（已 gitignore）。
 *   - 幂等：已存在且指向正确 ⇒ 跳过；指向其它路径 / 被真实目录占用 ⇒ 报告并保持原样（人工处置）。
 *   - 断链自愈：原指向的安装体被删除/改名（如换发行版 id 后 Roaming 目录消失）⇒ 断链属唯一
 *     可自动修复的冲突形态：写盘模式下重建为当前 scope；--check 模式下报告并 exit 1。
 *   - 环境不可用（未装 dsh / 无权限）⇒ 报告 + `exit 0`（测试侧按"依赖不可用"整组 skip）。
 *
 * 用法：
 *   node tools/dev/link-dsh-deps.mjs            # 建立/校验（默认）
 *   node tools/dev/link-dsh-deps.mjs --check    # 只报告，不写盘；不可用 ⇒ exit 1
 *   DSH_DEPS_SCOPE=<path> …                     # 显式指定 scope（CI / 非常规安装位）
 *
 * 约束：本文件位于 tools/（不在 CI ② / ③ 的 packages 扫描范围内），但仍遵守"C2：零进程出口"。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkOnly = process.argv.includes('--check');

/** 关键包：链接后逐个探测其入口是否存在（证明 scope 内容可用，而非仅目录存在）。 */
const REQUIRED = [
  'cordis',
  'schemastery',
  'dsh-tools',
  'dsh-subprocess',
  'dsh-jobs',
  'dsh-settings',
  'dsh-system-prompt',
  'dsh-subagent',
  'dsh-llm',
  'dsh-agent',
  'dsh-brand',
];

function localAppData() {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

function mtimeOf(path, fallback) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return fallback;
  }
}

function scopeCandidates() {
  const list = [];
  const explicit = process.env.DSH_DEPS_SCOPE;
  if (typeof explicit === 'string' && explicit.trim() !== '') list.push(resolve(explicit.trim()));
  // 2026-10-15 布局：桌面端 app.asar 物化体（tools/dev/extract-dsh-framework.mjs 落盘）：
  //   <root>/dsh-desktop-<ver>-<commit>/dsh/node_modules/@deepseek-ai（新者优先）
  const extractedRoot = process.env.DSH_FRAMEWORK_ROOT ?? join(localAppData(), 'dsh-framework-scope');
  if (existsSync(extractedRoot)) {
    const dirs = readdirSync(extractedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    dirs.sort((a, b) => mtimeOf(join(extractedRoot, b.name), 0) - mtimeOf(join(extractedRoot, a.name), 0));
    for (const entry of dirs) list.push(join(extractedRoot, entry.name, 'dsh', 'node_modules', '@deepseek-ai'));
  }
  // 旧 CLI 发行版布局（保留探测，兼容仍以明文 node_modules 安装的形态）：
  //   <Roaming>/<dist>/dependencies/dsh/node_modules/@deepseek-ai
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (existsSync(roaming)) {
    for (const entry of readdirSync(roaming, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      list.push(join(roaming, entry.name, 'dependencies', 'dsh', 'node_modules', '@deepseek-ai'));
    }
  }
  return list;
}

function findScope() {
  let fallback = null;
  for (const candidate of scopeCandidates()) {
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      /* 不存在/无权限 ⇒ 试下一个（缺这个 continue 曾把死路径误当 fallback，2026-10-15 修） */
      continue;
    }
    if (fallback === null) fallback = candidate;
    // 优先「关键包齐全」的 scope：换发行版后旧 Roaming 目录可能残留半删状态，
    // 仅凭目录存在会挑中空壳，链接到没有 schemastery/dsh-tools 的残骸。
    const missing = REQUIRED.filter((name) => !existsSync(join(candidate, name, 'package.json')));
    if (missing.length === 0) return candidate;
  }
  return fallback;
}

/**
 * 读 target 的链接状态。lstat 能成功但 existsSync 为 false = 断链
 * （junction 条目在、指向的路径已消失）——existsSync 会跟随链接，故断链看起来"不存在"。
 */
function linkState(target) {
  try {
    const st = lstatSync(target);
    if (!st.isSymbolicLink()) return { kind: 'dir', alive: true };
    const current = resolve(dirname(target), readlinkSync(target));
    return { kind: 'link', current, alive: existsSync(target) };
  } catch {
    return null;
  }
}

function pluginPackageDirs() {
  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'package.json')))
    .map((e) => join(packagesDir, e.name));
}

function missingRequiredIn(dir) {
  if (dir === null) return [...REQUIRED];
  return REQUIRED.filter((name) => !existsSync(join(dir, name, 'package.json')));
}

let scope = findScope();
let missingRequired = missingRequiredIn(scope);

// 2026-10-15：桌面端把框架打进 app.asar，磁盘无明文 scope ⇒ 先物化（幂等）再重找。
if (!checkOnly && (scope === null || missingRequired.length > 0)) {
  try {
    const { ensureFrameworkScope } = await import('./extract-dsh-framework.mjs');
    const ensured = ensureFrameworkScope();
    if (ensured.ok && ensured.scope) {
      scope = findScope();
      missingRequired = missingRequiredIn(scope);
    } else if (!ensured.ok) {
      console.log(`[link-dsh-deps] ${ensured.message ?? ensured.reason ?? '抽取器未就绪'}`);
    }
  } catch (error) {
    console.log(`[link-dsh-deps] 抽取器异常：${error instanceof Error ? error.message : String(error)}`);
  }
}

if (scope === null) {
  console.log('[link-dsh-deps] 未找到本机 dsh 安装体的 @deepseek-ai scope。');
  console.log('  探测过的位置（首个存在者胜）：');
  for (const c of scopeCandidates()) console.log(`    - ${c}`);
  console.log('  提示：可用 DSH_DEPS_SCOPE=<path> 显式指定；或用 node tools/dev/extract-dsh-framework.mjs 从桌面端 asar 物化；测试将按“依赖不可用”整组 skip。');
  process.exit(checkOnly ? 1 : 0);
}
console.log(`[link-dsh-deps] scope: ${scope}`);
if (missingRequired.length > 0) {
  console.log(`[link-dsh-deps] ⚠ scope 内缺少关键包：${missingRequired.join(', ')}`);
}

let linked = 0;
let already = 0;
let healed = 0;
let conflicts = 0;
let broken = 0;

for (const pkgDir of pluginPackageDirs()) {
  const nodeModules = join(pkgDir, 'node_modules');
  const target = join(nodeModules, '@deepseek-ai');
  const label = pkgDir.slice(repoRoot.length + 1).replaceAll('\\', '/');
  const st = linkState(target);

  if (st !== null && st.kind === 'link' && !st.alive) {
    // 断链：唯一自动修复形态（原安装体已消失，链接本身没有可保留的价值）
    if (checkOnly) {
      console.log(`[link-dsh-deps] ✗ ${label}/node_modules/@deepseek-ai → 断链（原指向已消失：${st.current}）`);
      broken += 1;
      continue;
    }
    rmSync(target); // 只删 junction 条目，不触碰任何一侧的目录内容
    mkdirSync(nodeModules, { recursive: true });
    symlinkSync(scope, target, 'junction');
    console.log(`[link-dsh-deps] ✔ ${label}/node_modules/@deepseek-ai → 断链已修复 → ${scope}`);
    healed += 1;
    continue;
  }

  if (st !== null) {
    if (st.kind === 'link') {
      if (st.current === resolve(scope)) {
        console.log(`[link-dsh-deps] ✓ ${label}/node_modules/@deepseek-ai → 已就位`);
        already += 1;
      } else {
        console.log(`[link-dsh-deps] ✗ ${label}/node_modules/@deepseek-ai → 指向其它位置（保持原样）：${st.current}`);
        conflicts += 1;
      }
    } else {
      console.log(`[link-dsh-deps] ✗ ${label}/node_modules/@deepseek-ai → 已被真实目录占用（保持原样）`);
      conflicts += 1;
    }
    continue;
  }

  if (checkOnly) {
    console.log(`[link-dsh-deps] · ${label}/node_modules/@deepseek-ai → 尚未建立（--check 不写盘）`);
    continue;
  }
  mkdirSync(nodeModules, { recursive: true });
  symlinkSync(scope, target, 'junction'); // Windows 目录 junction：无需管理员权限
  console.log(`[link-dsh-deps] ＋ ${label}/node_modules/@deepseek-ai → 已建立 junction`);
  linked += 1;
}

console.log(
  `[link-dsh-deps] 汇总：新建 ${linked}，已就位 ${already}，断链修复 ${healed}，冲突 ${conflicts}` +
    (missingRequired.length > 0 ? `，缺包 ${missingRequired.length}` : ''),
);
process.exit(
  checkOnly && (conflicts > 0 || broken > 0 || missingRequired.length > 0) ? 1 : 0,
);
