/**
 * ABOUTME: Execution engine for Ralph TUI agent loop.
 * Handles the iteration cycle: select task → inject prompt → run agent → check result → update tracker.
 * Supports configurable error handling strategies: retry, skip, abort.
 */

import type {
  EngineEvent,
  EngineEventListener,
  EngineState,
  EngineStatus,
  EngineSubagentState,
  ErrorHandlingConfig,
  ErrorHandlingStrategy,
  IterationResult,
  IterationStatus,
  SubagentTreeNode,
} from './types.js';
import { toEngineSubagentState } from './types.js';
import type { RalphConfig } from '../config/types.js';
import type { TrackerPlugin, TrackerTask } from '../plugins/trackers/types.js';
import type { AgentPlugin, AgentExecutionHandle } from '../plugins/agents/types.js';
import { getAgentRegistry } from '../plugins/agents/registry.js';
import { getTrackerRegistry } from '../plugins/trackers/registry.js';
import { SubagentTraceParser } from '../plugins/agents/tracing/parser.js';
import type { SubagentEvent } from '../plugins/agents/tracing/types.js';
import { ClaudeAgentPlugin } from '../plugins/agents/builtin/claude.js';
import { updateSessionIteration, updateSessionStatus } from '../session/index.js';
import { saveIterationLog } from '../logs/index.js';
import { renderPrompt } from '../templates/index.js';

/**
 * Pattern to detect completion signal in agent output
 */
const PROMISE_COMPLETE_PATTERN = /<promise>\s*COMPLETE\s*<\/promise>/i;

/**
 * Build prompt for the agent based on task using the template system.
 * Falls back to a hardcoded default if template rendering fails.
 */
function buildPrompt(task: TrackerTask, config: RalphConfig): string {
  // Use the template system
  const result = renderPrompt(task, config);

  if (result.success && result.prompt) {
    return result.prompt;
  }

  // Log template error and fall back to simple format
  console.error(`Template rendering failed: ${result.error}`);

  // Fallback prompt
  const lines: string[] = [];
  lines.push('## Task');
  lines.push(`**ID**: ${task.id}`);
  lines.push(`**Title**: ${task.title}`);

  if (task.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(task.description);
  }

  lines.push('');
  lines.push('## Instructions');
  lines.push('Complete the task described above. When finished, signal completion with:');
  lines.push('<promise>COMPLETE</promise>');

  return lines.join('\n');
}

/**
 * Execution engine for the agent loop
 */
export class ExecutionEngine {
  private config: RalphConfig;
  private agent: AgentPlugin | null = null;
  private tracker: TrackerPlugin | null = null;
  private listeners: EngineEventListener[] = [];
  private state: EngineState;
  private currentExecution: AgentExecutionHandle | null = null;
  private shouldStop = false;
  /** Track retry attempts per task */
  private retryCountMap: Map<string, number> = new Map();
  /** Track skipped tasks to avoid retrying them */
  private skippedTasks: Set<string> = new Set();
  /** Parser for extracting subagent lifecycle events from agent output */
  private subagentParser: SubagentTraceParser;

  constructor(config: RalphConfig) {
    this.config = config;
    this.state = {
      status: 'idle',
      currentIteration: 0,
      currentTask: null,
      totalTasks: 0,
      tasksCompleted: 0,
      iterations: [],
      startedAt: null,
      currentOutput: '',
      currentStderr: '',
      subagents: new Map(),
    };

    // Initialize subagent parser with event handler
    this.subagentParser = new SubagentTraceParser({
      onEvent: (event) => this.handleSubagentEvent(event),
      trackHierarchy: true,
    });
  }

  /**
   * Initialize the engine with plugins
   */
  async initialize(): Promise<void> {
    // Get agent instance
    const agentRegistry = getAgentRegistry();
    this.agent = await agentRegistry.getInstance(this.config.agent);

    // Detect agent availability
    const detectResult = await this.agent.detect();
    if (!detectResult.available) {
      throw new Error(
        `Agent '${this.config.agent.plugin}' not available: ${detectResult.error}`
      );
    }

    // Get tracker instance
    const trackerRegistry = getTrackerRegistry();
    this.tracker = await trackerRegistry.getInstance(this.config.tracker);

    // Sync tracker
    await this.tracker.sync();

    // Get initial task count
    const tasks = await this.tracker.getTasks({ status: ['open', 'in_progress'] });
    this.state.totalTasks = tasks.length;
  }

