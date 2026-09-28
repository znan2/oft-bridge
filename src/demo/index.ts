import { installDemoBackend } from './backend';
import { installDemoWallet } from './wallet';

export function installDemo() {
  installDemoBackend();
  installDemoWallet();
}
