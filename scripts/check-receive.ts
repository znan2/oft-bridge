import { writeFile } from 'node:fs/promises';
import { RpcGateway } from '../server/rpc';
import { SettingsStore } from '../server/settings';
import { ProtocolMetadataService } from '../server/protocol-metadata';
import { discover, RpcCallError } from '../src/lib/discovery';
import { validateRoute } from '../src/lib/route';
import drv from '../tests/fixtures/drv-ethereum-receive.json';
import dos from '../tests/fixtures/dos-bsc-ethereum.json';
import type { ChainId } from '../shared/chains';
const gateway = new RpcGateway(new SettingsStore('/tmp/oft-receive-unused-settings.json'));
const protocol = new ProtocolMetadataService();
// Fixture hashes are anonymized. Supply real public receive hashes through the environment to run live.
const cases = [
  { name: 'DRV Ethereum receive', tokenAddress: drv.tokenAddress, transactionHash: process.env.OFT_CHECK_DRV_RECEIVE_TX, expectedKind: 'OFT' },
  { name: 'DOS Ethereum adapter receive', tokenAddress: dos.destinationReceiptEvidence.tokenAddress, transactionHash: process.env.OFT_CHECK_DOS_RECEIVE_TX, expectedKind: 'OFTAdapter' },
].filter((entry): entry is typeof entry & { transactionHash: string } => {
  if (!entry.transactionHash) console.log(JSON.stringify({ name: entry.name, skipped: 'transaction hash env not set' }));
  return Boolean(entry.transactionHash);
});
const runs = [];
let id = 0;
for (const entry of cases) {
  const responses: unknown[] = [];
  const rpc = async (chainId: ChainId, method: string, params: unknown[]) => {
    const { response, host } = await gateway.request(chainId, { jsonrpc: '2.0', id: ++id, method, params });
    responses.push({ chainId, method, params, response, host });
    if (response.error) throw new RpcCallError(response.error.code, response.error.message, response.error.data);
    return response.result;
  };
  const store = { list: async () => [], save: async () => {} };
  const result = await discover({ chainId: 1, tokenAddress: entry.tokenAddress, transactionHash: entry.transactionHash }, { rpc: (m, p) => rpc(1, m, p), catalog: async () => { throw new Error('Receipt recovery must not use the catalog'); }, store });
  const candidate = result.candidates.find(c => c.status === 'identified');
  const ok = result.status === 'found' && candidate?.identity?.kind === entry.expectedKind && result.transaction?.kind === 'receive';
  const route = candidate ? await validateRoute({ sourceChain: 1, destinationChain: 56, tokenAddress: entry.tokenAddress, bridgeAddress: candidate.address }, { rpc, protocol: () => protocol.get(), store }) : undefined;
  console.log(JSON.stringify({ name: entry.name, ok, result, currentEthToBscConfiguration: route?.configurationStatus, routeProblems: route?.checks.filter(c => c.scope === 'configuration' && c.status === 'FAIL') }));
  runs.push({ name: entry.name, result, route, responses });
  if (!ok) process.exitCode = 1;
}
await writeFile('/tmp/oft-receive-recovery-evidence.json', JSON.stringify(runs, null, 2) + '\n');
