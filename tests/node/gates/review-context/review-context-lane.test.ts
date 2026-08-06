import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    isCustomReviewLaneInSnapshot,
    resolveReviewContextLaneBinding,
    resolveReviewCoverageCategoryIdsFromPreflight
} from '../../../../src/gates/review-context/review-context-lane';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../../../../src/gates/review-context/review-context-contract';
import { buildScopedDiff } from '../../../../src/gates/preflight/build-scoped-diff';
import { resolveCatalogReviewSkillBinding } from '../../../../src/gates/review-context/build-review-context';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import {
    buildReviewContext,
    runGit,
    writeTaskModeArtifactFixture
} from './build-review-context-fixtures';

function buildCustomPreflight(profileState: boolean | 'auto' = true): Record<string, unknown> {
    const catalog = normalizeReviewCatalog({
        version: 1,
        custom_review_types: [{
            id: 'architecture-boundary',
            display_label: 'Architecture boundary review',
            enabled_by_default: false,
            skill_id: 'architecture-review',
            trigger: { mode: 'manual', signal_ids: [] },
            coverage_category_ids: ['maintainability'],
            reviewer_role: {
                role_id: 'architecture-reviewer',
                focus_tags: ['maintainability']
            }
        }]
    }, { knownSkillIds: ['architecture-review'] });
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { 'architecture-boundary': profileState },
        capabilities,
        catalog
    );
    const snapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: 'a'.repeat(64),
        legacyRequiredReviews: {},
        scopeCategory: 'code',
        taskIntent: 'Inspect an architecture boundary',
        changedFiles: ['src/architecture.ts'],
        taskTriggers: {},
        zeroDiffBaselineOnly: false
    });
    return {
        task_id: 'T-729-4A-fixture',
        scope_category: 'code',
        changed_files: ['src/architecture.ts'],
        required_reviews: snapshot.required_reviews,
        effective_review_snapshot: snapshot,
        budget_forecast: { token_economy_active_for_depth: true },
        risk_aware_depth: { compression: { scoped_diffs: true } }
    };
}

