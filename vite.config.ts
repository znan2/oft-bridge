import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { parseNetworkMode } from './shared/network';

export default defineConfig(({ mode }) => {
  // `--mode demo`: static portfolio build with mocked chain data, always testnet + dry-run.
  const demo = mode === 'demo';
  const network = demo ? 'testnet' : parseNetworkMode(process.env.OFT_NETWORK);
  return {
    plugins: [react()],
    define: { __OFT_NETWORK__: JSON.stringify(network), __OFT_DEMO__: JSON.stringify(demo) },
    publicDir: demo ? 'demo-public' : false,
    build: { target: 'es2022' },
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:4318' } },
    },
  };
});
