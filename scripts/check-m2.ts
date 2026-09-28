import { SettingsStore } from '../server/settings';
import { RpcGateway } from '../server/rpc';
import { MetadataService } from '../server/metadata';
import { discover, RpcCallError } from '../src/lib/discovery';
import type { DiscoveryInput, DiscoveryResult, SavedCandidate } from '../shared/discovery';
import historical from '../tests/fixtures/dos-bsc-ethereum.json';

// Public read-only integration checks. Never load user RPC settings or browser records.
const gateway = new RpcGateway(new SettingsStore('.local/unused-m2-check.json'));
const metadata = new MetadataService();
const saved: SavedCandidate[] = [];
const bridge = historical.transaction.to;
const ethToken = historical.destinationReceiptEvidence.tokenAddress;
const store = {
  async list(chainId: number, token: string) { return saved.filter(s => s.chainId === chainId && s.tokenAddress.toLowerCase() === token.toLowerCase()); },
  async save(value: SavedCandidate) { saved.push(value); },
};
async function run(name: string, input: DiscoveryInput, expected: DiscoveryResult['status']) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  let calls = 0;
  const fallbacks: string[] = [];
  const result = await discover(input, {
    async rpc(method, params) {
      const response = await gateway.request(input.chainId, { jsonrpc: '2.0', id: ++calls, method, params });
      if (response.fallbackUsed) fallbacks.push(`${method}: ${response.host}`);
      if (response.response.error) throw new RpcCallError(response.response.error.code, response.response.error.message);
      return response.response.result;
    },
    catalog: () => metadata.get(), store,
  });
  const ok = result.status === expected && (name.includes('USDT') ? result.candidates.length === 3 && result.candidates.filter(c => c.status === 'unsupported').length === 2 : true);
  console.log(JSON.stringify({ name, ok, expected, ...result, calls, fallbacks }));
  if (!ok) process.exitCode = 1;
}
await Promise.all([
  run('DOS BSC direct CA', { chainId: 56, tokenAddress: bridge }, 'found'),
  run('DOS Ethereum CA absent from catalog', { chainId: 1, tokenAddress: ethToken }, 'not-found'),
]);
await run('DOS Ethereum manual adapter', { chainId: 1, tokenAddress: ethToken, manualAddress: bridge }, 'found');
await run('DOS Ethereum saved candidate revalidation', { chainId: 1, tokenAddress: ethToken }, 'found');
// The fixture hash is anonymized; a real public source hash must come from the environment.
if (process.env.OFT_CHECK_SOURCE_TX) await run('DOS historical source send recovery', { chainId: 56, tokenAddress: bridge, transactionHash: process.env.OFT_CHECK_SOURCE_TX }, 'found');
else console.log(JSON.stringify({ name: 'DOS historical source send recovery', skipped: 'OFT_CHECK_SOURCE_TX not set' }));
await run('Ethereum USDT mixed supported and unsupported adapters', { chainId: 1, tokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7' }, 'found');
