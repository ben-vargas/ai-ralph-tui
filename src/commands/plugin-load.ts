/**
 * ABOUTME: Helpers for reporting user plugin loading results.
 * Keeps plugin discovery warnings consistent across commands.
 */

export interface PluginLoadResult {
  success: boolean;
  error?: string;
}

type InitializePlugins = () => Promise<readonly PluginLoadResult[]>;

export function reportPluginLoadFailures(
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
