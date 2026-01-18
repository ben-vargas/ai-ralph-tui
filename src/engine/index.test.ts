/**
 * ABOUTME: Tests for the ExecutionEngine, focusing on prompt preview generation.
 * Verifies that prompt preview works for tasks in all statuses including completed.
 *
 * These tests avoid mock.module() to prevent interfering with other test files.
 * The tracker is injected directly, and filesystem functions gracefully handle
 * non-existent paths by returning empty strings.
 */

import { describe, test, expect } from 'bun:test';
import type { TrackerPlugin, TrackerTask, TaskFilter } from '../plugins/trackers/types.js';
import type { RalphConfig } from '../config/types.js';
import { ExecutionEngine } from './index.js';

/**
 * Creates a minimal mock tracker for testing.
 * Uses Partial<TrackerPlugin> with type assertion since we only need
 * the methods that generatePromptPreview actually uses.
 */
function createMockTracker(tasks: TrackerTask[]): TrackerPlugin {
  const mockTracker: Partial<TrackerPlugin> = {
    meta: {
      id: 'mock',
      name: 'Mock Tracker',
      description: 'Mock tracker for testing',
      version: '1.0.0',
      supportsBidirectionalSync: false,
      supportsHierarchy: false,
      supportsDependencies: false,
    },
    getTasks: async (options?: TaskFilter) => {
      if (!options?.status) return tasks;
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      return tasks.filter((t) => statuses.includes(t.status));
    },
    // Provide a simple Handlebars template that includes task ID and title
    getTemplate: () => `Task: {{taskId}} - {{taskTitle}}`,
    getPrdContext: async () => null,
  };
  return mockTracker as TrackerPlugin;
}

/**
 * Creates a mock task with specified properties
 */
function createMockTask(overrides: Partial<TrackerTask> = {}): TrackerTask {
  return {
    id: 'test-001',
    title: 'Test Task',
    status: 'open',
    priority: 2,
    ...overrides,
  };
}

/**
 * Creates a minimal RalphConfig for testing.
 * Uses /tmp paths that don't exist to ensure filesystem functions
 * gracefully return empty strings.
 */
function createMockConfig(): RalphConfig {
  return {
    cwd: '/tmp/ralph-test-nonexistent',
    model: 'test-model',
    agent: { name: 'test', plugin: 'claude', options: {} },
    tracker: { name: 'test', plugin: 'json', options: {} },
    maxIterations: 10,
    iterationDelay: 1000,
    outputDir: '/tmp/ralph-test-nonexistent/output',
    progressFile: '/tmp/ralph-test-nonexistent/progress.md',
    showTui: false,
    errorHandling: {
      strategy: 'skip',
      maxRetries: 3,
      retryDelayMs: 5000,
      continueOnNonZeroExit: false,
    },
  };
}

describe('ExecutionEngine', () => {
  describe('generatePromptPreview', () => {
    test('returns prompt for open tasks', async () => {
      const openTask = createMockTask({ id: 'task-open', status: 'open', title: 'Open Task' });
      const mockTracker = createMockTracker([openTask]);

      const engine = new ExecutionEngine(createMockConfig());

      // Inject mock tracker directly
      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('task-open');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prompt).toContain('task-open');
        expect(result.prompt).toContain('Open Task');
      }
    });

    test('returns prompt for in_progress tasks', async () => {
      const inProgressTask = createMockTask({
        id: 'task-progress',
        status: 'in_progress',
        title: 'In Progress Task',
      });
      const mockTracker = createMockTracker([inProgressTask]);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('task-progress');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prompt).toContain('task-progress');
        expect(result.prompt).toContain('In Progress Task');
      }
    });

    test('returns prompt for completed tasks', async () => {
      // This is the key test case - completed tasks should work
      const completedTask = createMockTask({
        id: 'task-done',
        status: 'completed',
        title: 'Completed Task',
      });
      const mockTracker = createMockTracker([completedTask]);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('task-done');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.prompt).toContain('task-done');
        expect(result.prompt).toContain('Completed Task');
      }
    });

    test('returns error for non-existent task', async () => {
      const mockTracker = createMockTracker([]);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      const result = await engine.generatePromptPreview('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Task not found');
        expect(result.error).toContain('nonexistent');
      }
    });

    test('returns error when no tracker configured', async () => {
      const engine = new ExecutionEngine(createMockConfig());

      // Don't set a tracker - it should be null/undefined

      const result = await engine.generatePromptPreview('any-task');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('No tracker configured');
      }
    });

    test('can generate preview for mixed status tasks', async () => {
      // Verify that the filter includes all three statuses
      const tasks = [
        createMockTask({ id: 'task-1', status: 'open', title: 'Open' }),
        createMockTask({ id: 'task-2', status: 'in_progress', title: 'In Progress' }),
        createMockTask({ id: 'task-3', status: 'completed', title: 'Completed' }),
      ];
      const mockTracker = createMockTracker(tasks);

      const engine = new ExecutionEngine(createMockConfig());

      (engine as unknown as { tracker: TrackerPlugin }).tracker = mockTracker;

      // All three should work
      const result1 = await engine.generatePromptPreview('task-1');
      const result2 = await engine.generatePromptPreview('task-2');
      const result3 = await engine.generatePromptPreview('task-3');

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);
    });
  });
});
