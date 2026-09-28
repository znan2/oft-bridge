import { mkdir, writeFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { RpcGateway } from '../server/rpc';
import { SettingsStore } from '../server/settings';
import { ProtocolMetadataService } from '../server/protocol-metadata';
import { validateRoute } from '../src/lib/route';
import { RpcCallError } from '../src/lib/discovery';
import historical from '../tests/fixtures/dos-bsc-ethereum.json';
const gateway = new RpcGateway(new SettingsStore('/tmp/oft-m7-unused-settings.json'));
const service = new ProtocolMetadataService();
let id=0;
const io = { async rpc(chainId:number,method:string,params:unknown[]) {
  const {response} = await gateway.request(chainId,{jsonrpc:'2.0',id:++id,method,params});
  if(response.error) throw new RpcCallError(response.error.code,response.error.message);
  return response.result;
}, protocol:()=>service.get(), store:{list:async()=>[],save:async()=>{}} };
const requests = [
  {name:'DRV Base → Arbitrum',sourceChain:8453,destinationChain:42161,bridge:'0x9d0e8f5b25384c7310cb8c6ae32c8fbeb645d083'},
  {name:'DRV Arbitrum → Base',sourceChain:42161,destinationChain:8453,bridge:'0x77b7787a09818502305c95d68a2571f090abb135'},
  {name:'frxUSD Avalanche → Optimism',sourceChain:43114,destinationChain:10,bridge:'0x80eede496655fb9047dd39d9f418d5483ed600df'},
  {name:'DOS BSC → Ethereum regression',sourceChain:56,destinationChain:1,bridge:historical.transaction.to},
  {name:'DOS Ethereum → BSC regression',sourceChain:1,destinationChain:56,bridge:historical.transaction.to,token:historical.destinationReceiptEvidence.tokenAddress},
];
const results=[];
for(const request of requests) {
  const result=await validateRoute({sourceChain:request.sourceChain,destinationChain:request.destinationChain,bridgeAddress:getAddress(request.bridge.toLowerCase()),tokenAddress:getAddress((request.token??request.bridge).toLowerCase())},io);
  results.push({name:request.name,result});
  console.log(JSON.stringify({name:request.name,configuration:result.configurationStatus,destinationToken:result.destination?.identity?.token.address,issues:result.checks.filter(c=>c.scope==='configuration'&&c.status!=='PASS').map(c=>({title:c.title,status:c.status,detail:c.detail}))}));
}
await mkdir('.local/evidence',{recursive:true});
await writeFile('.local/evidence/M7-route-probe.json',JSON.stringify({checkedAt:new Date().toISOString(),transactionsSent:0,results},null,2)+'\n');
