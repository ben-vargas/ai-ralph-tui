/**
 * ABOUTME: Tests for progress file reading utilities.
 * Verifies that progress can be read and codebase patterns can be extracted.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readProgress,
  getRecentProgressSummary,
  clearProgress,
  extractCodebasePatterns,
  getCodebasePatternsForPrompt,
  PROGRESS_FILE,
} from '../../src/logs/progress.js';

describe('progress.ts', () => {
  describe('file operations', () => {
    const testDir = '/tmp/progress-test-' + Date.now();

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    test('readProgress returns empty string for missing file', async () => {
      const content = await readProgress(testDir);
      expect(content).toBe('');
    });

    test('readProgress returns file content', async () => {
      const testContent = '# Test Progress\n\nSome content here.';
      await mkdir(join(testDir, '.ralph-tui'), { recursive: true });
      await writeFile(join(testDir, PROGRESS_FILE), testContent);

      const content = await readProgress(testDir);
      expect(content).toBe(testContent);
    });

    test('clearProgress creates file with default header', async () => {
      await clearProgress(testDir);

      const content = await readProgress(testDir);
      expect(content).toContain('# Ralph Progress Log');
      expect(content).toContain('## Codebase Patterns');
    });

    test('getRecentProgressSummary returns last N entries', async () => {
      // Write a progress file with multiple entries (simulating agent-written progress)
      const progressContent = `# Ralph Progress Log

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

---

## ✓ Iteration 1 - task-1: First task
*2024-01-01T00:00:00Z*
Completed first task.

---

## ✓ Iteration 2 - task-2: Second task
*2024-01-01T00:01:00Z*
Completed second task.

---

## ✓ Iteration 3 - task-3: Third task
*2024-01-01T00:02:00Z*
Completed third task.

---

## ✓ Iteration 4 - task-4: Fourth task
*2024-01-01T00:03:00Z*
Completed fourth task.

---

## ✓ Iteration 5 - task-5: Fifth task
*2024-01-01T00:04:00Z*
Completed fifth task.

---
`;
      await mkdir(join(testDir, '.ralph-tui'), { recursive: true });
      await writeFile(join(testDir, PROGRESS_FILE), progressContent);

      const summary = await getRecentProgressSummary(testDir, 3);

      expect(summary).toContain('Iteration 3');
      expect(summary).toContain('Iteration 4');
      expect(summary).toContain('Iteration 5');
      expect(summary).not.toContain('Iteration 2');
    });

    test('getRecentProgressSummary returns empty for missing file', async () => {
      const summary = await getRecentProgressSummary(testDir, 3);
      expect(summary).toBe('');
    });

    test('extractCodebasePatterns returns empty for default header', async () => {
      await clearProgress(testDir);

      const patterns = await extractCodebasePatterns(testDir);
      expect(patterns).toEqual([]);
    });

    test('extractCodebasePatterns extracts bullet points', async () => {
      const content = `# Ralph Progress Log

## Codebase Patterns (Study These First)

- Always use async/await for file operations
- Follow the ABOUTME comment convention
- Test files go alongside source files

---

## ✓ Iteration 1
`;
      await mkdir(join(testDir, '.ralph-tui'), { recursive: true });
      await writeFile(join(testDir, PROGRESS_FILE), content);

      const patterns = await extractCodebasePatterns(testDir);

      expect(patterns).toContain('Always use async/await for file operations');
      expect(patterns).toContain('Follow the ABOUTME comment convention');
      expect(patterns).toContain('Test files go alongside source files');
    });

    test('extractCodebasePatterns returns empty for missing file', async () => {
      const patterns = await extractCodebasePatterns(testDir);
      expect(patterns).toEqual([]);
    });

    test('getCodebasePatternsForPrompt returns empty for no patterns', async () => {
      await clearProgress(testDir);

      const formatted = await getCodebasePatternsForPrompt(testDir);
      expect(formatted).toBe('');
    });

    test('getCodebasePatternsForPrompt returns formatted markdown', async () => {
      const content = `# Ralph Progress Log

## Codebase Patterns (Study These First)

- Pattern one
- Pattern two

---
`;
      await mkdir(join(testDir, '.ralph-tui'), { recursive: true });
      await writeFile(join(testDir, PROGRESS_FILE), content);

      const formatted = await getCodebasePatternsForPrompt(testDir);

      expect(formatted).toContain('## Codebase Patterns (Study These First)');
      expect(formatted).toContain('- Pattern one');
      expect(formatted).toContain('- Pattern two');
    });
  });
});
