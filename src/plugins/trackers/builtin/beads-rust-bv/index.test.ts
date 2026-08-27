/**
 * ABOUTME: Tests for BeadsRustBvTrackerPlugin label-scope verification.
 * Mocks bv and the beads-rust delegate so task-selection behavior is isolated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { TrackerTask } from '../../types.js';

let BeadsRustBvTrackerPlugin: typeof import('./index.js').BeadsRustBvTrackerPlugin;

interface MockSpawnResponse {
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const spawnResponses: MockSpawnResponse[] = [];

function queueSpawnResponse(response: MockSpawnResponse): void {
  spawnResponses.push(response);
}

function queueRobotNextTask(id = 'task-42'): void {
  queueSpawnResponse({
    command: 'bv',
    stdout: JSON.stringify({
      generated_at: '2026-02-24T00:00:00.000Z',
      data_hash: 'hash',
      output_format: 'json',
      id,
      title: 'Robot next task',
      score: 0.9,
      reasons: ['Top rank'],
      unblocks: 5,
      claim_command: `br update ${id} --status in_progress`,
      show_command: `br show ${id}`,
    }),
  });
}

function configurePlugin(
  plugin: InstanceType<typeof BeadsRustBvTrackerPlugin>,
  labels: string[],
  task: TrackerTask | undefined,
  fallbackTask: TrackerTask
): void {
  const state = plugin as unknown as {
    bvAvailable: boolean;
    labels: string[];
    scheduleTriageRefresh: () => void;
    delegate: {
      getTask: (id: string) => Promise<TrackerTask | undefined>;
      getNextTask: (filter?: unknown) => Promise<TrackerTask | undefined>;
    };
  };
  state.bvAvailable = true;
  state.labels = labels;
  state.scheduleTriageRefresh = () => {};
  state.delegate.getTask = async () => task;
  state.delegate.getNextTask = async () => fallbackTask;
}

describe('BeadsRustBvTrackerPlugin label scope', () => {
  beforeAll(async () => {
    mock.module('node:child_process', () => ({
      spawn: (command: string) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
        };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();

        const matchIndex = spawnResponses.findIndex(
          (response) =>
            response.command === command || response.command === '*'
        );
        const response =
          matchIndex >= 0
            ? spawnResponses.splice(matchIndex, 1)[0]
            : { command, exitCode: 0 };

        setTimeout(() => {
          if (response?.stdout) {
            proc.stdout.emit('data', Buffer.from(response.stdout));
          }
          if (response?.stderr) {
            proc.stderr.emit('data', Buffer.from(response.stderr));
          }
          proc.emit('close', response?.exitCode ?? 0);
        }, 0);
        return proc;
      },
    }));

    mock.module('node:fs', () => ({
      constants: { R_OK: 4, W_OK: 2, X_OK: 1, F_OK: 0 },
    }));

    mock.module('node:fs/promises', () => ({
      access: async () => {},
      readFile: async () => '',
    }));

    const module = await import('./index.js');
    BeadsRustBvTrackerPlugin = module.BeadsRustBvTrackerPlugin;
  });

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    spawnResponses.length = 0;
  });

  test('falls back when bv pick is missing a configured label', async () => {
    const plugin = new BeadsRustBvTrackerPlugin();
    const fallbackTask: TrackerTask = {
      id: 'fallback-task',
      title: 'Label-scoped fallback task',
      status: 'open',
      priority: 2,
      labels: ['repo:site-djbclark', 'kind:feature'],
    };
    configurePlugin(
      plugin,
      ['repo:site-djbclark', 'kind:feature'],
      {
        id: 'task-42',
        title: 'Robot next task',
        status: 'open',
        priority: 2,
        labels: ['repo:site-djbclark'],
      },
      fallbackTask
    );
    queueRobotNextTask();

    const result = await plugin.getNextTask();

    expect(result).toEqual(fallbackTask);
  });

  test('returns bv metadata when the pick carries every configured label', async () => {
    const plugin = new BeadsRustBvTrackerPlugin();
    configurePlugin(
      plugin,
      ['repo:site-djbclark', 'kind:feature'],
      {
        id: 'task-42',
        title: 'Robot next task',
        status: 'open',
        priority: 2,
        labels: ['repo:site-djbclark', 'kind:feature'],
      },
      {
        id: 'fallback-task',
        title: 'Fallback task',
        status: 'open',
        priority: 2,
      }
    );
    queueRobotNextTask();

    const result = await plugin.getNextTask();

    expect(result?.id).toBe('task-42');
    expect(result?.metadata?.bvScore).toBe(0.9);
    expect(result?.metadata?.bvReasons).toEqual(['Top rank']);
    expect(result?.metadata?.bvUnblocks).toBe(5);
  });

  test('uses filter labels instead of configured labels for verification', async () => {
    const plugin = new BeadsRustBvTrackerPlugin();
    configurePlugin(
      plugin,
      ['repo:site-configured'],
      {
        id: 'task-42',
        title: 'Robot next task',
        status: 'open',
        priority: 2,
        labels: ['repo:site-filter'],
      },
      {
        id: 'fallback-task',
        title: 'Fallback task',
        status: 'open',
        priority: 2,
      }
    );
    queueRobotNextTask();

    const result = await plugin.getNextTask({
      labels: ['repo:site-filter'],
    });

    expect(result?.id).toBe('task-42');
    expect(result?.metadata?.bvScore).toBe(0.9);
  });

  test('falls back when the task cannot be fetched under a label scope', async () => {
    const plugin = new BeadsRustBvTrackerPlugin();
    const fallbackTask: TrackerTask = {
      id: 'fallback-task',
      title: 'Label-scoped fallback task',
      status: 'open',
      priority: 2,
      labels: ['repo:site-djbclark'],
    };
    configurePlugin(plugin, ['repo:site-djbclark'], undefined, fallbackTask);
    queueRobotNextTask();

    const result = await plugin.getNextTask();

    expect(result).toEqual(fallbackTask);
  });

  test('preserves the minimal bv task fallback without a label scope', async () => {
    const plugin = new BeadsRustBvTrackerPlugin();
    configurePlugin(
      plugin,
      [],
      undefined,
      {
        id: 'delegate-task',
        title: 'Delegate task',
        status: 'open',
        priority: 2,
      }
    );
    queueRobotNextTask();

    const result = await plugin.getNextTask();

    expect(result?.id).toBe('task-42');
    expect(result?.title).toBe('Robot next task');
    expect(result?.metadata?.bvScore).toBe(0.9);
  });
});
