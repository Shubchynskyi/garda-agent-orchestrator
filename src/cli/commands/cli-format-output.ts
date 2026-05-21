import * as readline from 'node:readline';
import {
    ALL_CLI_NAMES,
    DEFAULT_BUNDLE_NAME,
    PRIMARY_CLI_NAME,
    PRIMARY_PACKAGE_NAME,
    PRODUCT_ACRONYM,
    PRODUCT_ACRONYM_EXPANSION,
    PRODUCT_NAME
} from '../../core/constants';
import { formatStatusSnapshot, type StatusSnapshot as DetailedStatusSnapshot } from '../../validators/status';
import { COMMAND_SUMMARY } from './cli-constants';
import type {
    HighlightedPairOptions,
    PackageJsonLike,
    PromptSingleSelectConfig,
    PromptSingleSelectOption,
    StatusSnapshot
} from './cli-types';

export function applyNoColorFlag(noColor: boolean): void {
    if (noColor) {
        process.env.NO_COLOR = '1';
    }
}

export function supportsColor(): boolean {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.FORCE_COLOR !== undefined) return true;
    return Boolean(process.stdout && process.stdout.isTTY);
}

export function colorize(text: string, code: string): string {
    return supportsColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function bold(text: string): string { return colorize(text, '1'); }
export function green(text: string): string { return colorize(text, '32'); }
export function cyan(text: string): string { return colorize(text, '36'); }
export function yellow(text: string): string { return colorize(text, '33'); }
export function red(text: string): string { return colorize(text, '31'); }
export function dim(text: string): string { return colorize(text, '2'); }

export interface AgentReportInput {
    context: 'setup_handoff' | 'agent_init' | 'task_closeout';
    assistantLanguage: string | null;
    assistantLanguageConfirmed?: boolean | null;
    profileSummary?: string | null;
    reviewModeSummary?: string | null;
    optionalSkillsSummary?: string | null;
    mandatoryFullSuiteEnabled?: boolean | null;
    nextCommand?: string | null;
    nextTaskPrompt?: string | null;
    latestUpdateNotice?: string | null;
}

export interface AgentReportMessages {
    titles: Record<AgentReportInput['context'], string>;
    labels: {
        language: string;
        profile: string;
        reviewMode: string;
        optionalSkills: string;
        mandatoryFullSuite: string;
        nextCommand: string;
        nextTaskPrompt: string;
        updateNotice: string;
        noLanguage: string;
        noProfile: string;
    };
    statuses: {
        normalized: string;
        pendingConfirmation: string;
        unknown: string;
    };
    fullSuite: {
        enabled: string;
        disabled: string;
        unknown: string;
    };
    summaries: {
        mandatoryOrchestratorGates: string;
        askDuringAgentInit: string;
        confirmedDuringAgentInit: string;
        pendingDuringAgentInit: string;
        independentReviewAttested: string;
        localReview: string;
        noRequiredReview: string;
        verdicts: string;
        selected: string;
        recommendedPacks: string;
        noAdditionalSkills: string;
        unavailable: string;
        noneUsed: string;
        reason: string;
    };
}

const AGENT_REPORT_MESSAGES: AgentReportMessages = {
    titles: {
        setup_handoff: 'Setup handoff',
        agent_init: 'Agent-init summary',
        task_closeout: 'Task closeout'
    },
    labels: {
        language: 'Language',
        profile: 'Profile',
        reviewMode: 'Review mode',
        optionalSkills: 'Optional skills',
        mandatoryFullSuite: 'Mandatory full-suite',
        nextCommand: 'Next command',
        nextTaskPrompt: 'Tell the agent',
        updateNotice: 'Latest update notice',
        noLanguage: 'not recorded',
        noProfile: 'not configured'
    },
    statuses: {
        normalized: 'normalized',
        pendingConfirmation: 'pending confirmation',
        unknown: 'unknown'
    },
    fullSuite: {
        enabled: 'enabled',
        disabled: 'disabled',
        unknown: 'unknown'
    },
    summaries: {
        mandatoryOrchestratorGates: 'mandatory orchestrator gates',
        askDuringAgentInit: 'ask during AGENT_INIT_PROMPT',
        confirmedDuringAgentInit: 'confirmed during agent-init',
        pendingDuringAgentInit: 'still pending in agent-init',
        independentReviewAttested: 'independent review attested',
        localReview: 'local review',
        noRequiredReview: 'no required review',
        verdicts: 'verdicts',
        selected: 'selected',
        recommendedPacks: 'recommended packs',
        noAdditionalSkills: 'no additional skills',
        unavailable: 'unavailable',
        noneUsed: 'none used',
        reason: 'reason'
    }
};

function formatAgentReportTitle(
    context: AgentReportInput['context']
): string {
    return AGENT_REPORT_MESSAGES.titles[context];
}

function formatAgentReportLanguageStatus(
    confirmed?: boolean | null
): string {
    const messages = AGENT_REPORT_MESSAGES;
    if (confirmed === true) return messages.statuses.normalized;
    if (confirmed === false) return messages.statuses.pendingConfirmation;
    return messages.statuses.unknown;
}

function formatAgentReportFullSuite(
    enabled: boolean | null | undefined
): string {
    const messages = AGENT_REPORT_MESSAGES;
    if (enabled === true) return messages.fullSuite.enabled;
    if (enabled === false) return messages.fullSuite.disabled;
    return messages.fullSuite.unknown;
}

export function buildAgentReportBlock(input: AgentReportInput): string {
    const labels = AGENT_REPORT_MESSAGES.labels;

    const lines = [
        'GARDA_AGENT_REPORT',
        formatAgentReportTitle(input.context),
        `${labels.language}: ${(input.assistantLanguage || labels.noLanguage)} (${formatAgentReportLanguageStatus(input.assistantLanguageConfirmed)})`,
        `${labels.profile}: ${input.profileSummary || labels.noProfile}`
    ];

    if (input.reviewModeSummary) {
        lines.push(`${labels.reviewMode}: ${input.reviewModeSummary}`);
    }
    if (input.optionalSkillsSummary) {
        lines.push(`${labels.optionalSkills}: ${input.optionalSkillsSummary}`);
    }
    if (input.mandatoryFullSuiteEnabled !== undefined && input.mandatoryFullSuiteEnabled !== null) {
        lines.push(`${labels.mandatoryFullSuite}: ${formatAgentReportFullSuite(input.mandatoryFullSuiteEnabled)}`);
    }
    if (input.nextCommand) {
        lines.push(`${labels.nextCommand}: ${input.nextCommand}`);
    }
    if (input.nextTaskPrompt) {
        lines.push(`${labels.nextTaskPrompt}: ${input.nextTaskPrompt}`);
    }
    if (input.latestUpdateNotice) {
        lines.push(`${labels.updateNotice}: ${input.latestUpdateNotice}`);
    }

    return lines.join('\n');
}

export function padRight(text: string, width: number): string {
    return String(text).padEnd(width, ' ');
}

export function printHighlightedPair(label: string, value: string, options?: HighlightedPairOptions): void {
    const labelColor = (options && options.labelColor) || yellow;
    const valueColor = (options && options.valueColor) || green;
    const indent = (options && options.indent) || '';
    console.log(`${indent}${labelColor(label)} ${valueColor(value)}`);
}

export function supportsInteractivePrompts(): boolean {
    return Boolean(process.stdin && process.stdout && process.stdin.isTTY && process.stdout.isTTY);
}

export function readLineInput(promptText: string): Promise<string> {
    return new Promise<string>((resolve): void => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(promptText, (value: string): void => {
            rl.close();
            resolve(String(value || '').trim());
        });
    });
}

