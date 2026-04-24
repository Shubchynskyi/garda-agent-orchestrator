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

export type AgentReportLocale = 'en' | 'ru' | 'de' | 'fr' | 'es';

export interface LocalizedAgentReportInput {
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

interface AgentReportMessages {
    titles: Record<LocalizedAgentReportInput['context'], string>;
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

const AGENT_REPORT_MESSAGES: Record<AgentReportLocale, AgentReportMessages> = {
    en: {
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
    },
    ru: {
        titles: {
            setup_handoff: 'Передача после setup',
            agent_init: 'Итог agent-init',
            task_closeout: 'Итог задачи'
        },
        labels: {
            language: 'Язык',
            profile: 'Профиль',
            reviewMode: 'Режим ревью',
            optionalSkills: 'Опциональные навыки',
            mandatoryFullSuite: 'Обязательный full-suite',
            nextCommand: 'Следующая команда',
            nextTaskPrompt: 'Скажите агенту',
            updateNotice: 'Последнее update-уведомление',
            noLanguage: 'не указан',
            noProfile: 'не настроен'
        },
        statuses: {
            normalized: 'нормализован',
            pendingConfirmation: 'ждет подтверждения',
            unknown: 'неизвестно'
        },
        fullSuite: {
            enabled: 'включен',
            disabled: 'выключен',
            unknown: 'неизвестно'
        },
        summaries: {
            mandatoryOrchestratorGates: 'обязательные оркестраторные gate\'ы',
            askDuringAgentInit: 'уточнить в AGENT_INIT_PROMPT',
            confirmedDuringAgentInit: 'подтверждены на agent-init',
            pendingDuringAgentInit: 'еще не подтверждены на agent-init',
            independentReviewAttested: 'независимое ревью подтверждено',
            localReview: 'локальное ревью',
            noRequiredReview: 'ревью не требовалось',
            verdicts: 'вердикты',
            selected: 'выбрано',
            recommendedPacks: 'рекомендуются пакеты',
            noAdditionalSkills: 'без дополнительных навыков',
            unavailable: 'недоступно',
            noneUsed: 'не использовались',
            reason: 'причина'
        }
    },
    de: {
        titles: {
            setup_handoff: 'Setup-Uebergabe',
            agent_init: 'Agent-init-Zusammenfassung',
            task_closeout: 'Aufgabenabschluss'
        },
        labels: {
            language: 'Sprache',
            profile: 'Profil',
            reviewMode: 'Review-Modus',
            optionalSkills: 'Optionale Skills',
            mandatoryFullSuite: 'Verbindliche Full-Suite',
            nextCommand: 'Naechster Befehl',
            nextTaskPrompt: 'Sage dem Agenten',
            updateNotice: 'Letzter Update-Hinweis',
            noLanguage: 'nicht erfasst',
            noProfile: 'nicht konfiguriert'
        },
        statuses: {
            normalized: 'normalisiert',
            pendingConfirmation: 'Bestaetigung ausstehend',
            unknown: 'unbekannt'
        },
        fullSuite: {
            enabled: 'aktiviert',
            disabled: 'deaktiviert',
            unknown: 'unbekannt'
        },
        summaries: {
            mandatoryOrchestratorGates: 'verbindliche Orchestrator-Gates',
            askDuringAgentInit: 'waehrend AGENT_INIT_PROMPT klaeren',
            confirmedDuringAgentInit: 'waehrend agent-init bestaetigt',
            pendingDuringAgentInit: 'in agent-init noch ausstehend',
            independentReviewAttested: 'unabhaengiges Review bestaetigt',
            localReview: 'lokales Review',
            noRequiredReview: 'kein Pflicht-Review',
            verdicts: 'Verdikte',
            selected: 'ausgewaehlt',
            recommendedPacks: 'empfohlene Pakete',
            noAdditionalSkills: 'keine zusaetzlichen Skills',
            unavailable: 'nicht verfuegbar',
            noneUsed: 'nicht verwendet',
            reason: 'Grund'
        }
    },
    fr: {
        titles: {
            setup_handoff: 'Relais apres setup',
            agent_init: 'Resume agent-init',
            task_closeout: 'Cloture de la tache'
        },
        labels: {
            language: 'Langue',
            profile: 'Profil',
            reviewMode: 'Mode de revue',
            optionalSkills: 'Competences optionnelles',
            mandatoryFullSuite: 'Full-suite obligatoire',
            nextCommand: 'Commande suivante',
            nextTaskPrompt: 'Dites a l\'agent',
            updateNotice: 'Derniere notification de mise a jour',
            noLanguage: 'non renseignee',
            noProfile: 'non configure'
        },
        statuses: {
            normalized: 'normalise',
            pendingConfirmation: 'confirmation en attente',
            unknown: 'inconnu'
        },
        fullSuite: {
            enabled: 'active',
            disabled: 'desactive',
            unknown: 'inconnu'
        },
        summaries: {
            mandatoryOrchestratorGates: 'gates d\'orchestration obligatoires',
            askDuringAgentInit: 'a preciser pendant AGENT_INIT_PROMPT',
            confirmedDuringAgentInit: 'confirme pendant agent-init',
            pendingDuringAgentInit: 'encore en attente dans agent-init',
            independentReviewAttested: 'revue independante attestee',
            localReview: 'revue locale',
            noRequiredReview: 'aucune revue obligatoire',
            verdicts: 'verdicts',
            selected: 'selectionne',
            recommendedPacks: 'packs recommandes',
            noAdditionalSkills: 'aucune competence supplementaire',
            unavailable: 'indisponible',
            noneUsed: 'non utilisees',
            reason: 'raison'
        }
    },
    es: {
        titles: {
            setup_handoff: 'Transferencia tras setup',
            agent_init: 'Resumen de agent-init',
            task_closeout: 'Cierre de la tarea'
        },
        labels: {
            language: 'Idioma',
            profile: 'Perfil',
            reviewMode: 'Modo de revision',
            optionalSkills: 'Habilidades opcionales',
            mandatoryFullSuite: 'Full-suite obligatoria',
            nextCommand: 'Siguiente comando',
            nextTaskPrompt: 'Dile al agente',
            updateNotice: 'Ultimo aviso de actualizacion',
            noLanguage: 'no registrado',
            noProfile: 'no configurado'
        },
        statuses: {
            normalized: 'normalizado',
            pendingConfirmation: 'confirmacion pendiente',
            unknown: 'desconocido'
        },
        fullSuite: {
            enabled: 'habilitada',
            disabled: 'deshabilitada',
            unknown: 'desconocida'
        },
        summaries: {
            mandatoryOrchestratorGates: 'gates obligatorios del orquestador',
            askDuringAgentInit: 'aclarar durante AGENT_INIT_PROMPT',
            confirmedDuringAgentInit: 'confirmadas durante agent-init',
            pendingDuringAgentInit: 'todavia pendientes en agent-init',
            independentReviewAttested: 'revision independiente atestiguada',
            localReview: 'revision local',
            noRequiredReview: 'no se requirio revision',
            verdicts: 'veredictos',
            selected: 'seleccionado',
            recommendedPacks: 'packs recomendados',
            noAdditionalSkills: 'sin habilidades adicionales',
            unavailable: 'no disponible',
            noneUsed: 'sin uso',
            reason: 'motivo'
        }
    }
};

export function resolveAgentReportLocale(assistantLanguage: string | null | undefined): AgentReportLocale {
    const normalized = String(assistantLanguage || '').trim().toLowerCase();
    if (/(^|\s)(russian|рус)/i.test(normalized)) return 'ru';
    if (/(^|\s)(german|deutsch)/i.test(normalized)) return 'de';
    if (/(^|\s)(french|francais|fran[çc]ais)/i.test(normalized)) return 'fr';
    if (/(^|\s)(spanish|espanol|español)/i.test(normalized)) return 'es';
    return 'en';
}

export function getAgentReportMessages(locale: AgentReportLocale): AgentReportMessages {
    return AGENT_REPORT_MESSAGES[locale];
}

function localizeAgentReportTitle(
    locale: AgentReportLocale,
    context: LocalizedAgentReportInput['context']
): string {
    return getAgentReportMessages(locale).titles[context];
}

function localizeAgentReportLanguageStatus(
    locale: AgentReportLocale,
    confirmed?: boolean | null
): string {
    const messages = getAgentReportMessages(locale);
    if (confirmed === true) return messages.statuses.normalized;
    if (confirmed === false) return messages.statuses.pendingConfirmation;
    return messages.statuses.unknown;
}

function localizeAgentReportFullSuite(
    locale: AgentReportLocale,
    enabled: boolean | null | undefined
): string {
    const messages = getAgentReportMessages(locale);
    if (enabled === true) return messages.fullSuite.enabled;
    if (enabled === false) return messages.fullSuite.disabled;
    return messages.fullSuite.unknown;
}

export function buildLocalizedAgentReportBlock(input: LocalizedAgentReportInput): string {
    const locale = resolveAgentReportLocale(input.assistantLanguage);
    const labels = getAgentReportMessages(locale).labels;

    const lines = [
        'GARDA_AGENT_REPORT',
        localizeAgentReportTitle(locale, input.context),
        `${labels.language}: ${(input.assistantLanguage || labels.noLanguage)} (${localizeAgentReportLanguageStatus(locale, input.assistantLanguageConfirmed)})`,
        `${labels.profile}: ${input.profileSummary || labels.noProfile}`
    ];

    if (input.reviewModeSummary) {
        lines.push(`${labels.reviewMode}: ${input.reviewModeSummary}`);
    }
    if (input.optionalSkillsSummary) {
        lines.push(`${labels.optionalSkills}: ${input.optionalSkillsSummary}`);
    }
    if (input.mandatoryFullSuiteEnabled !== undefined && input.mandatoryFullSuiteEnabled !== null) {
        lines.push(`${labels.mandatoryFullSuite}: ${localizeAgentReportFullSuite(locale, input.mandatoryFullSuiteEnabled)}`);
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
