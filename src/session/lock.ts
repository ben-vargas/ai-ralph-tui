/**
 * ABOUTME: Single instance lock management for Ralph TUI.
 * Prevents concurrent runs in the same git repository to avoid state corruption.
 * Provides clear user feedback for lock conflicts and stale lock handling.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  readFile,
  unlink,
  mkdir,
  access,
  constants,
  open,
  type FileHandle,
} from 'node:fs/promises';
import { promptBoolean } from '../setup/prompts.js';
import type { LockFile } from './types.js';

/**
 * Directory for session data (relative to cwd)
 */
const SESSION_DIR = '.ralph-tui';
const LOCK_FILE = 'ralph.lock';
const LOCK_GUARD_FILE = 'ralph.lock.guard';
const GUARD_TIMEOUT_MS = 2000;
const GUARD_STALE_MS = 2000;
const GUARD_SYNC_TIMEOUT_MS = 300;

interface LockGuardFile {
  pid: number;
  guardId: string;
  acquiredAt: string;
}

let currentLockId: string | null = null;

/**
 * Result of checking the lock status
 */
export interface LockCheckResult {
  /** Whether a valid lock exists (another process is running) */
  isLocked: boolean;

  /** Whether the lock is stale (process no longer running) */
  isStale: boolean;

  /** The lock file contents if a lock exists */
  lock?: LockFile;
}

/**
 * Result of attempting to acquire a lock
 */
export interface LockAcquisitionResult {
  /** Whether the lock was successfully acquired */
  acquired: boolean;

  /** Error message if acquisition failed */
  error?: string;

  /** PID of the existing lock holder if blocked */
  existingPid?: number;
}

/**
 * Check if a process is running by sending signal 0
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the session directory path
 */
function getSessionDir(cwd: string): string {
  return join(cwd, SESSION_DIR);
}

/**
 * Get the lock file path
 */
function getLockPath(cwd: string): string {
  return join(getSessionDir(cwd), LOCK_FILE);
}

/**
 * Get the lock guard path.
 */
function getLockGuardPath(cwd: string): string {
  return join(getSessionDir(cwd), LOCK_GUARD_FILE);
}

/**
 * Ensure session directory exists
 */
