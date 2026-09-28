import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node');
const candidates = [process.execPath, bundled].filter(existsSync);
const runtime = candidates.find(path => {
  const version = spawnSync(path, ['--version'], { encoding: 'utf8' }).stdout?.trim();
  return version && /^v(24|26)\./.test(version);
});
if (!runtime) {
  console.error('Node.js 24 LTS가 필요합니다. 설치 후 다시 실행하세요.');
  process.exit(1);
}
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
function run(args, env = {}) {
  return new Promise(resolveExit => {
    const child = spawn(runtime, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    children.add(child);
    child.on('error', error => { console.error(error.message); stop(1); resolveExit(1); });
    child.on('exit', code => { children.delete(child); resolveExit(code ?? 1); });
  });
}
const bins = {
  vite: 'node_modules/vite/bin/vite.js',
  tsc: 'node_modules/typescript/bin/tsc',
  vitest: 'node_modules/vitest/vitest.mjs',
};
const mode = process.argv[2];
// Safe defaults: testnet + dry-run. Mainnet and live wallet signing are explicit opt-ins.
const optIns = new Set(process.argv.slice(3).filter(arg => arg === '--mainnet' || arg === '--live'));
const modes = {
  OFT_NETWORK: optIns.has('--mainnet') ? 'mainnet' : process.env.OFT_NETWORK || 'testnet',
  OFT_EXECUTION: optIns.has('--live') ? 'live' : process.env.OFT_EXECUTION || 'dry-run',
};
function announce() {
  console.log(`모드 · ${modes.OFT_NETWORK} · ${modes.OFT_EXECUTION}`);
  if (modes.OFT_NETWORK === 'mainnet' && modes.OFT_EXECUTION === 'live') console.log('경고: 메인넷 실자산 서명이 가능한 모드입니다. 감사받지 않은 코드이며 사용 책임은 사용자에게 있습니다.');
}
if (mode === 'dev') {
  console.log('OFT Bridge · http://127.0.0.1:5173 · Ctrl+C로 종료'); announce();
  await Promise.all([
    run(['--watch', '--import', 'tsx', 'server/index.ts'], modes).then(stop),
    run([bins.vite], modes).then(stop),
  ]);
} else if (mode === 'build') {
  process.exitCode = await run([bins.tsc, '--noEmit']);
  if (!process.exitCode) process.exitCode = await run([bins.vite, 'build'], modes);
} else if (mode === 'build:demo') {
  // Static portfolio build: mocked chain data, testnet, dry-run, no server.
  process.exitCode = await run([bins.tsc, '--noEmit']);
  if (!process.exitCode) process.exitCode = await run([bins.vite, 'build', '--mode', 'demo'], { OFT_NETWORK: 'testnet', OFT_EXECUTION: 'dry-run' });
} else if (mode === 'start') {
  if (!existsSync(resolve(root, 'dist/index.html'))) {
    console.error('먼저 npm run build를 실행하세요.'); process.exitCode = 1;
  } else if (existsSync(resolve(root, 'dist/_headers'))) {
    // Only build:demo emits _headers. Serving mock data over a real server would look like real balances.
    console.error('dist/는 목업 데모 빌드입니다. npm run build로 다시 빌드한 뒤 실행하세요.'); process.exitCode = 1;
  } else { announce(); process.exitCode = await run(['--import', 'tsx', 'server/index.ts'], { ...modes, NODE_ENV: 'production' }); }
} else if (mode === 'test') {
  process.exitCode = await run([bins.vitest, 'run', ...process.argv.slice(3)]);
} else if (mode === 'typecheck') {
  process.exitCode = await run([bins.tsc, '--noEmit']);
} else if (mode === 'check:live') {
  process.exitCode = await run(['--import', 'tsx', 'scripts/check-live.ts'], modes);
} else if (mode?.startsWith('check:m') || mode === 'check:receive') {
  // Read-only regressions pinned to mainnet contracts (DOS/DRV). Running one is the explicit mainnet choice.
  const scripts = { 'check:m2': 'scripts/check-m2.ts', 'check:m3': 'scripts/check-m3.ts', 'check:m4': 'scripts/check-m4.ts', 'check:m7': 'scripts/check-m7-networks.ts', 'check:receive': 'scripts/check-receive.ts' };
  if (mode === 'check:m5:local') process.exitCode = await run(['scripts/check-m5-local.mjs']);
  else if (scripts[mode]) process.exitCode = await run(['--import', 'tsx', scripts[mode], ...process.argv.slice(3).filter(a => !optIns.has(a))], { OFT_NETWORK: 'mainnet', OFT_EXECUTION: 'dry-run' });
  else { console.error(`알 수 없는 검사: ${mode}`); process.exitCode = 1; }
} else { console.error('사용법: npm run dev | build | build:demo | start | test  (옵션: -- --mainnet --live)'); process.exitCode = 1; }
