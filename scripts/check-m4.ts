import { writeFile } from 'node:fs/promises';
import { RpcGateway } from '../server/rpc';
import { SettingsStore } from '../server/settings';
import { ProtocolMetadataService } from '../server/protocol-metadata';
import { prepareTransfer, transferIssue } from '../src/lib/transfer';
import { RpcCallError } from '../src/lib/discovery';
import historical from '../tests/fixtures/dos-bsc-ethereum.json';
// Read-only quote for any sender; no connected wallet provider, state overrides or broadcasts.
// The fixture sender is anonymized, so balances read as zero unless OFT_CHECK_SENDER is set.
const sender = process.env.OFT_CHECK_SENDER ?? historical.transaction.from;
const gateway = new RpcGateway(new SettingsStore('.local/unused-m4-check.json'));
const protocol = new ProtocolMetadataService();
const evidence: unknown[] = [];
for (const sourceChain of [56, 1] as const) {
  let calls = 0; const responses: unknown[] = [];
  const name = sourceChain === 56 ? 'DOS BSC → Ethereum' : 'DOS Ethereum → BSC';
  try {
    const plan = await prepareTransfer({ route: { sourceChain, destinationChain: sourceChain === 56 ? 1 : 56, bridgeAddress: historical.transaction.to, tokenAddress: sourceChain === 56 ? historical.transaction.to : historical.destinationReceiptEvidence.tokenAddress }, sender, recipient: sender, refundAddress: sender, amount: '0.000001', slippagePercent: '0', extraReceiveGas: '0', walletChainId: sourceChain, providerUid: 'readonly-historical-fixture', rpcRevision: 0 }, {
      async rpc(chainId, method, params) {
        const { response, host, fallbackUsed } = await gateway.request(chainId, { jsonrpc: '2.0', id: ++calls, method, params });
        responses.push({ chainId, method, params, response, host, fallbackUsed });
        if (response.error) throw new RpcCallError(response.error.code, response.error.message, response.error.data);
        return response.result;
      }, protocol: () => protocol.get(), store: { list: async () => [], save: async () => {} },
    });
    const ok = plan.route.configurationStatus === 'PASS' && plan.executionReady === false && plan.fee.lzTokenFee === '0' && plan.simulation.status !== 'failed' && plan.blockers.every(issue => ['TOKEN_BALANCE', 'NATIVE_BALANCE', 'APPROVAL_REQUIRED', 'GAS_BALANCE', 'DESTINATION_BALANCE'].includes(issue.code));
    console.log(JSON.stringify({ name, ok, calls, createdAt: plan.createdAt, fee: plan.fee, amounts: plan.amounts, balances: plan.balances, approval: plan.approval, blockers: plan.blockers, simulation: plan.simulation, gas: plan.gas }));
    evidence.push({ name, fixtureSender: sender, plan, calls, responses });
    if (!ok) process.exitCode = 1;
  } catch (error) { const issue = transferIssue(error); console.log(JSON.stringify({ name, calls, issue })); evidence.push({ name, fixtureSender: sender, issue, responses }); process.exitCode = 1; }
}
await writeFile('/tmp/oft-m4-rpc-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
