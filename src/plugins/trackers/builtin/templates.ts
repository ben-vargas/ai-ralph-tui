/**
 * ABOUTME: Embedded templates for tracker plugins.
 * These templates are embedded as string constants to avoid path resolution issues
 * in bundled environments where __dirname resolves to the bundle root instead of
 * the original module's directory. See: https://github.com/subsy/ralph-tui/issues/248
 *
 * Users can still override these templates by placing custom templates at:
 * - Project: .ralph-tui/templates/{tracker}.hbs
 * - Global: ~/.config/ralph-tui/templates/{tracker}.hbs
 */

/**
 * Template for the beads tracker (bd CLI).
 * Context-first structure: PRD → Task → Workflow
 */
export const BEADS_TEMPLATE = `{{!--
  ABOUTME: Beads tracker prompt template.
  Context-first structure: PRD → Task → Workflow

  Users can customize this template by copying to:
  - Project: .ralph-tui/templates/beads.hbs
  - Global: ~/.config/ralph-tui/templates/beads.hbs
--}}

{{!-- Full PRD for project context (agent studies this first) --}}
{{#if prdContent}}
We are working in a project to implement the following Product Requirements Document (PRD):

{{prdContent}}

---
{{/if}}

## Bead Details
- **ID**: {{taskId}}
- **Title**: {{taskTitle}}
{{#if epicId}}
- **Epic**: {{epicId}}{{#if epicTitle}} - {{epicTitle}}{{/if}}
{{/if}}
{{#if taskDescription}}
- **Description**: {{taskDescription}}
{{/if}}

{{#if acceptanceCriteria}}
## Acceptance Criteria
{{acceptanceCriteria}}
{{/if}}

{{#if dependsOn}}
**Prerequisites**: {{dependsOn}}
{{/if}}

{{#if recentProgress}}
## Recent Progress
{{recentProgress}}
{{/if}}

## Workflow
1. Study the PRD context above to understand the bigger picture (if available)
2. Study \`.ralph-tui/progress.md\` to understand overall status, implementation progress, and learnings including codebase patterns and gotchas
3. Implement the requirements (stay on current branch)
4. Run your project's quality checks (typecheck, lint, etc.)
{{#if config.autoCommit}}
5. Do NOT create git commits. Changes will be committed automatically by the engine after task completion.
{{else}}
5. Do NOT create git commits. Leave all changes uncommitted for manual review.
{{/if}}
6. Close the bead: \`bd close {{taskId}} --db {{beadsDbPath}} --reason "Brief description"\`
7. Document learnings (see below)
8. Signal completion

## Before Completing
APPEND to \`.ralph-tui/progress.md\`:
\`\`\`
## [Date] - {{taskId}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`

If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of progress.md.

## Stop Condition
**IMPORTANT**: If the work is already complete (implemented in a previous iteration or already exists), verify it works correctly and signal completion immediately.

When finished (or if already complete), signal completion with:
<promise>COMPLETE</promise>
`;

/**
 * Template for the beads-rust tracker (br CLI).
 * Context-first structure: PRD -> Task -> Workflow (br CLI)
 */
export const BEADS_RUST_TEMPLATE = `{{!--
  ABOUTME: Beads-rust tracker prompt template.
  Context-first structure: PRD -> Task -> Workflow (br CLI)

  This template is specific to the beads-rust tracker (br), so its workflow
  instructions can diverge from the default beads (bd) template.
--}}

