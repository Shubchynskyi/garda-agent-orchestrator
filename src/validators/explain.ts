import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathExists } from '../core/fs';
import { getBundleCliCommand, PRIMARY_CLI_NAME, PRIMARY_PACKAGE_NAME, resolveBundleName } from '../core/constants';

export interface ExplainEntry {
    id: string;
    title: string;
    description: string;
    remediation: string[];
    seeAlso?: string[];
}

export interface ExplainResult {
    found: boolean;
    failureId: string;
    entry: ExplainEntry | null;
    suggestions: string[];
}

/**
 * Canonical remediation database for known failure IDs.
 * IDs are normalised to upper-case before lookup.
 */
let cachedExplainDatabase: readonly ExplainEntry[] | null = null;

function getExplainDatabase(): readonly ExplainEntry[] {
    if (cachedExplainDatabase) return cachedExplainDatabase;
    const bn = resolveBundleName();
    cachedExplainDatabase = Object.freeze([
    {
        id: 'BUNDLE_MISSING',
        title: 'Deployed bundle not found',
        description: `The ${bn} bundle directory is missing from the target root.`,
        remediation: [
            `Run 'npx ${PRIMARY_PACKAGE_NAME}' or 'npx ${PRIMARY_PACKAGE_NAME} setup' to deploy the bundle.`,
            "Ensure you are running commands from the correct target root (--target-root)."
        ]
    },
    {
        id: 'INIT_ANSWERS_MISSING',
        title: 'Init answers artifact not found',
        description: 'The runtime/init-answers.json artifact does not exist. The agent-init flow has not been completed.',
        remediation: [
            `Run setup: 'npx ${PRIMARY_PACKAGE_NAME} setup --target-root "."'`,
            `Or re-provide answers: 'npx ${PRIMARY_PACKAGE_NAME} setup' and complete the interactive flow.`
        ]
    },
    {
        id: 'INIT_ANSWERS_INVALID',
        title: 'Init answers artifact is invalid',
        description: 'The runtime/init-answers.json file exists but contains invalid or incomplete JSON.',
        remediation: [
            "Re-run setup to recreate the artifact.",
            "Check for JSON syntax errors by opening runtime/init-answers.json in an editor.",
            "If the file was hand-edited, validate it against the init-answers JSON schema."
        ]
    },
    {
        id: 'AGENT_HANDOFF_REQUIRED',
        title: 'Agent handoff required',
        description: 'Primary initialization is complete but the agent has not yet been launched with AGENT_INIT_PROMPT.md.',
        remediation: [
            "Launch your AI agent and provide it the contents of AGENT_INIT_PROMPT.md.",
            "The agent must complete the onboarding checklist and record agent-init-state.json.",
            `Then run '${PRIMARY_CLI_NAME} agent-init' to finalise initialization.`
        ]
    },
    {
        id: 'AGENT_STATE_STALE',
        title: 'Agent init state is stale',
        description: 'The agent-init-state.json no longer matches the current init-answers.json values.',
        remediation: [
            "Re-run the AGENT_INIT_PROMPT.md flow with your agent.",
            `Or run '${PRIMARY_CLI_NAME} reinit' if init answers need updating.`,
            `Then run '${PRIMARY_CLI_NAME} agent-init' to resynchronize the state.`
        ]
    },
    {
        id: 'AGENT_STATE_INVALID',
        title: 'Agent init state file is corrupt or unreadable',
        description: 'The runtime/agent-init-state.json file exists but cannot be parsed or is structurally invalid.',
        remediation: [
            "Delete runtime/agent-init-state.json and re-run the AGENT_INIT_PROMPT.md flow.",
            "Check the file for JSON syntax errors."
        ]
    },
    {
        id: 'LANGUAGE_CONFIRMATION_PENDING',
        title: 'Assistant language not confirmed',
        description: 'The AGENT_INIT_PROMPT flow has not yet confirmed the AssistantLanguage setting.',
        remediation: [
            "Open AGENT_INIT_PROMPT.md with your agent and complete the language confirmation step.",
            `Then run '${PRIMARY_CLI_NAME} agent-init --assistant-language "<language>"' to record the confirmation.`
        ]
    },
    {
        id: 'ACTIVE_AGENT_FILES_PENDING',
        title: 'Active agent files not confirmed',
        description: 'The agent-init flow has not yet confirmed which agent entrypoint files are active.',
        remediation: [
            "Re-open AGENT_INIT_PROMPT.md and confirm the active agent files.",
            `Then run '${PRIMARY_CLI_NAME} agent-init --active-agent-files "<comma-separated list>"'.`
        ]
    },
    {
        id: 'PROJECT_RULES_PENDING',
        title: 'Project rules have not been updated',
        description: 'The agent-init flow requires project-specific live rules to be updated before finalization.',
        remediation: [
            "Open the relevant live rule files (e.g. 40-commands.md) and fill in project-specific placeholders.",
            `Then run '${PRIMARY_CLI_NAME} agent-init --project-rules-updated yes'.`
        ]
    },
    {
        id: 'SKILLS_PROMPT_PENDING',
        title: 'Skills prompt has not been completed',
        description: 'The built-in specialist skills question was not asked during agent-init.',
        remediation: [
            "Ask your agent: 'Does this project need any specialist skill packs?'",
            `Use '${PRIMARY_CLI_NAME} skills list' to see available packs.`,
            `Then run '${PRIMARY_CLI_NAME} agent-init --skills-prompted yes'.`
        ]
    },
    {
        id: 'PROJECT_COMMANDS_PENDING',
        title: 'Project commands section is incomplete',
        description: 'The 40-commands.md file still contains placeholder project commands that need to be filled in.',
        remediation: [
            `Open ${bn}/live/docs/agent-rules/40-commands.md.`,
            "Replace placeholder entries in the 'Project Commands' section with actual commands.",
            `Run '${PRIMARY_CLI_NAME} doctor' again to verify after editing.`
        ]
    },
    {
        id: 'VALIDATION_PENDING',
        title: 'Workspace validation has not passed',
        description: 'Verify or manifest validation has not been run or did not pass.',
        remediation: [
            `Run '${PRIMARY_CLI_NAME} doctor' to identify specific verification failures.`,
            `Fix the listed violations, then run '${PRIMARY_CLI_NAME} verify' and '${PRIMARY_CLI_NAME} doctor' again.`
        ]
    },
    {
        id: 'MISSING_PATHS',
        title: 'Required paths are missing from the workspace',
        description: 'One or more files or directories that the orchestrator requires are absent.',
        remediation: [
            `Run '${PRIMARY_CLI_NAME} doctor' to see the full list of missing paths.`,
            `Run '${PRIMARY_CLI_NAME} update' or '${PRIMARY_CLI_NAME} reinit' to restore expected bundle structure.`,
            "If paths were intentionally removed, check whether the init-answers match the active agent files."
        ]
    },
    {
        id: 'RULE_FILE_VIOLATIONS',
        title: 'Rule file contract violations detected',
        description: 'One or more live rule files are missing required content snippets.',
        remediation: [
            `Run '${PRIMARY_CLI_NAME} verify' for the exact list of violations.`,
            `Run '${PRIMARY_CLI_NAME} update' to pull the latest rule file templates.`,
            "If rules were hand-edited, compare with the reference copies in the template/ directory."
        ]
    },
    {
        id: 'MANIFEST_MISSING',
        title: 'MANIFEST.md not found',
        description: 'The MANIFEST.md file is absent from the bundle.',
        remediation: [
            `Run '${PRIMARY_CLI_NAME} update' to restore the manifest.`,
            `Or run '${PRIMARY_CLI_NAME} gate validate-manifest' and review the output for details.`
        ]
    },
    {
        id: 'MANIFEST_INVALID',
        title: 'MANIFEST.md failed validation',
        description: 'The MANIFEST.md file exists but has invalid entries.',
        remediation: [
            `Run '${PRIMARY_CLI_NAME} gate validate-manifest --manifest-path MANIFEST.md' for details.`,
            'Fix path traversal, duplicate, or out-of-root entries.',
            `Then run '${PRIMARY_CLI_NAME} doctor' again.`
        ]
    },
    {
        id: 'TASK_MODE_NOT_ENTERED',
        title: 'Task mode was not explicitly entered',
        description: 'The enter-task-mode gate was not run for this task, so compile/review/completion gates will fail.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<summary>" --start-banner "<repo-owned-banner>"`,
            "Do this before any preflight or implementation work."
        ]
    },
    {
        id: 'RULE_PACK_NOT_LOADED',
        title: 'Rule pack evidence is missing',
        description: 'The load-rule-pack gate was not run, so downstream gates cannot prove that required rules were read.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "<rule-file>"`,
            "Include all rule files that were actually opened at task entry."
        ]
    },
    {
        id: 'PREFLIGHT_MISSING',
        title: 'Preflight classification artifact not found',
        description: 'The classify-change gate has not been run for this task.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate classify-change --changed-file "<file>" --task-intent "<summary>" --output-path "${bn}/runtime/reviews/<task-id>-preflight.json"`,
            "Or use --use-staged in a dirty workspace."
        ]
    },
    {
        id: 'COMPILE_GATE_FAILED',
        title: 'Compile gate failed',
        description: 'The build step raised errors. The task cannot move to IN_REVIEW until the compile gate passes.',
        remediation: [
            "Fix all TypeScript or build errors shown in the compile output.",
            "Run 'npm run build' locally to confirm the build succeeds.",
            `Re-run: ${getBundleCliCommand(bn)} gate compile-gate --task-id "<task-id>" --commands-path "${bn}/live/docs/agent-rules/40-commands.md"`
        ]
    },
    {
        id: 'REVIEW_GATE_FAILED',
        title: 'Required review gate failed',
        description: 'One or more required review verdicts are missing or returned FAILED.',
        remediation: [
            `Check ${bn}/runtime/reviews/<task-id>-code.md (or -db.md, -security.md, -refactor.md) for findings.`,
            "Fix all blocking findings.",
            `Re-run the relevant reviewer skill and then run: ${getBundleCliCommand(bn)} gate required-reviews-check ...`
        ]
    },
    {
        id: 'COMPLETION_GATE_FAILED',
        title: 'Completion gate failed',
        description: 'One or more completion gate conditions are not satisfied.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate completion-gate --task-id "<task-id>" and read the failure list.`,
            "Common causes: missing lifecycle events, unresolved findings in review artifacts, missing doc-impact gate.",
            "Fix each listed issue and re-run the completion gate."
        ]
    },
    {
        id: 'TIMELINE_INCOMPLETE',
        title: 'Task timeline is incomplete',
        description: 'The task event log is missing one or more mandatory lifecycle events.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate task-events-summary --task-id "<task-id>" to see which events are missing.`,
            "Re-run the appropriate gate commands to emit the missing events.",
            "Do not manually backfill events unless recovery tooling explicitly requires it."
        ]
    },
    {
        id: 'TIMELINE_INTEGRITY_FAILED',
        title: 'Task timeline integrity check failed',
        description: 'The task event JSONL file has hash-chain violations indicating tampering or replay.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate task-events-summary --task-id "<task-id>" for details.`,
            "Do not edit JSONL files manually.",
            "If the timeline is unrecoverable, mark the task BLOCKED with blocked_reason_code=TIMELINE_CORRUPT."
        ]
    },
    {
        id: 'DOC_IMPACT_MISSING',
        title: 'Documentation impact gate not run',
        description: 'The doc-impact-gate was not executed before the completion gate.',
        remediation: [
            `Run: ${getBundleCliCommand(bn)} gate doc-impact-gate --task-id "<task-id>" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --rationale "<why>"`,
            "Or if docs were changed: --decision \"DOCS_UPDATED\" --behavior-changed true --changelog-updated true"
        ]
    }
    ]);
    return cachedExplainDatabase;
}

