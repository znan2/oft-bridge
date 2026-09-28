import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import App from './App';
import { createWalletConfig } from './lib/wallet';
import './styles.css';

declare const __OFT_DEMO__: boolean;
// The static demo swaps the local server and Rabby for in-memory mocks before anything connects.
// Using the build-time constant directly lets regular builds drop the demo chunk entirely.
if (__OFT_DEMO__) (await import('./demo')).installDemo();
const config = createWalletConfig();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><WagmiProvider config={config} reconnectOnMount={false}><QueryClientProvider client={queryClient}><App /></QueryClientProvider></WagmiProvider></React.StrictMode>,
);
