/**
 * ABOUTME: JSON tracker plugin for prd.json task files.
 * The default tracker plugin that reads tasks from a local JSON file.
 * Implements full CRUD operations for file-based task tracking with the prd.json format.
 */

import { readFile, writeFile, access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BaseTrackerPlugin } from '../base.js';
import type {
  TrackerPluginMeta,
  TrackerPluginFactory,
  TrackerTask,
  TrackerTaskStatus,
  TaskPriority,
  TaskFilter,
  TaskCompletionResult,
  SetupQuestion,
} from '../types.js';

/**
 * Structure of a user story in prd.json format.
 * This matches the format specified in the PRD.
 */
interface PrdUserStory {
  /** Unique story identifier (e.g., "US-001") */
  id: string;

  /** Short title of the user story */
  title: string;

  /** Full description of the user story */
  description?: string;

  /** List of acceptance criteria */
  acceptanceCriteria?: string[];

  /** Priority level (lower = higher priority, 1-based) */
  priority?: number;

  /** Whether the story has passed/completed */
  passes: boolean;

  /** Labels or tags */
  labels?: string[];

  /** Dependencies - story IDs this story depends on */
  dependsOn?: string[];

  /** Optional notes for when the story was completed */
  completionNotes?: string;
}

/**
 * Root structure of a prd.json file.
 */
interface PrdJson {
  /** Name of the project or feature */
  name: string;

  /** Project/feature description */
  description?: string;

  /** Git branch name for this work */
  branchName?: string;

  /** List of user stories */
  userStories: PrdUserStory[];

  /** Optional metadata */
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    version?: string;
  };
}

/**
 * Convert a prd.json priority (1-based) to TaskPriority (0-4).
 * Priority 1 = P1 = highest (maps to 1)
 * Unmapped priorities clamped to 0-4 range.
 */
function mapPriority(prdPriority?: number): TaskPriority {
  if (prdPriority === undefined) {
    return 2; // Default to medium priority
  }
  // PRD priorities are 1-based, TaskPriority is 0-4
  // Map: 1 -> 1, 2 -> 2, 3 -> 3, 4 -> 4, 5+ -> 4
  const clamped = Math.max(0, Math.min(4, prdPriority - 1));
  return clamped as TaskPriority;
}

/**
 * Convert passes boolean to TrackerTaskStatus.
 */
function mapStatus(passes: boolean): TrackerTaskStatus {
  return passes ? 'completed' : 'open';
}

/**
 * Convert TrackerTaskStatus back to passes boolean.
 */
