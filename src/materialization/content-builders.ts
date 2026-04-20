import { normalizeLineEndings } from '../core/line-endings';
import { resolveBundleName } from '../core/constants';
import {
    buildFreshMainAgentStartBannerSentence,
    START_BANNER_EXEMPTION_RULE
} from '../core/orchestrator-start-banner';
import {
    getProviderBridgeEntries,
    getProviderBridgeRelativePaths,
    getProviderEntries,
    getProviderEntrypointFiles,
    getRequiredProviderEntryByBridgePath,
    getRequiredReviewSkillBridgeHostEntry
} from '../core/provider-registry';
import { getManagedGitignoreEntries, getManagedGitignoreCleanupEntries } from './common';
import { getNodeBundleCliCommand, getNodeGateCommandPrefix, getNodeHumanCommitCommand } from './command-constants';

function getConditionalDelegationProviderList(): string {
    return getProviderEntries()
        .filter((e) => e.reviewerCapabilityTier === 'delegation_conditional')
        .map((e) => e.id)
        .join(', ');
}

function getDelegationRequiredProviderLaunchLines(): readonly string[] {
    return Object.freeze(
        getProviderEntries()
            .filter((entry) => entry.reviewerCapabilityTier === 'delegation_required')
            .map((entry) => (
                `- ${entry.reviewerLaunchLabel!} (delegation-capable): ${entry.delegatedReviewerLaunchInstruction!}`
            ))
    );
}

function getReviewSkillBridgeHost(): { bridgePath: string; providerLabel: string } {
    const hostEntry = getRequiredReviewSkillBridgeHostEntry();
    const bridgePath = hostEntry.bridge!.orchestratorRelativePath;
    return {
        bridgePath,
        providerLabel: hostEntry.displayLabel
    };
}

function getSourceGateCommandPrefix(): string {
    return 'node bin/garda.js gate';
}

function buildBundleRelativePath(relativePath: string, bundleName = resolveBundleName()): string {
    return `${bundleName}/${relativePath}`;
}

function buildTaskEntryRuleFileFlags(bundleName = resolveBundleName()): string {
    return [
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/00-core.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/40-commands.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/80-task-workflow.md', bundleName)}"`,
        `--loaded-rule-file "${buildBundleRelativePath('live/docs/agent-rules/90-skill-catalog.md', bundleName)}"`
    ].join(' ');
}

function buildEnterTaskModeSnippet(commandPrefix: string, runtimeIdentityFlag: string): string {
    return [
        `${commandPrefix} enter-task-mode`,
        '--task-id "<task-id>"',
        '--entry-mode "EXPLICIT_TASK_EXECUTION"',
        '--requested-depth "<1|2|3>"',
        '--task-summary "<task summary>"',
        '--start-banner "<repo-owned-banner>"',
        runtimeIdentityFlag,
        '--repo-root "."'
    ].join(' ');
}

function buildTaskEntryRulePackSnippet(commandPrefix: string, bundleName = resolveBundleName()): string {
    return [
        `${commandPrefix} load-rule-pack`,
        '--task-id "<task-id>"',
        '--stage "TASK_ENTRY"',
        buildTaskEntryRuleFileFlags(bundleName),
        '--repo-root "."'
    ].join(' ');
}

function buildTaskStartSnippetSection(runtimeProviderLabel: string, routeTarget: string): string {
    const sourcePrefix = getSourceGateCommandPrefix();
    const bundlePrefix = getNodeGateCommandPrefix();
    const bundleName = resolveBundleName();
    return [
        '## Copy-Paste Start Commands',
        `- Source checkout (\`--provider\`): \`${buildEnterTaskModeSnippet(sourcePrefix, `--provider "${runtimeProviderLabel}"`)}\``,
        `- Source checkout (\`--routed-to\`): \`${buildEnterTaskModeSnippet(sourcePrefix, `--routed-to "${routeTarget}"`)}\``,
        `- Source checkout (\`TASK_ENTRY\` rules): \`${buildTaskEntryRulePackSnippet(sourcePrefix, bundleName)}\``,
        `- Deployed workspace (\`--provider\`): \`${buildEnterTaskModeSnippet(bundlePrefix, `--provider "${runtimeProviderLabel}"`)}\``,
        `- Deployed workspace (\`--routed-to\`): \`${buildEnterTaskModeSnippet(bundlePrefix, `--routed-to "${routeTarget}"`)}\``,
        `- Deployed workspace (\`TASK_ENTRY\` rules): \`${buildTaskEntryRulePackSnippet(bundlePrefix, bundleName)}\``
    ].join('\n');
}

export const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
export const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
export const COMMIT_GUARD_START = '# garda-agent-orchestrator:commit-guard-start';
export const COMMIT_GUARD_END = '# garda-agent-orchestrator:commit-guard-end';
export const GITIGNORE_MANAGED_COMMENT = '# garda-agent-orchestrator managed ignores';
export const UNINSTALL_BACKUP_GITIGNORE_COMMENT = '# Backup artifacts created by Garda Agent Orchestrator uninstall';
export function getUninstallBackupGitignoreEntry(): string {
    return `${resolveBundleName()}-uninstall-backups/`;
}
export function getLegacyUninstallBackupGitignoreEntry(): string {
    return `${resolveBundleName()}-uninstall-backups/**`;
}
export const COMMIT_GUARD_ENV_NAME = 'GARDA_ALLOW_COMMIT';
export const COMMIT_GUARD_EXTRA_MARKERS_ENV = 'GARDA_AGENT_ENV_MARKERS';
export const COMMIT_GUARD_AGENT_MARKERS = Object.freeze([
    'CODEX_THREAD_ID',
    'CLAUDE_CODE_SSE_PORT',
    'AIDER_SESSION_ID',
    'CURSOR_TRACE_ID',
    'CURSOR_AGENT'
]);

