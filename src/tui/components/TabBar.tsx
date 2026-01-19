/**
 * ABOUTME: Tab bar component for navigating between local and remote instances.
 * Shows connection status indicators and supports keyboard navigation.
 * First tab is always "Local", remote tabs show alias with status.
 */

import type { ReactNode } from 'react';
import { colors } from '../theme.js';
import type { ConnectionStatus, InstanceTab } from '../../remote/client.js';

/**
 * Props for the TabBar component
 */
export interface TabBarProps {
  /** List of instance tabs (local first, then remotes) */
  tabs: InstanceTab[];

  /** Currently selected tab index */
  selectedIndex: number;

  /** Callback when a tab is selected */
  onSelectTab?: (index: number) => void;

  /** Callback when "+" is clicked to add a new remote */
  onAddRemote?: () => void;
}

/**
 * Connection status indicator symbols
 * - connected: solid circle (green)
 * - connecting: half-filled circle (yellow, animated feel)
 * - disconnected: empty circle (grey)
 */
const STATUS_INDICATORS: Record<ConnectionStatus, string> = {
  connected: '●',
  connecting: '◐',
  disconnected: '○',
};

/**
 * Get color for connection status
 */
function getStatusColor(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return colors.status.success;
    case 'connecting':
      return colors.status.warning;
    case 'disconnected':
      return colors.fg.muted;
  }
}

/**
 * Single tab component
 */
function Tab({
  tab,
  isSelected,
  index,
}: {
  tab: InstanceTab;
  isSelected: boolean;
  index: number;
}): ReactNode {
  const statusIndicator = STATUS_INDICATORS[tab.status];
  const statusColor = getStatusColor(tab.status);

  // Show number key hint (1-9) for quick navigation
  const keyHint = index < 9 ? `${index + 1}` : '';

  // Use visual separator instead of borderRight (not supported)
  const separator = '│';

  // Selected tabs use different styling for emphasis
  const labelColor = isSelected ? colors.fg.primary : colors.fg.secondary;

  return (
    <box
      style={{
        flexDirection: 'row',
        paddingLeft: 1,
        paddingRight: 0,
        backgroundColor: isSelected ? colors.bg.tertiary : colors.bg.secondary,
      }}
    >
      <text>
        {/* Status indicator (skip for local since always connected) */}
        {!tab.isLocal && (
          <span fg={statusColor}>{statusIndicator} </span>
        )}

        {/* Tab label - use uppercase for selected to indicate emphasis */}
        <span fg={labelColor}>
          {isSelected ? tab.label.toUpperCase() : tab.label}
        </span>

        {/* Key hint */}
        {keyHint && (
          <span fg={colors.fg.dim}> [{keyHint}]</span>
        )}

        {/* Separator */}
        <span fg={colors.border.muted}> {separator}</span>
      </text>
    </box>
  );
}

/**
 * Add remote button (subtle "+" affordance)
 */
function AddRemoteButton(): ReactNode {
  return (
    <box
      style={{
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text fg={colors.fg.dim}>+</text>
    </box>
  );
}

/**
 * Tab bar for navigating between instances.
 * Shows tabs at the top of the TUI with connection status.
 *
 * Keybindings (handled by parent):
 * - Number keys (1-9): Jump to tab
 * - Ctrl+Tab / ]: Next tab
 * - Ctrl+Shift+Tab / [: Previous tab
 */
export function TabBar({
  tabs,
  selectedIndex,
}: TabBarProps): ReactNode {
  return (
    <box
      style={{
        width: '100%',
        height: 1,
        flexDirection: 'row',
        backgroundColor: colors.bg.secondary,
      }}
    >
      {/* Tab list */}
      <box
        style={{
          flexDirection: 'row',
          flexGrow: 1,
        }}
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            tab={tab}
            isSelected={index === selectedIndex}
            index={index}
          />
        ))}
      </box>

      {/* Add remote button */}
      <AddRemoteButton />
    </box>
  );
}
