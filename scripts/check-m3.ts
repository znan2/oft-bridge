import { writeFile } from 'node:fs/promises';
import { RpcGateway } from '../server/rpc';
import { SettingsStore } from '../server/settings';
import { ProtocolMetadataService } from '../server/protocol-metadata';
import { validateRoute } from '../src/lib/route';
import { RpcCallError } from '../src/lib/discovery';
import type { SavedCandidate } from '../shared/discovery';
import historical from '../tests/fixtures/dos-bsc-ethereum.json';
const gateway = new RpcGateway(new SettingsStore('.local/unused-m3-check.json'));
const protocol = new ProtocolMetadataService();
const saved: SavedCandidate[] = [];
const evidence: unknown[] = [];
for (const sourceChain of [56, 1] as const) {
  let calls = 0; const responses: unknown[] = [];
  const result = await validateRoute({ sourceChain, destinationChain: sourceChain === 56 ? 1 : 56, bridgeAddress: historical.transaction.to, tokenAddress: sourceChain === 56 ? historical.transaction.to : historical.destinationReceiptEvidence.tokenAddress }, {
    async rpc(chainId, method, params) {
      const { response, host, fallbackUsed } = await gateway.request(chainId, { jsonrpc: '2.0', id: ++calls, method, params });
      responses.push({ chainId, method, params, response, host, fallbackUsed });
      if (response.error) throw new RpcCallError(response.error.code, response.error.message);
      return response.result;
    }, protocol: () => protocol.get(), store: { list: async () => [], save: async candidate => { saved.push(candidate); } },
  });
  const ok = result.configurationStatus === 'PASS' && result.executionReady === false && result.destination?.identity !== undefined;
  console.log(JSON.stringify({ name: sourceChain === 56 ? 'DOS BSC → Ethereum' : 'DOS Ethereum → BSC', ok, calls, result }));
  evidence.push({ result, calls, responses });
  if (!ok) process.exitCode = 1;
}
await writeFile('/tmp/oft-m3-rpc-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