export const INSTALL_BACKUP_CANDIDATE_PATHS = Object.freeze([
    ...getProviderEntrypointFiles(), 'TASK.md',
    '.qwen/settings.json', '.claude/settings.local.json',
    '.vscode/settings.json',
    '.git/hooks/pre-commit', '.gitignore',
    '.agents/workflows/start-task.md',
    ...getProviderBridgeRelativePaths(),
    '.github/agents/reviewer.md', '.github/agents/code-review.md',
    '.github/agents/db-review.md', '.github/agents/security-review.md',
    '.github/agents/refactor-review.md', '.github/agents/api-review.md',
    '.github/agents/test-review.md', '.github/agents/performance-review.md',
    '.github/agents/infra-review.md', '.github/agents/dependency-review.md'
]);

export function getClaudeOrchestratorAllowEntries(): readonly string[] {
    return Object.freeze([
    `Bash(${getNodeBundleCliCommand()} *:*)`,
    `Bash(cd * && ${getNodeBundleCliCommand()} *:*)`,
    'Bash(npx garda-agent-orchestrator *:*)',
    'Bash(cd * && npx garda-agent-orchestrator *:*)',
    'Bash(cd * && git diff *:*)',
    'Bash(cd * && git log *:*)',
    'Bash(grep -n * | head * && echo * && grep -n * | head *:*)',
    'Bash(cd * && grep -n * | head * && echo * && grep -n * | head *:*)'
    ]);
}

function getEntrypointRuleLinks(): readonly (readonly [string, string])[] {
    const bn = resolveBundleName();
    return Object.freeze([
    [`${bn}/live/docs/agent-rules/00-core.md`, 'Core Rules'],
    [`${bn}/live/docs/agent-rules/10-project-context.md`, 'Project Context'],
    [`${bn}/live/docs/agent-rules/15-project-memory.md`, 'Project Memory Summary'],
    [`${bn}/live/docs/agent-rules/20-architecture.md`, 'Architecture'],
    [`${bn}/live/docs/agent-rules/30-code-style.md`, 'Code Style'],
    [`${bn}/live/docs/agent-rules/35-strict-coding-rules.md`, 'Strict Coding Rules'],
    [`${bn}/live/docs/agent-rules/40-commands.md`, 'Commands'],
    [`${bn}/live/docs/agent-rules/50-structure-and-docs.md`, 'Structure and Documentation'],
    [`${bn}/live/docs/agent-rules/60-operating-rules.md`, 'Operating Rules'],
    [`${bn}/live/docs/agent-rules/70-security.md`, 'Security'],
    [`${bn}/live/docs/agent-rules/80-task-workflow.md`, 'Task Workflow'],
    [`${bn}/live/docs/agent-rules/90-skill-catalog.md`, 'Skill Catalog']
    ] as const);
}

interface TaskQueueTableRange {
    lines: string[];
    rowsStartIndex: number;
    rowsEndIndex: number;
}

interface ProviderOrchestratorProfileLike {
    gitignoreEntries: string[];
}

type SettingsParseMode = 'default' | 'merge-existing' | 'invalid-root' | 'invalid-json';

interface SettingsBuildResult {
    content: string;
    needsUpdate: boolean;
    parseMode: SettingsParseMode;
}

interface ManagedBlockSyncResult {
    content: string;
    changed: boolean;
}

interface GitignoreManagedBlockSyncResult extends ManagedBlockSyncResult {
    addedEntries: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strips single-line (//) and block comments from JSONC content,
 * then removes trailing commas before closing brackets/braces
 * so the result can be parsed with standard JSON.parse.
 * Both passes are string-aware to avoid modifying quoted values.
 */
export function stripJsoncComments(text: string): string {
    // Pass 1: strip comments (string-aware)
    let stripped = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '"') {
            const start = i;
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') i++;
                i++;
            }
            i++;
            stripped += text.slice(start, i);
        } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
            i += 2;
            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2;
        } else {
            stripped += text[i];
            i++;
        }
    }

    // Pass 2: remove trailing commas (string-aware)
    let result = '';
    i = 0;
    while (i < stripped.length) {
        if (stripped[i] === '"') {
            const start = i;
            i++;
            while (i < stripped.length && stripped[i] !== '"') {
                if (stripped[i] === '\\') i++;
                i++;
            }
            i++;
            result += stripped.slice(start, i);
        } else if (stripped[i] === ',') {
            let j = i + 1;
            while (j < stripped.length && /\s/.test(stripped[j])) j++;
            if (j < stripped.length && (stripped[j] === '}' || stripped[j] === ']')) {
                // Trailing comma — skip it, preserve whitespace
                result += stripped.slice(i + 1, j);
                i = j;
            } else {
                result += stripped[i];
                i++;
            }
        } else {
            result += stripped[i];
            i++;
        }
    }
    return result;
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restoreEntrypointRuleLinks(content: string): string {
    let restored = String(content || '');
    for (const [rulePath, label] of getEntrypointRuleLinks()) {
        const plainBullet = new RegExp('^\\- \\`' + escapeRegex(rulePath) + '\\`$', 'gm');
        restored = restored.replace(plainBullet, `- [${label}](./${rulePath})`);
    }
    return restored;
}

/**
 * Extracts managed block (between start/end markers) from text content.
 */
export function extractManagedBlockFromContent(
    content: string | null | undefined,
    startMarker: string,
    endMarker: string
): string | null {
    if (!content || !content.trim()) return null;
    const pattern = new RegExp(
        `${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`, 'm'
    );
    const match = content.match(pattern);
    return match ? match[0] : null;
}

/**
 * Parses the Active Queue table range from a managed block in TASK.md.
 */
