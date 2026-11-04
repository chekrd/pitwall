// The advisor keeps the user's MCP servers so it can read tickets and docs and drive a browser, but nothing
// outward-facing: a PreToolUse hook runs this file. A browser's tools are allowed, but for uploading files; any other
// server's only when the tool's name says it reads and nothing says it writes. Whatever cannot be judged is denied.

const READS = new Set([
  'get', 'list', 'search', 'read', 'fetch', 'query', 'find', 'view', 'describe', 'export', 'lookup', 'show', 'inspect',
  'discover', 'info', 'whoami', 'count', 'preview', 'browse', 'retrieve', 'guide', 'help',
]);

const WRITES = new Set([
  'create', 'update', 'edit', 'delete', 'remove', 'add', 'send', 'post', 'publish', 'transition', 'comment',
  'write', 'destructive', 'upload', 'move', 'rename', 'archive', 'merge', 'assign', 'reply', 'share', 'invite',
  'schedule', 'cancel', 'batch', 'insert', 'put', 'patch', 'submit', 'approve', 'resolve', 'set', 'save', 'push',
  'deploy', 'fork', 'apply', 'execute', 'import', 'sync', 'close', 'reopen', 'lock', 'unlock', 'revert', 'reset',
  'drop', 'truncate', 'grant', 'revoke', 'trigger', 'start', 'stop', 'restart', 'install', 'uninstall', 'enable', 'disable',
  'authenticate', 'login', 'logout', 'subscribe', 'unsubscribe', 'react', 'star', 'unstar', 'pin', 'unpin', 'mark',
]);

const BROWSER = /chrome|brave|browser|devtools|playwright|puppeteer/i;

const words = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// The Atlassian server reads through executeRead, which names the risk tier rather than the verb; the scratch copy is
// the advisor's own, where it may write.
const ALLOWED = new Set(['mcp__plugin_atlassian_atlassian__executeRead', 'mcp__atlassian__executeRead', 'mcp__pitwall-advisor__scratch_copy']);

export function changesSomething(toolName: string) {
  const at = toolName.lastIndexOf('__');
  if (!toolName.startsWith('mcp__') || at <= 'mcp_'.length) return false;
  const server = toolName.slice(0, at);
  const tool = toolName.slice(at + 2);
  const said = words(tool);
  if (ALLOWED.has(toolName)) return false;
  if (BROWSER.test(server)) return said.includes('upload');
  return !said.some((w) => READS.has(w)) || said.some((w) => WRITES.has(w));
}

// Exit code 2 blocks the call and hands Claude the reason; any other failure would let it through.
function deny(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

if (import.meta.main) {
  let name: string;
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    name = JSON.parse(input).tool_name;
    if (typeof name !== 'string' || !name) throw new Error('no tool_name');
  } catch (err) {
    deny(`the second opinion's MCP guard could not read the tool call (${(err as Error).message}), so it is denied`);
  }
  if (changesSomething(name)) deny(`${name} may change something outside the worktree; a second opinion only reads and tries things in its scratch copy.`);
}