export async function promptTextInput(title: string, defaultValue: string): Promise<string> {
    const answer = await readLineInput(`${yellow(`${title} [default: ${defaultValue}]:`)} `);
    const resolvedValue = answer || defaultValue;
    console.log(green(`Selected: ${resolvedValue}`));
    return resolvedValue;
}

export async function promptSingleSelect(config: PromptSingleSelectConfig): Promise<string> {
    const { title, defaultLabel, options, defaultValue } = config;
    if (!supportsInteractivePrompts()) {
        throw new Error('Interactive setup requires a TTY terminal.');
    }
    const defaultIndex = Math.max(0, options.findIndex((option: PromptSingleSelectOption): boolean => option.value === defaultValue));
    console.log(yellow(title));
    console.log(`Default: ${defaultLabel}.`);
    options.forEach((option: PromptSingleSelectOption, index: number): void => {
        console.log(`  ${index + 1}. ${option.label}`);
    });
    while (true) {
        const answer = await readLineInput(`Select option [1-${options.length}] (Enter = ${defaultIndex + 1}): `);
        if (!answer) {
            console.log(green(`Selected: ${options[defaultIndex].label}`));
            return options[defaultIndex].value;
        }
        if (/^\d+$/.test(answer)) {
            const numericIndex = Number.parseInt(answer, 10) - 1;
            if (numericIndex >= 0 && numericIndex < options.length) {
                console.log(green(`Selected: ${options[numericIndex].label}`));
                return options[numericIndex].value;
            }
        }
        console.log(red(`Invalid selection. Enter a number between 1 and ${options.length}.`));
    }
}

export function printBanner(
    packageJson: PackageJsonLike,
    title: string,
    subtitle: string,
    options?: { versionOverride?: string | null }
): void {
    const width = 62;
    const top = `+${'-'.repeat(width - 2)}+`;
    const titleText = ' GARDA AGENT ORCHESTRATOR ';
    const effectiveVersion = options && options.versionOverride !== undefined
        ? options.versionOverride
        : packageJson.version;
    const versionText = effectiveVersion ? `v${effectiveVersion}` : '';
    const titleLine = versionText
        ? `|${padRight(titleText, width - versionText.length - 3)} ${versionText}|`
        : `|${padRight(titleText, width - 2)}|`;
    console.log(cyan(top));
    console.log(cyan(titleLine));
    console.log(cyan(top));
    if (title) console.log(bold(title));
    if (subtitle) console.log(dim(subtitle));
}

export function buildBannerText(
    packageJson: PackageJsonLike,
    title: string,
    subtitle: string,
    options?: { versionOverride?: string | null }
): string {
    const width = 62;
    const top = `+${'-'.repeat(width - 2)}+`;
    const titleText = ' GARDA AGENT ORCHESTRATOR ';
    const effectiveVersion = options && options.versionOverride !== undefined
        ? options.versionOverride
        : packageJson.version;
    const versionText = effectiveVersion ? `v${effectiveVersion}` : '';
    const titleLine = versionText
        ? `|${padRight(titleText, width - versionText.length - 3)} ${versionText}|`
        : `|${padRight(titleText, width - 2)}|`;
    const lines = [top, titleLine, top];
    if (title) lines.push(title);
    if (subtitle) lines.push(subtitle);
    return lines.join('\n');
}

