// True only in `vite build --mode demo` (static portfolio build with mocked chain data).
declare const __OFT_DEMO__: boolean | undefined;
export const DEMO = typeof __OFT_DEMO__ !== 'undefined' && __OFT_DEMO__ === true;
