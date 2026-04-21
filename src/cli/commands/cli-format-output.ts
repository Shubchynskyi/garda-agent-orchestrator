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

export function printStatus(snapshot: StatusSnapshot, options?: { heading?: string }): void {
    const heading = (options && options.heading) || 'GARDA_STATUS';
    console.log(heading);
    console.log(bold(getWorkspaceHeadline(snapshot)));
    console.log(`Project: ${snapshot.targetRoot}`);
    console.log(`Bundle: ${snapshot.bundlePath}`);
    console.log(`InitAnswers: ${snapshot.initAnswersResolvedPath}`);
    console.log(`CollectedVia: ${snapshot.collectedVia || 'n/a'}`);
    if (snapshot.activeAgentFiles) console.log(`ActiveAgentFiles: ${snapshot.activeAgentFiles}`);
    console.log(`SourceOfTruth: ${snapshot.sourceOfTruth || 'n/a'}${snapshot.canonicalEntrypoint ? ` -> ${snapshot.canonicalEntrypoint}` : ''}`);
    if (snapshot.activeProfile) console.log(`ActiveProfile: ${snapshot.activeProfile}`);
    console.log('');
    console.log(bold('Workspace Stages'));
    console.log(`  ${getStageBadge(snapshot.bundlePresent)} Installed`);
    console.log(`  ${getStageBadge(snapshot.primaryInitializationComplete, { warning: snapshot.bundlePresent && !snapshot.primaryInitializationComplete })} Primary initialization`);
    console.log(`  ${getStageBadge(snapshot.agentInitializationComplete, { warning: snapshot.primaryInitializationComplete && !snapshot.agentInitializationComplete })} Agent initialization`);

    if (snapshot.parityResult.isSourceCheckout) {
        console.log(`  ${getStageBadge(!snapshot.parityResult.isStale, { warning: snapshot.parityResult.isStale })} Source parity (Self-hosted)`);
        if (snapshot.parityResult.isStale) {
            for (const violation of snapshot.parityResult.violations) {
                console.log(`    Violation: ${violation}`);
            }
        }
    }

    console.log(`  ${getStageBadge(snapshot.readyForTasks, { warning: snapshot.agentInitializationComplete && !snapshot.readyForTasks })} Ready for task execution`);
    if (snapshot.agentInitializationPendingReason === 'AGENT_HANDOFF_REQUIRED') {
        printHighlightedPair('NextStage:', 'Launch your agent with AGENT_INIT_PROMPT.md');
    } else if (snapshot.agentInitializationPendingReason === 'LANGUAGE_CONFIRMATION_PENDING') {
        console.log('  Pending checkpoint: Confirm assistant language during AGENT_INIT_PROMPT flow');
    } else if (snapshot.agentInitializationPendingReason === 'ACTIVE_AGENT_FILES_PENDING') {
        console.log('  Pending checkpoint: Confirm active agent files during AGENT_INIT_PROMPT flow');
    } else if (snapshot.agentInitializationPendingReason === 'AGENT_STATE_STALE') {
        console.log('  Pending checkpoint: Agent-init state no longer matches current init answers');
    } else if (snapshot.agentInitializationPendingReason === 'PROJECT_RULES_PENDING') {
        console.log('  Pending checkpoint: Update project-specific live rules before finalizing agent init');
    } else if (snapshot.agentInitializationPendingReason === 'SKILLS_PROMPT_PENDING') {
        console.log('  Pending checkpoint: Ask the built-in specialist skills question before finalizing agent init');
    } else if (snapshot.agentInitializationPendingReason === 'VALIDATION_PENDING') {
        console.log('  Pending checkpoint: Final agent-init validation has not passed yet');
    } else if (snapshot.agentInitializationPendingReason === 'AGENT_STATE_INVALID') {
        console.log('  Pending checkpoint: Repair invalid agent-init state file');
    } else if (snapshot.agentInitializationPendingReason === 'PROJECT_COMMANDS_PENDING') {
        console.log(`  Missing project commands: ${snapshot.missingProjectCommands.length}`);
    }
    if (snapshot.initAnswersError) console.log(`InitAnswersStatus: INVALID (${snapshot.initAnswersError})`);
    if (snapshot.liveVersionError) console.log(`LiveVersionStatus: INVALID (${snapshot.liveVersionError})`);
    if (snapshot.agentInitStateError) console.log(`AgentInitStateStatus: INVALID (${snapshot.agentInitStateError})`);
    if (snapshot.agentInitializationPendingReason === 'PROJECT_COMMANDS_PENDING') {
        console.log(`CommandsRule: ${snapshot.commandsRulePath}`);
        printHighlightedPair('CommandsStatus:', 'PENDING_AGENT_CONTEXT');
    }
    printHighlightedPair('RecommendedNextCommand:', snapshot.recommendedNextCommand);
    console.log('');
    printCommandSummary();
}

export function printCommandSummary(): void {
    console.log(bold('Available Commands'));
    for (const [name, description] of COMMAND_SUMMARY) {
        console.log(`  ${padRight(name, 10)} ${description}`);
    }
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
