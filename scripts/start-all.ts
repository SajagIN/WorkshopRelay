/**
 * Convenience runner: API + worker + mock in one terminal with prefixed output.
 * Signals are forwarded so Ctrl-C shuts all three down gracefully.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs: Array<{ name: string; child: ChildProcess }> = [];
const COLORS: Record<string, string> = {
  api: '\x1b[36m', // cyan
  worker: '\x1b[35m', // magenta
  mock: '\x1b[33m', // yellow
};
const RESET = '\x1b[0m';

function start(name: string, script: string): void {
  const child = spawn('npx', ['tsx', script], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const color = COLORS[name] ?? '';
  const prefix = `${color}[${name}]${RESET} `;
  const pipe = (stream: NodeJS.ReadableStream, sink: NodeJS.WritableStream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) sink.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout!, process.stdout);
  pipe(child.stderr!, process.stderr);
  child.on('exit', (code, signal) => {
    process.stdout.write(`${prefix}exited (code=${code} signal=${signal})\n`);
    shutdown('child-exit');
  });
  procs.push({ name, child });
}

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\nShutting down (${reason})…\n`);
  for (const { child } of procs) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const { child } of procs) {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }
    process.exit(0);
  }, 4_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start('api', 'src/api/server.ts');
start('worker', 'src/worker/index.ts');
start('mock', 'src/mock/index.ts');

process.stdout.write(
  '\nWorkshopRelay: API (3000) · worker · mock (4100) — Ctrl-C to stop.\n',
);
