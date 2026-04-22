/**
 * ABOUTME: Tests for template engine tracker-type resolution and Jira template lookup.
 * Verifies Jira is treated as a first-class built-in template type for project overrides.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinTemplate, getTemplateTypeFromPlugin, loadTemplate } from './engine.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('template engine Jira support', () => {
  test('maps jira plugin names to the jira template type', () => {
    expect(getTemplateTypeFromPlugin('jira')).toBe('jira');
  });

  test('loads a project jira.hbs override before the tracker template fallback', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ralph-jira-template-'));
    const templatesDir = join(tempDir, '.ralph-tui', 'templates');
    const projectTemplate = join(templatesDir, 'jira.hbs');

    await mkdir(templatesDir, { recursive: true });
    await writeFile(projectTemplate, 'PROJECT JIRA TEMPLATE', 'utf-8');

    const result = loadTemplate(undefined, 'jira', tempDir, 'TRACKER TEMPLATE');

    expect(result.success).toBe(true);
    expect(result.content).toBe('PROJECT JIRA TEMPLATE');
    expect(result.source).toBe(`project:${projectTemplate}`);
  });

  test('returns the built-in Jira template for jira tracker type', () => {
    const template = getBuiltinTemplate('jira');
    expect(template).toContain('{{taskId}}');
    expect(template).toContain('## Workflow');
  });
});
