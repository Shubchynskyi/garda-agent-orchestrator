import * as path from 'node:path';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    isBundleRootLike,
    resolveBundleNameForTarget
} from '../../core/constants';
import { isOrchestratorSourceCheckout } from '../../gates/helpers';

interface GateHelpEntry {
    summary: string;
    usage: readonly string[];
    taskIdRemediation: boolean;
}

export interface GateHelpInfo {
    summary: string;
    usage: readonly string[];
}

const TASK_ID_PLACEHOLDER = '<task-id>';
const TASK_ID_POSITIONAL_RE = /^T-[A-Z0-9-]+$/i;
const BOOLEAN_GATE_OPTIONS = new Set([
    '--allow-plan-drift',
    '--as-json',
    '--behavior-changed',
    '--changelog-updated',
    '--compact',
    '--emit-metrics',
    '--hunk-level',
    '--include-details',
    '--include-untracked',
    '--orchestrator-work',
    '--review-output-stdin',
    '--sensitive-reviewed',
    '--sensitive-scope-reviewed',
    '--use-staged'
]);
const HELP_PREFERRED_VALUE_OPTIONS = new Set([
    '--task-id'
]);

function buildCliPrefix(repoRoot: string): string {
    return isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function resolveGateHelpRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    for (let index = 0; index < 20; index += 1) {
        if (isOrchestratorSourceCheckout(current)) {
            return current;
        }
        const bundleRoot = path.join(current, resolveBundleNameForTarget(current));
        if (isBundleRootLike(bundleRoot)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return path.resolve(startDir);
}

function buildBundleRelativePath(bundleName: string, relativePath: string): string {
    return `${bundleName}/${relativePath}`;
}

function buildTaskEntryRulePackSnippet(cliPrefix: string, bundleName: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        '--task-id "<task-id>"',
        '--stage "TASK_ENTRY"',
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--repo-root "."'
    ].join(' ');
}

function buildPostPreflightRulePackSnippet(cliPrefix: string, bundleName: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        '--task-id "<task-id>"',
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(bundleName, 'runtime/reviews/<task-id>-preflight.json')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--loaded-rule-file "<task-specific-downstream-rule-file>"',
        '--loaded-rule-file "<additional-task-specific-rule-file>"',
        '--repo-root "."'
    ].join(' ');
}

