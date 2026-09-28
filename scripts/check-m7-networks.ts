// Read-only public RPC inventory. No user settings, account, balance or wallet access.
import { mkdir, writeFile } from 'node:fs/promises';
import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import { CHAINS, CHAIN_REGISTRY_SOURCE } from '../shared/chains';
import { PROTOCOL } from '../shared/protocol';
import { RpcGateway } from '../server/rpc';
import { SettingsStore } from '../server/settings';
import { assertFinalityAvailable, additionalNetworkFee } from '../src/lib/network-execution';
const gateway = new RpcGateway(new SettingsStore('/tmp/oft-m7-unused-settings.json'), { timeoutMs: 3500 });
const eidAbi = parseAbi(['function eid() view returns (uint32)']);
let request = 0, cursor = 0;
const rows: Record<string, unknown>[] = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < CHAINS.length) {
    const chain = CHAINS[cursor++]; const hosts = new Set<string>();
    const row: Record<string, unknown> = { chainId: chain.id, name: chain.shortName, eid: chain.eid, model: chain.feeModel, checkedAt: new Date().toISOString(), rpc: false, endpoint: false, finalized: false };
    const io = { async rpc(chainId: number, method: string, params: unknown[]) {
      const result = await gateway.request(chainId, { jsonrpc: '2.0', id: ++request, method, params }); hosts.add(result.host);
      if (result.response.error) throw new Error(result.response.error.message);
      return result.response.result;
    } };
    try {
      row.head = await io.rpc(chain.id, 'eth_blockNumber', []); row.rpc = true;
      const raw = await io.rpc(chain.id, 'eth_call', [{ to: PROTOCOL[chain.id].endpoint, data: encodeFunctionData({ abi: eidAbi, functionName: 'eid' }) }, 'latest']);
      row.endpoint = decodeFunctionResult({ abi: eidAbi, functionName: 'eid', data: raw as `0x${string}` }) === chain.eid;
      try { await assertFinalityAvailable(chain.id, io); row.finalized = true; } catch (e) { row.finalityError = String(e); }
      if (chain.feeModel === 'op-stack') {
        try {
          row.feeProbe = await additionalNetworkFee(chain.id, { from: '0x0000000000000000000000000000000000000001', to: PROTOCOL[chain.id].endpoint, data: '0x', value: '0x0' }, 100000n, 1000000000n, io, 'latest', 0n);
        } catch(e) { row.feeError = String(e); }
      }
    } catch (error) { row.error = String(error); }
    row.hosts = [...hosts]; rows.push(row);
    if (rows.length % 20 === 0) console.log(`Checked ${rows.length}/${CHAINS.length}`);
  }
}));
rows.sort((a,b) => Number(a.chainId) - Number(b.chainId));
const summary = { registered: CHAINS.length, rpc: rows.filter(r => r.rpc).length, endpoint: rows.filter(r => r.endpoint).length, finalized: rows.filter(r => r.finalized).length, opFee: rows.filter(r => r.feeProbe).length, transactionsSent: 0 };
await mkdir('.local/evidence', { recursive: true });
await writeFile('.local/evidence/M7-network-probe.json', JSON.stringify({ registry: CHAIN_REGISTRY_SOURCE, checkedAt: new Date().toISOString(), summary, rows }, null, 2) + '\n');
console.log(JSON.stringify(summary));