export function getStageBadge(completed: boolean, options?: { warning?: boolean }): string {
    const warning = (options && options.warning) || false;
    const label = completed ? '[x]' : '[ ]';
    if (completed) return green(label);
    if (warning) return yellow(label);
    return dim(label);
}

export function getWorkspaceHeadline(snapshot: StatusSnapshot): string {
    if (snapshot.readyForTasks) return green('Workspace ready');
    if (snapshot.primaryInitializationComplete) return yellow('Agent setup required');
    if (snapshot.bundlePresent) return yellow('Primary setup required');
    return red('Not installed');
}

function getLineFormattingType(line: string): 'headline' | 'section' | 'badge' | 'kvpair' | 'other' {
    if (line === 'Workspace ready' || line === 'Agent setup required' || 
        line === 'Primary setup required' || line === 'Not installed' ||
        line.startsWith('Error')) {
        return 'headline';
    }
    if (line === 'Workspace Stages' || line === 'Toxin Metrics') {
        return 'section';
    }
    if (line.includes('[x]') || line.includes('[~]') || line.includes('[ ]')) {
        return 'badge';
    }
    // Dynamic kvpair detection: matches "Key: value" pattern (starts with word followed by colon)
    if (/^[A-Za-z][A-Za-z0-9]*:\s/.test(line)) {
        return 'kvpair';
    }
    return 'other';
}

export function applyStatusFormatting(text: string): string {
    const lines = text.split('\n');
    const formatted = lines.map((line, index) => {
        // First line: heading
        if (index === 0) {
            return line;
        }
        
        const lineType = getLineFormattingType(line);
        
        if (lineType === 'headline') {
            return bold(line);
        }
        if (lineType === 'section') {
            return bold(line);
        }
        if (lineType === 'badge') {
            let formatted = line;
            formatted = formatted.replace(/\[x\]/g, green('[x]'));
            formatted = formatted.replace(/\[~\]/g, yellow('[~]'));
            formatted = formatted.replace(/\[ \]/g, dim('[ ]'));
            return formatted;
        }
        if (lineType === 'kvpair') {
            const colonIndex = line.indexOf(':');
            if (colonIndex !== -1) {
                const label = line.substring(0, colonIndex);
                const value = line.substring(colonIndex + 1).trim();
                return `${yellow(label + ':')} ${green(value)}`;
            }
        }
        
        return line;
    });
    return formatted.join('\n');
}

export function printStatus(snapshot: DetailedStatusSnapshot, options?: { heading?: string }): void {
    const formatted = formatStatusSnapshot(snapshot, options);
    const withColors = applyStatusFormatting(formatted);
    console.log(withColors);
    console.log('');
    printCommandSummary();
}

export function printCommandSummary(): void {
    for (const line of buildCommandSummaryLines()) {
        console.log(line);
    }
}

export function buildCommandSummaryLines(): string[] {
    const lines = [bold('Available Commands')];
    for (const [name, description] of COMMAND_SUMMARY) {
        lines.push(`  ${cyan(padRight(name, 10))} ${dim(description)}`);
    }
    return lines;
}

export type GuardedCommandHelpName = 'agent-init' | 'skills' | 'review-capabilities' | 'templates' | 'profile' | 'workflow';
export type CommandHelpName =
    | GuardedCommandHelpName
    | 'stats'
    | 'task'
    | 'html'
    | 'ui'
    | 'off'
    | 'on'
    | 'status'
    | 'doctor'
    | 'debug'
    | 'cleanup'
    | 'repair'
    | 'gc'
    | 'clean';

interface CommandHelpDescriptor {
    readonly summary: string;
    readonly usage: readonly string[];
    readonly examples: readonly string[];
    readonly hints?: readonly string[];
}

