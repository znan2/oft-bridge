import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['tests/**/*.test.{ts,tsx}'], testTimeout: 15000,
  setupFiles: ['tests/setup/no-network.ts'],
  // Existing suites exercise the pinned mainnet registry with mocked RPCs. The testnet default is tested separately.
  env: { OFT_NETWORK: 'mainnet' },
} });