export function getTaskQueueTableRange(managedBlock: string | null | undefined): TaskQueueTableRange | null {
    if (!managedBlock || !managedBlock.trim()) return null;
    const normalized = normalizeLineEndings(managedBlock, '\n');
    const lines = normalized.split('\n');

    let activeQueueIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '## Active Queue') {
            activeQueueIndex = i;
            break;
        }
    }
    if (activeQueueIndex < 0) return null;

    let headerIndex = -1;
    for (let i = activeQueueIndex + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith('|')) {
            headerIndex = i;
            break;
        }
    }
    if (headerIndex < 0) return null;

    let separatorIndex = -1;
    if (headerIndex + 1 < lines.length && lines[headerIndex + 1].trim().startsWith('|')) {
        separatorIndex = headerIndex + 1;
    }
    if (separatorIndex < 0) return null;

    const rowsStartIndex = separatorIndex + 1;
    let rowsEndIndex = rowsStartIndex;
    while (rowsEndIndex < lines.length && lines[rowsEndIndex].trim().startsWith('|')) {
        rowsEndIndex++;
    }

    return { lines, rowsStartIndex, rowsEndIndex };
}

/**
 * Extracts task queue rows from a managed block.
 */
export function getTaskQueueRowsFromManagedBlock(managedBlock: string | null | undefined): string[] {
    const range = getTaskQueueTableRange(managedBlock);
    if (!range) return [];
    const rows = [];
    for (let i = range.rowsStartIndex; i < range.rowsEndIndex; i++) {
        if (range.lines[i] && range.lines[i].trim()) {
            rows.push(range.lines[i]);
        }
    }
    return rows;
}

/**
 * Replaces task queue rows in a managed block.
 */
export function setTaskQueueRowsInManagedBlock(managedBlock: string, rows: string[]): string {
    const range = getTaskQueueTableRange(managedBlock);
    if (!range) return managedBlock;

    const prefix = range.rowsStartIndex > 0 ? range.lines.slice(0, range.rowsStartIndex) : [];
    const suffix = range.rowsEndIndex < range.lines.length ? range.lines.slice(range.rowsEndIndex) : [];
    return [...prefix, ...rows, ...suffix].join('\n');
}

/**
 * Detects whether a managed block uses the legacy `Depth` column header.
 */
export function hasLegacyDepthColumn(managedBlock: string): boolean {
    return /\|\s*Depth\s*\|/i.test(managedBlock) && !/\|\s*Profile\s*\|/i.test(managedBlock);
}

/**
 * Migrates a task row from the legacy `Depth` column to `Profile`.
 * Numeric depth values (1, 2, 3) become `default`; the original depth
 * is preserved in the Notes column as `requested_depth=<value>` when
 * not already present.  Non-numeric values that look like valid profile
 * names are retained as-is (they may be user-entered profile overrides).
 */
export function migrateDepthToProfileRow(row: string): string {
    const cells = row.split('|');
    // Expect at least 10 segments: empty + 9 columns + trailing empty from '| a | b | ... |'
    if (cells.length < 10) return row;

    const depthCell = cells[8].trim(); // column index 8 = Depth (0-based split: ['', ID, Status, ..., Depth, Notes, ''])
    if (!depthCell) return row;

    const numericDepth = /^[1-3]$/.test(depthCell);
    const notesCell = cells[9] || '';

    if (numericDepth) {
        // Numeric depth → default, preserve original in Notes
        cells[8] = ' default ';
        if (!notesCell.includes('requested_depth')) {
            const trimmedNotes = notesCell.trim();
            const depthNote = `requested_depth=${depthCell}`;
            cells[9] = trimmedNotes
                ? ` ${depthNote}; ${trimmedNotes}`
                : ` ${depthNote} `;
        }
    }
    // Non-numeric values are kept as-is (may be valid profile names)

    return cells.join('|');
}

/**
 * Builds a TASK.md managed block preserving existing queue rows.
 * Migrates legacy Depth column values to Profile when the existing block
 * uses the old header format.
 */
export function buildTaskManagedBlockWithExistingQueue(templateContent: string, existingContent: string): string | null {
    const templateBlock = extractManagedBlockFromContent(templateContent, MANAGED_START, MANAGED_END);
    if (!templateBlock) return null;

    const existingBlock = extractManagedBlockFromContent(existingContent, MANAGED_START, MANAGED_END);
    if (!existingBlock) return templateBlock;

    let existingRows = getTaskQueueRowsFromManagedBlock(existingBlock);
    if (existingRows.length === 0) return templateBlock;

    if (hasLegacyDepthColumn(existingBlock)) {
        existingRows = existingRows.map(migrateDepthToProfileRow);
    }

    return setTaskQueueRowsInManagedBlock(templateBlock, existingRows);
}

/**
 * Builds the canonical entrypoint managed block (for the source-of-truth file).
 */
