import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { handleReviewCatalog } from '../../../src/cli/commands/review-catalog-command';
import { BUILT_IN_REVIEW_TYPE_IDS } from '../../../src/core/review-catalog';
import { analyzeReviewCatalogMigrationParity } from '../../../src/core/review-catalog-migration';
import type { ReviewCapabilitiesConfigMap } from '../../../src/core/review-capabilities';
import { runInit } from '../../../src/materialization/init';
import { buildReviewCatalogTab } from '../../../src/reports/report-data/review-catalog-tab';

const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    name: string;
    version: string;
    files: string[];
};

type CommandResult = Record<string, any>;

function readJson(filePath: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function runReviewCatalog(
    actionArgs: string[],
    targetRoot: string,
    bundleRoot: string
): CommandResult {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        const result = handleReviewCatalog([
            ...actionArgs,
            '--target-root', targetRoot,
            '--bundle-root', bundleRoot,
            '--json'
        ], PACKAGE_JSON);
        assert.ok(result);
        return result as CommandResult;
    } finally {
        console.log = originalLog;
    }
}

test('release template materializes a CLI and UI compatible catalog with parity-safe migration preview', () => {
    const repoRoot = process.cwd();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-catalog-release-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const templateRoot = path.join(bundleRoot, 'template');
    const liveConfigRoot = path.join(bundleRoot, 'live', 'config');
    const packageVisiblePaths = [
        'template/config/review-catalog.json',
        'template/config/review-capabilities.json',
        'template/config/profiles.json',
        'docs/configuration.md',
        'docs/cli-reference.md'
    ];

    try {
        assert.ok(PACKAGE_JSON.files.includes('template'));
    assert.ok(PACKAGE_JSON.files.some((entry: string) => entry.startsWith('docs/')));
        for (const relativePath of packageVisiblePaths) {
            assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `${relativePath} must be release-visible`);
        }

        fs.cpSync(path.join(repoRoot, 'template'), templateRoot, { recursive: true });
        runInit({
            targetRoot,
            bundleRoot,
            sourceOfTruth: 'Codex',
            assistantLanguage: 'English',
            assistantBrevity: 'concise'
        });

        const sourceCatalog = readJson(path.join(repoRoot, 'template', 'config', 'review-catalog.json'));
        const materializedCatalogPath = path.join(liveConfigRoot, 'review-catalog.json');
        const materializedCapabilitiesPath = path.join(liveConfigRoot, 'review-capabilities.json');
        const materializedProfilesPath = path.join(liveConfigRoot, 'profiles.json');
        assert.deepEqual(readJson(materializedCatalogPath), sourceCatalog);
        assert.deepEqual(sourceCatalog, { version: 1, custom_review_types: [] });

        const validation = runReviewCatalog(['validate'], targetRoot, bundleRoot);
        assert.equal(validation.status, 'PASS');
        assert.deepEqual(validation.issues, []);

        const listed = runReviewCatalog(['list'], targetRoot, bundleRoot);
        assert.equal(listed.catalog_exists, true);
        assert.deepEqual(
            listed.lanes.map((lane: CommandResult) => lane.id),
            [...BUILT_IN_REVIEW_TYPE_IDS]
        );
        assert.ok(listed.lanes.every((lane: CommandResult) => lane.built_in === true));

        const shownCode = runReviewCatalog(['show', 'code'], targetRoot, bundleRoot);
        assert.equal(shownCode.lane.profile_states.balanced, 'required');
        assert.equal(shownCode.lane.verdict_tokens.pass, 'REVIEW PASSED');
        assert.equal(shownCode.lane.verdict_tokens.fail, 'REVIEW FAILED');

        const uiCatalog = buildReviewCatalogTab(targetRoot, 'balanced');
        assert.equal(uiCatalog.status, 'present');
        assert.equal(uiCatalog.validation.status, 'PASS');
        assert.equal(uiCatalog.migration.status, 'current');
        assert.deepEqual(
            uiCatalog.lanes.map((lane) => lane.id),
            listed.lanes.map((lane: CommandResult) => lane.id)
        );
        const uiCode = uiCatalog.lanes.find((lane) => lane.id === 'code');
        assert.equal(uiCode?.profile.state, shownCode.lane.profile_states.balanced);
        assert.deepEqual(uiCode?.verdict_tokens, shownCode.lane.verdict_tokens);

        const managedPaths = [
            materializedCatalogPath,
            materializedCapabilitiesPath,
            materializedProfilesPath,
            path.join(liveConfigRoot, 'workflow-config.json')
        ];
        const beforeMigration = new Map(
            managedPaths.map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')])
        );
        const migration = runReviewCatalog(['migrate'], targetRoot, bundleRoot);
        assert.equal(
            migration.changed,
            migration.before_state_sha256 !== migration.after_state_sha256
        );
        assert.equal(migration.migration_parity.status, 'PASS');
        assert.ok(Object.values(migration.migration_parity.contracts).every(
            (contract: any) => contract.equal === true
        ));
        const sourceCapabilities = readJson(materializedCapabilitiesPath) as ReviewCapabilitiesConfigMap;
        const sourceProfiles = readJson(materializedProfilesPath);
        assert.throws(
            () => analyzeReviewCatalogMigrationParity({
                catalogExists: true,
                sourceCatalogConfig: sourceCatalog,
                proposedCatalogConfig: sourceCatalog,
                sourceCapabilities,
                proposedCapabilities: {
                    ...sourceCapabilities,
                    code: !sourceCapabilities.code
                },
                sourceProfiles: sourceProfiles as any,
                proposedProfiles: sourceProfiles as any,
                knownSkillIds: [],
                reviewExecutionPolicy: { mode: 'strict_sequential', configured: true }
            }),
            /retain the effective legacy review-capabilities contract|migration parity failed/iu
        );
        for (const [filePath, beforeText] of beforeMigration) {
            assert.equal(fs.readFileSync(filePath, 'utf8'), beforeText, `${filePath} changed during preview`);
        }
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});
