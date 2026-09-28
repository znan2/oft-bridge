// Reproducible, explicit update. Never auto-add live metadata to signing configuration.
// Usage: Node 24 scripts/generate-chain-registry.mjs /path/to/official-metadata.json [--testnet]
import { readFile, writeFile } from 'node:fs/promises';
import * as viemChains from 'viem/chains';
const sourceUrl = 'https://metadata.layerzero-api.com/v1/metadata';
const testnet = process.argv.includes('--testnet'), stage = testnet ? 'testnet' : 'mainnet';
const data = JSON.parse(await readFile(process.argv.slice(2).find(a => !a.startsWith('--')), 'utf8'));
// Testnets are an explicit, reviewed allowlist. Incomplete ULN302 profiles are still excluded below.
const testnetModels = { 'sepolia-testnet': 'standard', 'arbitrum-sepolia': 'arbitrum', 'base-sepolia': 'op-stack', 'optimism-sepolia': 'op-stack', 'bsc-testnet': 'standard' };
const standard = new Set('ethereum bsc avalanche bera chiliz conflux coredao cronosevm fantom flare gnosis hyperliquid iota islander kava klaytn monad nibiru peaq plasma polygon rootstock sei somnia sonic story subtensorevm tac telos tomo xdc beam dexalot dinari kite'.split(' '));
const op = new Set('base optimism ink unichain worldchain zora lisk bob mode blast fraxtal celo zircuit soneium'.split(' '));
const arb = new Set('arbitrum ape gravity plumephoenix reya superposition xai humanity'.split(' '));
const address = x => typeof x === 'string' && /^0x[\da-f]{40}$/i.test(x) && !/^0x0{40}$/.test(x);
const publicUrl = x => { try { const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password && !/[{}$]/.test(x); } catch { return false; } };
const seenIds = new Set(), seenEids = new Set(); const chains = [], excluded = [];
for (const [key, entry] of Object.entries(data)) {
  const d = entry.chainDetails ?? {};
  const deps = (entry.deployments ?? []).filter(v => v.version === 2 && v.stage === stage);
  if (!deps.length || d.chainType !== 'evm' || (testnet && !(key in testnetModels))) continue;
  let reason = '';
  if (d.chainStatus !== 'ACTIVE') reason = `chainStatus=${d.chainStatus ?? 'unknown'}`;
  else if (deps.length !== 1) reason = 'ambiguous V2 deployment';
  const dep = deps[0], id = Number(d.nativeChainId), eid = Number(dep.eid);
  if (!reason && (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(eid) || eid < (testnet ? 40000 : 30000) || eid >= (testnet ? 50000 : 40000) || seenIds.has(id) || seenEids.has(eid))) reason = `missing/duplicate ${stage} identity`;
  const matching = Object.values(viemChains).filter(v => v && typeof v === 'object' && v.id === id && Boolean(v.testnet) === testnet);
  const v = matching[0];
  if (!reason && (d.nativeCurrency?.decimals !== 18 || (v && v.nativeCurrency.decimals !== 18))) reason = 'special native unit requires separate implementation';
  const names = { endpoint: 'endpointV2', sendLibrary: 'sendUln302', receiveLibrary: 'receiveUln302', blockedLibrary: 'blockedMessageLib', deadDvn: 'deadDVN' };
  const protocol = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, dep[n]?.address?.toLowerCase()]));
  protocol.executors = [...new Set(['executor', 'lzExecutor'].map(n => dep[n]?.address?.toLowerCase()).filter(Boolean))];
  if (!reason && (!Object.values(names).every(n => address(dep[n]?.address)) || !protocol.executors.length || !protocol.executors.every(address))) reason = 'incomplete ULN302 deployment';
  const explorer = entry.blockExplorers?.find(b => publicUrl(b.url))?.url ?? v?.blockExplorers?.default?.url;
  if (!reason && !publicUrl(explorer)) reason = 'missing HTTPS explorer';
  if (reason) { excluded.push({ key, id: Number.isSafeInteger(id) ? id : null, reason }); continue; }
  let rpcs = [...new Set([...(entry.rpcs ?? []).map(r => r.url), ...(v?.rpcUrls?.default?.http ?? [])].filter(publicUrl))];
  rpcs.sort((a, b) => Number(!a.includes('publicnode.com')) - Number(!b.includes('publicnode.com')));
  if (id === 56) rpcs = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'];
  if (id === 1) rpcs = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://ethereum.publicnode.com'];
  const feeModel = testnet ? testnetModels[key] : standard.has(key) ? 'standard' : op.has(key) ? 'op-stack' : arb.has(key) ? 'arbitrum' : 'unreviewed';
  const name = id === 56 ? 'BNB Smart Chain' : id === 1 ? 'Ethereum Mainnet' : v?.name ?? d.name ?? key;
  const shortName = id === 56 ? 'BSC' : id === 1 ? 'Ethereum' : key === 'klaytn' ? 'Kaia (Klaytn)' : key === 'plumephoenix' ? 'Plume' : name;
  chains.push({ id, eid, key, name, shortName, symbol: v?.nativeCurrency?.symbol ?? d.nativeCurrency.symbol, decimals: 18, explorer: explorer.replace(/\/$/, ''), rpcs: rpcs.slice(0, 3), feeModel,
    ...(feeModel === 'unreviewed' ? { sourceRestriction: '조회 전용 · 이 체인의 수수료/트랜잭션 방식은 아직 검토하지 않아 출발 전송을 지원하지 않습니다.' } : {}), protocol });
  seenIds.add(id); seenEids.add(eid);
}
// The first two chains are the UI's default source and destination.
const first = testnet ? [11155111, 84532] : [56, 1];
const rank = c => first.includes(c.id) ? first.indexOf(c.id) - first.length : 0;
chains.sort((a,b) => rank(a) - rank(b) || a.shortName.localeCompare(b.shortName));
await writeFile(new URL(testnet ? '../shared/chain-registry.testnet.json' : '../shared/chain-registry.json', import.meta.url), JSON.stringify({ sourceUrl, generatedAt: new Date().toISOString(), chains, excluded }, null, 2) + '\n');
console.log(JSON.stringify({ registered: chains.length, sourceModels: Object.fromEntries(['standard','op-stack','arbitrum','unreviewed'].map(k => [k, chains.filter(c => c.feeModel === k).length])), excluded: excluded.length }));
