import * as path from 'node:path';
import {
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES,
    getBundleCliCommand,
    getLegacyBundleCliCommand,
    getLegacySourceCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import { isPathInsideRoot } from '../core/paths';
import { getManagedGitignoreEntries } from '../materialization/common';
import { validateSkillPacks, validateSkillsIndex } from '../runtime/skills';
import { getTaskModeRuleSectionMigrations } from '../materialization/rule-contracts';
import {
    PROJECT_COMMAND_PLACEHOLDERS,
    RULE_FILES,
    buildRequiredPaths,
    detectGitignoreViolations,
    detectManagedConfigViolations,
    detectMissingPaths,
    detectRuleFileViolations,
    detectVersionViolations,
    extractManagedBlock,
    getCanonicalEntrypoint
} from './workspace-layout';

interface VerifyInitAnswersResult {
    violations: string[];
    assistantLanguage: string | null;
    assistantBrevity: string | null;
    enforceNoAutoCommit: boolean;
    claudeOrchestratorFullAccess: boolean;
    tokenEconomyEnabled: boolean;
    providerMinimalism: boolean;
    activeAgentFiles: string[];
}

interface VerifyViolations {
    missingPaths: string[];
    initAnswersContractViolations: string[];
    versionContractViolations: string[];
    reviewCapabilitiesContractViolations: string[];
    pathsContractViolations: string[];
    tokenEconomyContractViolations: string[];
    outputFiltersContractViolations: string[];
    skillPacksConfigContractViolations: string[];
    skillsIndexConfigContractViolations: string[];
    ruleFileViolations: string[];
    templatePlaceholderViolations: string[];
    commandsContractViolations: string[];
    manifestContractViolations: string[];
    coreRuleContractViolations: string[];
    entrypointContractViolations: string[];
    taskContractViolations: string[];
    qwenSettingsViolations: string[];
    skillsIndexContractViolations: string[];
    skillPackContractViolations: string[];
    gitignoreMissing: string[];
}

interface VerifyResult {
    passed: boolean;
    targetRoot: string;
    sourceOfTruth: string;
    canonicalEntrypoint: string | null;
    bundleVersion: string | null | undefined;
    requiredPathsChecked: number;
    violations: VerifyViolations;
    totalViolationCount: number;
}

interface RunVerifyOptions {
    targetRoot: string;
    initAnswersPath: string;
    sourceOfTruth: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function parseBooleanLike(value: unknown, defaultValue: boolean): boolean {
    if (value === null || value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    var normalized = String(value).trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(normalized)) return true;
    if (BOOLEAN_FALSE_VALUES.includes(normalized)) return false;
    return defaultValue;
}

export function readVerifyInitAnswers(targetRoot: string, initAnswersPath: string, sourceOfTruth: string): VerifyInitAnswersResult {
    var violations: string[] = [];
    var defaults: VerifyInitAnswersResult = {
        violations: violations,
        assistantLanguage: null,
        assistantBrevity: null,
        enforceNoAutoCommit: false,
        claudeOrchestratorFullAccess: false,
        tokenEconomyEnabled: true,
        providerMinimalism: true,
        activeAgentFiles: []
    };

    var resolvedPath = '';
    try {
        var candidate = String(initAnswersPath || '').trim();
        if (!path.isAbsolute(candidate)) {
            candidate = path.join(targetRoot, candidate);
        }
        resolvedPath = path.resolve(candidate);
        if (!isPathInsideRoot(targetRoot, resolvedPath)) {
            violations.push("InitAnswersPath must resolve inside TargetRoot '" + targetRoot + "'. Resolved path: " + resolvedPath);
            return defaults;
        }
    } catch (err: unknown) {
        violations.push(getErrorMessage(err));
        return defaults;
    }

    if (!pathExists(resolvedPath)) {
        violations.push('Init answers artifact missing: ' + resolvedPath);
        return defaults;
    }

    var raw;
    try { raw = readTextFile(resolvedPath); } catch (e) {
        violations.push('Cannot read init answers artifact: ' + resolvedPath);
        return defaults;
    }

    if (!raw.trim()) {
        violations.push('Init answers artifact is empty: ' + resolvedPath);
        return defaults;
    }

    var parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (e) {
        violations.push('Init answers artifact is not valid JSON: ' + resolvedPath);
        return defaults;
    }

    function getField(obj: unknown, key: string): string | undefined {
        if (!isRecord(obj)) return undefined;
        return obj[key] !== undefined ? String(obj[key]) : undefined;
    }

    var assistantLanguage = getField(parsed, 'AssistantLanguage');
    if (!assistantLanguage || !assistantLanguage.trim()) {
        violations.push('Init answers artifact missing AssistantLanguage: ' + resolvedPath);
    }

    var assistantBrevity = getField(parsed, 'AssistantBrevity');
    if (!assistantBrevity || !assistantBrevity.trim()) {
        violations.push('Init answers artifact missing AssistantBrevity: ' + resolvedPath);
    } else {
        var nb = assistantBrevity.trim().toLowerCase();
        if (nb !== 'concise' && nb !== 'detailed') {
            violations.push("Init answers artifact has unsupported AssistantBrevity '" + nb + "'. Allowed values: concise, detailed.");
        }
    }

    var artifactSoT = getField(parsed, 'SourceOfTruth');
    if (!artifactSoT || !artifactSoT.trim()) {
        violations.push('Init answers artifact missing SourceOfTruth: ' + resolvedPath);
    } else {
        var aKey = artifactSoT.trim().toUpperCase().replace(/\s+/g, '');
        var eKey = sourceOfTruth.trim().toUpperCase().replace(/\s+/g, '');
        if (aKey !== eKey) {
            violations.push("Init answers SourceOfTruth '" + artifactSoT.trim() + "' does not match verification SourceOfTruth '" + sourceOfTruth + "'.");
        }
    }

    var enforceNoAutoCommit = parseBooleanLike(getField(parsed, 'EnforceNoAutoCommit'), false);
    var claudeOrchestratorFullAccess = parseBooleanLike(getField(parsed, 'ClaudeOrchestratorFullAccess'), false);
    var tokenEconomyEnabled = parseBooleanLike(getField(parsed, 'TokenEconomyEnabled'), true);
    var providerMinimalism = parseBooleanLike(getField(parsed, 'ProviderMinimalism'), true);

    var aafRaw = getField(parsed, 'ActiveAgentFiles');
    var activeAgentFiles: string[] = [];
    if (aafRaw) {
        activeAgentFiles = aafRaw
            .split(/[;,]/g)
            .map(function (s: string): string { return s.trim(); })
            .filter(function (s: string): boolean { return s.length > 0; });
    }
    var ce = getCanonicalEntrypoint(sourceOfTruth);
    if (activeAgentFiles.length === 0 && ce) { activeAgentFiles = [ce]; }

    return {
        violations: violations,
        assistantLanguage: assistantLanguage ? assistantLanguage.trim() : null,
        assistantBrevity: assistantBrevity ? assistantBrevity.trim().toLowerCase() : null,
        enforceNoAutoCommit: enforceNoAutoCommit,
        claudeOrchestratorFullAccess: claudeOrchestratorFullAccess,
        tokenEconomyEnabled: tokenEconomyEnabled,
        providerMinimalism: providerMinimalism,
        activeAgentFiles: activeAgentFiles
    };
}

export function detectCommandsViolations(targetRoot: string): string[] {
    var violations: string[] = [];
    var cp = path.join(targetRoot, resolveBundleName() + '/live/docs/agent-rules/40-commands.md');
    if (!pathExists(cp)) return violations;
    var content = readTextFile(cp);
    var req = [
        `${getBundleCliCommand()} gate enter-task-mode`,
        `${getBundleCliCommand()} gate load-rule-pack`,
        '### Compile Gate (Mandatory)',
        `${getBundleCliCommand()} gate classify-change`,
        `${getBundleCliCommand()} gate compile-gate`,
        `${getBundleCliCommand()} gate required-reviews-check`,
        `${getBundleCliCommand()} gate doc-impact-gate`,
        `${getBundleCliCommand()} gate completion-gate`,
        `${getBundleCliCommand()} gate log-task-event`,
        `${getBundleCliCommand()} gate task-events-summary`,
        `${getBundleCliCommand()} gate build-scoped-diff`,
        `${getBundleCliCommand()} gate build-review-context`,
        `${getBundleCliCommand()} gate validate-manifest`
    ];
    for (var i=0;i<req.length;i++) {
        var alternatives = getCommandSnippetAlternatives(req[i]);
        var present = false;
        for (var a=0;a<alternatives.length;a++) {
            if (content.includes(alternatives[a])) {
                present = true;
                break;
            }
        }
        if (!present) violations.push("40-commands.md must include gate contract snippet '"+req[i]+"'.");
    }
    for (var j=0;j<PROJECT_COMMAND_PLACEHOLDERS.length;j++) { if (content.includes(PROJECT_COMMAND_PLACEHOLDERS[j])) violations.push('40-commands.md contains unresolved command placeholder: '+PROJECT_COMMAND_PLACEHOLDERS[j]); }
    return violations;
}

export function detectTaskModeRuleContractViolations(targetRoot: string): string[] {
    const violations: string[] = [];

    for (const migration of getTaskModeRuleSectionMigrations()) {
        const fullPath = path.join(targetRoot, migration.liveRelativePath);
        if (!pathExists(fullPath)) {
            continue;
        }

        const content = readTextFile(fullPath);
        const fileLabel = path.basename(migration.liveRelativePath);
        for (const snippet of migration.requiredSnippets) {
            const alternatives = getCommandSnippetAlternatives(snippet);
            let present = false;
            for (const candidate of alternatives) {
                if (content.includes(candidate)) {
                    present = true;
                    break;
                }
            }
            if (!present) {
                violations.push(`${fileLabel} must include task-mode contract snippet '${snippet}'.`);
            }
        }
    }

    return violations;
}

function getCommandSnippetAlternatives(snippet: string): string[] {
    const normalizedSnippet = String(snippet || '');
    const effectiveBundlePath = getBundleCliCommand();
    if (!normalizedSnippet.includes(effectiveBundlePath)) {
        const legacyBundlePath = getLegacyBundleCliCommand();
        if (normalizedSnippet.includes(legacyBundlePath)) {
            return [
                normalizedSnippet,
                normalizedSnippet.replace(legacyBundlePath, getSourceCliCommand()),
                normalizedSnippet.replace(legacyBundlePath, getLegacySourceCliCommand())
            ];
        }
        return [normalizedSnippet];
    }

    const sourcePath = getSourceCliCommand();
    return [
        normalizedSnippet,
        normalizedSnippet.replace(effectiveBundlePath, sourcePath),
        normalizedSnippet.replace(effectiveBundlePath, getLegacySourceCliCommand()),
        normalizedSnippet.replace(effectiveBundlePath, getLegacyBundleCliCommand())
    ];
}

export function detectCoreRuleViolations(
    targetRoot: string,
    assistantLanguage: string | null,
    assistantBrevity: string | null
): string[] {
    var violations: string[] = [];
    var cp = path.join(targetRoot, resolveBundleName() + '/live/docs/agent-rules/00-core.md');
    if (!pathExists(cp)) { violations.push('00-core.md missing; core contract validation failed.'); return violations; }
    var content = readTextFile(cp);
    if (!/^Respond in .+ for explanations and assistance\.$/m.test(content)) violations.push('00-core.md must define configured assistant language sentence.');
    if (!/^Default response brevity: .+\.$/m.test(content)) violations.push('00-core.md must define configured assistant response brevity sentence.');
    if (assistantLanguage) {
        var el = 'Respond in '+assistantLanguage+' for explanations and assistance.';
        if (!new RegExp('^'+el.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','m').test(content))
            violations.push("00-core.md language does not match init answers artifact. Expected: '"+el+"'.");
    }
    if (assistantBrevity) {
        var bl = 'Default response brevity: '+assistantBrevity+'.';
        if (!new RegExp('^'+bl.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','m').test(content))
            violations.push("00-core.md response brevity does not match init answers artifact. Expected: '"+bl+"'.");
    }
    return violations;
}

export function detectTaskViolations(targetRoot: string, canonicalEntrypoint: string | null): string[] {
    var violations: string[] = [];
    var tp = path.join(targetRoot, 'TASK.md');
    if (!pathExists(tp)) { violations.push('TASK.md missing.'); return violations; }
    var content = readTextFile(tp);
    var mb = extractManagedBlock(content);
    if (!mb) { violations.push('TASK.md managed block missing.'); return violations; }
    if (!/\|\s*ID\s*\|\s*Status\s*\|\s*Priority\s*\|\s*Area\s*\|\s*Title\s*\|\s*Owner\s*\|\s*Updated\s*\|\s*Profile\s*\|\s*Notes\s*\|/.test(mb))
        violations.push('TASK.md queue header must include `Profile` column.');
    if (mb.includes('{{CANONICAL_ENTRYPOINT}}'))
        violations.push('TASK.md contains unresolved `{{CANONICAL_ENTRYPOINT}}` placeholder.');
    if (canonicalEntrypoint) {
        var ecl = 'Canonical instructions entrypoint for orchestration: `'+canonicalEntrypoint+'`.';
        if (!mb.includes(ecl)) violations.push("TASK.md must reference canonical instructions entrypoint '"+canonicalEntrypoint+"'.");
    }
    return violations;
}

export function detectEntrypointViolations(targetRoot: string, canonicalEntrypoint: string | null): string[] {
    var violations: string[] = [];
    if (!canonicalEntrypoint) return violations;
    var ep = path.join(targetRoot, canonicalEntrypoint);
    if (!pathExists(ep)) { violations.push('Canonical entrypoint missing: '+canonicalEntrypoint); return violations; }
    var content = readTextFile(ep);
    if (!/^# Garda Agent Orchestrator Rule Index$/m.test(content))
        violations.push(canonicalEntrypoint+' must contain canonical rule index content.');
    var rulePathPattern = new RegExp(resolveBundleName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/live\\/docs\\/agent-rules\\/[0-9]{2}[-a-z]+\\.md', 'g');
    var rl = content.match(rulePathPattern);
    var ul = rl ? Array.from(new Set(rl)) : [];
    if (ul.length < RULE_FILES.length)
        violations.push(canonicalEntrypoint+' has fewer rule links than expected. Found='+ul.length+', ExpectedAtLeast='+RULE_FILES.length);
    for (var i=0;i<ul.length;i++) { if (!pathExists(path.join(targetRoot,ul[i]))) violations.push(canonicalEntrypoint+' route target missing: '+ul[i]); }
    return violations;
}

export function detectQwenSettingsViolations(targetRoot: string, canonicalEntrypoint: string | null): string[] {
    var violations: string[] = [];
    var sp = path.join(targetRoot, '.qwen/settings.json');
    if (!pathExists(sp)) return violations;
    var settings: unknown;
    try {
        settings = JSON.parse(readTextFile(sp));
    } catch (e: unknown) {
        violations.push('.qwen/settings.json is not valid JSON: ' + getErrorMessage(e));
        return violations;
    }
    var fn: string[] = [];
    if (isRecord(settings)) {
        var contextValue = settings.context;
        if (isRecord(contextValue) && contextValue.fileName) {
            var rf = Array.isArray(contextValue.fileName) ? contextValue.fileName : [contextValue.fileName];
            for (var i = 0; i < rf.length; i++) {
                if (rf[i] && typeof rf[i] === 'string' && rf[i].trim()) fn.push(rf[i].trim());
            }
        }
    }
    var uf = Array.from(new Set(fn));
    if (canonicalEntrypoint && uf.indexOf(canonicalEntrypoint)===-1) violations.push('.qwen/settings.json must include context.fileName entry `'+canonicalEntrypoint+'`.');
    if (uf.indexOf('TASK.md')===-1) violations.push('.qwen/settings.json must include context.fileName entry `TASK.md`.');
    return violations;
}

export function detectManifestContractViolations(targetRoot: string): string[] {
    var violations: string[] = [];
    var mp = path.join(targetRoot, resolveBundleName() + '/MANIFEST.md');
    if (!pathExists(mp)) return violations;
    var content = readTextFile(mp);
    if (!content.includes('live/USAGE.md')) violations.push("MANIFEST.md must include 'live/USAGE.md'.");
    return violations;
}

export function runVerify(options: RunVerifyOptions): VerifyResult {
    var targetRoot = path.resolve(options.targetRoot);
    var sourceOfTruth = options.sourceOfTruth.trim();
    var canonicalEntrypoint = getCanonicalEntrypoint(sourceOfTruth);
    var iar = readVerifyInitAnswers(targetRoot, options.initAnswersPath, sourceOfTruth);
    var rp = buildRequiredPaths({ activeAgentFiles: iar.activeAgentFiles, claudeOrchestratorFullAccess: iar.claudeOrchestratorFullAccess });
    var mp = detectMissingPaths(targetRoot, rp);
    var vr = detectVersionViolations(targetRoot, sourceOfTruth, canonicalEntrypoint);
    var rcv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/review-capabilities.json');
    var pv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/paths.json');
    var tev = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/token-economy.json');
    var ofv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/output-filters.json');
    var spv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/skill-packs.json');
    var imv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/isolation-mode.json');
    var prv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/profiles.json');
    var rasv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/review-artifact-storage.json');
    var ocv = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/garda.config.json');
    var six = detectManagedConfigViolations(targetRoot, resolveBundleName() + '/live/config/skills-index.json');
    var rfr = detectRuleFileViolations(targetRoot);
    var tmv = detectTaskModeRuleContractViolations(targetRoot);
    var cv = detectCommandsViolations(targetRoot);
    var crv = detectCoreRuleViolations(targetRoot, iar.assistantLanguage, iar.assistantBrevity);
    var tv = detectTaskViolations(targetRoot, canonicalEntrypoint);
    var ev = detectEntrypointViolations(targetRoot, canonicalEntrypoint);
    var qv = detectQwenSettingsViolations(targetRoot, canonicalEntrypoint);
    var skillPackValidation = validateSkillPacks(path.join(targetRoot, resolveBundleName()));
    var skillsIndexValidation = validateSkillsIndex(path.join(targetRoot, resolveBundleName()));
    var ge: string[] = getManagedGitignoreEntries(
        iar.claudeOrchestratorFullAccess,
        iar.providerMinimalism && iar.activeAgentFiles.length > 0 ? iar.activeAgentFiles : undefined
    );
    var gm = detectGitignoreViolations(targetRoot, ge);
    var mv = detectManifestContractViolations(targetRoot);

    var violations: VerifyViolations = {
        missingPaths: mp,
        initAnswersContractViolations: iar.violations,
        versionContractViolations: vr.violations,
        reviewCapabilitiesContractViolations: rcv,
        pathsContractViolations: pv,
        tokenEconomyContractViolations: tev,
        outputFiltersContractViolations: ofv,
        skillPacksConfigContractViolations: spv,
        skillsIndexConfigContractViolations: six,
        ruleFileViolations: rfr.ruleFileViolations.concat(tmv),
        templatePlaceholderViolations: rfr.templatePlaceholderViolations,
        commandsContractViolations: cv,
        manifestContractViolations: mv.concat(imv, prv, rasv, ocv),
        coreRuleContractViolations: crv,
        entrypointContractViolations: ev,
        taskContractViolations: tv,
        qwenSettingsViolations: qv,
        skillsIndexContractViolations: skillsIndexValidation.issues,
        skillPackContractViolations: skillPackValidation.issues,
        gitignoreMissing: gm
    };

    var total = 0;
    var keys = Object.keys(violations) as Array<keyof VerifyViolations>;
    for (var i=0;i<keys.length;i++) total += violations[keys[i]].length;

    return {
        passed: total === 0,
        targetRoot: targetRoot,
        sourceOfTruth: sourceOfTruth,
        canonicalEntrypoint: canonicalEntrypoint,
        bundleVersion: vr.bundleVersion,
        requiredPathsChecked: rp.length,
        violations: violations,
        totalViolationCount: total
    };
}

export function formatVerifyResult(result: VerifyResult): string {
    var lines: string[] = [];
    lines.push('TargetRoot: '+result.targetRoot);
    lines.push('SourceOfTruth: '+result.sourceOfTruth);
    lines.push('CanonicalEntrypoint: '+(result.canonicalEntrypoint||'n/a'));
    lines.push('RequiredPathsChecked: '+result.requiredPathsChecked);
    lines.push('MissingPathCount: '+result.violations.missingPaths.length);
    lines.push('ReviewCapabilitiesContractViolationCount: '+result.violations.reviewCapabilitiesContractViolations.length);
    lines.push('PathsContractViolationCount: '+result.violations.pathsContractViolations.length);
    lines.push('TokenEconomyContractViolationCount: '+result.violations.tokenEconomyContractViolations.length);
    lines.push('OutputFiltersContractViolationCount: '+result.violations.outputFiltersContractViolations.length);
    lines.push('SkillPacksConfigContractViolationCount: '+result.violations.skillPacksConfigContractViolations.length);
    lines.push('SkillsIndexConfigContractViolationCount: '+result.violations.skillsIndexConfigContractViolations.length);
    lines.push('BundleVersion: '+(result.bundleVersion||'n/a'));
    lines.push('VersionContractViolationCount: '+result.violations.versionContractViolations.length);
    lines.push('RuleFileViolationCount: '+result.violations.ruleFileViolations.length);
    lines.push('TemplatePlaceholderViolationCount: '+result.violations.templatePlaceholderViolations.length);
    lines.push('CommandsContractViolationCount: '+result.violations.commandsContractViolations.length);
    lines.push('ManifestContractViolationCount: '+result.violations.manifestContractViolations.length);
    lines.push('InitAnswersContractViolationCount: '+result.violations.initAnswersContractViolations.length);
    lines.push('CoreRuleContractViolationCount: '+result.violations.coreRuleContractViolations.length);
    lines.push('EntrypointContractViolationCount: '+result.violations.entrypointContractViolations.length);
    lines.push('TaskContractViolationCount: '+result.violations.taskContractViolations.length);
    lines.push('QwenSettingsViolationCount: '+result.violations.qwenSettingsViolations.length);
    lines.push('SkillsIndexContractViolationCount: '+result.violations.skillsIndexContractViolations.length);
    lines.push('SkillPackContractViolationCount: '+result.violations.skillPackContractViolations.length);
    var keys = Object.keys(result.violations) as Array<keyof VerifyViolations>;
    for (var i=0;i<keys.length;i++) {
        var items = result.violations[keys[i]];
        if (items.length>0) {
            lines.push(keys[i]+':');
            for (var j=0;j<items.length;j++) lines.push(' - '+items[j]);
        }
    }
    if (!result.passed) lines.push('Verification failed. Resolve listed issues and rerun.');
    else lines.push('Verification: PASS');
    return lines.join('\n');
}

/**
 * Format verify result in compact mode.
 * On success: single summary line. On failure: full output (delegates to formatVerifyResult).
 */
export function formatVerifyResultCompact(result: VerifyResult): string {
    if (!result.passed) {
        return formatVerifyResult(result);
    }
    return `Verification: PASS | paths=${result.requiredPathsChecked} | violations=0`;
}
