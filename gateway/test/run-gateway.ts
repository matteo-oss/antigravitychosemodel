import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const names = [
  'gateway-integration', 'gateway-lifecycle', 'dashboard-ui', 'parse-tool-args', 'token-estimator', 'tool-translation',
  'mapper-translation', 'google-adapter', 'gateway-protocols', 'router-classify',
  'reasoning-store', 'session-store-ttl', 'safe-write', 'error-response',
  'context-windows', 'plugin-architecture', 'provider-expansion',
];
const selected = process.argv[2] ? names.filter(n => n.includes(process.argv[2])) : names;
if (!selected.length) throw new Error('No matching test module');
const child = spawn(process.execPath, ['--import', 'tsx', '--import', new URL('./isolate.ts', import.meta.url).href, '--test', '--test-concurrency=1', ...selected.map(n => fileURLToPath(new URL(`./${n}.test.ts`, import.meta.url)))], { stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code || 0; });