async function ensureSessionDir(cwd: string): Promise<void> {
  const dir = getSessionDir(cwd);
  try {
    await access(dir, constants.F_OK);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the lock file if it exists
 */
async function readLockFile(cwd: string): Promise<LockFile | null> {
  const lockPath = getLockPath(cwd);
  if (!(await fileExists(lockPath))) {
    return null;
  }

  try {
    const content = await readFile(lockPath, 'utf-8');
    return JSON.parse(content) as LockFile;
  } catch {
    // Corrupt lock file, treat as no lock
    return null;
  }
}

/**
 * Read the lock guard if it exists.
 */
async function readLockGuardFile(cwd: string): Promise<LockGuardFile | null> {
  try {
    const content = await readFile(getLockGuardPath(cwd), 'utf-8');
    return JSON.parse(content) as LockGuardFile;
  } catch {
    return null;
  }
}

/**
 * Read the lock guard synchronously if it exists.
 */
function readLockGuardFileSync(cwd: string): LockGuardFile | null {
  try {
    const content = readFileSync(getLockGuardPath(cwd), 'utf-8');
    return JSON.parse(content) as LockGuardFile;
  } catch {
    return null;
  }
}

/**
 * Check whether a guard has been abandoned.
 */
function isGuardStale(guard: LockGuardFile): boolean {
  const acquiredAt = Date.parse(guard.acquiredAt);
  return (
    !isProcessRunning(guard.pid) ||
    Number.isNaN(acquiredAt) ||
    Date.now() - acquiredAt >= GUARD_STALE_MS
  );
}

/**
 * Remove a guard only when it still has the observed identity.
 */
async function removeGuardIfOwned(
  cwd: string,
  guardId: string
): Promise<void> {
  const guard = await readLockGuardFile(cwd);
  if (guard?.guardId !== guardId) {
    return;
  }

  try {
    await unlink(getLockGuardPath(cwd));
  } catch {
    // Ignore a guard removed by another cleanup attempt.
  }
}

/**
 * Remove a guard synchronously only when it still has the observed identity.
 */
function removeGuardIfOwnedSync(cwd: string, guardId: string): void {
  const guard = readLockGuardFileSync(cwd);
  if (guard?.guardId !== guardId) {
    return;
  }

  try {
    unlinkSync(getLockGuardPath(cwd));
  } catch {
    // Ignore a guard removed by another cleanup attempt.
  }
}

/**
 * Break a stale guard without removing a newer guard that replaced it.
 */
async function breakStaleGuard(
  cwd: string,
  observedGuardId: string
): Promise<void> {
  const guard = await readLockGuardFile(cwd);
  if (guard?.guardId !== observedGuardId || !isGuardStale(guard)) {
    return;
  }

  try {
    await unlink(getLockGuardPath(cwd));
  } catch {
    // Ignore a guard removed by its owner.
  }
}

/**
 * Break a stale guard synchronously without removing a newer guard.
 */
function breakStaleGuardSync(cwd: string, observedGuardId: string): void {
  const guard = readLockGuardFileSync(cwd);
  if (guard?.guardId !== observedGuardId || !isGuardStale(guard)) {
    return;
  }

  try {
    unlinkSync(getLockGuardPath(cwd));
  } catch {
    // Ignore a guard removed by its owner.
  }
}

/**
 * Create the guard file atomically.
 */
async function tryCreateLockGuard(
  cwd: string,
  guardId: string
): Promise<boolean> {
  let handle: FileHandle | null = null;
  let created = false;
  let writeFailed = false;

  try {
    handle = await open(getLockGuardPath(cwd), 'wx');
    created = true;
    const guard: LockGuardFile = {
      pid: process.pid,
      guardId,
      acquiredAt: new Date().toISOString(),
    };
    await handle.writeFile(JSON.stringify(guard), 'utf-8');
    await handle.sync();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    writeFailed = created;
    throw error;
  } finally {
    if (handle) {
      await handle.close();
    }
    if (writeFailed) {
      try {
        await unlink(getLockGuardPath(cwd));
      } catch {
        // Best effort cleanup for a partially-written guard.
      }
    }
  }
}

/**
 * Serialize asynchronous mutations of the session lock.
 */
async function withLockGuard<T>(
  cwd: string,
  fn: () => Promise<T>
): Promise<T> {
  await ensureSessionDir(cwd);
  const guardId = randomUUID();
  const deadline = Date.now() + GUARD_TIMEOUT_MS;

  while (true) {
    if (await tryCreateLockGuard(cwd, guardId)) {
      break;
    }

    const guard = await readLockGuardFile(cwd);
    if (guard && isGuardStale(guard)) {
      await breakStaleGuard(cwd, guard.guardId);
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the session lock guard');
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  try {
    return await fn();
  } finally {
    await removeGuardIfOwned(cwd, guardId);
  }
}

/**
 * Serialize synchronous mutations of the session lock.
 */
function withLockGuardSync(cwd: string, fn: () => void): void {
  try {
    mkdirSync(getSessionDir(cwd), { recursive: true });
  } catch {
    fn();
    return;
  }

  const guardId = randomUUID();
  const deadline = Date.now() + GUARD_SYNC_TIMEOUT_MS;
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    let fileDescriptor: number | null = null;
    let created = false;
    let writeFailed = false;

    try {
      fileDescriptor = openSync(getLockGuardPath(cwd), 'wx');
      created = true;
      const guard: LockGuardFile = {
        pid: process.pid,
        guardId,
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(fileDescriptor, JSON.stringify(guard), 'utf-8');
      fsyncSync(fileDescriptor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        writeFailed = created;
        if (fileDescriptor !== null) {
          closeSync(fileDescriptor);
          fileDescriptor = null;
        }
        if (writeFailed) {
          try {
            unlinkSync(getLockGuardPath(cwd));
          } catch {
            // Best effort cleanup for a partially-written guard.
          }
        }
        fn();
        return;
      }
    } finally {
      if (fileDescriptor !== null) {
        closeSync(fileDescriptor);
      }
    }

    const guard = readLockGuardFileSync(cwd);
    if (guard && isGuardStale(guard)) {
      breakStaleGuardSync(cwd, guard.guardId);
    }

    if (Date.now() >= deadline) {
      // Exit cleanup must not hang behind a broken guard.
      fn();
      return;
    }

    Atomics.wait(sleepBuffer, 0, 0, 5);
  }

  try {
    fn();
  } finally {
    removeGuardIfOwnedSync(cwd, guardId);
  }
}

/**
 * Check whether the current process owns a lock.
 */
function isOurLock(lock: LockFile): boolean {
  return lock.lockId === undefined
    ? lock.pid === process.pid
    : lock.lockId === currentLockId;
}

/**
 * Check the current lock status without modifying anything
 */
export async function checkLock(cwd: string): Promise<LockCheckResult> {
  const lock = await readLockFile(cwd);

  if (!lock) {
    return { isLocked: false, isStale: false };
  }

  const isRunning = isProcessRunning(lock.pid);

  return {
    isLocked: isRunning,
    isStale: !isRunning,
    lock,
  };
}

/**
 * Create a new lock file
 */
async function writeLockFile(cwd: string, sessionId: string): Promise<void> {
  await ensureSessionDir(cwd);
  const lockPath = getLockPath(cwd);

  const lock: LockFile = {
    lockId: randomUUID(),
    pid: process.pid,
    sessionId,
    acquiredAt: new Date().toISOString(),
    cwd,
    hostname: hostname(),
  };

  let handle: FileHandle | null = null;
  try {
    // 'wx' enforces O_CREAT|O_EXCL so lock creation is atomic across processes.
    handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(JSON.stringify(lock, null, 2), 'utf-8');
      await handle.sync();
      currentLockId = lock.lockId ?? null;
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Best effort close before removing partial file.
      }
      handle = null;
      try {
        await unlink(lockPath);
      } catch {
        // Best effort cleanup for partial lock file.
      }
      throw error;
    }
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

/**
 * Attempt to atomically create a lock file.
 * Returns a structured conflict result when another process wins the race.
 */
async function tryWriteLockFile(
  cwd: string,
  sessionId: string
): Promise<LockAcquisitionResult> {
  try {
    await writeLockFile(cwd, sessionId);
    return { acquired: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const refreshed = await checkLock(cwd);
      const existingPid = refreshed.lock?.pid;
      return {
        acquired: false,
        error: existingPid
          ? `Ralph already running in this repo (PID: ${existingPid})`
          : 'Ralph lock already exists in this repo',
        existingPid,
      };
    }
    throw error;
  }
}

/**
 * Remove the lock file
 */
async function deleteLockFile(cwd: string): Promise<void> {
  const lockPath = getLockPath(cwd);
  try {
    await unlink(lockPath);
  } catch {
    // Ignore if lock doesn't exist
  }
}

/**
 * Return the standard conflict result for an existing lock.
 */
function lockConflictResult(lock: LockFile): LockAcquisitionResult {
  return {
    acquired: false,
    error: `Ralph already running in this repo (PID: ${lock.pid})`,
    existingPid: lock.pid,
  };
}

/**
 * Format the stale lock warning message
 */
function formatStaleLockWarning(lock: LockFile): string {
  const startTime = new Date(lock.acquiredAt).toLocaleString();
  return `
⚠️  Stale lock detected

A previous Ralph session did not exit cleanly:
  PID:      ${lock.pid} (no longer running)
  Started:  ${startTime}
  Host:     ${lock.hostname}

This may happen if Ralph was terminated unexpectedly (crash, kill -9, etc.).
`;
}

/**
 * Prompt user to clean stale lock
 */
async function promptCleanStaleLock(lock: LockFile): Promise<boolean> {
  console.log(formatStaleLockWarning(lock));

  const shouldClean = await promptBoolean(
    'Remove the stale lock and continue?',
    { default: true }
  );

  return shouldClean;
}

/**
 * Attempt to acquire the lock for starting a new session.
 *
 * This is the main entry point for lock management. It handles:
 * 1. Checking for existing locks
 * 2. Detecting stale locks and prompting for cleanup
 * 3. Blocking if another instance is running
 * 4. Creating a new lock file
 *
 * @param cwd - Working directory
 * @param sessionId - Session ID for the new lock
 * @param options - Configuration options
 * @returns Result indicating success or failure with details
 */
export async function acquireLockWithPrompt(
  cwd: string,
  sessionId: string,
  options: {
    /** Force acquisition even if locked (for --force flag) */
    force?: boolean;
    /** Skip interactive prompt for stale lock cleanup */
    nonInteractive?: boolean;
  } = {}
): Promise<LockAcquisitionResult> {
  const { force = false, nonInteractive = false } = options;

  // Check current lock status
  const lockStatus = await checkLock(cwd);

  // No lock exists - acquire immediately
  if (!lockStatus.lock) {
    try {
      return await withLockGuard(cwd, async () => {
        const refreshed = await checkLock(cwd);
        if (refreshed.lock) {
          if (force) {
            await deleteLockFile(cwd);
          } else {
            return lockConflictResult(refreshed.lock);
          }
        }
        return tryWriteLockFile(cwd, sessionId);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Timed out waiting for the session lock guard'
      ) {
        return {
          acquired: false,
          error: error.message,
        };
      }
      throw error;
    }
  }

  // Lock exists and is held by a running process
  if (lockStatus.isLocked && !force) {
    return lockConflictResult(lockStatus.lock);
  }

  // Lock exists but process is not running (stale lock)
  if (lockStatus.isStale) {
    if (nonInteractive) {
      // In non-interactive mode, warn and auto-clean
      console.log(`Warning: Removing stale lock (PID: ${lockStatus.lock.pid})`);
      try {
        return await withLockGuard(cwd, async () => {
        const refreshed = await checkLock(cwd);
          if (refreshed.lock && force) {
            await deleteLockFile(cwd);
          } else if (refreshed.lock && !refreshed.isStale) {
            return lockConflictResult(refreshed.lock);
          } else if (refreshed.lock) {
            await deleteLockFile(cwd);
          }
          return tryWriteLockFile(cwd, sessionId);
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Timed out waiting for the session lock guard'
        ) {
          return {
            acquired: false,
            error: error.message,
          };
        }
        throw error;
      }
    }

    // Interactive mode - prompt user
    const shouldClean = await promptCleanStaleLock(lockStatus.lock);

    if (!shouldClean) {
      return {
        acquired: false,
        error: 'Stale lock cleanup declined by user',
      };
    }

    try {
      return await withLockGuard(cwd, async () => {
        const refreshed = await checkLock(cwd);
        if (refreshed.lock && force) {
          await deleteLockFile(cwd);
        } else if (refreshed.lock && !refreshed.isStale) {
          return lockConflictResult(refreshed.lock);
        } else if (refreshed.lock) {
          await deleteLockFile(cwd);
        }
        return tryWriteLockFile(cwd, sessionId);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Timed out waiting for the session lock guard'
      ) {
        return {
          acquired: false,
          error: error.message,
        };
      }
      throw error;
    }
  }

  // Force flag set - override the lock
  if (force) {
    console.log(`Warning: Forcing lock acquisition (previous PID: ${lockStatus.lock.pid})`);
    try {
      return await withLockGuard(cwd, async () => {
        const refreshed = await checkLock(cwd);
        if (refreshed.lock) {
          await deleteLockFile(cwd);
        }
        return tryWriteLockFile(cwd, sessionId);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Timed out waiting for the session lock guard'
      ) {
        return {
          acquired: false,
          error: error.message,
        };
      }
      throw error;
    }
  }

  // Should not reach here, but handle gracefully
  return {
    acquired: false,
    error: 'Unexpected lock state',
  };
}

/**
 * Acquire a lock only when no lock file exists.
 *
 * This is the legacy session API used by resume flows. Stale locks are
 * intentionally left for cleanStaleLock to remove first.
 */
export async function acquireLockExclusive(
  cwd: string,
  sessionId: string
): Promise<boolean> {
  try {
    return await withLockGuard(cwd, async () => {
      if (await readLockFile(cwd)) {
        return false;
      }

      const result = await tryWriteLockFile(cwd, sessionId);
      return result.acquired;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Timed out waiting for the session lock guard'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Remove a stale lock while holding the session lock guard.
 */
export async function cleanStaleLock(cwd: string): Promise<boolean> {
  try {
    return await withLockGuard(cwd, async () => {
      const lock = await readLockFile(cwd);
      if (!lock || isProcessRunning(lock.pid)) {
        return false;
      }

      await deleteLockFile(cwd);
      return true;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Timed out waiting for the session lock guard'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Release the lock for the current session.
 * Should be called on clean exit, or during crash recovery.
 */
export async function releaseLock(cwd: string): Promise<void> {
  await withLockGuard(cwd, async () => {
    const lock = await readLockFile(cwd);
    if (lock && isOurLock(lock)) {
      await deleteLockFile(cwd);
    }
  });
}

/**
 * Release the lock synchronously when the current process owns it.
 */
export function releaseLockSync(cwd: string): void {
  withLockGuardSync(cwd, () => {
    const lockPath = getLockPath(cwd);

    try {
      const content = readFileSync(lockPath, 'utf-8');
      const lock = JSON.parse(content) as LockFile;

      if (isOurLock(lock)) {
        unlinkSync(lockPath);
      }
    } catch {
      // Best effort cleanup for missing or corrupt lock files.
    }
  });
}

/**
 * Register cleanup handlers to ensure lock is released on exit.
 *
 * This should be called once after acquiring the lock. It registers
 * handlers for:
 * - Normal exit (process.on('exit'))
 * - SIGTERM and SIGINT (graceful shutdown)
 * - Uncaught exceptions
 * - Unhandled promise rejections
 *
 * @param cwd - Working directory
 * @returns Cleanup function to remove the handlers
 */
export function registerLockCleanupHandlers(cwd: string): () => void {
  // Synchronous cleanup for exit event
  const handleExit = (): void => {
    releaseLockSync(cwd);
  };

  // While this is the only listener, nothing else can shut down the process,
  // so the lock layer terminates with the conventional signal exit code.
  // Once the run command or parallel mode installs its own listener, this
  // handler becomes a no-op and the application owns the signal entirely.
  const handleSignal = (signal: 'SIGTERM' | 'SIGINT') => (): void => {
    if (process.listenerCount(signal) > 1) {
      return;
    }
    releaseLockSync(cwd);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const handleSigterm = handleSignal('SIGTERM');
  const handleSigint = handleSignal('SIGINT');

  // Handle uncaught errors
  const handleUncaughtError = async (): Promise<void> => {
    await releaseLock(cwd);
    // Don't exit here - let Node's default behavior happen
  };

  process.on('exit', handleExit);
  process.on('SIGTERM', handleSigterm);
  process.on('SIGINT', handleSigint);
  process.on('uncaughtException', handleUncaughtError);
  process.on('unhandledRejection', handleUncaughtError);

  // Return cleanup function
  return () => {
    process.off('exit', handleExit);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
    process.off('uncaughtException', handleUncaughtError);
    process.off('unhandledRejection', handleUncaughtError);
  };
}
