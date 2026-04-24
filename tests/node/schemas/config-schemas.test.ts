import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EXIT_VALIDATION_FAILURE } from '../../../src/cli/exit-codes';
import { runCliWithCapturedOutput } from '../cli/commands/gate-test-helpers';

import {
    getConfigSchemas,
    getConfigSchemaByName,
    validateAgainstSchema,
    validateAllConfigs,
    formatValidationReport,
    formatValidationReportCompact,
    reviewCapabilitiesSchema,
    tokenEconomySchema,
    pathsSchema,
    outputFiltersSchema,
    skillPacksSchema,
    optionalSkillSelectionPolicySchema,
    isolationModeSchema,
    profilesSchema,
    reviewArtifactStorageSchema,
    workflowConfigSchema,
    gardaConfigSchema
} from '../../../src/schemas/config-schemas';

function isWorkspaceRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, 'package.json')) &&
        fs.existsSync(path.join(candidate, 'VERSION')) &&
        fs.existsSync(path.join(candidate, 'bin', 'garda.js')) &&
        fs.existsSync(path.join(candidate, 'src', 'index.ts'));
}

function findRepoRoot(): string {
    const cwd = path.resolve(process.cwd());
    if (isWorkspaceRoot(cwd)) {
        return cwd;
    }

    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (isWorkspaceRoot(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root from ' + __dirname);
}

const REPO_ROOT = findRepoRoot();
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'garda.js');
const VALIDATE_CONFIG_SCRIPT = path.join(REPO_ROOT, 'scripts', 'validate-config.cjs');
const NEUTRAL_CWD = path.join(REPO_ROOT, 'tests');

function readTemplateConfig(fileName: string): unknown {
    return JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'template', 'config', fileName), 'utf8')
    );
}

function makeTempBundleRoot(): { tmpDir: string; bundleRoot: string; configDir: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-schema-test-'));
    const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });

    for (const fileName of [
        'review-capabilities.json',
        'token-economy.json',
        'paths.json',
        'output-filters.json',
        'skill-packs.json',
        'optional-skill-selection-policy.json',
        'isolation-mode.json',
        'profiles.json',
        'review-artifact-storage.json',
        'workflow-config.json',
        'garda.config.json'
    ]) {
        fs.copyFileSync(
            path.join(REPO_ROOT, 'template', 'config', fileName),
            path.join(configDir, fileName)
        );
    }

    return { tmpDir, bundleRoot, configDir };
}

