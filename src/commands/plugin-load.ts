/**
 * ABOUTME: Helpers for reporting user plugin loading results.
 * Keeps plugin discovery warnings consistent across commands.
 */

import type { PluginLoadResult } from '../plugins/agents/registry.js';

type InitializePlugins = () => Promise<readonly PluginLoadResult[]>;

function reportPluginLoadFailures(
  results: readonly PluginLoadResult[]
): void {
  for (const result of results) {
    if (!result.success && result.error) {
      console.warn(`  ⚠ ${result.error}`);
    }
  }
}

export async function initializeAndReportPluginLoadFailures(
  initializeAgents: InitializePlugins,
  initializeTrackers: InitializePlugins
): Promise<void> {
  const [agentResults, trackerResults] = await Promise.all([
    initializeAgents(),
    initializeTrackers(),
  ]);
  reportPluginLoadFailures([...agentResults, ...trackerResults]);
}
