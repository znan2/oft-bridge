// EIP-6963 mock provider announced as Rabby so the real connect/switch flow runs in the demo.
// It holds no keys and refuses every signing method.
import { CHAINS } from '../../shared/chains';
import { DEMO_ACCOUNT } from './constants';

type Listener = (...args: unknown[]) => void;
const SIGNING = /^(eth_send|eth_sign|personal_sign|eth_signTypedData)/;

export function installDemoWallet() {
  let chainId = CHAINS[0].id, connected = false;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach(fn => fn(...args));
  const provider = {
    isRabby: true,
    on(event: string, fn: Listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); return provider; },
    removeListener(event: string, fn: Listener) { listeners.get(event)?.delete(fn); return provider; },
    async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
      if (SIGNING.test(method)) throw Object.assign(new Error('Demo wallet cannot sign.'), { code: 4001 });
      switch (method) {
        case 'eth_requestAccounts': connected = true; emit('connect', { chainId: `0x${chainId.toString(16)}` }); return [DEMO_ACCOUNT];
        case 'eth_accounts': return connected ? [DEMO_ACCOUNT] : [];
        case 'eth_chainId': return `0x${chainId.toString(16)}`;
        case 'wallet_requestPermissions': case 'wallet_getPermissions': return [{ parentCapability: 'eth_accounts' }];
        case 'wallet_revokePermissions': connected = false; return null;
        case 'wallet_switchEthereumChain': {
          const next = Number(BigInt((params[0] as { chainId: string }).chainId));
          if (!CHAINS.some(c => c.id === next)) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
          chainId = next; emit('chainChanged', `0x${next.toString(16)}`); return null;
        }
        default: throw Object.assign(new Error(`Demo wallet: ${method} unsupported`), { code: 4200 });
      }
    },
  };
  const icon = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#262626"/><path d="M9 16h14" stroke="#3ce8a0" stroke-width="3"/></svg>');
  const detail = Object.freeze({ info: { uuid: '00000000-0000-4000-8000-00000000de00', name: 'Rabby Wallet (Demo)', icon, rdns: 'io.rabby' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}
