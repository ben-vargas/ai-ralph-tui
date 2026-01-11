#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop using Beads + bv/bd
# Usage: ./ralph-beads.sh [--epic EPIC_ID] [--cli opencode|claude] [--model MODEL] [max_iterations]
#        max_iterations must be a number if provided as positional arg (default: 10)
#
# Uses bv for smart task selection when available.
# Falls back to bd-only mode if bv is not installed.
# Automatically closes epic when all children are complete.

set -e

MAX_ITERATIONS=10
# Only consume first arg as max_iterations if it's a number
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
    MAX_ITERATIONS="$1"
    shift
fi
PROGRESS_FILE="scripts/ralph/progress.txt"
PROMPT_FILE="scripts/ralph/prompt-beads.md"
ARCHIVE_DIR="scripts/ralph/archive"

# Parse flags
EPIC_ID=""
AGENT_CLI="opencode"
MODEL=""  # Model for agent (e.g., opus-4.5)
while [[ $# -gt 0 ]]; do
    case $1 in
        --epic)
            EPIC_ID="$2"
            shift 2
            ;;
        --cli)
            AGENT_CLI="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Detect available CLI if not specified
detect_agent_cli() {
    if [ "$AGENT_CLI" = "auto" ]; then
        if command -v opencode &> /dev/null; then
            echo "opencode"
        elif command -v claude &> /dev/null; then
            echo "claude"
        else
            echo ""
        fi
    else
        echo "$AGENT_CLI"
    fi
}

AGENT_CLI=$(detect_agent_cli)

# Validate agent CLI is available
if [ -z "$AGENT_CLI" ]; then
    echo "Error: No agent CLI found."
    echo "Install OpenCode (https://opencode.ai/) or Claude Code (https://claude.com/claude-code)"
    exit 1
fi

if ! command -v "$AGENT_CLI" &> /dev/null; then
    echo "Error: $AGENT_CLI CLI not found."
    echo "Install $AGENT_CLI or use --cli opencode|claude to specify"
    exit 1
fi

# Check for bd (required)
if ! command -v bd &> /dev/null; then
    echo "Error: bd command not found."
    echo "Install from https://github.com/mgsloan/bd"
    exit 1
fi

# Check for bv (optional - will use bd fallback if not found)
BV_AVAILABLE=false
if command -v bv &> /dev/null; then
    BV_AVAILABLE=true
fi

# Initialize progress file
if [ ! -f "$PROGRESS_FILE" ]; then
    mkdir -p "$(dirname "$PROGRESS_FILE")"
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
fi