function normalizeFailureId(rawId: string): string {
    return rawId.trim().toUpperCase().replace(/[-\s]+/g, '_');
}

function findSuggestions(normalizedId: string): string[] {
    const suggestions: string[] = [];
    for (const entry of getExplainDatabase()) {
        if (entry.id.includes(normalizedId) || normalizedId.includes(entry.id.slice(0, 6))) {
            suggestions.push(entry.id);
        }
    }
    return suggestions.slice(0, 5);
}

export function explainFailure(rawFailureId: string): ExplainResult {
    const normalizedId = normalizeFailureId(rawFailureId);
    const entry = getExplainDatabase().find((e) => e.id === normalizedId) || null;

    if (entry) {
        return { found: true, failureId: normalizedId, entry, suggestions: [] };
    }

    const suggestions = findSuggestions(normalizedId);
    return { found: false, failureId: normalizedId, entry: null, suggestions };
}

export function listExplainIds(): string[] {
    return getExplainDatabase().map((e) => e.id);
}

export function formatExplainResult(result: ExplainResult): string {
    const lines: string[] = [];

    if (!result.found || !result.entry) {
        lines.push(`ExplainFailure: UNKNOWN_ID`);
        lines.push(`FailureId: ${result.failureId}`);
        lines.push('');
        lines.push('No remediation entry found for this failure ID.');
        if (result.suggestions.length > 0) {
            lines.push('');
            lines.push('Did you mean one of:');
            for (const suggestion of result.suggestions) {
                lines.push(`  - ${suggestion}`);
            }
        }
        lines.push('');
        lines.push('Available failure IDs:');
        for (const id of listExplainIds()) {
            lines.push(`  ${id}`);
        }
        return lines.join('\n');
    }

    const entry = result.entry;
    lines.push(`ExplainFailure: ${entry.id}`);
    lines.push(`Title: ${entry.title}`);
    lines.push('');
    lines.push('Description:');
    lines.push(`  ${entry.description}`);
    lines.push('');
    lines.push('Remediation steps:');
    for (let i = 0; i < entry.remediation.length; i++) {
        lines.push(`  ${i + 1}. ${entry.remediation[i]}`);
    }
    if (entry.seeAlso && entry.seeAlso.length > 0) {
        lines.push('');
        lines.push('See also:');
        for (const ref of entry.seeAlso) {
            lines.push(`  - ${ref}`);
        }
    }
    return lines.join('\n');
}