export function buildCanonicalManagedBlock(canonicalFile: string, templateClaudeContent: string): string {
    const baseBlock = extractManagedBlockFromContent(templateClaudeContent, MANAGED_START, MANAGED_END);
    if (!baseBlock) {
        throw new Error('Template CLAUDE.md managed block is missing; cannot build canonical entrypoint.');
    }
    return restoreEntrypointRuleLinks(baseBlock).replace(/^# CLAUDE\.md$/m, `# ${canonicalFile}`);
}

/**
 * Builds a redirect managed block for non-canonical entrypoints.
 */
export function buildRedirectManagedBlock(
    targetFile: string,
    canonicalFile: string,
    providerBridgePaths: string[] | null | undefined
): string {
    const providerLines = [];
    const bridgeToLabel = new Map(
        getProviderBridgeEntries().map((e) => [
            e.bridge!.orchestratorRelativePath,
            e.displayLabel
        ])
    );
    for (const bridgePath of (providerBridgePaths || [])) {
        const normalized = bridgePath.replace(/\\/g, '/');
        const label = bridgeToLabel.get(normalized);
        if (label) {
            providerLines.push(`For ${label} Agents, run task execution through \`${normalized}\`.`);
        }
    }
    const uniqueProviderLines = [...new Set(providerLines)].sort();
    const providerBridgeSection = uniqueProviderLines.length > 0
        ? uniqueProviderLines.join('\r\n')
        : 'No provider-specific bridge files are enabled for this workspace.';

    return [
        MANAGED_START,
        `# ${targetFile}`,
        '',
        'This file is a redirect.',
        `Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.`,
        '',
        `Hard stop: read \`${canonicalFile}\` first and follow its routing links before responding to anything.`,
        `Hard stop: before any task execution, open \`${canonicalFile}\`, \`TASK.md\`, and \`.agents/workflows/start-task.md\`.`,
        'Do not implement tasks directly without orchestration preflight and required review gates.',
        'Canonical task-start command: `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`',
        buildFreshMainAgentStartBannerSentence(),
        'If the workspace already contains modified files before task-mode entry, stop and isolate scope via `--use-staged` or explicit `--changed-file ...` preflight inputs before continuing.',
        'Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.',
        'Treat `.agents/workflows/start-task.md` as the shared start-task router for root entrypoints and provider bridges; it routes to the canonical workflow and does not replace `80-task-workflow.md`.',
        `After opening downstream workflow files, record them via \`node bin/garda.js gate load-rule-pack ...\` in a self-hosted source checkout, or \`node ${resolveBundleName()}/bin/garda.js gate load-rule-pack ...\` inside a materialized/deployed workspace.`,
        `Before each required reviewer invocation, run \`node bin/garda.js gate build-review-context ...\` in a self-hosted source checkout, or \`node ${resolveBundleName()}/bin/garda.js gate build-review-context ...\` inside a materialized/deployed workspace; completion for code-changing tasks expects review-skill telemetry from that step. Downstream \`test\` review must wait for current-cycle PASS evidence from every required upstream non-\`test\` review.`,
        `Ignored orchestration control-plane files (for example \`TASK.md\`, \`${resolveBundleName()}/runtime/**\`, and \`${resolveBundleName()}/live/docs/changes/CHANGELOG.md\`) are expected local artifacts; never \`git add -f\` them unless the user explicitly asks to version orchestrator internals.`,
        providerBridgeSection,
        MANAGED_END
    ].join('\r\n');
}

/**
 * Builds the commit guard hook script content.
 */
export function buildCommitGuardManagedBlock() {
    const agentEnvLines = COMMIT_GUARD_AGENT_MARKERS.map((m) => `  "${m}"`).join('\n');
    return `${COMMIT_GUARD_START}
# Commit blocked by Garda auto-commit guard only for detected agent sessions.
if [ "\${${COMMIT_GUARD_ENV_NAME}:-}" = "1" ]; then
  exit 0
fi

garda_agent_env_markers=(
${agentEnvLines}
)

if [ -n "\${${COMMIT_GUARD_EXTRA_MARKERS_ENV}:-}" ]; then
  IFS=', ' read -r -a garda_extra_agent_markers <<< "\${${COMMIT_GUARD_EXTRA_MARKERS_ENV}}"
  for garda_marker in "\${garda_extra_agent_markers[@]}"; do
    if [[ "$garda_marker" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      garda_agent_env_markers+=("$garda_marker")
    fi
  done
fi

garda_detected_agent_var=""
for garda_marker in "\${garda_agent_env_markers[@]}"; do
  if [ -n "\${!garda_marker:-}" ]; then
    garda_detected_agent_var="$garda_marker"
    break
  fi
done

if [ -n "$garda_detected_agent_var" ]; then
  echo "Commit blocked: agent commit guard is enabled (detected env: $garda_detected_agent_var)."
  echo "If this is a manual human commit from the same shell, use helper:"
  echo "  ${getNodeHumanCommitCommand().replace(/"/g, '\\"')}"
  exit 1
fi
${COMMIT_GUARD_END}`;
}

/**
 * Builds provider orchestrator agent markdown content.
 */
export function buildProviderOrchestratorAgentContent(
    providerLabel: string,
    canonicalFile: string,
    bridgePath: string
): string {
    const providerEntry = getRequiredProviderEntryByBridgePath(bridgePath);
    const runtimeProviderLabel = providerEntry.displayLabel;
    const runtimeIdentityInstruction = `include explicit runtime identity with ` +
        `\`--provider "${runtimeProviderLabel}"\` or \`--routed-to "${bridgePath}"\`; do not rely on canonical SourceOfTruth fallback`;
    if (providerEntry?.bridge?.profileVariant === 'compact_router') {
        return `${MANAGED_START}
# ${runtimeProviderLabel} Agent: Orchestrator

Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.

This bridge is a router, not a second workflow.

Required:
1. Open \`${canonicalFile}\`, \`TASK.md\`, and \`.agents/workflows/start-task.md\`.
2. Start every task with \`Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.\`
3. ${buildFreshMainAgentStartBannerSentence()}
4. Follow the shared checklist in \`.agents/workflows/start-task.md\` exactly.
5. Use the active profile as the default execution mode; explicit \`depth=<1|2|3>\` is only a one-run override.
6. Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.
7. Do not bypass gates, fake review artifacts, or use provider-default review flow outside Garda.
8. Do not launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle. Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.
9. Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as \`npm run build:node-foundation\` -> direct \`node --test .node-build/...\` must use the guarded workflow path or run strictly sequentially, never in parallel.
10. If any mandatory gate command fails, stop, keep the task blocked, and report the exact command, cwd, CLI path, and stderr.

${buildTaskStartSnippetSection(runtimeProviderLabel, bridgePath)}

Canonical workflow skill: \`${resolveBundleName()}/live/skills/orchestration/SKILL.md\`
Skill catalog: \`${resolveBundleName()}/live/docs/agent-rules/90-skill-catalog.md\`
Bridge path: \`${bridgePath}\`
${MANAGED_END}`.trim();
    }

    return `${MANAGED_START}
# ${runtimeProviderLabel} Agent: Orchestrator

Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.

Hard stop: first open \`${canonicalFile}\`, \`TASK.md\`, and \`.agents/workflows/start-task.md\`.
Do not implement tasks directly without orchestration preflight and required review gates.
Canonical task-start command: \`Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.\`
${buildFreshMainAgentStartBannerSentence()}
If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.
Ignored orchestration control-plane files (for example \`TASK.md\`, \`${resolveBundleName()}/runtime/**\`, and \`${resolveBundleName()}/live/docs/changes/CHANGELOG.md\`) are expected local artifacts; never \`git add -f\` them unless the user explicitly asks to version orchestrator internals.
This provider profile is a strict bridge to Garda skills and the Node gate router.
Treat \`.agents/workflows/start-task.md\` as the shared router for every provider surface; it routes to canonical orchestration and does not replace \`80-task-workflow.md\`.
Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.
Do not execute task or review workflow with provider-default reviewer agents that bypass this bridge.

${buildTaskStartSnippetSection(runtimeProviderLabel, bridgePath)}

## Required Execution Contract
1. Read \`${canonicalFile}\` and its routing links before making changes.
2. Read \`TASK.md\` and select/create a task row before implementation.
3. Execute task workflow only in orchestrator mode: \`Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.\`
4. ${buildFreshMainAgentStartBannerSentence()}
5. Use the active profile as the default execution mode; explicit \`depth=<1|2|3>\` is only a one-run override.
6. If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.
7. Enter task mode explicitly via \`node bin/garda.js gate enter-task-mode ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} enter-task-mode ...\` inside a materialized/deployed workspace; ${runtimeIdentityInstruction}.
8. Record baseline downstream rules explicitly via \`node bin/garda.js gate load-rule-pack ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} load-rule-pack ...\` inside a materialized/deployed workspace.
9. Run handshake diagnostics via \`node bin/garda.js gate handshake-diagnostics ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} handshake-diagnostics ...\` inside a materialized/deployed workspace.
10. Run shell smoke preflight via \`node bin/garda.js gate shell-smoke-preflight ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} shell-smoke-preflight ...\` inside a materialized/deployed workspace.
11. Run preflight classification before implementation via \`node bin/garda.js gate classify-change ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} classify-change ...\` inside a materialized/deployed workspace.
12. After preflight, refresh downstream rule-pack evidence via \`node bin/garda.js gate load-rule-pack --stage "POST_PREFLIGHT" ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} load-rule-pack --stage "POST_PREFLIGHT" ...\` inside a materialized/deployed workspace.
13. Run compile gate before review via \`node bin/garda.js gate compile-gate ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} compile-gate ...\` inside a materialized/deployed workspace.
14. Before each required review, run \`node bin/garda.js gate build-review-context ...\` in a self-hosted source checkout, or \`${getNodeGateCommandPrefix()} build-review-context ...\` inside a materialized/deployed workspace; that step auto-emits \`REVIEW_PHASE_STARTED\`, \`SKILL_SELECTED\`, and \`SKILL_REFERENCE_LOADED\`. Dependent downstream review preparation or reviewer launch must wait until the required upstream PASS artifact and receipt exist for the same cycle.
15. Do not fan out known producer-consumer validation commands as raw shell sidecars around the gate flow. Flows such as \`npm run build:node-foundation\` -> direct \`node --test .node-build/...\` must use the guarded workflow path or run strictly sequentially, never in parallel.
16. Run required independent reviews and gates via \`node bin/garda.js gate required-reviews-check ...\` in a self-hosted source checkout, or \`${getNodeGateCommandPrefix()} required-reviews-check ...\` inside a materialized/deployed workspace; only independent review types may fan out in parallel for the same cycle. If a cycle changed only test scope, materialize reusable upstream \`code\` review evidence before launching \`test\`, then run \`doc-impact-gate\`, then \`completion-gate\` before marking \`DONE\`.
17. Update task status and artifacts in \`TASK.md\`.
18. Log or inspect lifecycle events by task id via \`node bin/garda.js gate log-task-event ...\` / \`task-events-summary\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} log-task-event ...\` / \`task-events-summary\` inside a materialized/deployed workspace.

## Reviewer Launch Mapping (Mandatory Delegation)
- Delegation-capable providers must spawn each required reviewer as a fresh-context sub-agent; same-agent self-review is invalid when delegation is available.
${getDelegationRequiredProviderLaunchLines().join('\n')}
- ${getConditionalDelegationProviderList()}: delegate when provider sub-agent support is available; otherwise use fallback.
- Platforms without task/sub-agent support (fallback only): run sequential isolated reviewer passes in one thread; never use provider-default reviewer agents.
- Dependency order is a launch-time contract even on delegation-capable platforms: do not launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.
- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge for the current cycle.
- Each review receipt must include \`reviewer_execution_mode\` (\`delegated_subagent\` or \`same_agent_fallback\`), \`reviewer_identity\`, and \`reviewer_fallback_reason\` when fallback mode is used.

## Skill Routing
- Orchestration: \`${resolveBundleName()}/live/skills/orchestration/SKILL.md\`
- Code review: \`${resolveBundleName()}/live/skills/code-review/SKILL.md\`
- DB review: \`${resolveBundleName()}/live/skills/db-review/SKILL.md\`
- Security review: \`${resolveBundleName()}/live/skills/security-review/SKILL.md\`
- Refactor review: \`${resolveBundleName()}/live/skills/refactor-review/SKILL.md\`

## Dynamic Skill Discovery (Required)
- Canonical skill list: \`${resolveBundleName()}/live/docs/agent-rules/90-skill-catalog.md\`
- Optional-skill capability flags: \`${resolveBundleName()}/live/config/review-capabilities.json\`
- Token-economy controls: \`${resolveBundleName()}/live/config/token-economy.json\`
- Output-filter profiles: \`${resolveBundleName()}/live/config/output-filters.json\`
- Include specialist skills added after initialization from \`${resolveBundleName()}/live/skills/**\` when required by preflight and capability flags.

## Task Timeline Logging (Required)
- Event logger: \`${getNodeGateCommandPrefix()} log-task-event ...\`
- Log file (per task): \`${resolveBundleName()}/runtime/task-events/<task-id>.jsonl\`
- Aggregate log: \`${resolveBundleName()}/runtime/task-events/all-tasks.jsonl\`

Bridge path for this provider: \`${bridgePath}\`.
${MANAGED_END}`.trim();
}

export function buildSharedStartTaskWorkflowContent(canonicalFile: string): string {
    const runtimeProviderPlaceholder = '<runtime-provider>';
    const routePlaceholder = '<provider-bridge-or-entrypoint>';
    return `${MANAGED_START}
---
description: "Mandatory shared router for any task execution through Garda orchestration."
---

# Start Task

This checklist is the shared start-task router for root entrypoints and provider bridges.
It routes to the canonical Garda workflow and does not replace \`80-task-workflow.md\` or the orchestration skill.

Before any code changes:
- Open \`${canonicalFile}\` and \`TASK.md\`.
- If an active provider bridge exists, open it too before implementation.
- ${buildFreshMainAgentStartBannerSentence()}
- ${START_BANNER_EXEMPTION_RULE}
- Move the task to \`IN_PROGRESS\`.
- Enter orchestrator mode with the canonical command: \`Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.\`
- Use the active profile as the default execution mode; explicit \`depth=<1|2|3>\` is only a one-run override.
- If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.
- Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.

${buildTaskStartSnippetSection(runtimeProviderPlaceholder, routePlaceholder)}

Mandatory gate order:
1. \`gate enter-task-mode\` with explicit runtime identity via \`--provider "<runtime-provider>"\` or \`--routed-to "<provider-bridge-or-entrypoint>"\`; never rely on canonical SourceOfTruth fallback
2. \`gate load-rule-pack --stage TASK_ENTRY\`
3. \`gate handshake-diagnostics\`
4. \`gate shell-smoke-preflight\`
5. \`gate classify-change\`
6. \`gate load-rule-pack --stage POST_PREFLIGHT\`
7. implement only after preflight
8. \`gate compile-gate\`
9. \`gate build-review-context\` for each required review
10. \`gate required-reviews-check\`
11. \`gate doc-impact-gate\`
12. \`gate full-suite-validation\` (when enabled via workflow-config.json)
13. \`gate completion-gate\`

Hard stops:
- If a mandatory gate fails or is unavailable, stop and report the exact command and stderr.
- Do not make code edits before \`enter-task-mode\`; unscoped pre-task diffs must be isolated first.
- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream PASS artifact and receipt exist for the same cycle.
- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.
- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as \`npm run build:node-foundation\` -> direct \`node --test .node-build/...\` must use the guarded workflow path or run strictly sequentially, never in parallel.
- Do not mark \`DONE\` without \`COMPLETION_GATE_PASSED\`.
- Do not create fake review artifacts or bypass reviewer routing.
- The \`40-commands.md\` preference to avoid ad-hoc manual commands does NOT exempt mandatory gates. Gates such as \`compile-gate\` must execute their underlying build/test commands when the workflow requires them.
${MANAGED_END}`.trim();
}

/**
 * Builds GitHub skill bridge agent markdown content.
 */
export function buildGitHubSkillBridgeAgentContent(
    profileTitle: string,
    canonicalFile: string,
    skillPath: string,
    reviewRequirement: string,
    capabilityFlag: string
): string {
    const reviewSkillBridgeHost = getReviewSkillBridgeHost();
    return `${MANAGED_START}
# GitHub Agent: ${profileTitle}

Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.

Hard stop: first open \`${reviewSkillBridgeHost.bridgePath}\`, \`${canonicalFile}\`, and \`TASK.md\`.
Do not implement tasks directly without orchestration preflight and required review gates.
Ignored orchestration control-plane files (for example \`TASK.md\`, \`${resolveBundleName()}/runtime/**\`, and \`${resolveBundleName()}/live/docs/changes/CHANGELOG.md\`) are expected local artifacts; never \`git add -f\` them unless the user explicitly asks to version orchestrator internals.
Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.

## Skill Bridge Contract
- Use this profile only as a bridge to skill: \`${skillPath}\`
- Required review selector: \`${reviewRequirement}\`
- Capability flag gate: \`${capabilityFlag}\`
- Re-read \`${resolveBundleName()}/live/docs/agent-rules/90-skill-catalog.md\` before execution.
- Re-read \`${resolveBundleName()}/live/config/review-capabilities.json\` before execution.
- Re-read \`${resolveBundleName()}/live/config/token-economy.json\` before execution.
- Re-read \`${resolveBundleName()}/live/config/output-filters.json\` before execution.
- Keep downstream rule-pack evidence current via \`${getNodeGateCommandPrefix()} load-rule-pack ...\`; bridge execution is invalid without recorded rule-file loading.
- Reviewer preparation must run \`${getNodeGateCommandPrefix()} build-review-context --review-type "<review-type>" ...\` before verdict capture; completion for code-changing tasks validates the resulting review-skill telemetry.
- Downstream \`test\` review must wait for current-cycle PASS evidence from required upstream non-\`test\` reviews; on pure test-scope reruns, materialize reusable upstream \`code\` review evidence first.
- On \`${reviewSkillBridgeHost.providerLabel}\`, spawn reviewer helper tasks via \`task\` tool with \`agent_type="general-purpose"\` and isolated context; same-agent self-review is invalid on this delegation-capable provider.
- Honor specialist skills added after initialization under \`${resolveBundleName()}/live/skills/**\`.
- Log review invocation and outcomes via \`${getNodeGateCommandPrefix()} log-task-event ...\` into task timeline.
- Task timeline path (per task): \`${resolveBundleName()}/runtime/task-events/<task-id>.jsonl\`.
- Review verdicts and completion status are recorded only through orchestrator workflow.
- Never mark task \`DONE\` from this profile; hand off to \`${reviewSkillBridgeHost.bridgePath}\`.
${MANAGED_END}`.trim();
}

/**
 * Merges required entries into Qwen settings JSON, preserving existing structure.
 */
export function buildQwenSettingsContent(
    existingContent: string | null | undefined,
    requiredEntries: string[] | null | undefined
): SettingsBuildResult {
    const entries = (requiredEntries || ['TASK.md', 'AGENTS.md']).filter((entry: string) => Boolean(entry && entry.trim()));
    const unique = [...new Set(entries)];
    let settingsMap: Record<string, unknown> = {};
    let needsUpdate = false;
    let parseMode: SettingsParseMode = 'default';

    if (existingContent && existingContent.trim()) {
        try {
            const parsed: unknown = JSON.parse(existingContent);
            if (isRecord(parsed)) {
                settingsMap = parsed;
                parseMode = 'merge-existing';
            } else {
                needsUpdate = true;
                parseMode = 'invalid-root';
            }
        } catch {
            needsUpdate = true;
            parseMode = 'invalid-json';
        }
    } else {
        needsUpdate = true;
    }

    const existingContext = settingsMap.context;
    const contextMap: Record<string, unknown> = isRecord(existingContext) ? existingContext : {};
    if (!isRecord(existingContext)) {
        settingsMap.context = contextMap;
        needsUpdate = true;
    }

    const currentEntries: string[] = [];
    const fileNameValue = contextMap.fileName;
    if (Array.isArray(fileNameValue)) {
        for (const item of fileNameValue) {
            if (item != null && String(item).trim()) {
                currentEntries.push(String(item).trim());
            }
        }
    }

    const existingSet = new Set(currentEntries.map((e) => e.toLowerCase()));
    for (const entry of unique) {
        if (!existingSet.has(entry.toLowerCase())) {
            currentEntries.push(entry);
            existingSet.add(entry.toLowerCase());
            needsUpdate = true;
        }
    }

    contextMap.fileName = currentEntries;
    return {
        content: JSON.stringify(settingsMap, null, 2),
        needsUpdate,
        parseMode
    };
}

/**
 * Merges required permission entries into Claude local settings JSON.
 */
export function buildClaudeLocalSettingsContent(
    existingContent: string | null | undefined,
    enableOrchestratorAccess: boolean
): SettingsBuildResult {
    const requiredAllowEntries = enableOrchestratorAccess ? [...getClaudeOrchestratorAllowEntries()] : [];
    let settingsMap: Record<string, unknown> = {};
    let needsUpdate = false;
    let parseMode: SettingsParseMode = 'default';

    if (existingContent && existingContent.trim()) {
        try {
            const parsed: unknown = JSON.parse(existingContent);
            if (isRecord(parsed)) {
                settingsMap = parsed;
                parseMode = 'merge-existing';
            } else {
                needsUpdate = true;
                parseMode = 'invalid-root';
            }
        } catch {
            needsUpdate = true;
            parseMode = 'invalid-json';
        }
    } else {
        needsUpdate = true;
    }

    const existingPermissions = settingsMap.permissions;
    const permissionsMap: Record<string, unknown> = isRecord(existingPermissions) ? existingPermissions : {};
    if (!isRecord(existingPermissions)) {
        settingsMap.permissions = permissionsMap;
        needsUpdate = true;
    }

    const allowEntries: string[] = [];
    const allowValue = permissionsMap.allow;
    if (Array.isArray(allowValue)) {
        for (const item of allowValue) {
            if (item != null && String(item).trim()) {
                allowEntries.push(String(item).trim());
            }
        }
    }

    const existingSet = new Set(allowEntries.map((e) => e.toLowerCase()));
    for (const entry of requiredAllowEntries) {
        if (!existingSet.has(entry.toLowerCase())) {
            allowEntries.push(entry);
            existingSet.add(entry.toLowerCase());
            needsUpdate = true;
        }
    }

    permissionsMap.allow = allowEntries;
    return {
        content: JSON.stringify(settingsMap, null, 2),
        needsUpdate,
        parseMode
    };
}

/**
 * Computes the set of .gitignore entries needed for a given configuration.
 *
 * When `providerMinimalism` is true, the base set is scoped to active providers only
 * instead of the full superset of all known providers.
 */
export function buildGitignoreEntries(
    activeEntryFiles: string[],
    providerOrchestratorProfiles: ProviderOrchestratorProfileLike[],
    enableClaudeOrchestratorFullAccess: boolean,
    includeQwenDirectory = false,
    providerMinimalism = false
): string[] {
    const scopedActiveFiles = providerMinimalism ? activeEntryFiles : undefined;
    const entries = new Set<string>(getManagedGitignoreEntries(enableClaudeOrchestratorFullAccess, scopedActiveFiles));

    if (includeQwenDirectory) {
        entries.add('.qwen/');
    }

    for (const entryFile of activeEntryFiles) {
        const normalized = entryFile.replace(/\\/g, '/');
        entries.add(normalized);
    }

    for (const profile of providerOrchestratorProfiles) {
        for (const entry of profile.gitignoreEntries) {
            entries.add(entry);
        }
    }

    return [...entries].sort();
}

export function buildManagedGitignoreBlock(entries: string[] | null | undefined, newline = '\n'): string {
    const normalizedEntries = [...new Set((entries || []).filter((entry) => Boolean(entry && String(entry).trim())).map((entry) => String(entry)))].sort();
    return [GITIGNORE_MANAGED_COMMENT, ...normalizedEntries].join(newline);
}

function normalizeUninstallBackupGitignoreLines(lines: string[]): string[] {
    const normalizedLines: string[] = [];
    let emittedBackupEntry = false;

    for (const line of lines) {
        const trimmed = line.trim();
        const isBackupLine = trimmed === UNINSTALL_BACKUP_GITIGNORE_COMMENT ||
            trimmed === getUninstallBackupGitignoreEntry() ||
            trimmed === getLegacyUninstallBackupGitignoreEntry();
        if (!isBackupLine) {
            normalizedLines.push(line);
            continue;
        }

        if (!emittedBackupEntry) {
            normalizedLines.push(UNINSTALL_BACKUP_GITIGNORE_COMMENT, getUninstallBackupGitignoreEntry());
            emittedBackupEntry = true;
        }
    }

    return normalizedLines;
}

function normalizeGitignoreComparableEntry(entry: string | null | undefined): string | null {
    if (!entry) {
        return null;
    }

    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    return trimmed;
}

export function syncManagedGitignoreBlockInContent(
    content: string | null | undefined,
    entries: string[],
    enableClaudeOrchestratorFullAccess: boolean
): GitignoreManagedBlockSyncResult {
    const originalContent = content || '';
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const normalizedContent = normalizeLineEndings(originalContent, '\n');
    const rawLines = normalizedContent.length > 0 ? normalizedContent.split('\n') : [];
    const lines = normalizeUninstallBackupGitignoreLines(rawLines);
    const cleanupEntrySet = new Set(getManagedGitignoreCleanupEntries(enableClaudeOrchestratorFullAccess));
    const canonicalEntries = [...new Set(entries)].sort();
    const canonicalComparableEntries = canonicalEntries
        .map((entry) => ({ entry, normalized: normalizeGitignoreComparableEntry(entry) }))
        .filter((item): item is { entry: string; normalized: string } => Boolean(item.normalized));

    let existingManagedEntries: string[] = [];
    const preservedLines: string[] = [];
    let insertionIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === GITIGNORE_MANAGED_COMMENT) {
            if (insertionIndex < 0) {
                insertionIndex = preservedLines.length;
            }
            let j = i + 1;
            while (j < lines.length && cleanupEntrySet.has(lines[j])) {
                existingManagedEntries.push(lines[j]);
                j++;
            }
            i = j - 1;
            continue;
        }
        preservedLines.push(lines[i]);
    }

    const userOwnedComparableEntries = new Set<string>();
    for (const line of preservedLines) {
        const normalized = normalizeGitignoreComparableEntry(line);
        if (normalized) {
            userOwnedComparableEntries.add(normalized);
        }
    }

    const managedEntries = canonicalComparableEntries
        .filter((item) => !userOwnedComparableEntries.has(item.normalized))
        .map((item) => item.entry);

    const canonicalBlockLines = [GITIGNORE_MANAGED_COMMENT, ...managedEntries];
    const existingManagedComparableEntries = new Set(
        existingManagedEntries
            .map((entry) => normalizeGitignoreComparableEntry(entry))
            .filter((entry): entry is string => Boolean(entry))
    );
    const addedEntries = managedEntries.filter((entry) => {
        const normalized = normalizeGitignoreComparableEntry(entry);
        return normalized ? !existingManagedComparableEntries.has(normalized) : false;
    }).length;

    let updatedLines: string[];
    if (insertionIndex >= 0) {
        updatedLines = [
            ...preservedLines.slice(0, insertionIndex),
            ...canonicalBlockLines,
            ...preservedLines.slice(insertionIndex)
        ];
    } else if (lines.length === 0) {
        updatedLines = canonicalBlockLines;
    } else {
        updatedLines = [...preservedLines];
        if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== '') {
            updatedLines.push('');
        }
        updatedLines.push(...canonicalBlockLines);
    }

    let updatedContent = updatedLines.join('\n');
    updatedContent = normalizeLineEndings(updatedContent, newline);
    if (updatedContent && !updatedContent.endsWith(newline)) {
        updatedContent += newline;
    }

    return {
        content: updatedContent,
        changed: updatedContent !== originalContent,
        addedEntries
    };
}