function buildGateHelpEntries(cliPrefix: string, bundleName: string): Readonly<Record<string, GateHelpEntry>> {
    return Object.freeze({
        'validate-manifest': {
            summary: 'Validate MANIFEST.md for traversal, duplicates, and out-of-root entries.',
            usage: Object.freeze([
                `${cliPrefix} gate validate-manifest --manifest-path "${buildBundleRelativePath(bundleName, 'MANIFEST.md')}"`,
                `${cliPrefix} gate validate-manifest --manifest-path "<manifest-path>" --repo-root "."`
            ]),
            taskIdRemediation: false
        },
        'validate-config': {
            summary: 'Validate a Garda JSON config artifact against the expected schema.',
            usage: Object.freeze([
                `${cliPrefix} gate validate-config --config-path "${buildBundleRelativePath(bundleName, 'live/config/<name>.json')}"`,
                `${cliPrefix} gate validate-config --config-path "<config-path>" --repo-root "."`
            ]),
            taskIdRemediation: false
        },
        'enter-task-mode': {
            summary: 'Enter explicit task mode before any implementation, with runtime identity pinned.',
            usage: Object.freeze([
                `${cliPrefix} gate enter-task-mode --task-id "${TASK_ID_PLACEHOLDER}" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --provider "<runtime-provider>" --repo-root "."`,
                `${cliPrefix} gate enter-task-mode --task-id "${TASK_ID_PLACEHOLDER}" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --start-banner "<repo-owned-banner>" --routed-to "<provider-bridge-or-entrypoint>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'load-rule-pack': {
            summary: 'Record the exact downstream rule files that were opened for the current task cycle.',
            usage: Object.freeze([
                buildTaskEntryRulePackSnippet(cliPrefix, bundleName),
                buildPostPreflightRulePackSnippet(cliPrefix, bundleName)
            ]),
            taskIdRemediation: true
        },
        'record-no-op': {
            summary: 'Record an audited no-op classification when the task intentionally produces no code changes.',
            usage: Object.freeze([
                `${cliPrefix} gate record-no-op --task-id "${TASK_ID_PLACEHOLDER}" --classification "BASELINE_ONLY" --reason "<why no code changed>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'handshake-diagnostics': {
            summary: 'Verify runtime identity, router presence, provider bridge expectations, and CLI path before preflight.',
            usage: Object.freeze([
                `${cliPrefix} gate handshake-diagnostics --task-id "${TASK_ID_PLACEHOLDER}" --provider "<runtime-provider>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'shell-smoke-preflight': {
            summary: 'Run lightweight launchability and filesystem probes before classify-change.',
            usage: Object.freeze([
                `${cliPrefix} gate shell-smoke-preflight --task-id "${TASK_ID_PLACEHOLDER}" --provider "<runtime-provider>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'command-timeout-diagnostics': {
            summary: 'Inspect command timeout records for the active task/runtime identity.',
            usage: Object.freeze([
                `${cliPrefix} gate command-timeout-diagnostics --task-id "${TASK_ID_PLACEHOLDER}" --provider "<runtime-provider>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'classify-change': {
            summary: 'Classify the intended scope before implementation and determine required review types.',
            usage: Object.freeze([
                `${cliPrefix} gate classify-change --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --changed-file "src/<file>" --output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                `${cliPrefix} gate classify-change --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --use-staged --output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'restart-coherent-cycle': {
            summary: 'Refresh preflight and downstream compile evidence for the current task after scope drift.',
            usage: Object.freeze([
                `${cliPrefix} gate restart-coherent-cycle --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --changed-file "src/<file>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'restart-review-cycle': {
            summary: 'Refresh preflight and downstream review evidence for the current task after review-era drift.',
            usage: Object.freeze([
                `${cliPrefix} gate restart-review-cycle --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --changed-file "src/<file>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'compile-gate': {
            summary: 'Run the mandatory build/typecheck/test commands selected by the guarded compile flow.',
            usage: Object.freeze([
                `${cliPrefix} gate compile-gate --task-id "${TASK_ID_PLACEHOLDER}" --commands-path "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/40-commands.md')}" --repo-root "."`,
                `${cliPrefix} gate compile-gate --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'build-scoped-diff': {
            summary: 'Materialize a review-type-specific scoped diff plus metadata for downstream reviewers.',
            usage: Object.freeze([
                `${cliPrefix} gate build-scoped-diff --review-type "<db|security|refactor|api|test|performance|infra|dependency>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-scoped.diff`)}" --repo-root "."`
            ]),
            taskIdRemediation: false
        },
        'build-review-context': {
            summary: 'Prepare reviewer rule context and emit mandatory review-skill telemetry before a review run.',
            usage: Object.freeze([
                `${cliPrefix} gate build-review-context --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --depth "<1|2|3>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
            ]),
            taskIdRemediation: false
        },
        'activate-optional-skill': {
            summary: 'Validate and record a selected optional skill activation before opening its SKILL.md for implementation work.',
            usage: Object.freeze([
                `${cliPrefix} gate activate-optional-skill --task-id "${TASK_ID_PLACEHOLDER}" --skill-id "<selected-skill-id>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'required-reviews-check': {
            summary: 'Validate that every required current-cycle review artifact and receipt is present and clean.',
            usage: Object.freeze([
                `${cliPrefix} gate required-reviews-check --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'doc-impact-gate': {
            summary: 'Record documentation impact evidence before completion.',
            usage: Object.freeze([
                `${cliPrefix} gate doc-impact-gate --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --rationale "<why>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'record-review-result': {
            summary: 'Materialize reviewer output into canonical artifacts, receipts, and routing telemetry.',
            usage: Object.freeze([
                `${cliPrefix} gate record-review-result --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --review-output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-output.md`)}" --reviewer-execution-mode "<delegated_subagent|same_agent_fallback>" --reviewer-identity "<agent:...|self:...>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'record-review-routing': {
            summary: 'Record reviewer routing metadata for a prepared review context.',
            usage: Object.freeze([
                `${cliPrefix} gate record-review-routing --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --reviewer-execution-mode "<delegated_subagent|same_agent_fallback>" --reviewer-identity "<agent:...|self:...>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'record-review-receipt': {
            summary: 'Record a review receipt when verdict capture and routing were completed externally.',
            usage: Object.freeze([
                `${cliPrefix} gate record-review-receipt --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --reviewer-execution-mode "<delegated_subagent|same_agent_fallback>" --reviewer-identity "<agent:...|self:...>" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'completion-gate': {
            summary: 'Validate final lifecycle evidence and mark the task DONE only after all mandatory gates passed.',
            usage: Object.freeze([
                `${cliPrefix} gate completion-gate --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'log-task-event': {
            summary: 'Append a structured lifecycle event to the current task timeline.',
            usage: Object.freeze([
                `${cliPrefix} gate log-task-event --task-id "${TASK_ID_PLACEHOLDER}" --event-type "PLAN_CREATED" --outcome "INFO" --message "<message>" --actor "orchestrator" --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'task-events-summary': {
            summary: 'Summarize task timeline events for audit and debugging.',
            usage: Object.freeze([
                `${cliPrefix} gate task-events-summary --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate task-events-summary --task-id "${TASK_ID_PLACEHOLDER}" --as-json --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'task-audit-summary': {
            summary: 'Build the final gate audit summary, including canonical final-closeout artifacts on PASS.',
            usage: Object.freeze([
                `${cliPrefix} gate task-audit-summary --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate task-audit-summary --task-id "${TASK_ID_PLACEHOLDER}" --as-json --repo-root "."`
            ]),
            taskIdRemediation: true
        },
        'human-commit': {
            summary: 'Run a human-authorized commit through the guarded helper path.',
            usage: Object.freeze([
                `${cliPrefix} gate human-commit --message "<commit message>" --repo-root "."`
            ]),
            taskIdRemediation: false
        },
        'validate-isolation': {
            summary: 'Validate isolation-mode configuration and task sandbox prerequisites.',
            usage: Object.freeze([
                `${cliPrefix} gate validate-isolation --repo-root "."`
            ]),
            taskIdRemediation: false
        },
        'prepare-isolation': {
            summary: 'Prepare an isolation sandbox and emit preparation telemetry.',
            usage: Object.freeze([
                `${cliPrefix} gate prepare-isolation --repo-root "."`
            ]),
            taskIdRemediation: false
        }
    });
}

function getTaskIdSyntaxMistake(argv: readonly string[]): { kind: 'flag' | 'positional'; taskId: string | null } | null {
    for (let index = 0; index < argv.length;) {
        const argument = String(argv[index] || '').trim();
        if (!argument) {
            index += 1;
            continue;
        }
        if (argument === '--task') {
            const nextValue = index + 1 < argv.length && !String(argv[index + 1] || '').startsWith('-')
                ? String(argv[index + 1] || '').trim()
                : null;
            return {
                kind: 'flag',
                taskId: nextValue && TASK_ID_POSITIONAL_RE.test(nextValue) ? nextValue : null
            };
        }
        if (argument.startsWith('--task=')) {
            const rawValue = argument.slice('--task='.length).trim();
            return {
                kind: 'flag',
                taskId: rawValue && TASK_ID_POSITIONAL_RE.test(rawValue) ? rawValue : null
            };
        }
        if (argument.startsWith('-')) {
            const consumesNextValue = (
                !argument.includes('=')
                && !BOOLEAN_GATE_OPTIONS.has(argument)
                && argument !== '-h'
                && argument !== '--help'
                && argument !== '-v'
                && argument !== '--version'
            );
            if (consumesNextValue && index + 1 < argv.length && !String(argv[index + 1] || '').startsWith('-')) {
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if (!argument.startsWith('-') && TASK_ID_POSITIONAL_RE.test(argument)) {
            return {
                kind: 'positional',
                taskId: argument
            };
        }
        index += 1;
    }
    return null;
}

function resolveSuggestedCommand(entry: GateHelpEntry, mistakenTaskId: string | null): string {
    const taskId = mistakenTaskId && TASK_ID_POSITIONAL_RE.test(mistakenTaskId)
        ? mistakenTaskId
        : TASK_ID_PLACEHOLDER;
    return entry.usage[0].split(TASK_ID_PLACEHOLDER).join(taskId);
}

export function buildGateHelpText(gateName: string, repoRoot = process.cwd()): string {
    const entry = getGateHelpEntry(gateName, repoRoot);
    if (!entry) {
        throw new Error(`Unknown gate: ${gateName}`);
    }
    return [
        `Gate: ${gateName}`,
        entry.summary,
        '',
        'Usage:',
        ...entry.usage.map((line) => `  ${line}`),
        '',
        'Options:',
        '  -h, --help     Show this gate help and exit.'
    ].join('\n');
}

export function getGateHelpEntry(gateName: string, repoRoot = process.cwd()): GateHelpInfo {
    const resolvedRepoRoot = resolveGateHelpRepoRoot(repoRoot);
    const entry = buildGateHelpEntries(
        buildCliPrefix(resolvedRepoRoot),
        resolveBundleNameForTarget(resolvedRepoRoot)
    )[gateName];
    if (!entry) {
        throw new Error(`Unknown gate: ${gateName}`);
    }
    return {
        summary: entry.summary,
        usage: [...entry.usage]
    };
}

export function hasStandaloneGateHelpFlag(argv: readonly string[]): boolean {
    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index] || '').trim();
        if (argument !== '-h' && argument !== '--help') {
            continue;
        }
        const previous = String(argv[index - 1] || '').trim();
        if (
            previous.startsWith('-')
            && !previous.includes('=')
            && !BOOLEAN_GATE_OPTIONS.has(previous)
            && previous !== '-h'
            && previous !== '--help'
            && previous !== '-v'
            && previous !== '--version'
        ) {
            if (
                HELP_PREFERRED_VALUE_OPTIONS.has(previous)
                && index === argv.length - 1
            ) {
                return true;
            }
            continue;
        }
        return true;
    }
    return false;
}

export function buildTaskIdSyntaxRemediationMessage(
    gateName: string,
    gateArgv: readonly string[],
    repoRoot = process.cwd()
): string | null {
    const resolvedRepoRoot = resolveGateHelpRepoRoot(repoRoot);
    const entry = buildGateHelpEntries(
        buildCliPrefix(resolvedRepoRoot),
        resolveBundleNameForTarget(resolvedRepoRoot)
    )[gateName];
    if (!entry || !entry.taskIdRemediation) {
        return null;
    }
    const mistake = getTaskIdSyntaxMistake(gateArgv);
    if (!mistake) {
        return null;
    }
    const mistakenToken = mistake.kind === 'flag'
        ? '--task'
        : (mistake.taskId || TASK_ID_PLACEHOLDER);
    const explanation = mistake.kind === 'flag'
        ? `Unknown option: ${mistakenToken}. Canonical task-id syntax for '${gateName}' uses '--task-id', not '--task'.`
        : `Unexpected positional argument: ${mistakenToken}. Canonical task-id syntax for '${gateName}' requires '--task-id "<task-id>"', not a positional task id.`;
    return [
        explanation,
        `Suggested command: ${resolveSuggestedCommand(entry, mistake.taskId)}`
    ].join(' ');
}
