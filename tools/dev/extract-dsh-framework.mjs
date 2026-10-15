#!/usr/bin/env node
/**
 * tools/dev/extract-dsh-framework.mjs — 从 DSH 桌面端 app.asar 物化框架 scope（真实文件树，供 link:dsh-deps junction）。
 *
 * 背景（2026-10-15 实测，含数字）：
 *   DSH 升级为 0.2.0-rc.2（"DeepSeek Harness" Electron 桌面端，安装于
 *   %LOCALAPPDATA%\Programs\DeepSeek Harness）后，框架包不再以明文 node_modules 出现在磁盘上，
 *   而是打包进 resources\app.asar 的 dsh/node_modules 子树：
 *     - asar 121,348,951 B（构建提交 04f392c9，版本 0.2.0-rc.2）；
 *     - dsh/** 共 12,412 文件：asar 数据 10,915 文件 / 107.4 MB；unpacked 旗标 1,497 文件 / 242.7 MB
 *       （实体在 resources\app.asar.unpacked\，原生 .node/.dll/.exe 都在那边）；
 *     - @deepseek-ai/* 全家（cordis / schemastery / dsh-tools / dsh-subprocess / dsh-jobs /
 *       dsh-settings / dsh-system-prompt / dsh-subagent / dsh-llm / dsh-agent / dsh-brand / dsh-base …）
 *       + 三方依赖（yaml / zod / undici …）都在 dsh/node_modules 下。
 *   旧的 <Roaming>/<dist>/dependencies/dsh/node_modules/@deepseek-ai 明文布局已随升级消失
 *   （仓库测试因此断链：10 个测试文件 ERR_MODULE_NOT_FOUND，详见 04-docs/CHECK-20261015-workbuddy.md）。
 *
 * 本工具做的事（幂等、离线、零 npm/pnpm 执行）：
 *   ① 定位本机桌面端 app.asar：DSH_APP_ASAR 显式指定 > 扫 %LOCALAPPDATA%\Programs\*\resources\app.asar，
 *      以「asar 头内存在 dsh/node_modules/@deepseek-ai/cordis/package.json」为有效性判据；
 *   ② 把 asar 的 dsh/** 子树整体抽取为真实文件树：
 *        unpacked:true 条目 → 从 resources\app.asar.unpacked\<同相对路径> 拷贝；
 *        其余条目 → 按 asar 头里的 offset/size 从数据区切片写出；
 *   ③ 落盘到 %LOCALAPPDATA%\dsh-framework-scope\dsh-desktop-<version>-<commit>\（DSH_FRAMEWORK_ROOT 可改根），
 *      并写 .extract.json 标记（asar 路径/大小/mtime + 版本）；标记命中即视为最新（--force 强制重抽）。
 *
 * 它【不是】安装：不联网、不执行 npm/pnpm、不写 ~/.dsh 与任何 harness 用户数据；
 * 只是把本机安装体里已有的字节物化出来，让测试的 junction 有的可指。
 * link:dsh-deps（tools/dev/link-dsh-deps.mjs）在找不到完整 scope 时会自动调用它。
 *
 * 用法：
 *   node tools/dev/extract-dsh-framework.mjs          # 需要时抽取（幂等）
 *   node tools/dev/extract-dsh-framework.mjs --force  # 强制重抽（桌面端升级后也可用它重置）
 *   node tools/dev/extract-dsh-framework.mjs --check  # 只报告将做什么，不写盘
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_PREFIX = '[extract-dsh-framework]';

function localAppData() {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

function frameworkRoot() {
  const explicit = process.env.DSH_FRAMEWORK_ROOT;
  return typeof explicit === 'string' && explicit.trim() !== ''
    ? resolve(explicit.trim())
    : join(localAppData(), 'dsh-framework-scope');
}

function listAsarCandidates() {
  const list = [];
  const explicit = process.env.DSH_APP_ASAR;
  if (typeof explicit === 'string' && explicit.trim() !== '') list.push(resolve(explicit.trim()));
  const programs = join(localAppData(), 'Programs');
  if (existsSync(programs)) {
    for (const entry of readdirSync(programs, { withFileTypes: true })) {
      if (entry.isDirectory()) list.push(join(programs, entry.name, 'resources', 'app.asar'));
    }
  }
  return list;
}

/** asar 头结构：sizePickle(8) + headerPickle；JSON 字符串 = [uint32 len @12][bytes @16]；数据区起点 = 8 + headerPickle 大小。 */
function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    if (readSync(fd, sizeBuf, 0, 16, 0) !== 16) throw new Error('asar 头截断');
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const jsonLength = sizeBuf.readUInt32LE(12);
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) throw new Error(`asar 头长度异常：${jsonLength}`);
    const jsonBuf = Buffer.alloc(jsonLength);
    if (readSync(fd, jsonBuf, 0, jsonLength, 16) !== jsonLength) throw new Error('asar 头 JSON 截断');
    return { header: JSON.parse(jsonBuf.toString('utf8')), dataStart: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

function hasFramework(header) {
  return Boolean(
    header?.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']?.files?.cordis?.files?.['package.json'],
  );
}

function readAsarNode(fd, dataStart, node) {
  const size = Number(node.size ?? 0);
  const buf = Buffer.alloc(size);
  if (size > 0) {
    const read = readSync(fd, buf, 0, size, dataStart + Number(node.offset));
    if (read !== size) throw new Error('asar 数据截断');
  }
  return buf;
}

export function findDesktopAsar() {
  for (const candidate of listAsarCandidates()) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = readAsarHeader(candidate);
      if (hasFramework(parsed.header)) return { asarPath: candidate, ...parsed };
    } catch {
      /* 不是有效 asar ⇒ 试下一个 */
    }
  }
  return null;
}

