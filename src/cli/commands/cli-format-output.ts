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

type GuardedCommandHelpName = 'agent-init' | 'skills' | 'review-capabilities' | 'profile' | 'workflow';

interface GuardedCommandHelpDescriptor {
    readonly summary: string;
    readonly usage: readonly string[];
    readonly examples: readonly string[];
    readonly hints?: readonly string[];
}

const GUARDED_COMMAND_HELP: Readonly<Record<GuardedCommandHelpName, GuardedCommandHelpDescriptor>> = Object.freeze({
    'agent-init': Object.freeze({
        summary: 'Finalize mandatory agent onboarding after AGENT_INIT_PROMPT work is complete.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} agent-init --active-agent-files "<file1>,<file2>" --project-rules-updated true|false --skills-prompted true|false [--target-root PATH] [--bundle-root PATH] [--init-answers-path PATH]`,
            `${PRIMARY_CLI_NAME} status`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} agent-init --active-agent-files "AGENTS.md,AGENT_INIT_PROMPT.md" --project-rules-updated true --skills-prompted true`
        ]),
        hints: Object.freeze([
            'This command has no subcommands and requires explicit completion flags.',
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
            `${PRIMARY_CLI_NAME} workflow set [--full-suite-enabled true|false] [--full-suite-command CMD] [--review-execution-policy MODE] [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} workflow`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite-enabled true --full-suite-command "npm test"`,
            `${PRIMARY_CLI_NAME} workflow set --review-execution-policy strict_sequential`
        ]),
        hints: Object.freeze([
            'Default mode: workflow with no subcommand behaves like workflow show.',
            'Review execution policy modes: parallel_all, test_after_code, code_first_optional, strict_sequential.'
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
            'setup', 'agent-init', 'status', 'doctor', 'debug', 'stats', 'bootstrap', 'install', 'init', 'reinit',
            'update', 'rollback', 'uninstall', 'cleanup', 'gc', 'clean', 'verify', 'check-update', 'skills',
            'review-capabilities', 'profile', 'workflow', 'diff-managed', 'gate', 'show', 'set', 'list', 'current',
            'use', 'create', 'delete', 'validate', 'suggest', 'add', 'remove', 'enable', 'disable'
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

export function buildGuardedCommandHelpText(commandName: GuardedCommandHelpName): string {
    const entry = GUARDED_COMMAND_HELP[commandName];
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
            '  bootstrap     Deploy the bundle only.',
            '  install       Deploy or refresh the bundle and run the Node install pipeline.',
            '  init          Re-materialize live/ from an existing deployed bundle.',
            '  reinit        Re-ask or override init answers for an existing deployed bundle.',
            '  update        Check for updates and optionally apply them (npm by default).',
            '  update git    Apply update from a git repo or local git clone.',
            '  rollback      Rollback to a specific version or restore from the latest rollback snapshot.',
            '  uninstall     Remove the deployed orchestrator bundle and managed files.',
            '  cleanup       Remove stale runtime artifacts and manage review-artifact storage policy.',
            '  gc            Extended cleanup with dry-run default, allowlist, stale locks, and isolation sandbox (alias: clean).',
            '  verify        Validate deployment consistency and rule contracts.',
            '  check-update  Compare current deployment with a newer npm package or local source.',
            '  skills        List, suggest, add, remove, and validate optional built-in skill packs.',
            '  review-capabilities  Show, enable, and disable repo-local optional review capabilities.',
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
            '  - cleanup uses retention defaults (30 days, 20 backups, 50 task events, 100 review sets, 10 update reports, 5 rollbacks, 5 bundle backups, 10000 aggregate task-event lines); override with --max-age-days, --max-backups, and --max-aggregate-lines.',
            `  - use \`${PRIMARY_CLI_NAME} cleanup policy edit\` for the dialog-first review-artifact storage policy editor, or \`${PRIMARY_CLI_NAME} cleanup policy\` to inspect current settings.`,
            '  - gc/clean is dry-run by default; pass --confirm to actually delete. Supports --category and --max-aggregate-lines.',
            `  - running \`${PRIMARY_CLI_NAME} profile create\` with no profile name in a TTY starts the full interactive profile builder.`,
            `  - ${PRODUCT_ACRONYM} = ${PRODUCT_ACRONYM_EXPANSION}. Available command names: ${ALL_CLI_NAMES.join(', ')}.`
        ]
    ];

    return sections.map((section) => section.join('\n')).join('\n\n');
}

export function getAgentReportMessages(): AgentReportMessages { return AGENT_REPORT_MESSAGES; }
