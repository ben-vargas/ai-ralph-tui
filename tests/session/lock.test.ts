/**
 * ABOUTME: Tests for synchronous lock cleanup and startup signal ownership.
 * Covers owned-lock release, listener handoff, and signal exit behavior.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLockWithPrompt,
  registerLockCleanupHandlers,
  releaseLock,
  releaseLockSync,
} from '../../src/session/lock.js';
import type { LockFile } from '../../src/session/types.js';

const SESSION_DIR = '.ralph-tui';
const LOCK_FILE = 'ralph.lock';
const READY_MARKER = 'LOCK_TEST_READY';

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'ralph-lock-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function lockPath(cwd: string): string {
  return join(cwd, SESSION_DIR, LOCK_FILE);
}

async function writeLock(cwd: string, pid: number): Promise<void> {
  await mkdir(join(cwd, SESSION_DIR), { recursive: true });
  const lock: LockFile = {
    pid,
    sessionId: 'lock-test-session',
    acquiredAt: new Date().toISOString(),
    cwd,
    hostname: 'lock-test-host',
  };
  await writeFile(lockPath(cwd), JSON.stringify(lock), 'utf-8');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForReadyFile(path: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for ${READY_MARKER}`);
}

async function runSignalChild(
  signal: 'SIGTERM' | 'SIGINT',
  expectedExitCode: number
): Promise<void> {
  const cwd = await createTempDir();
  const readyPath = join(cwd, 'ready-marker');
  const modulePath = join(process.cwd(), 'src/session/lock.ts');
  const scriptPath = join(cwd, 'signal-child.ts');
  const script = `
import { writeFile } from 'node:fs/promises';
import {
  acquireLockWithPrompt,
  registerLockCleanupHandlers,
} from ${JSON.stringify(modulePath)};

const cwd = process.argv[2];
const readyPath = process.argv[3];
const result = await acquireLockWithPrompt(cwd, 'signal-child', {
  nonInteractive: true,
});
if (!result.acquired) {
  process.exit(2);
}
registerLockCleanupHandlers(cwd);
console.log(${JSON.stringify(READY_MARKER)});
await writeFile(readyPath, ${JSON.stringify(READY_MARKER)}, 'utf-8');
setInterval(() => {}, 1000);
`;
  await writeFile(scriptPath, script, 'utf-8');

  const child = Bun.spawn([process.execPath, scriptPath, cwd, readyPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    await waitForReadyFile(readyPath);
    child.kill(signal);
    const exitCode = await child.exited;
    expect(exitCode).toBe(expectedExitCode);
    expect(await pathExists(lockPath(cwd))).toBe(false);
  } finally {
    if (!child.killed) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('releaseLockSync', () => {
  test('removes a lock owned by the current process', async () => {
    const cwd = await createTempDir();
    await writeLock(cwd, process.pid);

    releaseLockSync(cwd);

    expect(await pathExists(lockPath(cwd))).toBe(false);
  });

  test('leaves a lock owned by another process untouched', async () => {
    const cwd = await createTempDir();
    await writeLock(cwd, process.pid + 1);
    const before = await readFile(lockPath(cwd), 'utf-8');

    releaseLockSync(cwd);

    expect(await pathExists(lockPath(cwd))).toBe(true);
    expect(await readFile(lockPath(cwd), 'utf-8')).toBe(before);
  });

  test('does nothing when the lock file is missing', async () => {
    const cwd = await createTempDir();

    expect(() => releaseLockSync(cwd)).not.toThrow();
    expect(await pathExists(lockPath(cwd))).toBe(false);
  });

  test('does nothing when the lock file is corrupt', async () => {
    const cwd = await createTempDir();
    await mkdir(join(cwd, SESSION_DIR), { recursive: true });
    await writeFile(lockPath(cwd), 'not-json', 'utf-8');

    expect(() => releaseLockSync(cwd)).not.toThrow();
    expect(await pathExists(lockPath(cwd))).toBe(true);
  });
});

test('does not take ownership of signals when another listener exists', async () => {
  const cwd = await createTempDir();
  const acquired = await acquireLockWithPrompt(cwd, 'listener-test');
  expect(acquired.acquired).toBe(true);

  const cleanup = registerLockCleanupHandlers(cwd);
  const listeners: Array<{
    signal: 'SIGTERM' | 'SIGINT';
    handler: () => void;
  }> = [];

  try {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      let listenerRan = false;
      const handler = (): void => {
        listenerRan = true;
      };
      listeners.push({ signal, handler });
      process.on(signal, handler);

      process.emit(signal);

      expect(listenerRan).toBe(true);
      expect(await pathExists(lockPath(cwd))).toBe(true);
      process.off(signal, handler);
    }
  } finally {
    for (const { signal, handler } of listeners) {
      process.off(signal, handler);
    }
    cleanup();
    await releaseLock(cwd);
  }
});

describe('startup signal ownership', () => {
  test('exits with 143 and releases the lock for SIGTERM', async () => {
    await runSignalChild('SIGTERM', 143);
  });

  test('exits with 130 and releases the lock for SIGINT', async () => {
    await runSignalChild('SIGINT', 130);
  });
});