const COMMAND_HELP: Readonly<Record<CommandHelpName, CommandHelpDescriptor>> = Object.freeze({
    'agent-init': Object.freeze({
        summary: 'Finalize mandatory agent onboarding after AGENT_INIT_PROMPT work is complete.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} agent-init --active-agent-files "<file1>,<file2>" --project-rules-updated true|false --skills-prompted true|false [--ordinary-doc-paths "<path-or-glob,...>"] [--target-root PATH] [--bundle-root PATH] [--init-answers-path PATH]`,
            `${PRIMARY_CLI_NAME} status`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} agent-init --active-agent-files "AGENTS.md,AGENT_INIT_PROMPT.md" --project-rules-updated true --skills-prompted true --ordinary-doc-paths "CHANGELOG.md,docs/plan.md"`
        ]),
        hints: Object.freeze([
            'This command has no subcommands and requires explicit completion flags.',
            'Complete the AGENT_INIT_PROMPT style-policy question before running this command; final answer tokens remain exactly default or custom.',
            'Confirm --ordinary-doc-paths only after explaining they are auditable planning/changelog doc exceptions, not a global ignore list.',
            'Use status first if you need to confirm whether agent-init is still required.'
        ])
    }),
    skills: Object.freeze({
        summary: 'List, suggest, add, remove, and validate optional built-in skill packs.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} skills [list] [--target-root PATH] [--bundle-root PATH]`,
            `${PRIMARY_CLI_NAME} skills suggest --task-text "<task summary>" [--changed-path src/<file>] [--limit N]`,
            `${PRIMARY_CLI_NAME} skills add <pack-id> | remove <pack-id> | validate`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} skills`,
            `${PRIMARY_CLI_NAME} skills suggest --task-text "Improve parity-blocked command discoverability"`
        ]),
        hints: Object.freeze([
            'Default mode: skills with no subcommand behaves like skills list.'
        ])
    }),
    'review-capabilities': Object.freeze({
        summary: 'Show, enable, and disable repo-local optional review capabilities.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} review-capabilities [show|list] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} review-capabilities enable <api|test|performance|infra|dependency> [<capability> ...]`,
            `${PRIMARY_CLI_NAME} review-capabilities disable <api|test|performance|infra|dependency> [<capability> ...]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} review-capabilities`,
            `${PRIMARY_CLI_NAME} review-capabilities list`,
            `${PRIMARY_CLI_NAME} review-capabilities enable api test`
        ]),
        hints: Object.freeze([
            'Default mode: review-capabilities with no subcommand behaves like review-capabilities show.',
            'The list alias behaves like review-capabilities show.'
        ])
    }),
    templates: Object.freeze({
        summary: 'Show, validate, and manage user-owned message template overrides.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} templates [list] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} templates show --template final-report|commit-message|reviewer-prompt [--json]`,
            `${PRIMARY_CLI_NAME} templates path --template final-report|commit-message|reviewer-prompt`,
            `${PRIMARY_CLI_NAME} templates edit --template final-report|commit-message|reviewer-prompt`,
            `${PRIMARY_CLI_NAME} templates validate [--template final-report|commit-message|reviewer-prompt] [--json]`,
            `${PRIMARY_CLI_NAME} templates reset --template final-report|commit-message|reviewer-prompt`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} templates list`,
            `${PRIMARY_CLI_NAME} templates show --template final-report`,
            `${PRIMARY_CLI_NAME} templates edit --template commit-message`,
            `${PRIMARY_CLI_NAME} templates validate`
        ]),
        hints: Object.freeze([
            'Default mode: templates with no subcommand behaves like templates list.',
            'User overrides may change wording, but effective templates preserve protected workflow sections and required placeholders.',
            'The edit action creates or reports the user-owned override path; it does not open an interactive editor.'
        ])
    }),
    profile: Object.freeze({
        summary: 'List, switch, create, delete, and validate workspace profiles.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} profile [current|list|validate] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} profile use <name>`,
            `${PRIMARY_CLI_NAME} profile create <name> [--description TEXT] [--depth 1|2|3] [--copy-from <existing>]`,
            `${PRIMARY_CLI_NAME} profile delete <name>`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} profile`,
            `${PRIMARY_CLI_NAME} profile use balanced`
        ]),
        hints: Object.freeze([
            'Default mode: profile with no subcommand behaves like profile current.'
        ])
    }),
    workflow: Object.freeze({
        summary: 'Show and set repo-local workflow config.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} workflow [show] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} workflow set [--full-suite on|off|--full-suite-enabled true|false] [--full-suite-command CMD] [--full-suite-placement after_compile_before_reviews|before_test_review|before_completion] [--review-execution-policy MODE] [--scope-budget on|off|--scope-budget-enabled true|false] [--scope-budget-action BLOCK_FOR_SPLIT|WARN_ONLY] [--scope-budget-profiles LIST] [--scope-budget-max-files N] [--scope-budget-max-changed-lines N] [--scope-budget-max-required-reviews N] [--scope-budget-max-review-tokens N] [--review-cycle on|off|--review-cycle-enabled true|false] [--review-cycle-action BLOCK_FOR_OPERATOR_DECISION|WARN_ONLY] [--review-cycle-max-failed-non-test-reviews N] [--review-cycle-max-total-non-test-reviews N] [--review-cycle-excluded-review-types LIST] [--review-cycle-auto-split on|off|--review-cycle-auto-split-enabled true|false] [--project-memory on|off|--project-memory-enabled true|false] [--project-memory-mode off|check|update|strict] [--project-memory-run-before-final-closeout on|off] [--project-memory-require-user-approval-for-writes on|off] [--project-memory-max-compact-summary-chars N] [--project-memory-read-strategy index_first] [--project-memory-impact-artifact-retention-days N] [--task-reset on|off|--task-reset-enabled true|false] [--garda-self-guard on|off] --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} workflow`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite-enabled true --full-suite-command "npm test" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite-placement before_test_review --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --review-execution-policy strict_sequential --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --scope-budget on --scope-budget-max-changed-lines 1200 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --scope-budget-max-review-tokens 50000 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --review-cycle-enabled true --review-cycle-max-total-non-test-reviews 30 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --review-cycle-auto-split on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --project-memory on --project-memory-mode update --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --task-reset on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --garda-self-guard on`,
            `${PRIMARY_CLI_NAME} workflow set --garda-self-guard off --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`
        ]),
        hints: Object.freeze([
            'Default mode: workflow with no subcommand behaves like workflow show.',
            'Review execution policy modes: parallel_all, test_after_code, code_first_optional, strict_sequential.',
            'Scope budget guard actions: BLOCK_FOR_SPLIT, WARN_ONLY.',
            'Scope budget guard can block oversized tasks before compile/review loops.',
            'Review cycle guard can block runaway non-test review attempts; fresh defaults allow 15 failed non-test reviews and 30 total non-test reviews, with test review excluded by default.',
            'Short aliases map exactly to existing boolean settings: --full-suite, --scope-budget, --review-cycle, --review-cycle-auto-split, --project-memory, and --task-reset accept on|off.',
            'Review cycle auto split is disabled by default and can be enabled with --review-cycle-auto-split on.',
            'Project memory maintenance defaults to update mode; use off, check, update, or strict mode for explicit repo-local policy.',
            'Task reset mutations are disabled by default and can be enabled with --task-reset on.',
            'Garda self-guard defaults to on for application workspaces and blocks agent self-entry into --orchestrator-work.',
            'workflow set writes require --operator-confirmed yes and --operator-confirmed-at-utc after explicit operator approval; agents must not approve workflow-config mutations for themselves.'
        ])
    }),
    stats: Object.freeze({
        summary: 'Show token-overhead and runtime analytics per task or across all tasks.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} stats "<task-id>" [--target-root PATH] [--events-root PATH] [--reviews-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} stats [--task-id "<task-id>"] [--target-root PATH] [--events-root PATH] [--reviews-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} stats --json`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} stats`,
            `${PRIMARY_CLI_NAME} stats "T-001"`,
            `${PRIMARY_CLI_NAME} stats --task-id "T-001"`,
            `${PRIMARY_CLI_NAME} stats --json`
        ]),
        hints: Object.freeze([
            'Default mode: stats with no task id prints aggregate task analytics.',
            'Use a positional task id or --task-id for task-specific statistics.'
        ])
    }),
    task: Object.freeze({
        summary: 'Inspect one task through read-only stats and event timeline views.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} task "<task-id>" stats [--target-root PATH] [--events-root PATH] [--reviews-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} task "<task-id>" events [--repo-root PATH] [--events-root PATH] [--reviews-root PATH] [--include-details] [--as-json]`,
            `${PRIMARY_CLI_NAME} task help`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} task "T-001" stats`,
            `${PRIMARY_CLI_NAME} task "T-001" events`,
            `${PRIMARY_CLI_NAME} task "T-001" events --include-details`
        ]),
        hints: Object.freeze([
            'This namespace is read-only and does not change task lifecycle state.',
            'Use stats for task metrics and events for the task timeline.',
            'The events action does not expose --output-path; use the gate command directly when you intentionally need an artifact.'
        ])
    }),
    html: Object.freeze({
        summary: 'Write a static read-only HTML report and print its browser link.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} html [--target-root PATH] [--output-path PATH] [--snapshot] [--retain-snapshots N] [--max-detailed-tasks N] [--json]`,
            `${PRIMARY_CLI_NAME} html --output-path "garda-agent-orchestrator/runtime/reports/garda-report.html" --snapshot --retain-snapshots 5`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} html`,
            `${PRIMARY_CLI_NAME} html --target-root "."`,
            `${PRIMARY_CLI_NAME} html --snapshot --retain-snapshots 5`,
            `${PRIMARY_CLI_NAME} html --max-detailed-tasks 0`,
            `${PRIMARY_CLI_NAME} html --json`
        ]),
        hints: Object.freeze([
            'The report is read-only: it reads TASK.md, workflow config, and existing runtime logs/artifacts.',
            'Default output is garda-agent-orchestrator/runtime/reports/garda-report.html.',
            'Use --snapshot to keep a timestamped copy under runtime/reports/snapshots; --retain-snapshots N keeps the newest N snapshots.',
            'Deep per-task runtime details are lazy for static reports and skipped by default so large histories return promptly; use --max-detailed-tasks N for a heavier snapshot.',
            'Open the printed file URL in a browser; no local server is started.'
        ])
    }),
    ui: Object.freeze({
        summary: 'Start a localhost UI with lazy task-detail loading and optional allow-listed actions.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} ui [--target-root PATH] [--port PORT] [--language en|ru] [--idle-minutes N] [--idle-warning-seconds N] [--no-idle-shutdown] [--read-only] [--actions]`,
            `${PRIMARY_CLI_NAME} ui --target-root "."`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} ui`,
            `${PRIMARY_CLI_NAME} ui --target-root "."`,
            `${PRIMARY_CLI_NAME} ui --port 17340`,
            `${PRIMARY_CLI_NAME} ui --language ru`,
            `${PRIMARY_CLI_NAME} ui --idle-minutes 15 --idle-warning-seconds 60`,
            `${PRIMARY_CLI_NAME} ui --no-idle-shutdown`,
            `${PRIMARY_CLI_NAME} ui --actions`
        ]),
        hints: Object.freeze([
            'The UI server binds only to 127.0.0.1 and prints a browser URL.',
            'The process stays in the foreground; stop it with Ctrl+C or the guarded Server Status stop action.',
            'Idle shutdown is server-owned by default: browser activity pings reset the timer, then a warning countdown appears before the process closes.',
            'The UI chrome supports English and Russian with English fallback; commands, task IDs, config keys, enum values, paths, and raw output stay untranslated.',
            'After shutdown the page cannot launch a replacement server; rerun garda ui --target-root "." from a terminal.',
            'Task details are loaded on demand through read-only local JSON endpoints.',
            'By default the browser cannot run commands, mutate workflow state, or edit settings.',
            '--actions exposes only allow-listed Garda commands with preview, confirmation for mutating actions, and runtime audit events.'
        ])
    }),
    off: Object.freeze({
        summary: 'Hide Garda root agent instruction files without uninstalling the deployed bundle.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} off [--target-root PATH] [--dry-run]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} off --dry-run`,
            `${PRIMARY_CLI_NAME} off --target-root "."`
        ]),
        hints: Object.freeze([
            'Moves Garda-owned root agent entrypoints into runtime/switch/off and restores user-owned alternatives from runtime/switch/on.',
            'TASK.md remains visible. The deployed bundle remains installed.',
            'Conflicts fail closed without overwriting user files; run --dry-run first when checking a workspace.'
        ])
    }),
    on: Object.freeze({
        summary: 'Restore Garda root agent instruction files after off mode.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} on [--target-root PATH] [--dry-run]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} on --dry-run`,
            `${PRIMARY_CLI_NAME} on --target-root "."`
        ]),
        hints: Object.freeze([
            'Moves user-owned root alternatives into runtime/switch/on and restores Garda-owned files from runtime/switch/off.',
            'Removes the managed .agentignore block created by off mode.',
            'Conflicts fail closed without overwriting user files; run --dry-run first when checking a workspace.'
        ])
    }),
    status: Object.freeze({
        summary: 'Show current project status without changing files.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} status [--target-root PATH] [--bundle-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} status`,
            `${PRIMARY_CLI_NAME} status --json`
        ]),
        hints: Object.freeze([
            'Status is read-only and is safe to run before task work.'
        ])
    }),
    doctor: Object.freeze({
        summary: 'Run verify plus manifest validation using existing init answers.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} doctor [--target-root PATH] [--bundle-root PATH] [--json] [--cleanup-stale-locks] [--dry-run]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} doctor`,
            `${PRIMARY_CLI_NAME} doctor --cleanup-stale-locks --dry-run`
        ]),
        hints: Object.freeze([
            'Doctor is for diagnostics and validation; use --dry-run when checking cleanup behavior.'
        ])
    }),
    debug: Object.freeze({
        summary: 'Show environment and runtime triage snapshots for bug reports.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} debug env [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} debug env`,
            `${PRIMARY_CLI_NAME} debug env --json`
        ]),
        hints: Object.freeze([
            'Default help lists the debug namespace. The currently supported debug subcommand is env.'
        ])
    }),
    cleanup: Object.freeze({
        summary: 'Remove stale runtime artifacts and inspect tiered retention policy.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} cleanup [--target-root PATH] [--dry-run] [--confirm] [--max-age-days N] [--max-backups N] [--max-working-plans N] [--max-aggregate-lines N] [--max-metrics-lines N]`,
            `${PRIMARY_CLI_NAME} cleanup policy [show|edit] [--target-root PATH]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} cleanup --dry-run`,
            `${PRIMARY_CLI_NAME} cleanup policy`,
            `${PRIMARY_CLI_NAME} cleanup policy edit`
        ]),
        hints: Object.freeze([
            'Use dry-run first when removing runtime artifacts.',
            'Runtime retention tiers are active evidence, ledger history for healthy DONE tasks, compressed forensic evidence for problem tasks, and confirmed purge.',
            'Clean-success compile/full-suite raw logs may be omitted at gate time; warnings, failures, and non-clean runs retain raw output.',
            'Working-plan cleanup is limited to runtime/plans/*.md and preserves active task plans.',
            'The policy subcommand is the human-facing review-artifact storage policy editor/viewer.'
        ])
    }),
    repair: Object.freeze({
        summary: 'Inspect and rebuild derived runtime indexes, protected manifests, and stale lock state.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} repair [inspect] [--target-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} repair rebuild-indexes [--target-root PATH] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair protected-manifest [--target-root PATH] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair locks [--target-root PATH] [--cleanup-stale] [--confirm] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} repair inspect`,
            `${PRIMARY_CLI_NAME} repair rebuild-indexes`,
            `${PRIMARY_CLI_NAME} repair rebuild-indexes --confirm`,
            `${PRIMARY_CLI_NAME} repair locks --cleanup-stale`,
            `${PRIMARY_CLI_NAME} repair protected-manifest --confirm`
        ]),
        hints: Object.freeze([
            'inspect is read-only and names canonical versus derived runtime state.',
            'rebuild-indexes and protected-manifest are dry-run by default; pass --confirm to write.',
            'locks reports task-event, review-artifact, and completion-finalization locks; cleanup only removes proven-stale task-event/review-artifact locks after --cleanup-stale --confirm.'
        ])
    }),
    gc: Object.freeze({
        summary: 'Extended cleanup with dry-run default, retention tiers, stale locks, and generated-zone cleanup.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} gc [--target-root PATH] [--category NAME] [--max-age-days N] [--max-working-plans N] [--max-aggregate-lines N] [--max-metrics-lines N] [--confirm]`,
            `${PRIMARY_CLI_NAME} clean [--target-root PATH] [--category NAME] [--confirm]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} gc`,
            `${PRIMARY_CLI_NAME} gc --category reviews`,
            `${PRIMARY_CLI_NAME} gc --category stale-locks`,
            `${PRIMARY_CLI_NAME} gc --confirm`
        ]),
        hints: Object.freeze([
            'gc is dry-run by default; pass --confirm to apply retention-approved removal or compression.',
            'Healthy DONE task compaction requires verified ledger evidence; problem tasks keep recovery-readable evidence and compress only heavy forensic artifacts.',
            'Full purge is never automatic; use explicit confirmed cleanup after reviewing the dry-run output.',
            'Use --category plans to limit cleanup to retained runtime working-plan files.'
        ])
    }),
    clean: Object.freeze({
        summary: 'Alias for gc extended cleanup.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} clean [--target-root PATH] [--category NAME] [--max-age-days N] [--max-working-plans N] [--max-aggregate-lines N] [--max-metrics-lines N] [--confirm]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} clean`,
            `${PRIMARY_CLI_NAME} clean --confirm`
        ]),
        hints: Object.freeze([
            'clean is an alias for gc and is dry-run by default unless --confirm is passed.'
        ])
    })
});

