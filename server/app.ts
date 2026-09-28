import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { isChainId, type ChainId } from '../shared/chains';
import { AppError } from './errors';
import { SettingsStore } from './settings';
import { RpcGateway, parseRpcRequest } from './rpc';
import { MetadataService } from './metadata';
import { ProtocolMetadataService } from './protocol-metadata';
import { ScanService } from './scan';
import { NETWORK_MODE, type ExecutionMode, type NetworkMode } from '../shared/network';

function parseChain(value: string): ChainId {
  const id = Number(value);
  if (!isChainId(id)) throw new AppError('INVALID_REQUEST', '지원하지 않는 네트워크입니다.');
  return id;
}
export interface RuntimeModes { network: NetworkMode; execution: ExecutionMode }
export function createApp(store: SettingsStore, gateway: RpcGateway, production = false, metadata = new MetadataService(), protocol = new ProtocolMetadataService(), scan = new ScanService(), runtime: RuntimeModes = { network: NETWORK_MODE, execution: 'dry-run' }) {
  const app = new Hono();
  const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4318', 'http://localhost:4318']);
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    const origin = c.req.header('origin');
    if (!host || !origins.has(`http://${host}`) || (origin && !origins.has(origin)) || c.req.header('sec-fetch-site') === 'cross-site') {
      throw new AppError('ACCESS_DENIED', '로컬 대시보드에서만 사용할 수 있습니다.', 403);
    }
    if (c.req.path !== '/api/health' && c.req.header('x-oft-client') !== 'local-dashboard') throw new AppError('ACCESS_DENIED', '대시보드 요청을 확인하지 못했습니다.', 403);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 131072, onError: c => c.json({ code: 'INVALID_REQUEST', message: '요청 크기가 너무 큽니다.' }, 413) }));
  app.use('/api/*', async (c, next) => {
    if (['POST', 'PUT'].includes(c.req.method) && !c.req.header('content-type')?.startsWith('application/json')) throw new AppError('INVALID_REQUEST', 'JSON 요청이 필요합니다.', 415);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ code: error.code, message: error.message }, error.status as 400);
    if (error instanceof SyntaxError) return c.json({ code: 'INVALID_REQUEST', message: '잘못된 JSON 요청입니다.' }, 400);
    return c.json({ code: 'INVALID_REQUEST', message: '로컬 조회 서버에서 요청을 처리하지 못했습니다.' }, 500);
  });
  // The server never signs. walletExecution tells the UI whether it may ask Rabby to sign at all.
  app.get('/api/health', c => c.json({ ok: true, signing: false, network: runtime.network, executionMode: runtime.execution, walletExecution: runtime.execution === 'live' }));
  app.get('/api/scan/tx/:hash', async c => c.json(await scan.get(c.req.param('hash'))));
  app.get('/api/metadata/protocol', async c => c.json(await protocol.get()));
  app.get('/api/metadata/ofts', async c => c.json(await metadata.get(c.req.query('refresh') === '1')));
  app.get('/api/settings/rpc', c => c.json(store.summary()));
  app.put('/api/settings/rpc/:chainId', async c => {
    const id = parseChain(c.req.param('chainId'));
    const body: unknown = await c.req.json();
    if (!body || typeof body !== 'object' || !('url' in body)) throw new AppError('INVALID_REQUEST', 'RPC 주소를 입력하세요.');
    return c.json(await gateway.setCustom(id, body.url));
  });
  app.delete('/api/settings/rpc/:chainId', async c => c.json(await store.set(parseChain(c.req.param('chainId')), null)));
  app.get('/api/chains/:chainId/health', async c => c.json(await gateway.health(parseChain(c.req.param('chainId')))));
  app.post('/api/rpc/:chainId', async c => {
    const id = parseChain(c.req.param('chainId'));
    const expected = c.req.header('x-oft-rpc-revision');
    if (expected != null && (!/^\d+$/.test(expected) || Number(expected) !== store.summary().revision)) throw new AppError('STALE_CONTEXT', 'RPC 설정이 변경되었습니다. 다시 조회하세요.', 409);
    const request = parseRpcRequest(await c.req.json());
    const result = await gateway.request(id, request);
    if (expected != null && (result.revision !== Number(expected) || store.summary().revision !== Number(expected))) throw new AppError('STALE_CONTEXT', 'RPC 설정이 변경되었습니다. 다시 조회하세요.', 409);
    return c.json(result.response);
  });
  app.all('/api/*', c => c.json({ code: 'INVALID_REQUEST', message: '지원하지 않는 조회 요청입니다.' }, 404));
  if (production) {
    app.use('/*', serveStatic({ root: './dist' }));
    app.get('*', serveStatic({ path: './dist/index.html' }));
  }
  return app;
}
