import { createApp } from '../server/app';
import { SettingsStore } from '../server/settings';
import { RpcGateway } from '../server/rpc';
import { CHAINS } from '../shared/chains';

// This check performs public reads only. It neither loads nor changes user RPC settings.
const store = new SettingsStore('.local/unused-live-check.json');
const results = await Promise.all(CHAINS.flatMap(chain => chain.rpcs.map(async url => {
  try {
    const data = await new RpcGateway(store, { endpoints: { [chain.id]: [url] } }).health(chain.id);
    return { kind: 'rpc', ok: true, url, ...data };
  } catch (error) { return { kind: 'rpc', ok: false, url, message: error instanceof Error ? error.message : '조회 실패' }; }
})));
for (const result of results) console.log(JSON.stringify(result));
for (const url of ['https://metadata.layerzero-api.com/v1/metadata', 'https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list']) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(JSON.stringify({ kind: 'metadata', ok: true, url, topLevelEntries: Object.keys(data as object).length }));
  } catch (error) { console.log(JSON.stringify({ kind: 'metadata', ok: false, url, message: error instanceof Error ? error.message : '조회 실패' })); process.exitCode = 1; }
}
const app = createApp(store, new RpcGateway(store), true);
const staticPage = await app.request('http://127.0.0.1:4318/');
const api = await app.request('http://127.0.0.1:4318/api/health', { headers: { host: '127.0.0.1:4318' } });
console.log(JSON.stringify({ kind: 'production-serving', htmlStatus: staticPage.status, apiStatus: api.status, api: await api.json() }));
if (results.some(r => !r.ok) || staticPage.status !== 200 || api.status !== 200) process.exitCode = 1;
