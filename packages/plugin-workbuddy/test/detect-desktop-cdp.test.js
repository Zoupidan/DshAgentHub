/**
 * WorkBuddy 桌面端 CDP 探测与通配缓存扫描回归测试套件
 * (detect-desktop-cdp.test.js)
 *
 * 验证目标:
 * 1. Positive CDP Detection: 调试端口（9222 等）命中 WorkBuddy UA 或 target ⇒ installed: true, method: 'desktop-cdp'
 * 2. Closed Port Fallback: 端口关闭/超时且无缓存 ⇒ installed: false, reason: 'not_found', method: 'desktop-probe'
 * 3. Non-WorkBuddy Rejection: 调试端口为外部 Chromium (无 WorkBuddy 签名) ⇒ 拒绝假冒，installed: false
 * 4. Wildcard Cache Scanning: ~/.workbuddy/cache/acc-product-config-v3-<pid>-<uuid>.json 动态文件名 ⇒ installed: true, method: 'desktop-cache'
 * 5. Tool Surface Injection: CDP 探测成功时，reconcileTools 正确注入 workbuddy_run / workbuddy_status
 * 6. Availability Text: installed: true 时不再提示 "the WorkBuddy desktop was not found"；installed: false 时保留严格回退文案
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectWorkBuddy } from '../src/host/probe/detect.js';
import { availabilityText } from '../src/host/prompts/availability.js';
import { REGISTRY_STATES } from '../src/host/config/constants.js';
import { boot } from './host.test.js';

/** 创建单次使用的临时测试目录 */
function makeTempHome() {
  return mkdtempSync(join(tmpdir(), 'wb-cdp-test-'));
}

