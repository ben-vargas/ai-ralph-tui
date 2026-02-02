/**
 * ABOUTME: Epic loader overlay component for switching epics mid-session.
 * Provides an in-TUI modal for selecting a different epic without restarting.
 * Supports both beads-style epic selection (list) and json-style (file path prompt).
 */

import type { ReactNode } from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useKeyboard } from '@opentui/react';
import { relative } from 'node:path';
import { colors, statusIndicators } from '../theme.js';
import type { TrackerTask } from '../../plugins/trackers/types.js';
import { findFiles } from '../../utils/files.js';
import { fuzzySearch } from '../../utils/fuzzy-search.js';

/**
 * Mode for the epic loader overlay
 */
export type EpicLoaderMode = 'list' | 'file-prompt';

/**
 * Props for the EpicLoaderOverlay component
 */
export interface EpicLoaderOverlayProps {
  /** Whether the overlay is visible */
  visible: boolean;

  /** Mode: 'list' for beads-style selection, 'file-prompt' for json-style */
  mode: EpicLoaderMode;

  /** Available epics (for list mode) */
  epics: TrackerTask[];

  /** Whether epics are loading */
  loading: boolean;

  /** Error message if loading failed */
  error?: string;

  /** Tracker name for display */
  trackerName: string;

  /** Current epic ID (for highlighting) */
  currentEpicId?: string;

  /** Callback when an epic is selected */
  onSelect: (epic: TrackerTask) => void;

  /** Callback when user cancels (Escape) */
  onCancel: () => void;

  /** Callback when file path is submitted (file-prompt mode) */
  onFilePath?: (path: string) => void;
}

/**
 * Truncate text to fit within a given width
 */
function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }
  return text.slice(0, maxWidth - 1) + '…';
}

/**
 * Get a status color for an epic based on its completion status
 */
function getEpicStatusColor(epic: TrackerTask): string {
  const meta = epic.metadata as Record<string, unknown> | undefined;
  if (meta) {
    const storyCount = meta.storyCount as number | undefined;
    const completedCount = meta.completedCount as number | undefined;
    if (storyCount !== undefined && completedCount !== undefined) {
      if (completedCount >= storyCount) {
        return colors.status.success;
      }
      if (completedCount > 0) {
        return colors.status.warning;
      }
    }
  }

  switch (epic.status) {
    case 'completed':
      return colors.status.success;
    case 'in_progress':
      return colors.status.info;
    default:
      return colors.fg.primary;
  }
}

/** Directories to exclude from JSON file search */
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'];

/** Maximum number of file suggestions to display */
const MAX_SUGGESTIONS = 8;

/**
 * Modal overlay for loading/switching epics during a TUI session.
 * Supports two modes:
 * - 'list': Display a list of available epics for selection (beads/beads-bv)
 * - 'file-prompt': Prompt user to enter a file path (json tracker)
 */
