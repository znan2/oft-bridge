// Strip credentials from text that may reach logs, the UI or error reports.
// RPC URLs often embed API keys in the path or query (Alchemy, Infura, QuickNode…), so whole URLs are removed.
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'`<>)]+/gi;
const ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|private[_-]?key|mnemonic)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BARE_TOKEN = /\b(?!0x)[A-Za-z0-9_-]{32,}\b/g;

export function redactSecrets(text: string): string {
  return text
    .replace(/\\\//g, '/') // JSON-escaped URLs (https:\/\/host\/key)
    .replace(URL_PATTERN, match => { try { return `[URL ${new URL(match).hostname}]`; } catch { return '[URL]'; } })
    .replace(ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}[REDACTED]`)
    .replace(BARE_TOKEN, '[REDACTED]');
}