function appMetaFromAsar(found) {
  const node = found.header?.files?.['package.json'];
  if (!node) return { version: 'unknown', commit: 'unknown' };
  const fd = openSync(found.asarPath, 'r');
  try {
    const meta = JSON.parse(readAsarNode(fd, found.dataStart, node).toString('utf8'));
    return {
      version: typeof meta.version === 'string' ? meta.version : 'unknown',
      commit: typeof meta.dshBuildCommit === 'string' ? meta.dshBuildCommit.slice(0, 8) : 'unknown',
    };
  } finally {
    closeSync(fd);
  }
}

function safeSegment(text) {
  return String(text).replaceAll(/[^A-Za-z0-9._-]+/g, '_');
}

function readMarker(targetDir) {
  try {
    return JSON.parse(readFileSync(join(targetDir, '.extract.json'), 'utf8'));
  } catch {
    return null;
  }
}

function markerIsFresh(marker) {
  if (marker === null || typeof marker.asarPath !== 'string') return false;
  try {
    const st = statSync(marker.asarPath);
    return st.size === marker.asarSize && Math.round(st.mtimeMs) === marker.asarMtimeMs;
  } catch {
    return false;
  }
}

/**
 * 保障一个可用的框架 scope 存在，返回其路径。
 * @returns {{ok: boolean, scope?: string|null, targetDir?: string, version?: string, commit?: string,
 *            extracted?: boolean, wouldExtract?: boolean, reason?: string, message?: string}}
 */