/**
 * Synchronizes a managed block into a file's content.
 * If the file already contains a managed block, replace it in place.
 * If the file has unrelated legacy content and no managed block, replace the file
 * entirely so the previous content lives only in install backups instead of being
 * merged with the new orchestrator contract.
 */
export function syncManagedBlockInContent(content: string | null | undefined, managedBlock: string): ManagedBlockSyncResult {
    const pattern = new RegExp(
        `${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`, 'm'
    );

    let newContent;
    if (pattern.test(content || '')) {
        newContent = (content || '').replace(pattern, managedBlock);
    } else if (!content || !content.trim()) {
        newContent = managedBlock + '\r\n';
    } else {
        newContent = managedBlock + '\r\n';
    }

    return { content: newContent, changed: newContent !== (content || '') };
}

/**
 * Directories that IDEs and language services should not index in workspaces
 * where Garda Agent Orchestrator is present.
 */
export const IDE_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
    resolveBundleName(),
    'dist',
    '.node-build',
    '.scripts-build',
    'node_modules',
    'runtime'
]);

/**
 * Merges IDE exclude patterns into VS Code settings JSON.
 * Adds entries under files.exclude, search.exclude, and files.watcherExclude
 * so generated/heavy directories do not degrade IDE responsiveness.
 */
export function buildVscodeSettingsContent(
    existingContent: string | null | undefined
): SettingsBuildResult {
    let settingsMap: Record<string, unknown> = {};
    let needsUpdate = false;
    let parseMode: SettingsParseMode = 'default';

    if (existingContent && existingContent.trim()) {
        try {
            const stripped = stripJsoncComments(existingContent);
            const parsed: unknown = JSON.parse(stripped);
            if (isRecord(parsed)) {
                settingsMap = parsed;
                parseMode = 'merge-existing';
            } else {
                needsUpdate = true;
                parseMode = 'invalid-root';
            }
        } catch {
            needsUpdate = true;
            parseMode = 'invalid-json';
        }
    } else {
        needsUpdate = true;
    }

    const excludeKeys = ['files.exclude', 'search.exclude', 'files.watcherExclude'] as const;
    for (const key of excludeKeys) {
        const existing = settingsMap[key];
        const map: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
        for (const dir of IDE_EXCLUDED_DIRECTORIES) {
            const pattern = `**/${dir}`;
            if (map[pattern] !== true) {
                map[pattern] = true;
                needsUpdate = true;
            }
        }
        settingsMap[key] = map;
    }

    return {
        content: JSON.stringify(settingsMap, null, 2),
        needsUpdate,
        parseMode
    };
}
