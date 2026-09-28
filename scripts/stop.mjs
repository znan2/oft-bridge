import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const projectRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const patterns = [
  ['manager', /(?:^|[\s/])scripts\/run\.mjs (?:dev|start)$/],
  ['server', /(?:^|\s)(?:--watch )?--import tsx (?:.*\/)?server\/index\.ts$/],
  ['server', /(?:^|[\s/])node_modules\/vite\/bin\/vite\.js$/],
];
async function command(file, args) {
  try { return (await exec(file, args, { timeout: 2500, maxBuffer: 2_000_000 })).stdout; }
  catch (error) { if (error.code === 1 && !error.stderr?.trim()) return ''; throw error; }
}
function row(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), args: match[4] };
}
async function owned(candidate) {
  if (!candidate || candidate.pid === process.pid || candidate.uid !== process.getuid()) return null;
  const kind = patterns.find(([, pattern]) => pattern.test(candidate.args))?.[0];
  if (!kind) return null;
  const executable = (await command('/bin/ps', ['-p', String(candidate.pid), '-o', 'comm='])).trim();
  if (basename(executable) !== 'node') return null;
  const cwdInfo = await command('/usr/sbin/lsof', ['-a', '-p', String(candidate.pid), '-d', 'cwd', '-Fn']);
  const cwd = cwdInfo.split('\n').find(line => line.startsWith('n'))?.slice(1);
  if (!cwd || await realpath(cwd).catch(() => '') !== projectRoot) return null;
  return { ...candidate, kind };
}
export async function findOftProcesses() {
  const table = await command('/bin/ps', ['-axo', 'pid=,ppid=,uid=,args=']);
  const candidates = table.split('\n').map(row).filter(Boolean).filter(r => patterns.some(([, pattern]) => pattern.test(r.args)));
  return (await Promise.all(candidates.map(owned))).filter(Boolean);
}
async function terminate(candidate) {
  // Recheck identity immediately before signaling; never kill by port or command substring alone.
  const fresh = await owned(row(await command('/bin/ps', ['-p', String(candidate.pid), '-o', 'pid=,ppid=,uid=,args='])));
  if (!fresh || fresh.args !== candidate.args) return;
  try { process.kill(fresh.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
export async function stopOft({ inspectOnly = false } = {}) {
  let active = await findOftProcesses();
  if (inspectOnly) { console.log(active.map(p => `${p.pid} ${p.kind}: ${p.args}`).join('\n') || '실행 중인 OFT 서버가 없습니다.'); return; }
  if (!active.length) { console.log('실행 중인 OFT 서버가 없습니다. 이 창은 ⌘W로 닫으세요.'); return; }
  console.log('OFT Bridge 서버를 종료합니다…');
  const managers = active.filter(p => p.kind === 'manager');
  for (const candidate of managers.length ? managers : active) await terminate(candidate);
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(250);
    active = await findOftProcesses();
    if (!active.length) { console.log('OFT Bridge 서버를 종료했습니다. 이 창은 ⌘W로 닫으세요.'); return; }
    // Clean up a standalone server or a watcher left after its manager exited.
    if (attempt === 3) for (const candidate of active) await terminate(candidate);
  }
  throw new Error('일부 OFT 서버가 아직 종료되지 않았습니다. 실행 중인 터미널을 확인하세요.');
}