export function ensureFrameworkScope({ force = false, checkOnly = false, log = (line) => console.log(line) } = {}) {
  const root = frameworkRoot();

  // ① 标记快扫：已有与当前 asar 一致的抽取体 ⇒ 直接复用（免深扫/免重抽）
  if (!force && existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const targetDir = join(root, entry.name);
      const scope = join(targetDir, 'dsh', 'node_modules', '@deepseek-ai');
      const marker = readMarker(targetDir);
      if (marker === null || !existsSync(scope)) continue;
      if (markerIsFresh(marker)) {
        log(`${LOG_PREFIX} ✓ 已是最新：${scope}`);
        return { ok: true, scope, targetDir, version: marker.version, commit: marker.commit, extracted: false };
      }
    }
  }

  // ② 深扫：定位含框架的 app.asar
  const found = findDesktopAsar();
  if (found === null) {
    return { ok: false, reason: 'no-asar', message: '未找到含 dsh 框架的 app.asar（可用 DSH_APP_ASAR 显式指定）' };
  }
  const meta = appMetaFromAsar(found);
  const dirName = `dsh-desktop-${safeSegment(meta.version)}-${safeSegment(meta.commit)}`;
  const targetDir = join(root, dirName);
  const scope = join(targetDir, 'dsh', 'node_modules', '@deepseek-ai');
  const unpackedRoot = join(dirname(found.asarPath), 'app.asar.unpacked');

  const asarStat = statSync(found.asarPath);
  const marker = {
    asarPath: found.asarPath,
    asarSize: asarStat.size,
    asarMtimeMs: Math.round(asarStat.mtimeMs),
    version: meta.version,
    commit: meta.commit,
  };

  const currentMarker = readMarker(targetDir);
  const fresh = existsSync(scope) && markerIsFresh(currentMarker);

  if (checkOnly) {
    return {
      ok: true,
      scope: fresh ? scope : null,
      targetDir,
      version: meta.version,
      commit: meta.commit,
      wouldExtract: !fresh,
    };
  }

  if (fresh && !force) {
    log(`${LOG_PREFIX} ✓ 已是最新：${scope}`);
    return { ok: true, scope, targetDir, version: meta.version, commit: meta.commit, extracted: false };
  }

  log(`${LOG_PREFIX} 从 ${found.asarPath} 抽取 → ${targetDir}`);
  rmSync(targetDir, { recursive: true, force: true });
  const dshNode = found.header?.files?.['dsh'];
  if (!dshNode?.files) {
    return { ok: false, reason: 'no-dsh-subtree', message: 'asar 内没有 dsh/ 子树' };
  }
  const fd = openSync(found.asarPath, 'r');
  let files = 0;
  let bytes = 0;
  const missingUnpacked = [];
  try {
    const visit = (node, rel) => {
      if (!node?.files) return;
      for (const [name, child] of Object.entries(node.files)) {
        const childRel = `${rel}/${name}`;
        if (child.files) {
          visit(child, childRel);
          continue;
        }
        const outPath = join(targetDir, childRel);
        mkdirSync(dirname(outPath), { recursive: true });
        if (child.unpacked) {
          const source = join(unpackedRoot, childRel);
          if (!existsSync(source)) {
            missingUnpacked.push(childRel);
            continue;
          }
          copyFileSync(source, outPath);
          bytes += statSync(source).size;
        } else {
          writeFileSync(outPath, readAsarNode(fd, found.dataStart, child));
          bytes += Number(child.size ?? 0);
        }
        files += 1;
      }
    };
    visit(dshNode, 'dsh');
  } finally {
    closeSync(fd);
  }
  writeFileSync(
    join(targetDir, '.extract.json'),
    `${JSON.stringify({ ...marker, extractedAt: new Date().toISOString(), files, bytes }, null, 2)}\n`,
  );
  if (missingUnpacked.length > 0) {
    log(
      `${LOG_PREFIX} ⚠ ${missingUnpacked.length} 个 unpacked 侧文件缺失（已跳过）：` +
        `${missingUnpacked.slice(0, 5).join(' | ')}${missingUnpacked.length > 5 ? ' …' : ''}`,
    );
  }
  log(`${LOG_PREFIX} ✓ 抽取完成：${files} 文件 / ${(bytes / 1048576).toFixed(1)} MB`);
  log(`${LOG_PREFIX} scope = ${scope}`);
  return { ok: true, scope, targetDir, version: meta.version, commit: meta.commit, extracted: true, files, bytes };
}

const isMain = (() => {
  if (typeof process.argv[1] !== 'string' || process.argv[1] === '') return false;
  const self = fileURLToPath(import.meta.url);
  return resolve(process.argv[1]).toLowerCase() === self.toLowerCase();
})();

if (isMain) {
  const force = process.argv.includes('--force');
  const checkOnly = process.argv.includes('--check');
  const result = ensureFrameworkScope({ force, checkOnly });
  if (!result.ok) {
    console.error(`${LOG_PREFIX} ✗ ${result.message ?? result.reason}`);
    process.exit(1);
  }
  if (result.wouldExtract) {
    console.log(`${LOG_PREFIX} （--check）目标未就绪；将抽取到 ${result.targetDir}`);
    process.exit(0);
  }
  console.log(`${LOG_PREFIX} scope: ${result.scope}`);
}