function cleanupTempBundleRoot(tmpDir: string): void {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

test('getConfigSchemas returns entries for all ten managed configs', () => {
    const schemas = getConfigSchemas();
    assert.equal(schemas.length, 10);
    const names = schemas.map((s) => s.name);
    assert.ok(names.includes('review-capabilities'));
    assert.ok(names.includes('token-economy'));
    assert.ok(names.includes('paths'));
    assert.ok(names.includes('output-filters'));
    assert.ok(names.includes('skill-packs'));
    assert.ok(names.includes('optional-skill-selection-policy'));
    assert.ok(names.includes('isolation-mode'));
    assert.ok(names.includes('profiles'));
    assert.ok(names.includes('review-artifact-storage'));
    assert.ok(names.includes('workflow-config'));
});

test('getConfigSchemaByName returns correct schema entry', () => {
    const entry = getConfigSchemaByName('token-economy');
    assert.ok(entry);
    assert.equal(entry.name, 'token-economy');
    assert.equal(entry.fileName, 'token-economy.json');
});

test('getConfigSchemaByName returns undefined for unknown name', () => {
    assert.equal(getConfigSchemaByName('nonexistent'), undefined);
});

// ---------------------------------------------------------------------------
// Schema objects are well-formed
// ---------------------------------------------------------------------------

test('all schema objects have $schema, $id, title, and type', () => {
    for (const schema of [
        reviewCapabilitiesSchema,
        tokenEconomySchema,
        pathsSchema,
        outputFiltersSchema,
        skillPacksSchema,
        optionalSkillSelectionPolicySchema,
        isolationModeSchema,
        profilesSchema,
        reviewArtifactStorageSchema,
        gardaConfigSchema
    ]) {
        assert.equal(typeof (schema as Record<string, unknown>).$schema, 'string');
        assert.equal(typeof (schema as Record<string, unknown>).$id, 'string');
        assert.equal(typeof (schema as Record<string, unknown>).title, 'string');
        assert.equal((schema as Record<string, unknown>).type, 'object');
    }
});

// ---------------------------------------------------------------------------
// Template config files validate against their schemas
// ---------------------------------------------------------------------------

test('template review-capabilities.json validates against schema', () => {
    const data = readTemplateConfig('review-capabilities.json');
    const result = validateAgainstSchema(data, reviewCapabilitiesSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template token-economy.json validates against schema', () => {
    const data = readTemplateConfig('token-economy.json');
    const result = validateAgainstSchema(data, tokenEconomySchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template paths.json validates against schema', () => {
    const data = readTemplateConfig('paths.json');
    const result = validateAgainstSchema(data, pathsSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template output-filters.json validates against schema', () => {
    const data = readTemplateConfig('output-filters.json');
    const result = validateAgainstSchema(data, outputFiltersSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template skill-packs.json validates against schema', () => {
    const data = readTemplateConfig('skill-packs.json');
    const result = validateAgainstSchema(data, skillPacksSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template optional-skill-selection-policy.json validates against schema', () => {
    const data = readTemplateConfig('optional-skill-selection-policy.json');
    const result = validateAgainstSchema(data, optionalSkillSelectionPolicySchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('garda.config schema allows omitting optional-skill-selection-policy for backward-compatible bundles', () => {
    const data = readTemplateConfig('garda.config.json') as Record<string, unknown>;
    const clone = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    delete ((clone.configs as Record<string, unknown>)['optional-skill-selection-policy']);
    const result = validateAgainstSchema(clone, gardaConfigSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template isolation-mode.json validates against schema', () => {
    const data = readTemplateConfig('isolation-mode.json');
    const result = validateAgainstSchema(data, isolationModeSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template profiles.json validates against schema', () => {
    const data = readTemplateConfig('profiles.json');
    const result = validateAgainstSchema(data, profilesSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template review-artifact-storage.json validates against schema', () => {
    const data = readTemplateConfig('review-artifact-storage.json');
    const result = validateAgainstSchema(data, reviewArtifactStorageSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('workflow-config schema allows future top-level toggle groups', () => {
    const data = readTemplateConfig('workflow-config.json') as Record<string, unknown>;
    const clone = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    clone.future_toggle_group = {
        sticky_notice_enabled: true
    };
    const result = validateAgainstSchema(clone, workflowConfigSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('workflow-config schema allows future full_suite_validation knobs', () => {
    const data = readTemplateConfig('workflow-config.json') as Record<string, unknown>;
    const clone = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    (clone.full_suite_validation as Record<string, unknown>).auto_open_report = true;
    const result = validateAgainstSchema(clone, workflowConfigSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

test('template garda.config.json validates against root schema', () => {
    const data = readTemplateConfig('garda.config.json');
    const result = validateAgainstSchema(data, gardaConfigSchema);
    assert.equal(result.valid, true, `Errors: ${JSON.stringify(result.errors)}`);
});

// ---------------------------------------------------------------------------
// validateAgainstSchema rejects invalid data
// ---------------------------------------------------------------------------

test('validateAgainstSchema catches missing required properties', () => {
    const result = validateAgainstSchema({}, reviewCapabilitiesSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 9);
});

test('validateAgainstSchema catches wrong type', () => {
    const result = validateAgainstSchema('not an object', tokenEconomySchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('Expected object')));
});

test('validateAgainstSchema catches additional properties when disallowed', () => {
    const data = {
        code: true, db: true, security: true, refactor: true,
        api: true, test: true, performance: true, infra: true, dependency: true,
        extra_key: true
    };
    const result = validateAgainstSchema(data, reviewCapabilitiesSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("'extra_key'")));
});

test('validateAgainstSchema catches integer minimum violation', () => {
    const data = {
        enabled: true, enabled_depths: [1], strip_examples: true,
        strip_code_blocks: true, scoped_diffs: true,
        compact_reviewer_output: true, fail_tail_lines: 0
    };
    const result = validateAgainstSchema(data, tokenEconomySchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('minimum')));
});

test('validateAgainstSchema catches enum violation in isolation-mode', () => {
    const data = {
        enabled: false, enforcement: 'INVALID',
        require_manifest_match_before_task: true,
        refuse_on_preflight_drift: true, use_sandbox: true
    };
    const result = validateAgainstSchema(data, isolationModeSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('not in enum')));
});

test('validateAgainstSchema validates nested objects in garda.config schema', () => {
    const data = { version: 1, configs: {} };
    const result = validateAgainstSchema(data, gardaConfigSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('configs')));
});

test('validateAgainstSchema detects array uniqueItems violation', () => {
    const data = { version: 1, installed_packs: ['a', 'a'] };
    const result = validateAgainstSchema(data, skillPacksSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('Duplicate')));
});

test('validateAgainstSchema validates triggers minProperties in paths', () => {
    const data = {
        metrics_path: 'test', runtime_roots: ['src/'],
        fast_path_roots: ['web/'], triggers: {}
    };
    const result = validateAgainstSchema(data, pathsSchema);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes('minimum')));
});

// ---------------------------------------------------------------------------
// Full config directory validation (if live config present)
// ---------------------------------------------------------------------------

test('validateAllConfigs validates the live config directory when present', () => {
    const bundleRoot = path.join(process.cwd(), 'garda-agent-orchestrator');
    const configDir = path.join(bundleRoot, 'live', 'config');

    if (!fs.existsSync(path.join(configDir, 'garda.config.json'))) {
        // Live config not yet materialized - skip
        return;
    }

    const report = validateAllConfigs(bundleRoot);
    assert.equal(report.configs.length, 10);
    for (const cfg of report.configs) {
        assert.equal(cfg.exists, true, `${cfg.name} should exist`);
        assert.equal(cfg.parseable, true, `${cfg.name} should be parseable`);
    }
});

test('validateAllConfigs fails when garda.config.json is missing', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        fs.rmSync(path.join(configDir, 'garda.config.json'));
        const report = validateAllConfigs(bundleRoot);
        assert.equal(report.passed, false);
        assert.equal(report.rootConfigValid, false);
        assert.ok(report.rootErrors.length > 0);
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs reports invalid root manifest schema errors', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        fs.writeFileSync(
            path.join(configDir, 'garda.config.json'),
            JSON.stringify({ version: 1, configs: {} }, null, 2),
            'utf8'
        );
        const report = validateAllConfigs(bundleRoot);
        assert.equal(report.passed, false);
        assert.equal(report.rootConfigValid, false);
        assert.ok(report.rootErrors.some((error) => error.includes('configs')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs uses garda.config.json as the authoritative path map', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const rootConfig = readTemplateConfig('garda.config.json') as Record<string, unknown>;
        const configs = (rootConfig.configs as Record<string, string>);
        configs['review-capabilities'] = 'custom-review-capabilities.json';
        fs.copyFileSync(
            path.join(configDir, 'review-capabilities.json'),
            path.join(configDir, 'custom-review-capabilities.json')
        );
        fs.rmSync(path.join(configDir, 'review-capabilities.json'));
        fs.writeFileSync(path.join(configDir, 'garda.config.json'), JSON.stringify(rootConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        assert.equal(report.passed, true, JSON.stringify(report, null, 2));
        assert.ok(report.configs.some((cfg) => cfg.filePath.endsWith('custom-review-capabilities.json')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs rejects manifest paths outside live/config', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const rootConfig = readTemplateConfig('garda.config.json') as Record<string, unknown>;
        const configs = (rootConfig.configs as Record<string, string>);
        configs['review-capabilities'] = '../escaped.json';
        fs.writeFileSync(path.join(configDir, 'garda.config.json'), JSON.stringify(rootConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const reviewReport = report.configs.find((cfg) => cfg.name === 'review-capabilities');
        assert.equal(report.passed, false);
        assert.ok(reviewReport);
        assert.ok(reviewReport.errors.some((error) => error.includes('resolve inside live/config')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs reports missing manifest-referenced config files', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const rootConfig = readTemplateConfig('garda.config.json') as Record<string, unknown>;
        const configs = (rootConfig.configs as Record<string, string>);
        configs.paths = 'missing-paths.json';
        fs.writeFileSync(path.join(configDir, 'garda.config.json'), JSON.stringify(rootConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const pathsReport = report.configs.find((cfg) => cfg.name === 'paths');
        assert.equal(report.passed, false);
        assert.ok(pathsReport);
        assert.ok(pathsReport.errors.some((error) => error.includes('File not found')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs reports parse failures for manifest-referenced config files', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        fs.writeFileSync(path.join(configDir, 'skill-packs.json'), '{"broken":', 'utf8');
        const report = validateAllConfigs(bundleRoot);
        const skillPacksReport = report.configs.find((cfg) => cfg.name === 'skill-packs');
        assert.equal(report.passed, false);
        assert.ok(skillPacksReport);
        assert.ok(skillPacksReport.errors.some((error) => error.startsWith('parse:')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs reports runtime validator failures', () => {
    const { tmpDir, bundleRoot } = makeTempBundleRoot();
    try {
        const report = validateAllConfigs(bundleRoot, {
            'review-capabilities': () => {
                throw new Error('synthetic runtime validation failure');
            }
        });
        const reviewReport = report.configs.find((cfg) => cfg.name === 'review-capabilities');
        assert.equal(report.passed, false);
        assert.ok(reviewReport);
        assert.equal(reviewReport.runtimeValid, false);
        assert.ok(reviewReport.errors.some((error) => error.includes('synthetic runtime validation failure')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs accepts workflow-config files with preserved future top-level toggles', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const workflowConfigPath = path.join(configDir, 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        workflowConfig.future_toggle_group = {
            sticky_notice_enabled: true
        };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const workflowReport = report.configs.find((cfg) => cfg.name === 'workflow-config');
        assert.equal(report.passed, true, JSON.stringify(report, null, 2));
        assert.ok(workflowReport);
        assert.equal(workflowReport.schemaValid, true);
        assert.equal(workflowReport.runtimeValid, true);
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs accepts workflow-config files with preserved future full_suite_validation knobs', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const workflowConfigPath = path.join(configDir, 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        (workflowConfig.full_suite_validation as Record<string, unknown>).auto_open_report = true;
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const workflowReport = report.configs.find((cfg) => cfg.name === 'workflow-config');
        assert.equal(report.passed, true, JSON.stringify(report, null, 2));
        assert.ok(workflowReport);
        assert.equal(workflowReport.schemaValid, true);
        assert.equal(workflowReport.runtimeValid, true);
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs rejects likely typo top-level workflow-config keys', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const workflowConfigPath = path.join(configDir, 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        delete workflowConfig.review_execution_policy;
        workflowConfig.review_execution_polciy = {
            mode: 'parallel_all'
        };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const workflowReport = report.configs.find((cfg) => cfg.name === 'workflow-config');
        assert.equal(report.passed, false);
        assert.ok(workflowReport);
        assert.equal(workflowReport.schemaValid, true);
        assert.equal(workflowReport.runtimeValid, false);
        assert.ok(workflowReport.errors.some((error) => error.includes("did you mean 'review_execution_policy'")));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs rejects case-drifted workflow-config review_execution_policy keys', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const workflowConfigPath = path.join(configDir, 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        delete workflowConfig.review_execution_policy;
        workflowConfig.Review_Execution_Policy = {
            mode: 'parallel_all'
        };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const workflowReport = report.configs.find((cfg) => cfg.name === 'workflow-config');
        assert.equal(report.passed, false);
        assert.ok(workflowReport);
        assert.equal(workflowReport.runtimeValid, false);
        assert.ok(workflowReport.errors.some((error) => error.includes("exact key 'review_execution_policy'")));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validateAllConfigs rejects unknown nested workflow-config review_execution_policy keys', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        const workflowConfigPath = path.join(configDir, 'workflow-config.json');
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, unknown>;
        workflowConfig.review_execution_policy = {
            mode: 'parallel_all',
            visible_summary_line: 'unexpected'
        };
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2), 'utf8');

        const report = validateAllConfigs(bundleRoot);
        const workflowReport = report.configs.find((cfg) => cfg.name === 'workflow-config');
        assert.equal(report.passed, false);
        assert.ok(workflowReport);
        assert.equal(workflowReport.schemaValid, false);
        assert.equal(workflowReport.runtimeValid, false);
        assert.ok(workflowReport.errors.some((error) => error.includes('visible_summary_line')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

test('formatValidationReport includes PASSED/FAILED header', () => {
    const report = {
        passed: true,
        rootConfigValid: true,
        rootConfigPath: '/test/garda.config.json',
        rootErrors: [],
        configs: []
    };
    const text = formatValidationReport(report);
    assert.ok(text.includes('CONFIG_VALIDATION_PASSED'));
});

test('formatValidationReportCompact returns single line', () => {
    const report = {
        passed: false,
        rootConfigValid: false,
        rootConfigPath: '/test/garda.config.json',
        rootErrors: ['root failure'],
        configs: [
            { name: 'test', filePath: '/test/test.json', exists: true, parseable: true, schemaValid: true, runtimeValid: true, errors: [] }
        ]
    };
    const text = formatValidationReportCompact(report);
    assert.ok(text.includes('CONFIG_VALIDATION_FAILED'));
    assert.ok(text.includes('1/1'));
    assert.ok(text.includes('root_errors=1'));
    assert.ok(!text.includes('\n'));
});

test('formatValidationReport includes root and config errors', () => {
    const report = {
        passed: false,
        rootConfigValid: false,
        rootConfigPath: '/test/garda.config.json',
        rootErrors: ['root failure'],
        configs: [
            {
                name: 'paths',
                filePath: '/test/paths.json',
                exists: true,
                parseable: true,
                schemaValid: false,
                runtimeValid: true,
                errors: ['schema: $.triggers: Object has 0 properties, minimum is 1.']
            }
        ]
    };
    const text = formatValidationReport(report);
    assert.ok(text.includes('root: root failure'));
    assert.ok(text.includes('paths: FAIL'));
    assert.ok(text.includes('/test/garda.config.json'));
});

// ---------------------------------------------------------------------------
// CLI / script integration
// ---------------------------------------------------------------------------

test('gate validate-config succeeds against a valid bundle root', async () => {
    const { tmpDir, bundleRoot } = makeTempBundleRoot();
    try {
        const result = await runCliWithCapturedOutput([
            'gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'
        ], { cwd: NEUTRAL_CWD });
        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        assert.ok(result.logs.some((line) => line.includes('CONFIG_VALIDATION_PASSED')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('gate validate-config succeeds when optional-skill-selection-policy is omitted from root config', async () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        fs.rmSync(path.join(configDir, 'optional-skill-selection-policy.json'));
        const rootConfigPath = path.join(configDir, 'garda.config.json');
        const rootConfig = JSON.parse(fs.readFileSync(rootConfigPath, 'utf8')) as Record<string, unknown>;
        delete ((rootConfig.configs as Record<string, unknown>)['optional-skill-selection-policy']);
        fs.writeFileSync(rootConfigPath, JSON.stringify(rootConfig, null, 2), 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'
        ], { cwd: NEUTRAL_CWD });
        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        assert.ok(result.logs.some((line) => line.includes('CONFIG_VALIDATION_PASSED')));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('gate validate-config fails against an invalid bundle root', async () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        fs.rmSync(path.join(configDir, 'garda.config.json'));
        const result = await runCliWithCapturedOutput([
            'gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'
        ], { cwd: NEUTRAL_CWD });
        assert.equal(result.exitCode, EXIT_VALIDATION_FAILURE);
        assert.ok(
            [...result.logs, ...result.errors].some((line) => line.includes('CONFIG_VALIDATION_FAILED'))
        );
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validate-config script exits 0 on valid bundle root', () => {
    const { tmpDir, bundleRoot } = makeTempBundleRoot();
    try {
        const result = spawnSync(process.execPath, [
            VALIDATE_CONFIG_SCRIPT, '--bundle-root', bundleRoot
        ], { cwd: NEUTRAL_CWD, encoding: 'utf8', timeout: 30_000 });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes('CONFIG_VALIDATION_PASSED'));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});

test('validate-config script exits 1 on invalid bundle root', () => {
    const { tmpDir, bundleRoot, configDir } = makeTempBundleRoot();
    try {
        fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), '{', 'utf8');
        const result = spawnSync(process.execPath, [
            VALIDATE_CONFIG_SCRIPT, '--bundle-root', bundleRoot
        ], { cwd: NEUTRAL_CWD, encoding: 'utf8', timeout: 30_000 });
        assert.equal(result.status, 1);
        assert.ok((result.stdout + result.stderr).includes('CONFIG_VALIDATION_FAILED'));
    } finally {
        cleanupTempBundleRoot(tmpDir);
    }
});
