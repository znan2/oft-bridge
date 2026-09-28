import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const directory = await mkdtemp(join(tmpdir(), 'oft-m5-anvil-'));
const children = [];
const binary = name => join(homedir(), '.foundry/bin', name);
async function port() { return new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function run(binary, args, env = process.env) {
  return new Promise((resolve, reject) => { const child = spawn(binary,args,{stdio:'inherit',env}); children.push(child);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${binary}: ${code}`))); });
}
const stop = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); };
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{stop();process.exitCode=1;});
try {
  await mkdir(join(directory,'src')); await copyFile('tests/contracts/M5Harness.sol',join(directory,'src/M5Harness.sol'));
  await run(binary('forge'),['build','--root',directory,'--use','0.8.24']);
  const bscPort = await port(), ethPort = await port();
  for (const [p, chain] of [[bscPort,56],[ethPort,1]]) {
    const child=spawn(binary('anvil'),['--host','127.0.0.1','--port',String(p),'--chain-id',String(chain),'--silent'],{stdio:'ignore'}); children.push(child);
    let spawnError; child.on('error',e=>{spawnError=e;}); let ready=false;
    for(let i=0;i<60;i++) {
      if(spawnError || child.exitCode !== null) throw spawnError ?? new Error('Anvil startup failed');
      try { const r=await fetch(`http://127.0.0.1:${p}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});const body=await r.json();if(BigInt(body.result)===BigInt(chain)){ready=true;break;} } catch {}
      await new Promise(r=>setTimeout(r,100));
    }
    if(!ready) throw new Error('Anvil readiness timeout');
  }
  await run(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/m5-anvil.test.ts'],{...process.env,OFT_M5_ANVIL:'1',OFT_M5_ARTIFACTS:join(directory,'out'),OFT_M5_BSC_PORT:String(bscPort),OFT_M5_ETH_PORT:String(ethPort)});
  console.log(await readFile('/tmp/oft-m5-local-evidence.json','utf8'));
} catch (error) { console.error(error.message); process.exitCode=1; }
finally { stop(); }
