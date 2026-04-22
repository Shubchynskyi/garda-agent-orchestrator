import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { buildReviewContext, getRulePack, toNonNegativeInt, resolveContextOutputPath, resolveScopedDiffMetadataPath } from '../../../src/gates/build-review-context';
import {
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath
} from '../../../src/gates/review-context-paths';
import { buildTaskModeArtifact, resolveTaskModeArtifactPath } from '../../../src/gates/task-mode';
import { resolveReviewerRoutingPolicy, resolveRuntimeReviewerIdentity } from '../../../src/gates/reviewer-routing';

function writeTaskModeArtifactFixture(
    repoRoot: string,
    taskId: string,
    options: {
        provider: string | null;
        canonicalSourceOfTruth: string | null;
        routedTo?: string | null;
        executionProviderSource?: string | null;
        runtimeIdentityStatus?: string | null;
    }
): void {
    const taskModePath = resolveTaskModeArtifactPath(repoRoot, taskId, '');
    fs.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 3,
        effectiveDepth: 3,
        taskSummary: 'Enforce delegated reviewer routing',
        provider: options.provider,
        canonicalSourceOfTruth: options.canonicalSourceOfTruth,
        routedTo: options.routedTo ?? null,
        executionProviderSource: options.executionProviderSource ?? null,
        runtimeIdentityStatus: options.runtimeIdentityStatus ?? null
    }), null, 2), 'utf8');
}