function statusToPasses(status: TrackerTaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * Convert a PrdUserStory to TrackerTask.
 */
function storyToTask(story: PrdUserStory, parentName?: string): TrackerTask {
  return {
    id: story.id,
    title: story.title,
    status: mapStatus(story.passes),
    priority: mapPriority(story.priority),
    description: story.description,
    labels: story.labels,
    type: 'story',
    parentId: parentName,
    dependsOn: story.dependsOn,
    metadata: {
      acceptanceCriteria: story.acceptanceCriteria,
      completionNotes: story.completionNotes,
    },
  };
}

/**
 * JSON tracker plugin implementation.
 * Reads and writes tasks from a local prd.json file.
 */
export class JsonTrackerPlugin extends BaseTrackerPlugin {
  readonly meta: TrackerPluginMeta = {
    id: 'json',
    name: 'JSON File Tracker',
    description: 'Track tasks in a local prd.json file',
    version: '1.0.0',
    supportsBidirectionalSync: false,
    supportsHierarchy: true,
    supportsDependencies: true,
  };

  private filePath: string = '';
  private branchName: string = '';
  private prdCache: PrdJson | null = null;
  private cacheTime: number = 0;
  private readonly CACHE_TTL_MS = 1000; // 1 second cache TTL

  override async initialize(config: Record<string, unknown>): Promise<void> {
    await super.initialize(config);

    if (typeof config.path === 'string') {
      this.filePath = resolve(config.path);
    }

    if (typeof config.branchName === 'string') {
      this.branchName = config.branchName;
    }

    // Check if file exists and is readable
    if (this.filePath) {
      try {
        await access(this.filePath, constants.R_OK | constants.W_OK);
        this.ready = true;
      } catch {
        this.ready = false;
      }
    }
  }

  override async isReady(): Promise<boolean> {
    if (!this.filePath) {
      return false;
    }

    try {
      await access(this.filePath, constants.R_OK | constants.W_OK);
      this.ready = true;
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  getSetupQuestions(): SetupQuestion[] {
    return [
      {
        id: 'path',
        prompt: 'Path to prd.json file:',
        type: 'path',
        default: './prd.json',
        required: true,
        help: 'The JSON file containing your task definitions',
      },
      {
        id: 'branchName',
        prompt: 'Git branch name for this work:',
        type: 'text',
        default: '',
        required: false,
        help: 'The git branch to use for this work (optional)',
      },
    ];
  }

  override async validateSetup(
    answers: Record<string, unknown>
  ): Promise<string | null> {
    if (!answers.path || typeof answers.path !== 'string') {
      return 'File path is required';
    }

    const resolvedPath = resolve(answers.path as string);

    // Check if file exists
    try {
      await access(resolvedPath, constants.R_OK);
    } catch {
      return `File not found or not readable: ${resolvedPath}`;
    }

    // Try to parse it
    try {
      const content = await readFile(resolvedPath, 'utf-8');
      const prd = JSON.parse(content) as PrdJson;

      if (!prd.userStories || !Array.isArray(prd.userStories)) {
        return 'Invalid prd.json: missing userStories array';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Failed to parse prd.json: ${message}`;
    }

    return null;
  }

  /**
   * Read and parse the prd.json file with caching.
   */
  private async readPrd(): Promise<PrdJson> {
    const now = Date.now();

    // Return cached version if still valid
    if (this.prdCache && now - this.cacheTime < this.CACHE_TTL_MS) {
      return this.prdCache;
    }

    const content = await readFile(this.filePath, 'utf-8');
    this.prdCache = JSON.parse(content) as PrdJson;
    this.cacheTime = now;

    return this.prdCache;
  }

  /**
   * Write the prd.json file and update the cache.
   */
  private async writePrd(prd: PrdJson): Promise<void> {
    // Update the metadata timestamp
    if (!prd.metadata) {
      prd.metadata = {};
    }
    prd.metadata.updatedAt = new Date().toISOString();

    // Write with pretty formatting for human readability
    const content = JSON.stringify(prd, null, 2);
    await writeFile(this.filePath, content, 'utf-8');

    // Update cache
    this.prdCache = prd;
    this.cacheTime = Date.now();
  }

  async getTasks(filter?: TaskFilter): Promise<TrackerTask[]> {
    if (!this.filePath) {
      return [];
    }

    try {
      const prd = await this.readPrd();
      const tasks = prd.userStories.map((story) =>
        storyToTask(story, prd.name)
      );

      // Apply filtering from base class
      return this.filterTasks(tasks, filter);
    } catch (err) {
      console.error('Failed to read prd.json:', err);
      return [];
    }
  }

  override async getTask(id: string): Promise<TrackerTask | undefined> {
    const tasks = await this.getTasks();
    return tasks.find((t) => t.id === id);
  }

  /**
   * Get the next task to work on.
   * Selects the highest priority task where passes: false.
   */
  override async getNextTask(
    filter?: TaskFilter
  ): Promise<TrackerTask | undefined> {
    // Get open tasks that are ready (no unresolved dependencies)
    const tasks = await this.getTasks({
      ...filter,
      status: 'open',
      ready: true,
    });

    if (tasks.length === 0) {
      return undefined;
    }

    // Sort by priority (lower number = higher priority)
    tasks.sort((a, b) => a.priority - b.priority);

    return tasks[0];
  }

  async completeTask(
    id: string,
    reason?: string
  ): Promise<TaskCompletionResult> {
    try {
      const prd = await this.readPrd();
      const storyIndex = prd.userStories.findIndex((s) => s.id === id);

      if (storyIndex === -1) {
        return {
          success: false,
          message: `Task ${id} not found`,
          error: 'Task not found in prd.json',
        };
      }

      // Update the story
      const story = prd.userStories[storyIndex];
      if (!story) {
        return {
          success: false,
          message: `Task ${id} not found`,
          error: 'Task not found in prd.json',
        };
      }

      story.passes = true;
      if (reason) {
        story.completionNotes = reason;
      }

      // Write back to file
      await this.writePrd(prd);

      return {
        success: true,
        message: `Task ${id} marked as complete`,
        task: storyToTask(story, prd.name),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to complete task ${id}`,
        error: message,
      };
    }
  }

  async updateTaskStatus(
    id: string,
    status: TrackerTaskStatus
  ): Promise<TrackerTask | undefined> {
    try {
      const prd = await this.readPrd();
      const storyIndex = prd.userStories.findIndex((s) => s.id === id);

      if (storyIndex === -1) {
        return undefined;
      }

      const story = prd.userStories[storyIndex];
      if (!story) {
        return undefined;
      }

      // Update the passes field based on status
      story.passes = statusToPasses(status);

      // Write back to file
      await this.writePrd(prd);

      return storyToTask(story, prd.name);
    } catch (err) {
      console.error(`Failed to update task ${id} status:`, err);
      return undefined;
    }
  }

  /**
   * Check if all user stories have passes: true.
   */
  override async isComplete(filter?: TaskFilter): Promise<boolean> {
    const tasks = await this.getTasks(filter);
    return tasks.every(
      (t) => t.status === 'completed' || t.status === 'cancelled'
    );
  }

  /**
   * Get the branch name configured for this tracker.
   */
  getBranchName(): string {
    return this.branchName || this.prdCache?.branchName || '';
  }
}

/**
 * Factory function for the JSON tracker plugin.
 */
const createJsonTracker: TrackerPluginFactory = () => new JsonTrackerPlugin();

export default createJsonTracker;