function styleHelpToken(token: string): string {
    const trimmed = token.trim();
    const normalized = trimmed.replace(/^[[(]+|[\]),]+$/g, '');
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed.startsWith('--') || trimmed.startsWith('[--')) {
        return yellow(trimmed);
    }
    if (
        normalized === PRIMARY_CLI_NAME
        || normalized === PRIMARY_PACKAGE_NAME
        || normalized === 'node'
        || normalized.endsWith('garda.js')
        || [
            'setup', 'agent-init', 'status', 'doctor', 'debug', 'stats', 'task', 'html', 'ui', 'off', 'on', 'bootstrap', 'install', 'init', 'reinit',
            'update', 'rollback', 'uninstall', 'cleanup', 'repair', 'gc', 'clean', 'verify', 'check-update', 'skills',
            'review-capabilities', 'templates', 'profile', 'workflow', 'diff-managed', 'gate', 'show', 'set', 'list', 'current',
            'use', 'create', 'delete', 'validate', 'suggest', 'add', 'remove', 'enable', 'disable', 'edit', 'reset',
            'inspect', 'rebuild-indexes', 'protected-manifest', 'locks',
            'events'
        ].includes(normalized)
    ) {
        return cyan(trimmed);
    }
    if (
        normalized.startsWith('<')
        || normalized.startsWith('[')
        || normalized.includes('|')
        || normalized === 'PATH'
        || normalized === 'TEXT'
        || normalized === 'CMD'
        || normalized === 'N'
    ) {
        return dim(trimmed);
    }
    return trimmed;
}

