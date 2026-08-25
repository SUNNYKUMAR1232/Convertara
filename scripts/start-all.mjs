/**
 * Runs the API and the web app as one service.
 *
 * A single-port host (Render, Railway, Fly) exposes one port, so the web app
 * takes it and the API stays on loopback. Nothing else has to change: the
 * browser talks only to the web app, and app/api/[...path]/route.ts forwards
 * /api/* to API_URL at request time - which already defaults to 127.0.0.1:4000.
 *
 * Binding the API to 127.0.0.1 rather than 0.0.0.0 is deliberate. It keeps the
 * API off the public interface, and it stops a host that discovers its port by
 * scanning from picking the API as the service port instead of the web app's.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const PUBLIC_PORT = process.env.PORT ?? '3000';
const API_HOST = '127.0.0.1';

/**
 * The API's port is an implementation detail - nothing outside this process
 * needs to predict it - so never fail over it. A SIGKILLed supervisor (any
 * host force-kills after its grace period) orphans the API, which keeps its
 * port, and a fixed port would then make every restart die on EADDRINUSE:
 * a crash loop out of a shutdown that was only slightly untidy. A busy port
 * just means we take another one.
 *
 * The public port is excluded rather than probed. Render hands out PORT=4000,
 * which is also the natural default here, and probing cannot see the clash:
 * the web child has not bound its port yet, so 4000 looks free, both children
 * are sent to it, and the API loses the race. A port we are about to give away
 * is never a candidate.
 *
 * API_PORT is still honoured when set, and left to fail loudly if it is busy -
 * someone who names a port wants that port.
 */
async function pickApiPort() {
  if (process.env.API_PORT) {
    if (process.env.API_PORT === PUBLIC_PORT) {
      throw new Error(`API_PORT (${process.env.API_PORT}) is the port the web app serves on; pick another.`);
    }
    return process.env.API_PORT;
  }
  // 0 lets the OS choose, so it can never collide with the public port.
  const candidates = [4000, 0].filter((port) => port === 0 || String(port) !== PUBLIC_PORT);
  for (const candidate of candidates) {
    const port = await tryBind(candidate);
    if (port !== null && String(port) !== PUBLIC_PORT) return String(port);
  }
  throw new Error('could not find a free loopback port for the API');
}

function tryBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(null));
    probe.listen(port, API_HOST, () => {
      const { port: bound } = probe.address();
      probe.close(() => resolve(bound));
    });
  });
}

const API_PORT = await pickApiPort();

const children = new Map();
let stopping = false;

function run(name, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.set(name, child);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    // Neither process is optional, so a half-dead service is worse than none:
    // bring the other down and exit non-zero so the host restarts us cleanly.
    console.error(`[start-all] ${name} exited (${signal ?? `code ${code}`}); shutting down`);
    shutdown(signal ? 1 : (code ?? 1));
  });

  child.on('error', (error) => {
    console.error(`[start-all] ${name} failed to start: ${error.message}`);
    shutdown(1);
  });

  return child;
}

function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill('SIGTERM');

  // Don't let a process that ignores SIGTERM hold the deploy open.
  const force = setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 10_000);
  force.unref();

  const done = setInterval(() => {
    if (children.size > 0) return;
    clearInterval(done);
    process.exit(exitCode);
  }, 100);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(0));
}

run('api', process.execPath, ['dist/index.js'], {
  cwd: 'apps/api',
  env: { ...process.env, PORT: API_PORT, HOST: API_HOST },
});

run('web', process.execPath, ['.next/standalone/apps/web/server.js'], {
  cwd: 'apps/web',
  env: {
    ...process.env,
    PORT: PUBLIC_PORT,
    HOSTNAME: '0.0.0.0',
    API_URL: process.env.API_URL ?? `http://${API_HOST}:${API_PORT}`,
  },
});

console.log(`[start-all] web on :${PUBLIC_PORT}, api on ${API_HOST}:${API_PORT}`);
