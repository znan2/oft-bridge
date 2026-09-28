import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { createApp } from './app';
import { SettingsStore, rpcOverrides } from './settings';
import { RpcGateway } from './rpc';
import { NETWORK_MODE, parseExecutionMode } from '../shared/network';
import { redactSecrets } from '../shared/redact';

const store = new SettingsStore(resolve('.local/rpc.json'));
try {
  const execution = parseExecutionMode(process.env.OFT_EXECUTION);
  const endpoints = rpcOverrides(process.env);
  await store.load();
  const app = createApp(store, new RpcGateway(store, { envEndpoints: endpoints }), process.env.NODE_ENV === 'production', undefined, undefined, undefined, { network: NETWORK_MODE, execution });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4318 }, () => {
    console.log(`로컬 조회 서버 · http://127.0.0.1:4318 · ${NETWORK_MODE} · ${execution}${Object.keys(endpoints).length ? ` · 환경변수 RPC ${Object.keys(endpoints).length}개` : ''}`);
    if (execution === 'dry-run') console.log('dry-run: 경로·예상 수수료만 계산합니다. 지갑 서명 요청은 비활성입니다. (실제 전송: --live)');
  });
  server.on('error', error => { console.error(redactSecrets(error.message)); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
} catch (error) {
  console.error(error instanceof Error ? redactSecrets(error.message) : '로컬 조회 서버 시작 실패'); process.exitCode = 1;
}