describe('gates/build-review-context', () => {
    describe('getRulePack', () => {
        it('returns code review pack with full/depth1/depth2', () => {
            const pack = getRulePack('code');
            assert.ok(pack.full.length > 0);
            assert.ok(pack.depth1.length > 0);
            assert.ok(pack.depth2.length > 0);
            assert.ok(pack.full.includes('00-core.md'));
            assert.ok(pack.full.includes('80-task-workflow.md'));
        });

        it('returns db/security review pack', () => {
            const pack = getRulePack('db');
            assert.ok(pack.full.includes('70-security.md'));
            const secPack = getRulePack('security');
            assert.deepEqual(pack, secPack);
        });

        it('returns refactor review pack', () => {
            const pack = getRulePack('refactor');
            assert.ok(pack.full.includes('30-code-style.md'));
            assert.ok(!pack.full.includes('70-security.md'));
        });

        it('returns default pack for unknown type', () => {
            const pack = getRulePack('unknown');
            assert.ok(pack.full.length > 0);
        });

        it('depth1 is always a subset of full', () => {
            for (const type of ['code', 'db', 'security', 'refactor']) {
                const pack = getRulePack(type);
                for (const file of pack.depth1) {
                    assert.ok(pack.full.includes(file), `depth1 file ${file} not in full for ${type}`);
                }
            }
        });
    });

    describe('toNonNegativeInt', () => {
        it('returns int for positive number', () => {
            assert.equal(toNonNegativeInt(42), 42);
        });
        it('returns int for string number', () => {
            assert.equal(toNonNegativeInt('50'), 50);
        });
        it('returns null for boolean', () => {
            assert.equal(toNonNegativeInt(true), null);
        });
        it('returns null for null', () => {
            assert.equal(toNonNegativeInt(null), null);
        });
        it('returns null for negative', () => {
            assert.equal(toNonNegativeInt(-1), null);
        });
        it('returns 0 for zero', () => {
            assert.equal(toNonNegativeInt(0), 0);
        });
    });

    describe('resolveContextOutputPath', () => {
        it('derives from preflight path when explicit is empty', () => {
            const result = resolveContextOutputPath('', '/repo/reviews/T-001-preflight.json', 'code', '/repo');
            assert.ok(result!.includes('T-001-code-review-context.json'));
        });
    });

    describe('resolveScopedDiffMetadataPath', () => {
        it('derives from preflight path when explicit is empty', () => {
            const result = resolveScopedDiffMetadataPath('', '/repo/reviews/T-001-preflight.json', 'db', '/repo');
            assert.ok(result!.includes('T-001-db-scoped.json'));
        });
    });

    describe('resolveCanonicalReviewContextPath', () => {
        it('materializes canonical default path from legacy default artifact when needed', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-paths-'));
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });

            const canonicalPath = getCanonicalReviewContextPath(reviewsRoot, 'T-001', 'code');
            const legacyPath = getLegacyDefaultReviewContextPath(reviewsRoot, 'T-001', 'code');
            fs.writeFileSync(legacyPath, JSON.stringify({ review_type: 'code', legacy: true }, null, 2) + '\n', 'utf8');

            const resolvedPath = resolveCanonicalReviewContextPath({
                reviewsRoot,
                taskId: 'T-001',
                reviewType: 'code'
            });

            assert.equal(resolvedPath, canonicalPath);
            assert.equal(fs.existsSync(canonicalPath), true);
            assert.deepEqual(
                JSON.parse(fs.readFileSync(canonicalPath, 'utf8')),
                JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    });

    describe('resolveReviewerRoutingPolicy', () => {
        it('marks Codex as delegation-required', () => {
            const policy = resolveReviewerRoutingPolicy('Codex');
            assert.equal(policy.delegation_required, true);
            assert.equal(policy.expected_execution_mode, 'delegated_subagent');
            assert.equal(policy.fallback_allowed, false);
        });

        it('marks Antigravity as conditional delegation with fallback reason', () => {
            const policy = resolveReviewerRoutingPolicy('Antigravity');
            assert.equal(policy.delegation_required, false);
            assert.equal(policy.expected_execution_mode, 'delegated_subagent');
            assert.equal(policy.fallback_allowed, true);
            assert.equal(policy.fallback_reason_required, true);
        });

        it('marks single-agent providers as fallback-allowed with reason required', () => {
            for (const provider of ['Gemini', 'Qwen']) {
                const policy = resolveReviewerRoutingPolicy(provider);
                assert.equal(policy.capability_level, 'single_agent_only', `${provider} capability_level`);
                assert.equal(policy.delegation_required, false, `${provider} delegation_required`);
                assert.equal(policy.fallback_allowed, true, `${provider} fallback_allowed`);
                assert.equal(policy.fallback_reason_required, true, `${provider} fallback_reason_required`);
                assert.equal(policy.expected_execution_mode, 'same_agent_fallback', `${provider} expected_execution_mode`);
            }
        });

        it('marks unknown providers as fallback-allowed with reason required', () => {
            const policy = resolveReviewerRoutingPolicy('UnknownProvider');
            assert.equal(policy.capability_level, 'unknown');
            assert.equal(policy.delegation_required, false);
            assert.equal(policy.fallback_allowed, true);
            assert.equal(policy.fallback_reason_required, true);
            assert.equal(policy.expected_execution_mode, 'same_agent_fallback');
        });

        it('marks null/empty provider as unknown with fallback reason required', () => {
            for (const value of [null, '', undefined]) {
                const policy = resolveReviewerRoutingPolicy(value);
                assert.equal(policy.capability_level, 'unknown', `value=${String(value)}`);
                assert.equal(policy.fallback_reason_required, true, `value=${String(value)}`);
            }
        });

        it('prefers task-mode provider over init-answers provider for routing policy', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Qwen'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Qwen',
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2]
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 3,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-code-scoped.json'),
                outputPath,
                repoRoot
            });

            assert.equal(result.reviewer_routing.source_of_truth, 'Codex');
            assert.equal(result.reviewer_routing.execution_provider, 'Codex');
            assert.equal(result.reviewer_routing.canonical_source_of_truth, 'Qwen');
            assert.equal(result.reviewer_routing.identity_status, 'resolved');
            assert.equal(result.reviewer_routing.delegation_required, true);
            assert.equal(result.reviewer_routing.expected_execution_mode, 'delegated_subagent');
            assert.equal(result.reviewer_routing.fallback_allowed, false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('keeps pinned explicit-provider task-mode identity resolved when no routed_to is present', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-explicit-provider-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-explicit-provider', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });

            const result = resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId: 'T-901-explicit-provider',
                allowLegacyFallback: false
            });

            assert.equal(result.execution_provider, 'Codex');
            assert.equal(result.execution_provider_source, 'explicit_provider');
            assert.equal(result.identity_status, 'resolved');
            assert.equal(result.delegation_required, true);
            assert.equal(result.expected_execution_mode, 'delegated_subagent');
            assert.equal(result.fallback_allowed, false);
            assert.deepEqual(result.violations, []);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('reads plan metadata from the explicit custom task-mode artifact path', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-plan-path-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-plan-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-plan',
                required_reviews: { code: true }
            }, null, 2), 'utf8');

            const defaultTaskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901-plan', '');
            fs.writeFileSync(defaultTaskModePath, JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901-plan',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Drifted default task-mode artifact without plan metadata',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            }), null, 2), 'utf8');

            const customTaskModePath = path.join(orchestratorRoot, 'runtime', 'custom-artifacts', 'T-901-plan-task-mode.json');
            fs.mkdirSync(path.dirname(customTaskModePath), { recursive: true });
            fs.writeFileSync(customTaskModePath, JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901-plan',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Preserve plan metadata from a custom task-mode artifact path',
                provider: 'Antigravity',
                canonicalSourceOfTruth: 'Codex',
                routedTo: '.antigravity/agents/orchestrator.md',
                executionProviderSource: 'provider_bridge',
                runtimeIdentityStatus: 'resolved',
                plan: {
                    plan_path: 'garda-agent-orchestrator/runtime/reviews/T-901-plan-task-plan.json',
                    plan_sha256: 'a'.repeat(64),
                    plan_summary: 'Preserve the approved plan from a custom task-mode artifact path'
                }
            }), null, 2), 'utf8');

            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-plan-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                taskModePath: customTaskModePath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });

            assert.equal(result.reviewer_routing.execution_provider, 'Antigravity');
            assert.equal(result.plan.plan_guided, true);
            assert.equal(result.plan.plan_path, 'garda-agent-orchestrator/runtime/reviews/T-901-plan-task-plan.json');
            assert.equal(result.plan.plan_summary, 'Preserve the approved plan from a custom task-mode artifact path');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects task-mode artifacts that omit pinned identity metadata', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-taskmode-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Qwen'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901',
                required_reviews: { test: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901', {
                provider: null,
                canonicalSourceOfTruth: null,
                routedTo: null,
                executionProviderSource: null,
                runtimeIdentityStatus: null
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2]
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-test-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'test',
                    depth: 3,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-test-scoped.json'),
                    outputPath,
                    repoRoot
                }),
                /missing canonical_source_of_truth|missing execution_provider_source|missing runtime_identity_status/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects stripped current-style task-mode artifacts when latest TASK_MODE_ENTERED still carries current-era markers', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-current-era-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901c-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901c',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            const taskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901c', '');
            const raw = JSON.parse(JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901c',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Reject stripped current-style task-mode artifacts at review-context build',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                runtimeIdentityStatus: 'resolved'
            })));
            delete raw.canonical_source_of_truth;
            delete raw.execution_provider_source;
            delete raw.reviewer_capability_level;
            delete raw.reviewer_expected_execution_mode;
            delete raw.reviewer_fallback_allowed;
            delete raw.reviewer_fallback_reason_required;
            delete raw.runtime_identity_status;
            delete raw.runtime_identity_violations;
            fs.writeFileSync(taskModePath, JSON.stringify(raw, null, 2), 'utf8');
            appendTaskEvent(orchestratorRoot, 'T-901c', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry before tampering.', {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                entry_mode: 'EXPLICIT_TASK_EXECUTION',
                requested_depth: 2,
                effective_depth: 2,
                task_summary: 'Reject stripped current-style task-mode artifacts at review-context build',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901c-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /missing canonical_source_of_truth|execution_provider_source/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('ignores malformed tail lines after the latest valid current-era TASK_MODE_ENTERED', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-current-era-tail-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'task-events'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901d-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901d',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            const taskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901d', '');
            const raw = JSON.parse(JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901d',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Ignore malformed tail after current task-mode entry at review-context build',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                runtimeIdentityStatus: 'resolved'
            })));
            delete raw.canonical_source_of_truth;
            delete raw.execution_provider_source;
            delete raw.reviewer_capability_level;
            delete raw.reviewer_expected_execution_mode;
            delete raw.reviewer_fallback_allowed;
            delete raw.reviewer_fallback_reason_required;
            delete raw.runtime_identity_status;
            delete raw.runtime_identity_violations;
            fs.writeFileSync(taskModePath, JSON.stringify(raw, null, 2), 'utf8');
            appendTaskEvent(orchestratorRoot, 'T-901d', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry before malformed tail.', {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                entry_mode: 'EXPLICIT_TASK_EXECUTION',
                requested_depth: 2,
                effective_depth: 2,
                task_summary: 'Ignore malformed tail after current task-mode entry at review-context build',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved'
            });
            fs.appendFileSync(path.join(orchestratorRoot, 'runtime', 'task-events', 'T-901d.jsonl'), '{"event_type":"TASK_MODE_ENTERED"', 'utf8');
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901d-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /missing canonical_source_of_truth|execution_provider_source/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects stale provider-only task-mode artifacts even when provider matches workspace canonical owner', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-provider-only-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901b-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901b',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901b', {
                provider: 'Codex',
                canonicalSourceOfTruth: null,
                routedTo: null,
                executionProviderSource: null,
                runtimeIdentityStatus: null
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901b-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /legacy_fallback|runtime identity is invalid/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects workspace canonical drift after task-mode identity is pinned', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-drift-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-902-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-902',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-902', {
                provider: 'Antigravity',
                canonicalSourceOfTruth: 'Codex',
                routedTo: '.antigravity/agents/orchestrator.md',
                executionProviderSource: 'provider_bridge',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Qwen'
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-902-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /contradicts task-mode canonical_source_of_truth/i
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        // T-1005: reviewer_routing includes explicit requirement fields
        it('includes reviewer_execution_mode_required and reviewer_identity_required for required reviews', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-req-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-1005',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-1005', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });

            assert.equal(result.task_id, 'T-1005');
            assert.equal(result.preflight_path, preflightPath.replace(/\\/g, '/'));
            assert.equal(typeof result.preflight_sha256, 'string');
            assert.ok(String(result.preflight_sha256 || '').length > 0);
            assert.equal(result.reviewer_routing.reviewer_execution_mode_required, true);
            assert.equal(result.reviewer_routing.reviewer_identity_required, true);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('sets reviewer requirement fields to false for non-required reviews', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-nonreq-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005b-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-1005b',
                required_reviews: { code: false }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-1005b', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005b-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });

            assert.equal(result.reviewer_routing.reviewer_execution_mode_required, false);
            assert.equal(result.reviewer_routing.reviewer_identity_required, false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('fails fast when the review-context artifact is locked by a live writer', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-locked-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1006-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-1006',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-1006', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1006-code-review-context.json');
            const lockPath = `${outputPath}.lock`;
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /Timed out acquiring file lock/
            );
            assert.equal(fs.existsSync(outputPath), false);
            assert.equal(fs.existsSync(outputPath.replace(/\.json$/, '.md')), false);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
    });
});