  /**
   * Add event listener
   */
  on(listener: EngineEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Get current engine state
   */
  getState(): Readonly<EngineState> {
    return { ...this.state };
  }

  /**
   * Get current status
   */
  getStatus(): EngineStatus {
    return this.state.status;
  }

  /**
   * Refresh the task list from the tracker and emit a tasks:refreshed event.
   * Call this when the user wants to manually refresh the task list (e.g., 'r' key).
   */
  async refreshTasks(): Promise<void> {
    if (!this.tracker) {
      return;
    }

    // Fetch all tasks including completed for TUI display
    const tasks = await this.tracker.getTasks({
      status: ['open', 'in_progress', 'completed'],
    });

    // Update total task count (open/in_progress only)
    const activeTasks = tasks.filter(
      (t) => t.status === 'open' || t.status === 'in_progress'
    );
    this.state.totalTasks = activeTasks.length;

    this.emit({
      type: 'tasks:refreshed',
      timestamp: new Date().toISOString(),
      tasks,
    });
  }

  /**
   * Start the execution loop
   */
  async start(): Promise<void> {
    if (this.state.status !== 'idle') {
      throw new Error(`Cannot start engine in ${this.state.status} state`);
    }

    if (!this.agent || !this.tracker) {
      throw new Error('Engine not initialized');
    }

    this.state.status = 'running';
    this.state.startedAt = new Date().toISOString();
    this.shouldStop = false;

    // Fetch all tasks including completed for TUI display
    // Open/in_progress tasks are actionable; completed tasks are for historical view
    const initialTasks = await this.tracker.getTasks({
      status: ['open', 'in_progress', 'completed'],
    });

    this.emit({
      type: 'engine:started',
      timestamp: new Date().toISOString(),
      sessionId: '',
      totalTasks: this.state.totalTasks, // Only counts open/in_progress
      tasks: initialTasks,
    });

    try {
      await this.runLoop();
    } finally {
      this.state.status = 'idle';
    }
  }

  /**
   * Main execution loop
   */
  private async runLoop(): Promise<void> {
    while (!this.shouldStop) {
      // Check if pausing - if so, transition to paused and wait
      if (this.state.status === 'pausing') {
        this.state.status = 'paused';
        this.emit({
          type: 'engine:paused',
          timestamp: new Date().toISOString(),
          currentIteration: this.state.currentIteration,
        });

        // Wait until resumed
        while (this.state.status === 'paused' && !this.shouldStop) {
          await this.delay(100); // Poll every 100ms
        }

        // If we were stopped while paused, exit the loop
        if (this.shouldStop) {
          break;
        }

        // Emit resumed event and continue
        this.emit({
          type: 'engine:resumed',
          timestamp: new Date().toISOString(),
          fromIteration: this.state.currentIteration,
        });
      }

      // Check max iterations
      if (
        this.config.maxIterations > 0 &&
        this.state.currentIteration >= this.config.maxIterations
      ) {
        this.emit({
          type: 'engine:stopped',
          timestamp: new Date().toISOString(),
          reason: 'max_iterations',
          totalIterations: this.state.currentIteration,
          tasksCompleted: this.state.tasksCompleted,
        });
        break;
      }

      // Check if all tasks complete
      const isComplete = await this.tracker!.isComplete();
      if (isComplete) {
        this.emit({
          type: 'all:complete',
          timestamp: new Date().toISOString(),
          totalCompleted: this.state.tasksCompleted,
          totalIterations: this.state.currentIteration,
        });
        this.emit({
          type: 'engine:stopped',
          timestamp: new Date().toISOString(),
          reason: 'completed',
          totalIterations: this.state.currentIteration,
          tasksCompleted: this.state.tasksCompleted,
        });
        break;
      }

      // Get next task (excluding skipped tasks)
      const task = await this.getNextAvailableTask();
      if (!task) {
        this.emit({
          type: 'engine:stopped',
          timestamp: new Date().toISOString(),
          reason: 'no_tasks',
          totalIterations: this.state.currentIteration,
          tasksCompleted: this.state.tasksCompleted,
        });
        break;
      }

      // Run iteration with error handling
      const result = await this.runIterationWithErrorHandling(task);

      // Check if we should abort
      if (result.status === 'failed' && this.config.errorHandling.strategy === 'abort') {
        this.emit({
          type: 'engine:stopped',
          timestamp: new Date().toISOString(),
          reason: 'error',
          totalIterations: this.state.currentIteration,
          tasksCompleted: this.state.tasksCompleted,
        });
        break;
      }

      // Update session
      await updateSessionIteration(
        this.config.cwd,
        this.state.currentIteration,
        this.state.tasksCompleted
      );

      // Wait between iterations
      if (this.config.iterationDelay > 0 && !this.shouldStop) {
        await this.delay(this.config.iterationDelay);
      }
    }
  }

  /**
   * Get the next available task, excluding skipped ones
   */
  private async getNextAvailableTask(): Promise<TrackerTask | null> {
    const tasks = await this.tracker!.getTasks({ status: ['open', 'in_progress'] });

    for (const task of tasks) {
      // Skip tasks that have been marked as skipped
      if (this.skippedTasks.has(task.id)) {
        continue;
      }

      // Check if task is ready (no unresolved dependencies)
      const isReady = await this.tracker!.isTaskReady(task.id);
      if (isReady) {
        return task;
      }
    }

    return null;
  }

  /**
   * Run iteration with error handling strategy
   */
  private async runIterationWithErrorHandling(task: TrackerTask): Promise<IterationResult> {
    const errorConfig = this.config.errorHandling;
    let result = await this.runIteration(task);
    this.state.iterations.push(result);

    // Handle success
    if (result.status !== 'failed') {
      if (result.taskCompleted) {
        this.state.tasksCompleted++;
        // Clear retry count on success
        this.retryCountMap.delete(task.id);
      }
      return result;
    }

    // Handle failure according to strategy
    const errorMessage = result.error ?? 'Unknown error';

    switch (errorConfig.strategy) {
      case 'retry': {
        const currentRetries = this.retryCountMap.get(task.id) ?? 0;

        if (currentRetries < errorConfig.maxRetries) {
          // Emit failed event with retry action
          this.emit({
            type: 'iteration:failed',
            timestamp: new Date().toISOString(),
            iteration: this.state.currentIteration,
            error: errorMessage,
            task,
            action: 'retry',
          });

          // Emit retry event
          this.emit({
            type: 'iteration:retrying',
            timestamp: new Date().toISOString(),
            iteration: this.state.currentIteration,
            retryAttempt: currentRetries + 1,
            maxRetries: errorConfig.maxRetries,
            task,
            previousError: errorMessage,
            delayMs: errorConfig.retryDelayMs,
          });

          // Update retry count
          this.retryCountMap.set(task.id, currentRetries + 1);

          // Wait before retry
          if (errorConfig.retryDelayMs > 0 && !this.shouldStop) {
            await this.delay(errorConfig.retryDelayMs);
          }

          // Recursively retry
          if (!this.shouldStop) {
            return this.runIterationWithErrorHandling(task);
          }
        } else {
          // Max retries exceeded - treat as skip
          const skipReason = `Max retries (${errorConfig.maxRetries}) exceeded: ${errorMessage}`;
          this.emit({
            type: 'iteration:failed',
            timestamp: new Date().toISOString(),
            iteration: this.state.currentIteration,
            error: skipReason,
            task,
            action: 'skip',
          });
          this.emitSkipEvent(task, skipReason);
          this.skippedTasks.add(task.id);
          this.retryCountMap.delete(task.id);
        }
        break;
      }

      case 'skip': {
        // Emit failed event with skip action
        this.emit({
          type: 'iteration:failed',
          timestamp: new Date().toISOString(),
          iteration: this.state.currentIteration,
          error: errorMessage,
          task,
          action: 'skip',
        });
        this.emitSkipEvent(task, errorMessage);
        this.skippedTasks.add(task.id);
        break;
      }

      case 'abort': {
        // Emit failed event with abort action
        this.emit({
          type: 'iteration:failed',
          timestamp: new Date().toISOString(),
          iteration: this.state.currentIteration,
          error: errorMessage,
          task,
          action: 'abort',
        });
        break;
      }
    }

    return result;
  }

  /**
   * Emit a skip event for a task
   */
  private emitSkipEvent(task: TrackerTask, reason: string): void {
    this.emit({
      type: 'iteration:skipped',
      timestamp: new Date().toISOString(),
      iteration: this.state.currentIteration,
      task,
      reason,
    });
  }

  /**
   * Run a single iteration
   */
  private async runIteration(task: TrackerTask): Promise<IterationResult> {
    this.state.currentIteration++;
    this.state.currentTask = task;
    this.state.currentOutput = '';
    this.state.currentStderr = '';

    // Reset subagent tracking for this iteration
    this.state.subagents.clear();
    this.subagentParser.reset();

    const startedAt = new Date();
    const iteration = this.state.currentIteration;

    this.emit({
      type: 'iteration:started',
      timestamp: startedAt.toISOString(),
      iteration,
      task,
    });

    this.emit({
      type: 'task:selected',
      timestamp: new Date().toISOString(),
      task,
      iteration,
    });

    // Update task status to in_progress
    await this.tracker!.updateTaskStatus(task.id, 'in_progress');

    // Emit task:activated for crash recovery tracking
    // This allows the session to track which tasks it "owns" for reset on shutdown
    this.emit({
      type: 'task:activated',
      timestamp: new Date().toISOString(),
      task,
      iteration,
    });

    // Build prompt
    const prompt = buildPrompt(task, this.config);

    // Build agent flags
    const flags: string[] = [];
    if (this.config.model) {
      flags.push('--model', this.config.model);
    }

    // Check if agent supports subagent tracing
    const supportsTracing = this.agent!.meta.supportsSubagentTracing;

    // Create streaming JSONL parser if tracing is enabled
    const jsonlParser = supportsTracing
      ? ClaudeAgentPlugin.createStreamingJsonlParser()
      : null;

    try {
      // Execute agent with subagent tracing if supported
      const handle = this.agent!.execute(prompt, [], {
        cwd: this.config.cwd,
        flags,
        subagentTracing: supportsTracing,
        onStdout: (data) => {
          this.state.currentOutput += data;
          this.emit({
            type: 'agent:output',
            timestamp: new Date().toISOString(),
            stream: 'stdout',
            data,
            iteration,
          });

          // Parse JSONL output for subagent events if tracing is enabled
          if (jsonlParser) {
            const results = jsonlParser.push(data);
            for (const result of results) {
              if (result.success) {
                this.subagentParser.processMessage(result.message);
              }
            }
          }
        },
        onStderr: (data) => {
          this.state.currentStderr += data;
          this.emit({
            type: 'agent:output',
            timestamp: new Date().toISOString(),
            stream: 'stderr',
            data,
            iteration,
          });
        },
      });

      this.currentExecution = handle;

      // Wait for completion
      const agentResult = await handle.promise;
      this.currentExecution = null;

      // Flush any remaining buffered JSONL data
      if (jsonlParser) {
        const remaining = jsonlParser.flush();
        for (const result of remaining) {
          if (result.success) {
            this.subagentParser.processMessage(result.message);
          }
        }
      }

      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();

      // Check for completion signal
      const promiseComplete = PROMISE_COMPLETE_PATTERN.test(agentResult.stdout);

      // Determine if task was completed
      const taskCompleted =
        promiseComplete || agentResult.status === 'completed';

      // Update tracker if task completed
      if (taskCompleted) {
        await this.tracker!.completeTask(task.id, 'Completed by agent');
        this.emit({
          type: 'task:completed',
          timestamp: new Date().toISOString(),
          task,
          iteration,
        });
      }

      // Determine iteration status
      let status: IterationStatus;
      if (agentResult.interrupted) {
        status = 'interrupted';
      } else if (agentResult.status === 'failed') {
        status = 'failed';
      } else {
        status = 'completed';
      }

      const result: IterationResult = {
        iteration,
        status,
        task,
        agentResult,
        taskCompleted,
        promiseComplete,
        durationMs,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      };

      // Save iteration output to .ralph-tui/iterations/ directory
      await saveIterationLog(
        this.config.cwd,
        result,
        agentResult.stdout,
        agentResult.stderr ?? this.state.currentStderr,
        this.config
      );

      this.emit({
        type: 'iteration:completed',
        timestamp: endedAt.toISOString(),
        result,
      });

      return result;
    } catch (error) {
      const endedAt = new Date();
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Note: We don't emit iteration:failed here anymore - it's handled
      // by runIterationWithErrorHandling which determines the action.
      // This keeps the error handling logic centralized.

      return {
        iteration,
        status: 'failed',
        task,
        taskCompleted: false,
        promiseComplete: false,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        error: errorMessage,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      };
    } finally {
      this.state.currentTask = null;
    }
  }

  /**
   * Stop the execution loop
   */
  async stop(): Promise<void> {
    this.shouldStop = true;
    this.state.status = 'stopping';

    // Interrupt current execution if any
    if (this.currentExecution) {
      this.currentExecution.interrupt();
    }

    // Update session status
    await updateSessionStatus(this.config.cwd, 'interrupted');

    this.emit({
      type: 'engine:stopped',
      timestamp: new Date().toISOString(),
      reason: 'interrupted',
      totalIterations: this.state.currentIteration,
      tasksCompleted: this.state.tasksCompleted,
    });
  }

  /**
   * Request to pause the execution loop after the current iteration completes.
   * If already pausing or paused, this is a no-op.
   */
  pause(): void {
    if (this.state.status !== 'running') {
      return;
    }

    // Set to 'pausing' - the loop will transition to 'paused' after the current iteration
    this.state.status = 'pausing';
    // Note: We don't emit engine:paused here. That happens in runLoop when we actually pause.
  }

  /**
   * Resume the execution loop from a paused state.
   * This can also be used to cancel a pending pause (when status is 'pausing').
   */
  resume(): void {
    if (this.state.status === 'pausing') {
      // Cancel the pending pause - just go back to running
      this.state.status = 'running';
      return;
    }

    if (this.state.status !== 'paused') {
      return;
    }

    // Resume from paused state - the runLoop will detect this and continue
    this.state.status = 'running';
    // Note: engine:resumed event is emitted in runLoop when we actually resume
  }

  /**
   * Check if the engine is pausing or paused
   */
  isPaused(): boolean {
    return this.state.status === 'paused';
  }

  /**
   * Check if the engine is in the process of pausing
   */
  isPausing(): boolean {
    return this.state.status === 'pausing';
  }

  /**
   * Delay for specified milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Reset specific task IDs back to open status.
   * Used during graceful shutdown to release tasks that were set to in_progress
   * by this session but not completed.
   *
   * @param taskIds - Array of task IDs to reset to open
   * @returns Number of tasks successfully reset
   */
  async resetTasksToOpen(taskIds: string[]): Promise<number> {
    if (!this.tracker || taskIds.length === 0) {
      return 0;
    }

    let resetCount = 0;
    for (const taskId of taskIds) {
      try {
        await this.tracker.updateTaskStatus(taskId, 'open');
        resetCount++;
      } catch {
        // Silently continue on individual task reset failures
        // The task may have been deleted or modified externally
      }
    }

    return resetCount;
  }

  /**
   * Get the tracker instance for external operations.
   * Used by the run command for stale task detection and reset.
   */
  getTracker(): TrackerPlugin | null {
    return this.tracker;
  }

  /**
   * Handle a subagent event from the parser and update engine state.
   */
  private handleSubagentEvent(event: SubagentEvent): void {
    const parserState = this.subagentParser.getSubagent(event.id);
    if (!parserState) {
      return;
    }

    // Calculate depth for this subagent
    const depth = this.calculateSubagentDepth(event.id);

    // Convert to engine state format and update map
    const engineState = toEngineSubagentState(parserState, depth);
    this.state.subagents.set(event.id, engineState);
  }

  /**
   * Calculate the nesting depth for a subagent.
   * Top-level subagents have depth 1, their children have depth 2, etc.
   */
  private calculateSubagentDepth(subagentId: string): number {
    let depth = 1;
    let current = this.subagentParser.getSubagent(subagentId);

    while (current?.parentId) {
      depth++;
      current = this.subagentParser.getSubagent(current.parentId);
    }

    return depth;
  }

  /**
   * Get the subagent tree for TUI rendering.
   * Returns an array of root-level subagent tree nodes with their children nested.
   */
  getSubagentTree(): SubagentTreeNode[] {
    const roots: SubagentTreeNode[] = [];
    const nodeMap = new Map<string, SubagentTreeNode>();

    // First pass: create nodes for all subagents
    for (const state of this.state.subagents.values()) {
      nodeMap.set(state.id, {
        state,
        children: [],
      });
    }

    // Second pass: build the tree structure
    for (const state of this.state.subagents.values()) {
      const node = nodeMap.get(state.id)!;

      if (state.parentId && nodeMap.has(state.parentId)) {
        // Add as child of parent
        const parentNode = nodeMap.get(state.parentId)!;
        parentNode.children.push(node);
      } else {
        // This is a root node
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * Dispose of engine resources
   */
  async dispose(): Promise<void> {
    await this.stop();
    this.listeners = [];
  }
}

// Re-export types
export type {
  EngineEvent,
  EngineEventListener,
  EngineState,
  EngineStatus,
  EngineSubagentState,
  ErrorHandlingConfig,
  ErrorHandlingStrategy,
  IterationResult,
  IterationStatus,
  SubagentTreeNode,
};