{{!-- Full PRD for project context (agent studies this first) --}}
{{#if prdContent}}
We are working in a project to implement the following Product Requirements Document (PRD):

{{prdContent}}

---
{{/if}}

## Bead Details
- **ID**: {{taskId}}
- **Title**: {{taskTitle}}
{{#if epicId}}
- **Epic**: {{epicId}}{{#if epicTitle}} - {{epicTitle}}{{/if}}
{{/if}}
{{#if taskDescription}}
- **Description**: {{taskDescription}}
{{/if}}

{{#if acceptanceCriteria}}
## Acceptance Criteria
{{acceptanceCriteria}}
{{/if}}

{{#if dependsOn}}
**Prerequisites**: {{dependsOn}}
{{/if}}

{{#if recentProgress}}
## Recent Progress
{{recentProgress}}
{{/if}}

## Workflow
1. Study the PRD context above to understand the bigger picture (if available)
2. Study \`.ralph-tui/progress.md\` to understand overall status, implementation progress, and learnings including codebase patterns and gotchas
3. Implement the requirements (stay on current branch)
4. Run your project's quality checks (typecheck, lint, etc.)
{{#if config.autoCommit}}
5. Do NOT create git commits. Changes will be committed automatically by the engine after task completion.
{{else}}
5. Do NOT create git commits. Leave all changes uncommitted for manual review.
{{/if}}
6. Close the bead: \`br close {{taskId}} --reason "Brief description"\`
7. Flush tracker state to JSONL (no git side effects): \`br sync --flush-only\`
8. Document learnings (see below)
9. Signal completion

## Before Completing
APPEND to \`.ralph-tui/progress.md\`:
\`\`\`
## [Date] - {{taskId}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`

If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of progress.md.

## Stop Condition
**IMPORTANT**: If the work is already complete (implemented in a previous iteration or already exists), verify it works correctly and signal completion immediately.

When finished (or if already complete), signal completion with:
<promise>COMPLETE</promise>
`;

/**
 * Template for the beads-bv tracker (bd + bv CLI).
 * Context-first structure: PRD → Selection Context → Task → Workflow
 * Includes bv-specific selection reasoning and impact sections.
 */
export const BEADS_BV_TEMPLATE = `{{!--
  ABOUTME: Beads+bv tracker prompt template.
  Context-first structure: PRD → Selection Context → Task → Workflow
  Includes bv-specific selection reasoning and impact sections.

  Users can customize this template by copying to:
  - Project: .ralph-tui/templates/beads-bv.hbs
  - Global: ~/.config/ralph-tui/templates/beads-bv.hbs
--}}

{{!-- Full PRD for project context (agent studies this first) --}}
{{#if prdContent}}
We are working in a project to implement the following Product Requirements Document (PRD):

{{prdContent}}

---
{{/if}}

{{!-- Why this task was selected (bv context) --}}
{{#if selectionReason}}
## Why This Task Was Selected
{{selectionReason}}
{{/if}}

## Bead Details
- **ID**: {{taskId}}
- **Title**: {{taskTitle}}
{{#if epicId}}
- **Epic**: {{epicId}}{{#if epicTitle}} - {{epicTitle}}{{/if}}
{{/if}}
{{#if taskDescription}}
- **Description**: {{taskDescription}}
{{/if}}

{{#if acceptanceCriteria}}
## Acceptance Criteria
{{acceptanceCriteria}}
{{/if}}

{{#if dependsOn}}
## Dependencies
This task depends on: {{dependsOn}}
{{/if}}

{{#if blocks}}
## Impact
Completing this task will unblock: {{blocks}}
{{/if}}

{{#if recentProgress}}
## Recent Progress
{{recentProgress}}
{{/if}}

## Workflow
1. Study the PRD context above to understand the bigger picture (if available)
2. Study \`.ralph-tui/progress.md\` to understand overall status, implementation progress, and learnings including codebase patterns and gotchas
3. Implement the requirements (stay on current branch)
4. Run your project's quality checks (typecheck, lint, etc.)
{{#if config.autoCommit}}
5. Do NOT create git commits. Changes will be committed automatically by the engine after task completion.
{{else}}
5. Do NOT create git commits. Leave all changes uncommitted for manual review.
{{/if}}
6. Close the bead: \`bd close {{taskId}} --db {{beadsDbPath}} --reason "Brief description"\`
7. Document learnings (see below)
8. Signal completion

## Before Completing
APPEND to \`.ralph-tui/progress.md\`:
\`\`\`
## [Date] - {{taskId}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`

If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of progress.md.

## Stop Condition
**IMPORTANT**: If the work is already complete (implemented in a previous iteration or already exists), verify it works correctly and signal completion immediately.

When finished (or if already complete), signal completion with:
<promise>COMPLETE</promise>
`;

/**
 * Template for the JSON tracker (prd.json files).
 * Context-first structure: PRD → Patterns → Task → Workflow
 */
export const JSON_TEMPLATE = `{{!--
  ABOUTME: JSON (prd.json) tracker prompt template.
  Context-first structure: PRD → Patterns → Task → Workflow

  Users can customize this template by copying to:
  - Project: .ralph-tui/templates/json.hbs
  - Global: ~/.config/ralph-tui/templates/json.hbs
--}}

{{!-- Full PRD for project context (agent studies this first) --}}
{{#if prdContent}}
We are working in a project to implement the following Product Requirements Document (PRD):

{{prdContent}}

---
{{/if}}

{{!-- Task details --}}
## Your Task: {{taskId}} - {{taskTitle}}

{{#if taskDescription}}
### Description
{{taskDescription}}
{{/if}}

{{#if acceptanceCriteria}}
### Acceptance Criteria
{{acceptanceCriteria}}
{{/if}}

{{#if notes}}
### Notes
{{notes}}
{{/if}}

{{#if dependsOn}}
**Prerequisites**: {{dependsOn}}
{{/if}}

{{#if recentProgress}}
## Recent Progress
{{recentProgress}}
{{/if}}

## Workflow
1. Study the PRD context above to understand the bigger picture
2. Study \`.ralph-tui/progress.md\` to understand overall status, implementation progress, and learnings including codebase patterns and gotchas
3. Implement this single story following acceptance criteria
4. Run quality checks: typecheck, lint, etc.
{{#if config.autoCommit}}
5. Do NOT create git commits. Changes will be committed automatically by the engine after task completion.
{{else}}
5. Do NOT create git commits. Leave all changes uncommitted for manual review.
{{/if}}
6. Document learnings (see below)
7. Signal completion

## Before Completing
APPEND to \`.ralph-tui/progress.md\`:
\`\`\`
## [Date] - {{taskId}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`

If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of progress.md.

## Stop Condition
**IMPORTANT**: If the work is already complete (implemented in a previous iteration or already exists), verify it meets the acceptance criteria and signal completion immediately.

When finished (or if already complete), signal completion with:
<promise>COMPLETE</promise>
`;

/**
 * Minimal fallback template used when a tracker-specific template fails to load.
 */
export const FALLBACK_TEMPLATE = `## Task: {{taskTitle}}
{{#if taskDescription}}
{{taskDescription}}
{{/if}}

When finished, signal completion with:
<promise>COMPLETE</promise>
`;