# Get epic to work on
get_epic() {
    if [ -n "$EPIC_ID" ]; then
        bd show "$EPIC_ID" 2>/dev/null
    elif [ "$BV_AVAILABLE" = true ]; then
        BEST_EPIC=$(bv --robot-triage --format json 2>/dev/null | jq -r '
            .recommendations[] | select(.labels // [] | contains("ralph")) | .id
        ' | head -1)
        if [ -n "$BEST_EPIC" ] && [ "$BEST_EPIC" != "null" ]; then
            bd show "$BEST_EPIC" 2>/dev/null
        fi
    else
        FIRST_EPIC=$(bd list --labels="ralph,feature" --format json 2>/dev/null | jq -r '.[0].id')
        if [ -n "$FIRST_EPIC" ] && [ "$FIRST_EPIC" != "null" ]; then
            bd show "$FIRST_EPIC" 2>/dev/null
        fi
    fi
}

# Get next bead within epic (dependency-aware)
# Arg 1: Epic ID (not bd show output)
get_next_bead_in_epic() {
    local EPIC_ID="$1"

    if [ -z "$EPIC_ID" ]; then
        return 1
    fi

    if [ "$BV_AVAILABLE" = true ]; then
        # bv --robot-next returns the single best task to work on
        # Filter to children of this epic (IDs starting with EPIC_ID.)
        bv --robot-next 2>/dev/null | jq --arg EPIC "$EPIC_ID" '
            select(.id | startswith($EPIC + ".")) |
            {
                id: .id,
                title: .title,
                score: .score,
                reasons: (.reasons // []),
                epic: $EPIC
            }
        '
    else
        # Fallback: parse bd list output (no JSON support)
        # Get first open child bead by priority
        local FIRST_CHILD=$(bd list --parent="$EPIC_ID" --status=open 2>/dev/null | head -1)
        if [ -n "$FIRST_CHILD" ]; then
            # Parse: "○ ID [● P1] [type] [labels] - Title"
            local CHILD_ID=$(echo "$FIRST_CHILD" | sed 's/^[^a-z]*//' | cut -d' ' -f1)
            local CHILD_TITLE=$(echo "$FIRST_CHILD" | sed 's/.*- //')
            echo "{\"id\": \"$CHILD_ID\", \"title\": \"$CHILD_TITLE\", \"score\": 0.5, \"reasons\": [\"From bd list\"], \"epic\": \"$EPIC_ID\"}"
        fi
    fi
}

# Check if all children of an epic are closed
# Arg 1: Epic ID (not bd show output)
are_all_children_closed() {
    local EPIC_ID="$1"

    if [ -z "$EPIC_ID" ]; then
        return 1
    fi

    # bd list --status=open only shows open beads; if none, all are closed
    local OPEN_CHILDREN=$(bd list --parent="$EPIC_ID" --status=open 2>/dev/null | grep -c "^" || echo "0")
    [ "$OPEN_CHILDREN" = "0" ]
}

# Close a bead using bd
close_bead() {
    local BEAD_ID="$1"
    local REASON="${2:-Completed via Ralph}"
    bd update "$BEAD_ID" --status=closed --close_reason="$REASON" 2>/dev/null
}

# Close epic
# Arg 1: Epic ID (not bd show output)
close_epic() {
    local EPIC_ID="$1"

    if [ -z "$EPIC_ID" ]; then
        return 1
    fi

    close_bead "$EPIC_ID" "All child beads completed via Ralph"
    echo ""
    echo "✓ Epic $EPIC_ID closed"
}

# Run agent CLI with a prompt
run_agent() {
    local PROMPT="$1"
    local BEAD_FILE="$2"
    local PROGRESS_FILE="$3"
    
    if [ "$AGENT_CLI" = "opencode" ]; then
        if [ -n "$MODEL" ]; then
            opencode run \
                --agent general \
                --model "$MODEL" \
                --file "$BEAD_FILE" \
                --file "$PROGRESS_FILE" \
                "$PROMPT" 2>&1
        else
            opencode run \
                --agent general \
                --file "$BEAD_FILE" \
                --file "$PROGRESS_FILE" \
                "$PROMPT" 2>&1
        fi
    elif [ "$AGENT_CLI" = "claude" ]; then
        # Combine bead details and prompt into a single prompt
        local FULL_PROMPT="$(cat "$BEAD_FILE")

---
Progress file: $PROGRESS_FILE

$PROMPT"

        if [ -n "$MODEL" ]; then
            claude -p \
                --dangerously-skip-permissions \
                --model "$MODEL" \
                "$FULL_PROMPT" 2>&1
        else
            claude -p \
                --dangerously-skip-permissions \
                "$FULL_PROMPT" 2>&1
        fi
    fi
}

echo "Starting Ralph (Beads + $AGENT_CLI)"
[ "$BV_AVAILABLE" = false ] && echo "Note: bv not found, using bd-only mode"

# Flush database to JSONL at startup to ensure bv sees current state
# (issues.jsonl is git-tracked but database is not, so they can drift after branch switches)
# Use --no-daemon to bypass daemon caching and write directly
bd sync --flush-only --no-daemon 2>/dev/null || true
echo ""

# Get the epic we're working on
EPIC=$(get_epic)
if [ -z "$EPIC" ]; then
    echo "Error: No ralph epic found to work on."
    echo "Use --epic EPIC_ID to specify which epic to work on."
    echo ""
    echo "Available ralph epics:"
    bd list --labels="ralph,feature" --format json 2>/dev/null | jq -r '.[] | "  \(.id): \(.title)"' || echo "  (none found)"
    exit 1
fi

# Store user-provided epic ID before it might get overwritten
USER_EPIC_ID="$EPIC_ID"

# If user provided --epic, use that ID directly (don't re-parse from bd show output)
if [ -n "$USER_EPIC_ID" ]; then
    EPIC_ID="$USER_EPIC_ID"
    # Extract title from bd show output: "○ ID [TYPE] · Title   [● P1 · STATUS]"
    # Use grep to find the line containing the ID (skips empty lines)
    EPIC_TITLE=$(echo "$EPIC" | grep "$USER_EPIC_ID" | head -1 | sed 's/^[^·]*· //' | sed 's/  *\[.*$//')
else
    # Parse ID from bd show output (auto-detected epic)
    EPIC_ID=$(echo "$EPIC" | grep "^[^:]*:" | head -1 | cut -d: -f1 | tr -d ' ')
    EPIC_TITLE=$(echo "$EPIC" | head -1 | cut -d: -f2- | sed 's/^ *//')
fi

echo "Working on epic: $EPIC_ID"
echo "Title: $EPIC_TITLE"
echo ""
echo "Agent CLI: $AGENT_CLI"
echo "Mode: $([ "$BV_AVAILABLE" = true ] && echo "bv + bd (smart)" || echo "bd-only (fallback)")"
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
    echo "═══════════════════════════════════════════════════════"
    echo "  Iteration $i of $MAX_ITERATIONS"
    echo "═══════════════════════════════════════════════════════"
    
    # Check if all children are done
    if are_all_children_closed "$EPIC_ID"; then
        close_epic "$EPIC_ID"
        echo ""
        echo "Ralph completed epic: $EPIC_ID"
        echo "<promise>COMPLETE</promise>"
        exit 0
    fi
    
    # Get next bead in this epic
    NEXT_BEAD_JSON=$(get_next_bead_in_epic "$EPIC_ID")
    
    if [ -z "$NEXT_BEAD_JSON" ] || echo "$NEXT_BEAD_JSON" | jq -e '.id' >/dev/null 2>&1; then
        BEAD_ID=$(echo "$NEXT_BEAD_JSON" | jq -r '.id')
        BEAD_TITLE=$(echo "$NEXT_BEAD_JSON" | jq -r '.title')
        SCORE=$(echo "$NEXT_BEAD_JSON" | jq -r '.score')
    else
        echo ""
        echo "No more beads in epic $EPIC_ID"
        if are_all_children_closed "$EPIC_ID"; then
            close_epic "$EPIC_ID"
            echo "Ralph completed epic: $EPIC_ID"
            echo "<promise>COMPLETE</promise>"
            exit 0
        fi
        echo "Check status manually."
        exit 1
    fi

    if [ -z "$BEAD_ID" ] || [ "$BEAD_ID" = "null" ]; then
        echo ""
        echo "No more beads in epic $EPIC_ID"
        if are_all_children_closed "$EPIC_ID"; then
            close_epic "$EPIC_ID"
            echo "Ralph completed epic: $EPIC_ID"
            echo "<promise>COMPLETE</promise>"
            exit 0
        fi
        exit 1
    fi
    
    echo ""
    echo "Selected bead: $BEAD_ID"
    echo "Title: $BEAD_TITLE"
    echo "Priority Score: $SCORE"
    
    # Show why this bead was picked
    echo ""
    echo "Why this bead:"
    echo "$NEXT_BEAD_JSON" | jq -r '.reasons[]' 2>/dev/null | head -5
    
    # Get full bead details
    BEAD_DETAILS=$(bd show "$BEAD_ID" 2>/dev/null)
    BEAD_DESCRIPTION=$(echo "$BEAD_DETAILS" | sed -n '/Description:/,/Acceptance Criteria/p' | head -n -1 | tail -n +2)
    
    # Create temporary files for agent
    TEMP_BEAD=$(mktemp)
    TEMP_PROMPT=$(mktemp)
    
    # Create bead file with full details
    cat > "$TEMP_BEAD" << EOF
## Bead Details
- **ID**: $BEAD_ID
- **Title**: $BEAD_TITLE
- **Epic**: $EPIC_ID - $EPIC_TITLE
- **Description**: $BEAD_DESCRIPTION

## Instructions
1. Create branch: ralph/bead-$BEAD_ID
2. Implement the requirements
3. Run: pnpm typecheck && pnpm lint
4. Commit: feat: $BEAD_ID - $BEAD_TITLE
5. Close the bead when done (bd update $BEAD_ID --status=closed --close_reason="...")
EOF
    
    # Create prompt with bead ID injected
    sed "s/\[TO_BE_INJECTED\]/$BEAD_ID/g" "$PROMPT_FILE" | \
        sed "s/\[TO_BE_INJECTED\]/$BEAD_TITLE/g" | \
        sed "s/\[TO_BE_INJECTED\]/$BEAD_DESCRIPTION/g" > "$TEMP_PROMPT"
    
    # Run agent with the bead
    OUTPUT=$(run_agent "$(cat "$TEMP_PROMPT")" "$TEMP_BEAD" "$PROGRESS_FILE")
    
    rm -f "$TEMP_BEAD" "$TEMP_PROMPT"
    
    # Check if bead was closed by agent
    # Look for "CLOSED" in the status indicator: [● P1 · CLOSED]
    if bd show "$BEAD_ID" 2>/dev/null | grep -q "CLOSED"; then
        echo ""
        echo "✓ Bead $BEAD_ID closed"
        # Flush database to JSONL so bv sees the change
        # Use --no-daemon to bypass daemon caching
        bd sync --flush-only --no-daemon 2>/dev/null || true
    else
        echo ""
        echo "Note: Bead $BEAD_ID still open (agent may need more time)"
    fi

    echo "Iteration $i complete. Continuing..."
    sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS)."
echo "Epic: $EPIC_ID"
echo "Check progress: $PROGRESS_FILE"
exit 1