export function styleHelpCommandLine(line: string): string {
    return line
        .split(/\s+/)
        .map((token) => styleHelpToken(token))
        .join(' ');
}

export function isKnownCommandHelpName(commandName: string): commandName is CommandHelpName {
    return Object.prototype.hasOwnProperty.call(COMMAND_HELP, commandName);
}

export function buildCommandHelpText(commandName: CommandHelpName): string {
    const entry = COMMAND_HELP[commandName];
    const lines: string[] = [];
    lines.push('GARDA_COMMAND_HELP');
    lines.push(cyan(commandName));
    lines.push(dim(entry.summary));
    lines.push('');
    lines.push(bold('Usage'));
    for (const usageLine of entry.usage) {
        lines.push(`  ${styleHelpCommandLine(usageLine)}`);
    }
    if (entry.hints && entry.hints.length > 0) {
        lines.push('');
        lines.push(bold('Hints'));
        for (const hint of entry.hints) {
            lines.push(`  ${dim(hint)}`);
        }
    }
    lines.push('');
    lines.push(bold('Examples'));
    for (const exampleLine of entry.examples) {
        lines.push(`  ${green(exampleLine)}`);
    }
    return lines.join('\n');
}

export function buildGuardedCommandHelpText(commandName: GuardedCommandHelpName): string {
    return buildCommandHelpText(commandName);
}

