import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function dashboardReady(url, apiUrl = url) {
  try {
    // Probe the API before its Vite proxy to avoid expected connection errors during startup.
    const healthAt = address => fetch(new URL('/api/health', address), { signal: AbortSignal.timeout(1200), redirect: 'error' }).then(async r => r.ok ? r.json() : null);
    const valid = health => health?.ok === true && health.signing === false && ['dry-run', 'live'].includes(health.executionMode);
    const health = await healthAt(apiUrl);
    if (!valid(health)) return false;
    const [page, proxy] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(1200), redirect: 'error' }).then(async r => r.ok ? r.text() : ''),
      apiUrl === url ? true : healthAt(url).then(valid),
    ]);
    // Returns the running server's health so callers can compare its modes.
    return /<title>OFT Bridge · Local<\/title>/.test(page) && proxy ? health : false;
  } catch { return false; }
}
export function portInUse(port) {
  return new Promise((resolvePort, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1200);
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`${port} 포트 상태를 확인하지 못했습니다.`)); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolvePort(false) : reject(error));
  });
}
function openChrome(url) {
  return new Promise(resolveOpen => {
    const browser = spawn('/usr/bin/open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    browser.once('error', () => resolveOpen(false));
    browser.once('exit', code => resolveOpen(code === 0));
  });
}

// The optional ports/root/opener let smoke checks exercise startup without stopping an existing session.
export async function launch({ root = projectRoot, port = 5173, apiPort = 4318, open = openChrome, optIns = [] } = {}) {
  const url = `http://127.0.0.1:${port}/`;
  const isReady = () => dashboardReady(url, `http://127.0.0.1:${apiPort}/`);
  async function show() {
    console.log(`\n대시보드: ${url}`);
    if (!await open(url)) console.log('Chrome을 열지 못했습니다. Rabby가 설치된 브라우저에서 위 주소를 열어주세요.');
  }
  const wanted = { network: optIns.includes('--mainnet') ? 'mainnet' : process.env.OFT_NETWORK || 'testnet', executionMode: optIns.includes('--live') ? 'live' : process.env.OFT_EXECUTION || 'dry-run' };
  // Never silently reuse a server running in a different network or signing mode.
  const reusable = health => {
    if (health.network === wanted.network && health.executionMode === wanted.executionMode) return true;
    throw new Error(`이미 실행 중인 서버는 ${health.network} · ${health.executionMode} 모드입니다. 요청한 모드(${wanted.network} · ${wanted.executionMode})로 쓰려면 ‘OFT Bridge 종료.command’로 먼저 종료하세요.`);
  };
  const running = await isReady();
  if (running && reusable(running)) {
    console.log('OFT Bridge가 이미 실행 중입니다. 기존 서버를 사용합니다.');
    await show();
    console.log('이 창은 ⌘W로 닫으세요. 서버를 끄려면 ‘OFT Bridge 종료.command’를 더블클릭하세요.');
    return;
  }
  const occupied = (await Promise.all([port, apiPort].map(async p => await portInUse(p) ? p : null))).filter(Boolean);
  if (occupied.length) {
    // Another double-click may still be starting the two servers. Reuse it once ready.
    for (let attempt = 0; attempt < 8; attempt++) {
      await delay(500);
      const ready = await isReady();
      if (ready && reusable(ready)) { console.log('실행 중인 OFT Bridge를 확인했습니다.'); await show(); console.log('이 창은 ⌘W로 닫으세요. 서버 종료: OFT Bridge 종료.command'); return; }
    }
    throw new Error(`${occupied.join(', ')} 포트가 사용 중이지만 대시보드가 준비되지 않았습니다. 이전 OFT 실행 터미널이 있다면 Ctrl+C로 종료한 뒤 다시 더블클릭하세요. 다른 프로그램은 자동 종료하지 않습니다.`);
  }
  if (!existsSync(resolve(root, 'node_modules/vite/bin/vite.js')) || !existsSync(resolve(root, 'node_modules/tsx/package.json'))) {
    throw new Error('실행에 필요한 설치 파일이 없습니다. 프로젝트 폴더에서 npm ci로 복구해야 합니다.');
  }
  console.log('OFT Bridge를 시작합니다…\n사용 중에는 이 터미널 창을 열어 두세요. 서버 종료: Ctrl+C 또는 OFT Bridge 종료.command\n');
  const child = spawn(process.execPath, ['scripts/run.mjs', 'dev', ...optIns], { cwd: root, stdio: 'inherit', detached: true });
  let stopping = false, ended = false, startError;
  const finished = new Promise(resolveExit => {
    child.once('error', error => { startError = error; ended = true; resolveExit(1); });
    child.once('exit', code => { ended = true; resolveExit(code ?? 1); });
  });
  // Only terminate the process group created by this launcher. Never touch a reused server.
  const stop = () => {
    stopping = true;
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); } }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !stopping && !ended; attempt++) {
      if (await isReady()) { ready = true; break; }
      await delay(300);
    }
    if (stopping) return;
    if (!ready || ended) throw new Error(startError?.message ?? '서버가 정상적으로 시작되지 않았습니다. 위 오류 내용을 확인하세요.');
    await show();
    const code = await finished;
    if (!stopping && code !== 0) throw new Error('로컬 서버가 중단됐습니다. 위 오류 내용을 확인하세요.');
  } finally {
    stop();
    await finished;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
    console.log('OFT Bridge 실행을 종료했습니다.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = { ...(process.argv.includes('--no-browser') ? { open: async () => true } : {}), optIns: process.argv.filter(arg => arg === '--mainnet' || arg === '--live') };
  const action = process.argv.includes('--stop')
    ? import('./stop.mjs').then(({ stopOft }) => stopOft({ inspectOnly: process.argv.includes('--check') }))
    : launch(options);
  await action.catch(error => { console.error(`\n실행 오류: ${error.message}`); process.exitCode = 1; });
}
