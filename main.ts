// Entry lifecycle: bring the forge up on an ephemeral port, tell the trial
// environment where to find it, then stay alive until the environment says
// the trial is over. Nothing here talks to any model or outside service —
// the only remote party is the trial environment itself, via MAKEFUN_ENV_URL.

import { createApp } from './app.ts';

// The trial environment's base URL, with any trailing slashes removed so the
// paths appended below join cleanly.
const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envBase === '') {
  process.stderr.write('MAKEFUN_ENV_URL is not set; cannot register with an environment.\n');
  process.exit(1);
}

// One HTTP round trip to the environment may take at most this long before it
// is abandoned and tried again.
const REQUEST_TIMEOUT_MS = 30_000;

// Backoff between retries: start short, double each time, stop growing here.
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(failureCount: number): number {
  return Math.min(BACKOFF_START_MS * 2 ** failureCount, BACKOFF_CEILING_MS);
}

function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// Announce our bound port to the environment. A 200 means the environment
// took it; a 409 means some other entry registered first, in which case this
// process simply keeps waiting like any other. Anything else (a 4xx that
// says the request itself was wrong, or a transport failure) is retried with
// backoff, except a malformed-request answer, which is fatal.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await timedFetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register rejected with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register rejected with HTTP ')) {
        throw error;
      }
    }
    await pause(backoffMs(failures++));
  }
}

// Keep asking the environment whether the trial is finished. A slow or
// failed poll is not an answer, so it is retried; only a body of
// {"done": true} ends the wait.
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await timedFetch(`${envBase}/done`, { method: 'GET' });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The environment is not answering, or the poll timed out: not done yet.
    }
    await pause(backoffMs(failures++));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`listening on port ${bound.port}\n`);
  await announcePort(bound.port);
  process.stdout.write('registered; waiting for the environment to finish\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('environment done; exiting\n');
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