export function buildParityBlockedCommandText(options: {
    commandName: string;
    helpText: string;
    violations: readonly string[];
    remediation: string | null | undefined;
}): string {
    const lines: string[] = [];
    lines.push(red('PARITY_BLOCKED'));
    lines.push(red(`BlockedCommand: ${options.commandName}`));
    lines.push(red('Source Parity Violation: The deployed bundle is stale compared to the source checkout.'));
    if (options.violations.length > 0) {
        lines.push('');
        lines.push(bold('Detected drift'));
        for (const violation of options.violations) {
            lines.push(`  ${red(violation)}`);
        }
    }
    if (options.remediation) {
        lines.push('');
        lines.push(bold('Fix'));
        lines.push(`  ${green(options.remediation)}`);
    }
    lines.push('');
    lines.push(options.helpText);
    return lines.join('\n');
}

export function printHelp(packageJson: PackageJsonLike): void {
    console.log(buildHelpText(packageJson));
}

export function buildHelpText(packageJson: PackageJsonLike): string {
    const sections = [
        [
            `${PRODUCT_NAME} CLI v${packageJson.version}`,
            'Usage:',
            `  ${PRIMARY_PACKAGE_NAME}`,
            `  ${PRIMARY_PACKAGE_NAME} setup [options]`,
            `  ${PRIMARY_PACKAGE_NAME} status [options]`,
            `  ${PRIMARY_PACKAGE_NAME} COMMAND [options]`
        ],
        [
            'Commands:',
            '  setup         First-run onboarding: deploy/refresh bundle, collect init answers, run install, and validate manifest.',
            '  agent-init    Finalize mandatory agent onboarding after AGENT_INIT_PROMPT work is complete.',
            '  preprompt     Read-only task bootstrap context and exact next commands.',
            '  next-step     Show the deterministic next command for a task.',
            '  status        Show current project status without changing files.',
            '  doctor        Run verify + manifest validation using existing init answers.',
            '  debug env     Show environment and runtime triage snapshot for bug reports.',
            '  stats         Show token-overhead and runtime analytics per task or across all tasks.',
            '  task          Inspect one task via read-only stats and event timeline views.',
            '  html          Write a static read-only HTML report and print its browser link.',
            '  ui            Start a read-only localhost UI with lazy task details.',
            '  off           Hide Garda root agent instruction files without uninstalling.',
            '  on            Restore Garda root agent instruction files after off mode.',
            '  bootstrap     Deploy the bundle only.',
            '  install       Deploy or refresh the bundle and run the Node install pipeline.',
            '  init          Re-materialize live/ from an existing deployed bundle.',
            '  reinit        Re-ask or override init answers for an existing deployed bundle.',
            '  update        Check for updates and optionally apply them (npm by default).',
            '  update git    Apply update from a git repo or local git clone.',
            '  rollback      Rollback to a specific version or restore from the latest rollback snapshot.',
            '  uninstall     Remove the deployed orchestrator bundle and managed files.',
            '  cleanup       Remove stale runtime artifacts and manage review-artifact storage policy.',
            '  repair        Inspect and rebuild runtime indexes, protected manifests, and stale lock state.',
            '  gc            Extended cleanup with dry-run default, allowlist, stale locks, and isolation sandbox (alias: clean).',
            '  verify        Validate deployment consistency and rule contracts.',
            '  check-update  Compare current deployment with a newer npm package or local source.',
            '  skills        List, suggest, add, remove, and validate optional built-in skill packs.',
            '  review-capabilities  Show, enable, and disable repo-local optional review capabilities.',
            '  templates     Show, validate, and manage user-owned message template overrides.',
            '  workflow      Show and set repo-local workflow config.',
            '  profile       List, use, create, delete, and validate workspace profiles.',
            '  diff-managed  Show managed vs user-owned block ownership across workspace files.',
            '  gate          Run an agent gate or helper command.'
        ],
        [
            'Global options:',
            '  -h, --help                 Show this help message.',
            '  -v, --version              Show the package version.',
            '      --no-color             Disable colored output (honors NO_COLOR env var).',
            `      --bundle-name NAME     Override deployed bundle directory name (default: ${DEFAULT_BUNDLE_NAME}; env: GARDA_BUNDLE_NAME).`,
            '      --offline              Block network-sensitive commands (env: GARDA_OFFLINE=1).',
            '      --force-network        Override --offline for a single invocation.'
        ],
        [
            'Shared lifecycle options:',
            '      --target-root PATH           Workspace root. Defaults to the current working directory.',
            '      --init-answers-path PATH     Path inside the workspace to agent-produced init answers.'
        ],
        [
            'Bootstrap/install source override options:',
            '      --repo-url URL               Clone bundle source from a repo instead of the packaged bundle.',
            '      --branch NAME                Clone a specific branch for branch testing.'
        ],
        [
            'Update source override options:',
            '      --package-spec SPEC          npm package spec, version tag, or local .tgz for check-update/update.',
            '      --source-path PATH           Local unpacked bundle root for check-update/update testing.',
            '      --check-only                 Compare a git source without applying the update.',
            '      --to-version VERSION         Update or rollback to a specific version.',
            '      --repo-url URL               Compare against or update from a git repo.',
            '      --branch NAME                Compare against or update from a git branch.',
            `      --snapshot-path PATH         Explicit rollback snapshot path for \`${PRIMARY_CLI_NAME} rollback\`.`
        ],
        [
            'Notes:',
            '  - setup/install/bootstrap act on the current working directory unless --target-root is provided.',
            '  - update compares installed vs available bundle versions and prints a summary before applying changes.',
            '  - rollback without --to-version restores the latest saved pre-update snapshot; with --to-version it acquires that version, syncs the bundle, and re-materializes the workspace.',
            '  - older snapshots created before rollback metadata persistence cannot be restored automatically.',
            '  - cleanup uses retention defaults (30 days, 20 backups, 50 task events, 100 review sets, 100 working plans, 10 update reports, 5 rollbacks, 5 bundle backups, 10000 aggregate task-event lines, 2000 metrics lines); override with --max-age-days, --max-backups, --max-working-plans, --max-aggregate-lines, and --max-metrics-lines.',
            '  - runtime retention is tiered: active evidence is preserved, healthy DONE tasks can compact to ledger history after verified ledger evidence, problem tasks keep recovery-readable evidence and compress heavy forensic artifacts, and purge requires explicit confirmation.',
            '  - clean-success compile/full-suite raw logs may be intentionally omitted at gate time; retained summaries still record status, duration, hashes, and line/char counts.',
            `  - use \`${PRIMARY_CLI_NAME} cleanup policy edit\` for the dialog-first review-artifact storage policy editor, or \`${PRIMARY_CLI_NAME} cleanup policy\` to inspect current settings.`,
            '  - gc/clean is dry-run by default; pass --confirm to apply retention-approved removal or compression. Supports --category, --max-working-plans, --max-aggregate-lines, and --max-metrics-lines.',
            `  - running \`${PRIMARY_CLI_NAME} profile create\` with no profile name in a TTY starts the full interactive profile builder.`,
            `  - use \`${PRIMARY_CLI_NAME} help <command>\` or \`${PRIMARY_CLI_NAME} <command> help\` for command-specific usage.`,
            `  - use \`${PRIMARY_CLI_NAME} gate help <gate-name>\` or \`${PRIMARY_CLI_NAME} gate <gate-name> --help\` for gate-specific usage.`,
            `  - ${PRODUCT_ACRONYM} = ${PRODUCT_ACRONYM_EXPANSION}. Available command names: ${ALL_CLI_NAMES.join(', ')}.`
        ]
    ];

    return sections.map((section) => section.join('\n')).join('\n\n');
}

export function getAgentReportMessages(): AgentReportMessages { return AGENT_REPORT_MESSAGES; }