/**
 * Scan a doctor output file or runtime review directory for failure IDs and
 * return those that have explain entries, to give quick remediation hints.
 */
export function scanRuntimeForKnownFailures(bundlePath: string): string[] {
    const knownIds: string[] = [];
    const reviewsRoot = path.join(bundlePath, 'runtime', 'reviews');

    if (!pathExists(reviewsRoot)) {
        return knownIds;
    }

    let entries: string[];
    try {
        entries = fs.readdirSync(reviewsRoot).filter((name: string) => name.endsWith('.json'));
    } catch {
        return knownIds;
    }

    for (const entry of entries) {
        let parsed: Record<string, unknown>;
        try {
            const raw = fs.readFileSync(path.join(reviewsRoot, entry), 'utf8');
            parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            continue;
        }

        const status = String(parsed.status || parsed.outcome || '').toUpperCase();
        if (status === 'FAILED' || status === 'FAIL') {
            if (entry.includes('-task-mode')) {
                knownIds.push('TASK_MODE_NOT_ENTERED');
            } else if (entry.includes('-rule-pack')) {
                knownIds.push('RULE_PACK_NOT_LOADED');
            } else if (entry.includes('-preflight')) {
                knownIds.push('PREFLIGHT_MISSING');
            } else if (entry.includes('-compile-gate')) {
                knownIds.push('COMPILE_GATE_FAILED');
            } else if (entry.includes('-review-gate')) {
                knownIds.push('REVIEW_GATE_FAILED');
            } else if (entry.includes('-doc-impact')) {
                knownIds.push('DOC_IMPACT_MISSING');
            }
        }
    }

    return Array.from(new Set(knownIds));
}