/** 启动模拟 CDP HTTP 服务 */
function startMockCdpServer({
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkBuddy/5.9.3 Electron/37.10.3 Chrome/138.0.7204.251 Safari/537.36',
  targets = [
    {
      id: 'target-1',
      type: 'page',
      title: 'WorkBuddy',
      url: 'file:///C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-1',
    },
  ],
} = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'Chrome/138.0.7204.251',
        'User-Agent': userAgent,
      }));
    } else if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('CDP 1: 命中 WorkBuddy CDP 调试端口 ⇒ installed: true, method: desktop-cdp', async () => {
  const mockServer = await startMockCdpServer();
  const tempHome = makeTempHome();
  try {
    const fakeEnv = {
      WORKBUDDY_HOME: tempHome,
      HOME: tempHome,
      USERPROFILE: tempHome,
      ProgramFiles: tempHome,
      ProgramW6432: tempHome,
      'ProgramFiles(x86)': tempHome,
      LOCALAPPDATA: tempHome,
    };
    const result = await detectWorkBuddy({}, { followupCdpPort: mockServer.port, timeoutMs: 150 }, fakeEnv);

    assert.equal(result.target, 'workbuddy');
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.method, 'desktop-cdp');
    assert.equal(result.resolvedPath, `http://127.0.0.1:${mockServer.port}`);

    const cdpEvidence = result.evidence.find((e) => e.kind === 'desktop-cdp');
    assert.ok(cdpEvidence, '必须包含 desktop-cdp 证据');
    assert.equal(cdpEvidence.found, true);
    assert.equal(cdpEvidence.value, `http://127.0.0.1:${mockServer.port}`);
  } finally {
    await mockServer.close();
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('CDP 2: CDP 端口关闭且无缓存 ⇒ 优雅回退 installed: false, method: desktop-probe', async () => {
  const tempHome = makeTempHome();
  try {
    const fakeEnv = {
      WORKBUDDY_HOME: tempHome,
      HOME: tempHome,
      USERPROFILE: tempHome,
      ProgramFiles: tempHome,
      ProgramW6432: tempHome,
      'ProgramFiles(x86)': tempHome,
      LOCALAPPDATA: tempHome,
    };
    // 使用一个肯定未监听的高位回环端口
    const unusedPort = 59999;
    const result = await detectWorkBuddy({}, { followupCdpPort: unusedPort, timeoutMs: 50 }, fakeEnv);

    assert.equal(result.target, 'workbuddy');
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'not_found');
    assert.equal(result.method, 'desktop-probe');

    const cdpEvidence = result.evidence.find((e) => e.kind === 'desktop-cdp');
    assert.ok(cdpEvidence, '必须包含 desktop-cdp 证据');
    assert.equal(cdpEvidence.found, false);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('CDP 3: 外部非 WorkBuddy Chromium 调试端口 ⇒ 严格拒绝，防止假冒', async () => {
  // 模拟普通 Chrome 浏览器 CDP（无 WorkBuddy UA，无 app.asar/workbuddy target）
  const foreignServer = await startMockCdpServer({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
    targets: [
      {
        id: 'page-google',
        type: 'page',
        title: 'Google',
        url: 'https://www.google.com/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/google',
      },
    ],
  });
  const tempHome = makeTempHome();
  try {
    const fakeEnv = {
      WORKBUDDY_HOME: tempHome,
      HOME: tempHome,
      USERPROFILE: tempHome,
      ProgramFiles: tempHome,
      ProgramW6432: tempHome,
      'ProgramFiles(x86)': tempHome,
      LOCALAPPDATA: tempHome,
    };
    const result = await detectWorkBuddy({}, { followupCdpPort: foreignServer.port, timeoutMs: 150 }, fakeEnv);

    assert.equal(result.target, 'workbuddy');
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'not_found');
    assert.equal(result.method, 'desktop-probe');

    const cdpEvidence = result.evidence.find((e) => e.kind === 'desktop-cdp');
    assert.ok(cdpEvidence);
    assert.equal(cdpEvidence.found, false);
  } finally {
    await foreignServer.close();
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Cache 4: 通配扫描动态文件名 acc-product-config-v3-<pid>-<uuid>.json ⇒ installed: true, method: desktop-cache', async () => {
  const tempHome = makeTempHome();
  try {
    const cacheDir = join(tempHome, '.workbuddy', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    // 写入新版带 PID 和 UUID 的动态缓存文件
    const dynamicCacheFile = join(cacheDir, 'acc-product-config-v3-23836-7c9e6679-7425-40de-944b-e07fc1f90ae7.json');
    writeFileSync(dynamicCacheFile, JSON.stringify({ version: '3.0', models: [{ id: 'fast-model' }] }), 'utf8');

    const fakeEnv = {
      WORKBUDDY_HOME: tempHome,
      HOME: tempHome,
      USERPROFILE: tempHome,
      ProgramFiles: tempHome,
      ProgramW6432: tempHome,
      'ProgramFiles(x86)': tempHome,
      LOCALAPPDATA: tempHome,
    };
    // 禁用 CDP 探针，专门验证通配扫描能力
    const result = await detectWorkBuddy({}, { followupCdpPort: 0 }, fakeEnv);

    assert.equal(result.target, 'workbuddy');
    assert.equal(result.installed, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.method, 'desktop-cache');
    assert.equal(result.resolvedPath, dynamicCacheFile);

    const cacheEvidence = result.evidence.find((e) => e.kind === 'desktop-cache');
    assert.ok(cacheEvidence, '必须包含 desktop-cache 证据');
    assert.equal(cacheEvidence.found, true);
    assert.equal(cacheEvidence.value, dynamicCacheFile);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Availability 5: 当 installed 为 true 时，可用性提示词决不包含 "was not found"', () => {
  const runtimeInstalled = {
    detected: () => ({ installed: true, reason: 'ok', method: 'desktop-cdp' }),
    registry: () => REGISTRY_STATES.REGISTERED,
    currentConfig: () => ({ enabled: true, model: '', effort: '' }),
  };
  const text = availabilityText(runtimeInstalled, { hasTools: true, teamMember: false });

  assert.doesNotMatch(text, /the WorkBuddy desktop was not found on this machine/);
  assert.doesNotMatch(text, /tools are not offered/);
  assert.match(text, /WorkBuddy delegation is available: use workbuddy_run to delegate/);
});

test('Availability 6: 当 installed 为 false 时，保留严格回退提示并说明未提供工具', () => {
  const runtimeNotInstalled = {
    detected: () => ({ installed: false, reason: 'not_found', method: 'desktop-probe' }),
    registry: () => REGISTRY_STATES.NOT_INSTALLED,
    currentConfig: () => ({ enabled: true }),
  };
  const text = availabilityText(runtimeNotInstalled, { hasTools: false, teamMember: false });

  assert.match(
    text,
    /WorkBuddy delegation is unavailable: the WorkBuddy desktop was not found on this machine\. The workbuddy_run \/ workbuddy_status tools are not offered\./,
  );
});

test('Integration 7: CDP 探测成功且开关开启时，宿主装配成功注册 workbuddy_run 与 workbuddy_status', async () => {
  const mockServer = await startMockCdpServer();
  try {
    const host = boot({
      enabled: true,
      desktopInstalled: false,
      catalog: null,
      followupCdpPort: mockServer.port,
    });
    // 等待探测落地
    let payload = null;
    for (let i = 0; i < 50; i += 1) {
      payload = await host.statusPayload();
      if (payload.json?.probe !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(payload?.json?.probe !== null, '探测应在线性时间内落地');
    assert.equal(payload.json.probe.installed, true);
    assert.equal(payload.json.probe.method, 'desktop-cdp');
    assert.equal(payload.json.registry, 'REGISTERED');
    assert.equal(host.state.registration.size, 4);
    assert.ok(host.state.registration.has('workbuddy_run'), '应成功向宿主注入 workbuddy_run 工具');
    assert.ok(host.state.registration.has('workbuddy_status'), '应成功向宿主注入 workbuddy_status 工具');
    assert.ok(host.state.registration.has('workbuddy_purge'), '应成功向宿主注入 workbuddy_purge 工具');
    assert.ok(host.state.registration.has('workbuddy_harvest'), '应成功向宿主注入 workbuddy_harvest 工具');
  } finally {
    await mockServer.close();
  }
});