export function EpicLoaderOverlay({
  visible,
  mode,
  epics,
  loading,
  error,
  trackerName,
  currentEpicId,
  onSelect,
  onCancel,
  onFilePath,
}: EpicLoaderOverlayProps): ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filePath, setFilePath] = useState('');

  // File suggestion state (for file-prompt mode)
  const [jsonFiles, setJsonFiles] = useState<string[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);

  // Get current working directory for relative paths
  const cwd = process.cwd();

  // Compute filtered file suggestions based on current input
  const filteredFiles = useMemo(() => {
    if (jsonFiles.length === 0) return [];
    // Convert to relative paths for display and matching
    const relativePaths = jsonFiles.map((f) => {
      const rel = relative(cwd, f);
      return rel.startsWith('.') ? rel : './' + rel;
    });
    return fuzzySearch(relativePaths, filePath, MAX_SUGGESTIONS).map((m) => m.item);
  }, [jsonFiles, filePath, cwd]);

  // Reset state when overlay becomes visible
  useEffect(() => {
    if (visible) {
      // Find the currently selected epic in the list
      const currentIndex = epics.findIndex((e) => e.id === currentEpicId);
      setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
      setFilePath('');
      setSelectedFileIndex(0);
    }
  }, [visible, epics, currentEpicId]);

  // Discover JSON files when overlay becomes visible in file-prompt mode
  useEffect(() => {
    if (visible && mode === 'file-prompt' && jsonFiles.length === 0 && !filesLoading) {
      setFilesLoading(true);
      findFiles(cwd, {
        extension: '.json',
        recursive: true,
        maxDepth: 5,
      })
        .then((files) => {
          // Filter out excluded directories
          const filtered = files.filter((f) => {
            const relPath = relative(cwd, f);
            return !EXCLUDED_DIRS.some((dir) => relPath.startsWith(dir + '/') || relPath.startsWith(dir + '\\'));
          });
          setJsonFiles(filtered);
        })
        .catch(() => {
          // Silently fail - file suggestions are optional
        })
        .finally(() => {
          setFilesLoading(false);
        });
    }
  }, [visible, mode, jsonFiles.length, filesLoading, cwd]);

  // Reset file selection when filtered results change
  useEffect(() => {
    setSelectedFileIndex(0);
  }, [filteredFiles.length]);

  // Handle keyboard input
  const handleKeyboard = useCallback(
    (key: { name: string; sequence?: string }) => {
      if (!visible) return;

      if (mode === 'list') {
        switch (key.name) {
          case 'escape':
            onCancel();
            break;

          case 'up':
          case 'k':
            setSelectedIndex((prev) => Math.max(0, prev - 1));
            break;

          case 'down':
          case 'j':
            setSelectedIndex((prev) => Math.min(epics.length - 1, prev + 1));
            break;

          case 'return':
          case 'enter':
            if (epics.length > 0 && epics[selectedIndex]) {
              onSelect(epics[selectedIndex]);
            }
            break;
        }
      } else if (mode === 'file-prompt') {
        switch (key.name) {
          case 'escape':
            onCancel();
            break;

          case 'return':
          case 'enter':
            // If a suggestion is selected and there are suggestions, use it
            if (filteredFiles.length > 0 && filteredFiles[selectedFileIndex]) {
              const selected = filteredFiles[selectedFileIndex];
              if (onFilePath) {
                onFilePath(selected);
              }
            } else if (filePath.trim() && onFilePath) {
              // Otherwise use the typed path
              onFilePath(filePath.trim());
            }
            break;

          case 'tab':
            // Autocomplete with selected suggestion
            if (filteredFiles.length > 0 && filteredFiles[selectedFileIndex]) {
              setFilePath(filteredFiles[selectedFileIndex]);
            }
            break;

          case 'up':
            // Navigate suggestions up
            if (filteredFiles.length > 0) {
              setSelectedFileIndex((prev) => Math.max(0, prev - 1));
            }
            break;

          case 'down':
            // Navigate suggestions down
            if (filteredFiles.length > 0) {
              setSelectedFileIndex((prev) => Math.min(filteredFiles.length - 1, prev + 1));
            }
            break;

          case 'backspace':
            setFilePath((prev) => prev.slice(0, -1));
            break;

          default:
            // Handle character input (including pasted text which may be multi-character)
            if (key.sequence && key.name !== 'backspace') {
              setFilePath((prev) => prev + key.sequence);
            }
            break;
        }
      }
    },
    [visible, mode, epics, selectedIndex, filePath, filteredFiles, selectedFileIndex, onSelect, onCancel, onFilePath]
  );

  useKeyboard(handleKeyboard);

  if (!visible) {
    return null;
  }

  // Full-screen overlay with centered modal
  return (
    <box
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#00000080', // 50% opacity black (OpenTUI doesn't support rgba syntax)
      }}
    >
      <box
        style={{
          width: 70,
          height: mode === 'file-prompt' ? 18 : 20,
          backgroundColor: colors.bg.secondary,
          border: true,
          borderColor: colors.accent.primary,
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <box
          style={{
            width: '100%',
            height: 3,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: colors.bg.tertiary,
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text fg={colors.accent.primary}>
            {mode === 'list' ? 'Load Epic' : 'Enter PRD File Path'}
          </text>
          <text fg={colors.fg.muted}>[{trackerName}]</text>
        </box>

        {/* Content */}
        {mode === 'file-prompt' ? (
          <box
            style={{
              flexGrow: 1,
              flexDirection: 'column',
              padding: 1,
            }}
          >
            <text fg={colors.fg.secondary}>
              Enter the path to a prd.json file:
            </text>
            <box style={{ height: 1 }} />
            <box
              style={{
                width: '100%',
                height: 1,
                backgroundColor: colors.bg.primary,
                paddingLeft: 1,
              }}
            >
              <text fg={colors.fg.primary}>
                {filePath}
                <span fg={colors.accent.primary}>_</span>
              </text>
            </box>
            <box style={{ height: 1 }} />

            {/* File suggestions list */}
            {filteredFiles.length > 0 && (
              <box
                style={{
                  flexDirection: 'column',
                  height: Math.min(filteredFiles.length, MAX_SUGGESTIONS),
                }}
              >
                {filteredFiles.map((file, index) => {
                  const isSelected = index === selectedFileIndex;
                  return (
                    <box
                      key={file}
                      style={{
                        width: '100%',
                        height: 1,
                        flexDirection: 'row',
                        backgroundColor: isSelected ? colors.bg.highlight : 'transparent',
                      }}
                    >
                      <text fg={isSelected ? colors.accent.primary : 'transparent'}>
                        {isSelected ? '▸ ' : '  '}
                      </text>
                      <text fg={isSelected ? colors.fg.primary : colors.fg.secondary}>
                        {truncateText(file, 60)}
                      </text>
                    </box>
                  );
                })}
              </box>
            )}

            {/* Show loading indicator or empty state */}
            {filteredFiles.length === 0 && filesLoading && (
              <text fg={colors.fg.muted}>  Searching for JSON files...</text>
            )}
            {filteredFiles.length === 0 && !filesLoading && filePath.length > 0 && (
              <text fg={colors.fg.muted}>  No matching files found</text>
            )}

            <box style={{ flexGrow: 1 }} />
            <text fg={colors.fg.muted}>
              <span fg={colors.accent.primary}>↑↓</span> Navigate{'  '}
              <span fg={colors.accent.primary}>Enter</span> Select{'  '}
              <span fg={colors.accent.primary}>Tab</span> Complete{'  '}
              <span fg={colors.accent.primary}>Esc</span> Cancel
            </text>
          </box>
        ) : loading ? (
          <box
            style={{
              flexGrow: 1,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <text fg={colors.fg.secondary}>Loading epics...</text>
          </box>
        ) : error ? (
          <box
            style={{
              flexGrow: 1,
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <text fg={colors.status.error}>Error: {error}</text>
            <box style={{ height: 1 }} />
            <text fg={colors.fg.muted}>Press Escape to close</text>
          </box>
        ) : epics.length === 0 ? (
          <box
            style={{
              flexGrow: 1,
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <text fg={colors.fg.secondary}>No epics found</text>
            <box style={{ height: 1 }} />
            <text fg={colors.fg.muted}>Press Escape to close</text>
          </box>
        ) : (
          <box
            style={{
              flexGrow: 1,
              flexDirection: 'column',
              paddingTop: 1,
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <scrollbox style={{ flexGrow: 1 }}>
              {epics.map((epic, index) => {
                const isSelected = index === selectedIndex;
                const isCurrent = epic.id === currentEpicId;
                const statusColor = getEpicStatusColor(epic);
                const meta = epic.metadata as Record<string, unknown> | undefined;
                const storyCount = (meta?.storyCount as number | undefined) ?? 0;
                const completedCount = (meta?.completedCount as number | undefined) ?? 0;
                const childCount = (meta?.childCount as number | undefined) ?? storyCount;

                let progressText = '';
                if (childCount > 0) {
                  progressText = ` (${completedCount}/${childCount})`;
                }

                return (
                  <box
                    key={epic.id}
                    style={{
                      width: '100%',
                      height: 1,
                      flexDirection: 'row',
                      backgroundColor: isSelected ? colors.bg.highlight : 'transparent',
                    }}
                  >
                    {/* Selection indicator */}
                    <text fg={isSelected ? colors.accent.primary : 'transparent'}>
                      {isSelected ? '▸ ' : '  '}
                    </text>

                    {/* Current epic marker */}
                    <text fg={isCurrent ? colors.status.success : 'transparent'}>
                      {isCurrent ? '● ' : '  '}
                    </text>

                    {/* Status indicator */}
                    <text fg={statusColor}>
                      {epic.status === 'in_progress'
                        ? statusIndicators.active
                        : statusIndicators.pending}{' '}
                    </text>

                    {/* Epic ID */}
                    <text fg={colors.fg.muted}>{truncateText(epic.id, 20)} </text>

                    {/* Epic title */}
                    <text fg={isSelected ? colors.fg.primary : colors.fg.secondary}>
                      {truncateText(epic.title, 30)}
                    </text>

                    {/* Progress */}
                    <text fg={colors.fg.muted}>{progressText}</text>
                  </box>
                );
              })}
            </scrollbox>
          </box>
        )}

        {/* Footer - only shown for list mode (file-prompt has inline help) */}
        {mode === 'list' && (
          <box
            style={{
              width: '100%',
              height: 2,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: colors.bg.tertiary,
              gap: 3,
            }}
          >
            <text fg={colors.fg.muted}>
              <span fg={colors.accent.primary}>Enter</span> Select
            </text>
            <text fg={colors.fg.muted}>
              <span fg={colors.accent.primary}>↑↓/jk</span> Navigate
            </text>
            <text fg={colors.fg.muted}>
              <span fg={colors.accent.primary}>Esc</span> Cancel
            </text>
          </box>
        )}
      </box>
    </box>
  );
}
