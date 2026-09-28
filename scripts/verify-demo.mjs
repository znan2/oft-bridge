// Verifies the static demo build (dist/): serves it with the CSP from dist/_headers, walks the dry-run flow
// in headless Chromium, captures screenshots and fails on any non-local request or CSP violation.
// Usage: npm run build:demo && npm run verify:demo [-- --out docs/screenshots] [--video] [--seconds 30]
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve('dist'), out = resolve(arg('--out', 'docs/screenshots')), seconds = Number(arg('--seconds', '30'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// Minimal Netlify/Cloudflare `_headers` parser: a path line followed by indented `Name: value` lines.
async function headersFile() {
  const rules = []; let current;
  for (const line of (await readFile(join(root, '_headers'), 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { current = { pattern: line.trim(), headers: {} }; rules.push(current); continue; }
    const at = line.indexOf(':'); current.headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return rules;
}
const rules = await headersFile();
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = resolve(root, '.' + path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(root, 'index.html'); }
  const headers = Object.assign({ 'content-type': types[extname(file)] ?? 'application/octet-stream' }, ...rules.filter(r => r.pattern === '/*' || r.pattern === path).map(r => r.headers));
  try { res.writeHead(200, headers).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'ko-KR', colorScheme: 'dark',
  ...(process.argv.includes('--video') ? { recordVideo: { dir: resolve('.local/demo-video'), size: { width: 1440, height: 1000 } } } : {}) });
const external = [], csp = [], errors = [];
context.on('request', request => { const url = new URL(request.url()); if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== origin) external.push(request.url()); });
await context.addInitScript(() => document.addEventListener('securitypolicyviolation', e => { (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`); }));
const page = await context.newPage();
page.on('websocket', ws => external.push(ws.url()));
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

const started = Date.now();
await mkdir(out, { recursive: true });
const shot = async (name, options = {}) => { await page.screenshot({ path: join(out, name), ...options }); console.log(`screenshot ${join(out, name)}`); };
try {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByText('브릿지 컨트랙트 후보를 확인했습니다.').waitFor({ timeout: 15000 });
  await page.getByText('기본 경로 설정이 일치합니다').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Rabby 연결/ }).click();
  await page.getByLabel('연결 주소').waitFor();
  await page.getByRole('heading', { name: '브릿지 전송과 도착 확인' }).scrollIntoViewIfNeeded();
  await shot('01-overview.png');
  await page.locator('#transfer-amount').fill('25');
  await page.getByRole('button', { name: '견적 생성 · 시뮬레이션' }).click();
  await page.getByRole('button', { name: '전송 직전 재검증' }).waitFor({ timeout: 15000 });
  await page.locator('.route-panel').scrollIntoViewIfNeeded();
  await shot('02-route-and-quote.png', { fullPage: false });
  await page.getByRole('button', { name: '전송 직전 재검증' }).click();
  await page.getByRole('button', { name: 'Dry-run · 서명 요청 비활성' }).waitFor({ timeout: 15000 });
  await page.locator('.execution-panel').scrollIntoViewIfNeeded();
  await shot('03-dry-run-review.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('04-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Keep observing until the full window has elapsed (idle timers, polling, lazy requests).
  const remaining = seconds * 1000 - (Date.now() - started);
  if (remaining > 0) await page.waitForTimeout(remaining);
  csp.push(...await page.evaluate(() => window.__csp ?? []));
} catch (error) {
  errors.push(`flow: ${error.message.split('\n')[0]}`);
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
  console.log((await page.locator('main').innerText().catch(() => '')).slice(0, 1500));
}
finally { await context.close(); await browser.close(); server.close(); }

const result = { origin, observedSeconds: Math.round((Date.now() - started) / 1000), externalRequests: external, cspViolations: csp, errors };
console.log(JSON.stringify(result, null, 2));
if (external.length || csp.length || errors.length || result.observedSeconds < seconds) process.exitCode = 1;
