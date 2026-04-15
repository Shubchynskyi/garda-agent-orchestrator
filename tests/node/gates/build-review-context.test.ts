import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildReviewContext, getRulePack, toNonNegativeInt, resolveContextOutputPath, resolveScopedDiffMetadataPath } from '../../../src/gates/build-review-context';
import { buildTaskModeArtifact, resolveTaskModeArtifactPath } from '../../../src/gates/task-mode';
import { resolveReviewerRoutingPolicy } from '../../../src/gates/reviewer-routing';

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
            assert.ok(result!.includes('T-001-code-context.json'));
        });
    });

    describe('resolveScopedDiffMetadataPath', () => {
        it('derives from preflight path when explicit is empty', () => {
            const result = resolveScopedDiffMetadataPath('', '/repo/reviews/T-001-preflight.json', 'db', '/repo');
            assert.ok(result!.includes('T-001-db-scoped.json'));
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
            const taskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901', '');
            fs.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 3,
                effectiveDepth: 3,
                taskSummary: 'Enforce delegated reviewer routing',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            }), null, 2), 'utf8');
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
            assert.equal(result.reviewer_routing.delegation_required, true);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('falls back to init-answers provider when task-mode provider is unavailable', () => {
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
            const taskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901', '');
            fs.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 3,
                effectiveDepth: 3,
                taskSummary: 'Enforce delegated reviewer routing',
                provider: null,
                routedTo: 'AGENTS.md'
            }), null, 2), 'utf8');
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2]
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-test-review-context.json');

            const result = buildReviewContext({
                reviewType: 'test',
                depth: 3,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-test-scoped.json'),
                outputPath,
                repoRoot
            });

            assert.equal(result.reviewer_routing.source_of_truth, 'Qwen');
            assert.equal(result.reviewer_routing.delegation_required, false);
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