describe('catalog-backed review context lane binding', () => {
    it('binds a selected custom lane to snapshot hashes, role, canonical verdict, coverage, and scoped diff', () => {
        const preflight = buildCustomPreflight(true);
        const binding = resolveReviewContextLaneBinding(preflight, 'architecture-boundary');

        assert.equal(binding.review_type, 'architecture-boundary');
        assert.equal(binding.selection, 'required');
        assert.equal(binding.built_in, false);
        assert.deepEqual(binding.skill_ids, ['architecture-review']);
        assert.deepEqual(binding.coverage_category_ids, ['maintainability']);
        assert.deepEqual(binding.reviewer_role, {
            role_id: 'architecture-reviewer',
            focus_tags: ['maintainability']
        });
        assert.deepEqual(binding.verdict_tokens, {
            pass: 'ARCHITECTURE BOUNDARY REVIEW PASSED',
            fail: 'ARCHITECTURE BOUNDARY REVIEW FAILED'
        });
        assert.match(binding.binding_sha256, /^[a-f0-9]{64}$/u);
        assert.equal(isCustomReviewLaneInSnapshot(preflight, 'architecture-boundary'), true);
        assert.deepEqual(
            resolveReviewCoverageCategoryIdsFromPreflight(preflight, 'architecture-boundary'),
            ['maintainability']
        );
        assert.equal(
            buildReviewContextPreflightDiffExpectations(preflight, 'architecture-boundary').expectedScopedDiff,
            true
        );

        const coverage = buildReviewCoverageContract({
            reviewType: 'architecture-boundary',
            changedFiles: ['src/architecture.ts'],
            categoryIds: binding.coverage_category_ids
        });
        assert.ok(coverage.obligations.some((entry) => entry.id === 'CATEGORY-MAINTAINABILITY'));
        assert.equal(coverage.obligations.some((entry) => entry.id === 'CATEGORY-ASSIGNED-REVIEW-CONTRACT'), false);
    });

    it('rejects unknown, inactive, malformed-category, and missing-skill lanes before launch', () => {
        const activePreflight = buildCustomPreflight(true);
        assert.throws(
            () => resolveReviewContextLaneBinding(activePreflight, 'live-config-only'),
            /unknown to the immutable effective review snapshot/u
        );

        const inactivePreflight = buildCustomPreflight(false);
        assert.throws(
            () => resolveReviewContextLaneBinding(inactivePreflight, 'architecture-boundary'),
            /is inactive in the immutable effective review snapshot/u
        );

        const malformedPreflight = JSON.parse(JSON.stringify(activePreflight)) as Record<string, unknown>;
        const malformedSnapshot = malformedPreflight.effective_review_snapshot as {
            lanes: Array<{ id: string; definition: { coverage_category_ids: string[] } }>;
        };
        const malformedLane = malformedSnapshot.lanes.find((lane) => lane.id === 'architecture-boundary');
        assert.ok(malformedLane);
        malformedLane.definition.coverage_category_ids = ['raw-prompt-category'];
        assert.throws(
            () => resolveReviewContextLaneBinding(malformedPreflight, 'architecture-boundary'),
            /unknown coverage category 'raw-prompt-category'/u
        );

        const malformedLanesPreflight = JSON.parse(JSON.stringify(activePreflight)) as Record<string, unknown>;
        (malformedLanesPreflight.effective_review_snapshot as Record<string, unknown>).lanes = {};
        assert.throws(
            () => resolveReviewContextLaneBinding(malformedLanesPreflight, 'architecture-boundary'),
            /Effective review snapshot lanes must be an array/u
        );

        const malformedReasonsPreflight = JSON.parse(JSON.stringify(inactivePreflight)) as Record<string, unknown>;
        const malformedReasonsSnapshot = malformedReasonsPreflight.effective_review_snapshot as {
            lanes: Array<{ id: string; inactive_reasons: unknown }>;
        };
        const malformedReasonsLane = malformedReasonsSnapshot.lanes.find(
            (lane) => lane.id === 'architecture-boundary'
        );
        assert.ok(malformedReasonsLane);
        malformedReasonsLane.inactive_reasons = 'raw reason';
        assert.throws(
            () => resolveReviewContextLaneBinding(malformedReasonsPreflight, 'architecture-boundary'),
            /reasons must be string arrays/u
        );

        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-lane-skill-'));
        try {
            assert.throws(
                () => resolveCatalogReviewSkillBinding(['architecture-review'], repoRoot),
                /missing an entrypoint/u
            );
            const skillRoot = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'skills',
                'architecture-review'
            );
            fs.mkdirSync(skillRoot, { recursive: true });
            fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Architecture review\n', 'utf8');
            const selectedSkill = resolveCatalogReviewSkillBinding(['architecture-review'], repoRoot);
            assert.equal(selectedSkill.skill_id, 'architecture-review');
            assert.equal(selectedSkill.skill_entrypoint_exists, true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('builds an end-to-end custom lane context and rejects the disabled lane before artifact generation', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-custom-review-context-build-'));
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
        const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
        const pathsConfigPath = path.join(orchestratorRoot, 'live', 'config', 'paths.json');
        const sourcePath = path.join(repoRoot, 'src', 'architecture.ts');
        try {
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(path.dirname(tokenConfigPath), { recursive: true });
            fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: false }, null, 2), 'utf8');
            fs.writeFileSync(pathsConfigPath, JSON.stringify({
                triggers: { 'architecture-boundary': ['^src/architecture\\.ts$'] }
            }, null, 2), 'utf8');
            fs.writeFileSync(sourcePath, 'export const architecture = 1;\n', 'utf8');
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(sourcePath, 'export const architecture = 2;\n', 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-729-4A-fixture', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });

            const activePreflight = buildCustomPreflight(true);
            const activePreflightPath = path.join(reviewsRoot, 'T-729-4A-fixture-preflight.json');
            fs.writeFileSync(activePreflightPath, JSON.stringify(activePreflight, null, 2), 'utf8');
            const scopedDiffMetadataPath = path.join(
                reviewsRoot,
                'T-729-4A-fixture-architecture-boundary-scoped.json'
            );
            buildScopedDiff({
                reviewType: 'architecture-boundary',
                preflightPath: activePreflightPath,
                pathsConfigPath,
                outputPath: path.join(
                    reviewsRoot,
                    'T-729-4A-fixture-architecture-boundary-scoped.diff'
                ),
                metadataPath: scopedDiffMetadataPath,
                repoRoot
            });
            const outputPath = path.join(
                reviewsRoot,
                'T-729-4A-fixture-architecture-boundary-review-context.json'
            );
            const result = buildReviewContext({
                reviewType: 'architecture-boundary',
                depth: 3,
                preflightPath: activePreflightPath,
                preflightPayload: activePreflight,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath,
                outputPath,
                repoRoot
            });

            const reviewLane = result.review_lane;
            assert.ok(reviewLane);
            assert.equal(reviewLane.review_type, 'architecture-boundary');
            assert.equal(reviewLane.reviewer_role.role_id, 'architecture-reviewer');
            assert.ok(result.coverage_contract.obligations.some(
                (entry: { id: string }) => entry.id === 'CATEGORY-MAINTAINABILITY'
            ));
            assert.equal(result.rule_context.selected_skill.skill_id, 'architecture-review');
            assert.match(
                fs.readFileSync(result.reviewer_handoff.role_prompt.artifact_path, 'utf8'),
                /Catalog reviewer role id: architecture-reviewer/u
            );
            const manifest = JSON.parse(fs.readFileSync(
                result.reviewer_handoff.evidence_manifest.artifact_path,
                'utf8'
            )) as Record<string, unknown>;
            assert.deepEqual(manifest.review_lane, reviewLane);

            const forgedContext = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
            const forgedRuleContext = forgedContext.rule_context as {
                selected_skill: Record<string, unknown>;
            };
            const forgedHandoff = forgedContext.reviewer_handoff as {
                role_prompt: { selected_skill: Record<string, unknown> };
            };
            for (const selectedSkill of [
                forgedRuleContext.selected_skill,
                forgedHandoff.role_prompt.selected_skill
            ]) {
                selectedSkill.skill_id = 'unrelated-review';
                selectedSkill.candidate_skill_ids = ['unrelated-review'];
            }
            const forgedViolations = getReviewContextContractViolations({
                contextPath: outputPath,
                reviewContext: forgedContext,
                expectedReviewType: 'architecture-boundary',
                expectedPreflightPayload: activePreflight
            });
            assert.ok(forgedViolations.some(
                (violation) => violation.includes('custom selected_skill is not bound')
            ));
            assert.ok(forgedViolations.some(
                (violation) => violation.includes('custom selected_skill candidates do not match')
            ));

            const inactivePreflight = buildCustomPreflight(false);
            const inactivePath = path.join(reviewsRoot, 'T-729-4A-fixture-inactive-preflight.json');
            fs.writeFileSync(inactivePath, JSON.stringify(inactivePreflight, null, 2), 'utf8');
            assert.throws(() => buildReviewContext({
                reviewType: 'architecture-boundary',
                depth: 3,
                preflightPath: inactivePath,
                preflightPayload: inactivePreflight,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: '',
                outputPath: path.join(reviewsRoot, 'inactive-review-context.json'),
                repoRoot
            }), /is inactive in the immutable effective review snapshot/u);
            assert.equal(fs.existsSync(path.join(reviewsRoot, 'inactive-review-context.json')), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
