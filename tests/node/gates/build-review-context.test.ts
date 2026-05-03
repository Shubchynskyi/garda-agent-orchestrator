import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { buildReviewContext, getRulePack, toNonNegativeInt, resolveContextOutputPath, resolveScopedDiffMetadataPath } from '../../../src/gates/build-review-context';
import { getWorkspaceSnapshot } from '../../../src/gates/compile-gate';
import { buildChangedFileFingerprintEntries } from '../../../src/gates/review-context-diff';
import { buildReviewTreeState } from '../../../src/gates/review-tree-state';
import {
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath
} from '../../../src/gates/review-context-paths';
import { computeReviewContextReuseHash } from '../../../src/gates/review-reuse';
import { buildTaskModeArtifact, getTaskModeEvidence, resolveTaskModeArtifactPath } from '../../../src/gates/task-mode';
import { resolveReviewerRoutingPolicy, resolveRuntimeReviewerIdentity } from '../../../src/gates/reviewer-routing';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

function sha256Text(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function writeTaskModeArtifactFixture(
    repoRoot: string,
    taskId: string,
    options: {
        provider: string | null;
        canonicalSourceOfTruth: string | null;
        routedTo?: string | null;
        executionProviderSource?: string | null;
        runtimeIdentityStatus?: string | null;
        materializeRoutedTo?: boolean;
        reviewerSubagentLaunchStatus?: 'launchable' | 'blocked' | 'unknown' | null;
        reviewerSubagentLaunchRoute?: string | null;
        reviewerSubagentLaunchReason?: string | null;
        reviewerSubagentLaunchRemediation?: string | null;
    }
): void {
    const normalizedRoutedTo = options.routedTo ? String(options.routedTo).replace(/\\/g, '/').replace(/^\.\//, '') : null;
    if (normalizedRoutedTo && options.materializeRoutedTo !== false) {
        const routePath = path.join(repoRoot, normalizedRoutedTo);
        fs.mkdirSync(path.dirname(routePath), { recursive: true });
        if (!fs.existsSync(routePath)) {
            fs.writeFileSync(routePath, '# routed workflow fixture\n', 'utf8');
        }
    }
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
        runtimeIdentityStatus: options.runtimeIdentityStatus ?? null,
        reviewerSubagentLaunchStatus: options.reviewerSubagentLaunchStatus ?? null,
        reviewerSubagentLaunchRoute: options.reviewerSubagentLaunchRoute ?? null,
        reviewerSubagentLaunchReason: options.reviewerSubagentLaunchReason ?? null,
        reviewerSubagentLaunchRemediation: options.reviewerSubagentLaunchRemediation ?? null
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

        it('rejects explicit review-context paths that escape the repo through symlinked directories', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-paths-link-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-paths-outside-'));
            try {
                const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
                fs.mkdirSync(reviewsRoot, { recursive: true });
                fs.writeFileSync(path.join(outsideRoot, 'context.json'), '{}\n', 'utf8');
                const linkedDirPath = path.join(reviewsRoot, 'linked-outside');
                try {
                    fs.symlinkSync(outsideRoot, linkedDirPath, process.platform === 'win32' ? 'junction' : 'dir');
                } catch (error) {
                    t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }

                assert.throws(() => resolveCanonicalReviewContextPath({
                    reviewsRoot,
                    taskId: 'T-001',
                    reviewType: 'code',
                    explicitPath: path.join(linkedDirPath, 'context.json'),
                    repoRoot
                }), /Review context path must resolve inside (reviews|repo) root/);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });
    });

    describe('resolveReviewerRoutingPolicy', () => {
        it('marks Codex as delegation-required', () => {
            const policy = resolveReviewerRoutingPolicy('Codex');
            assert.equal(policy.delegation_required, true);
            assert.equal(policy.expected_execution_mode, 'delegated_subagent');
            assert.equal(policy.fallback_allowed, false);
        });

        it('marks Antigravity as delegation-required', () => {
            const policy = resolveReviewerRoutingPolicy('Antigravity');
            assert.equal(policy.capability_level, 'delegation_required');
            assert.equal(policy.delegation_required, true);
            assert.equal(policy.expected_execution_mode, 'delegated_subagent');
            assert.equal(policy.fallback_allowed, false);
            assert.equal(policy.fallback_reason_required, false);
        });

        it('marks previously single-agent providers as delegation-required', () => {
            for (const provider of ['Gemini', 'Qwen']) {
                const policy = resolveReviewerRoutingPolicy(provider);
                assert.equal(policy.capability_level, 'delegation_required', `${provider} capability_level`);
                assert.equal(policy.delegation_required, true, `${provider} delegation_required`);
                assert.equal(policy.fallback_allowed, false, `${provider} fallback_allowed`);
                assert.equal(policy.fallback_reason_required, false, `${provider} fallback_reason_required`);
                assert.equal(policy.expected_execution_mode, 'delegated_subagent', `${provider} expected_execution_mode`);
            }
        });

        it('marks unknown providers as delegated-only until proven otherwise', () => {
            const policy = resolveReviewerRoutingPolicy('UnknownProvider');
            assert.equal(policy.capability_level, 'unknown');
            assert.equal(policy.delegation_required, true);
            assert.equal(policy.fallback_allowed, false);
            assert.equal(policy.fallback_reason_required, false);
            assert.equal(policy.expected_execution_mode, 'delegated_subagent');
        });

        it('marks null/empty provider as unknown with delegated-only routing', () => {
            for (const value of [null, '', undefined]) {
                const policy = resolveReviewerRoutingPolicy(value);
                assert.equal(policy.capability_level, 'unknown', `value=${String(value)}`);
                assert.equal(policy.delegation_required, true, `value=${String(value)}`);
                assert.equal(policy.fallback_allowed, false, `value=${String(value)}`);
                assert.equal(policy.fallback_reason_required, false, `value=${String(value)}`);
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

        it('reuses precomputed task-mode evidence and runtime identity without rereading the task-mode artifact', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-runtime-cache-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Qwen'
            }, null, 2), 'utf8');
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-cache-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-cache',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-cache', {
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
            const taskModeEvidence = getTaskModeEvidence(repoRoot, 'T-901-cache', '');
            const runtimeReviewerIdentity = resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId: 'T-901-cache',
                taskModeEvidence,
                allowLegacyFallback: true
            });
            fs.rmSync(resolveTaskModeArtifactPath(repoRoot, 'T-901-cache', ''), { force: true });

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 3,
                preflightPath,
                taskModePath: '',
                taskModeEvidence,
                runtimeReviewerIdentity,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-cache-code-scoped.json'),
                outputPath: path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-cache-code-review-context.json'),
                repoRoot
            });

            assert.equal(result.reviewer_routing.source_of_truth, 'Codex');
            assert.equal(result.reviewer_routing.execution_provider, 'Codex');
            assert.equal(result.reviewer_routing.canonical_source_of_truth, 'Qwen');
            assert.equal(result.reviewer_routing.identity_status, 'resolved');
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
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.reviewer_subagent_launch_route, 'AGENTS.md');
            assert.match(result.reviewer_subagent_launch_reason, /explicit provider selection/i);
            assert.deepEqual(result.violations, []);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('does not inherit task-mode routed_to when an explicit provider override omits --routed-to', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-explicit-provider-override-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-explicit-provider-override', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });

            const result = resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId: 'T-901-explicit-provider-override',
                executionProvider: 'Codex',
                allowLegacyFallback: false
            });

            assert.equal(result.execution_provider, 'Codex');
            assert.equal(result.execution_provider_source, 'explicit_provider');
            assert.equal(result.routed_to, null);
            assert.equal(result.identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.reviewer_subagent_launch_route, 'AGENTS.md');
            assert.match(result.reviewer_subagent_launch_reason, /explicit provider selection/i);
            assert.deepEqual(result.violations, []);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('keeps shared AGENTS.md routed_to resolved for Cursor when provider is explicit in task-mode', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-cursor-shared-entrypoint-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Cursor'
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-cursor-shared-entrypoint', {
                provider: 'Cursor',
                canonicalSourceOfTruth: 'Cursor',
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });

            const result = resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId: 'T-901-cursor-shared-entrypoint',
                allowLegacyFallback: false
            });

            assert.equal(result.execution_provider, 'Cursor');
            assert.equal(result.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.routed_to, 'AGENTS.md');
            assert.equal(result.identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.deepEqual(result.violations, []);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('flags shared AGENTS.md route as ambiguous when no provider disambiguates it', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-shared-route-ambiguous-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Cursor'
            }, null, 2), 'utf8');

            const result = resolveRuntimeReviewerIdentity({
                repoRoot,
                routedTo: 'AGENTS.md',
                allowLegacyFallback: false
            });

            assert.equal(result.execution_provider, null);
            assert.equal(result.identity_status, 'contradictory');
            assert.ok(result.violations.some((violation) => violation.includes('shared by multiple providers')));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('builds required review-contexts when task-mode uses a direct explicit_provider session', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-launch-blocked-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-launch',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-launch', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'explicit_provider');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('writes task scope and changed files into the reviewer prompt artifact', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-task-scope-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2]
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-scope', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-scope-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-scope',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/app.ts'],
                required_reviews: { code: true, security: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-scope-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-scope-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('# Review Context: T-901-scope code'));
            assert.ok(promptArtifact.includes('## Changed Files'));
            assert.ok(promptArtifact.includes('- src/app.ts'));
            assert.equal(result.reviewer_routing.opaque_handoff_required, true);
            assert.ok(String(result.reviewer_routing.opaque_handoff_instruction || '').includes('opaque handoff artifact'));
            assert.ok(String(result.reviewer_routing.opaque_handoff_instruction || '').includes('Do not open or summarize'));
            assert.ok(promptArtifact.includes('## Reviewer Output Contract'));
            assert.ok(promptArtifact.includes('Return a canonical code review report using exactly this section order and heading text'));
            assert.ok(promptArtifact.includes('```markdown\n## Findings by Severity'));
            assert.ok(promptArtifact.includes('## Deferred Findings'));
            assert.ok(promptArtifact.includes('## Residual Risks'));
            assert.ok(promptArtifact.includes('## Verdict'));
            assert.ok(promptArtifact.includes('1-3 concise sentences naming the reviewed files and behavior checked'));
            assert.ok(promptArtifact.includes('Do not return only headings, `none`, and a PASS verdict'));
            assert.ok(promptArtifact.includes('record-review-result rejects trivial or obviously synthetic reports'));
            assert.deepEqual(result.task_scope.changed_files, ['src/app.ts']);
            assert.deepEqual(result.task_scope.required_reviews, ['code', 'security']);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('uses staged diffs and a dynamic markdown fence in reviewer prompt artifacts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-staged-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'staged.md'),
                '```ts\nexport const staged = true;\n```\n',
                'utf8'
            );
            runGit(repoRoot, ['add', 'src/staged.md']);
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-staged', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-staged-preflight.json');
            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-staged',
                detection_source: 'git_staged_only',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/staged.md'],
                metrics: {
                    changed_files_sha256: stagedSnapshot.changed_files_sha256,
                    scope_content_sha256: stagedSnapshot.scope_content_sha256,
                    scope_sha256: stagedSnapshot.scope_sha256
                },
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-staged-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-staged-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('+export const staged = true;'));
            assert.ok(promptArtifact.includes('````diff'));
            assert.ok(promptArtifact.includes('## Review Tree State'));
            assert.ok(promptArtifact.includes('Use staged snapshot: true'));
            assert.equal(result.task_scope.diff.source, 'git_diff_cached');
            assert.match(String(result.tree_state.tree_state_sha256), /^[0-9a-f]{64}$/);
            assert.equal(result.tree_state.use_staged, true);
            assert.deepEqual(result.tree_state.stale_staged_snapshot_files, []);
            const stagedFingerprints = buildChangedFileFingerprintEntries(repoRoot, ['src/staged.md'], { stagedScope: true });
            assert.equal(stagedFingerprints[0].status, 'staged');
            assert.equal(Object.prototype.hasOwnProperty.call(stagedFingerprints[0], 'sha256'), false);

            const cachedResult = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-staged-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-staged-security-review-context.json'),
                repoRoot
            });
            const cachedPromptArtifact = fs.readFileSync(cachedResult.rule_context.artifact_path, 'utf8');
            assert.equal(cachedResult.task_scope.diff.cached, true);
            assert.ok(cachedPromptArtifact.includes('+export const staged = true;'));

            fs.writeFileSync(path.join(repoRoot, 'src', 'staged.md'), '```ts\nexport const dirty = true;\n```\n', 'utf8');
            assert.throws(
                () => buildReviewContext({
                    reviewType: 'refactor',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: tokenConfigPath,
                    scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-staged-refactor-scoped.json'),
                    outputPath: path.join(reviewsRoot, 'T-901-staged-refactor-review-context.json'),
                    repoRoot
                }),
                /Staged review scope is stale: src\/staged\.md has unstaged working-tree changes/
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('fails closed when review tree-state git probes cannot be read', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-tree-state-probe-fail-'));
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');

            assert.throws(
                () => buildReviewTreeState({
                    repoRoot,
                    detectionSource: 'git_staged_only',
                    includeUntracked: false,
                    changedFiles: ['src/app.ts']
                }),
                /Unable to collect review tree state: git status .* failed/
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects staged delete snapshots when the same path is recreated before review', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-staged-delete-recreate-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['config', 'status.showUntrackedFiles', 'no']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-staged-delete-recreate', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            runGit(repoRoot, ['rm', 'src/app.ts']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            assert.deepEqual(stagedSnapshot.changed_files, ['src/app.ts']);
            const preflightPath = path.join(reviewsRoot, 'T-901-staged-delete-recreate-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-staged-delete-recreate',
                detection_source: 'git_staged_only',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: stagedSnapshot.changed_files,
                metrics: {
                    changed_files_sha256: stagedSnapshot.changed_files_sha256,
                    scope_content_sha256: stagedSnapshot.scope_content_sha256,
                    scope_sha256: stagedSnapshot.scope_sha256
                },
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: tokenConfigPath,
                    scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-staged-delete-recreate-code-scoped.json'),
                    outputPath: path.join(reviewsRoot, 'T-901-staged-delete-recreate-code-review-context.json'),
                    repoRoot
                }),
                /Staged review scope is stale: src\/app\.ts has unstaged working-tree changes/
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('binds unstaged working-tree review contexts to file hashes without requiring staged scope', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-unstaged-tree-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            runGit(repoRoot, ['add', 'garda-agent-orchestrator/live']);
            runGit(repoRoot, ['commit', '-m', 'rules']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
            const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
            writeTaskModeArtifactFixture(repoRoot, 'T-901-unstaged-tree', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-unstaged-tree-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-unstaged-tree',
                detection_source: 'git_auto',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                },
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-unstaged-tree-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-unstaged-tree-code-review-context.json'),
                repoRoot
            });

            assert.equal(result.tree_state.use_staged, false);
            assert.deepEqual(result.tree_state.changed_files, ['src/app.ts']);
            assert.match(String(result.tree_state.tree_state_sha256), /^[0-9a-f]{64}$/);
            assert.equal(result.tree_state.entries[0].worktree.status, 'file');
            assert.match(String(result.tree_state.entries[0].worktree.sha256), /^[0-9a-f]{64}$/);
            assert.equal(result.task_scope.diff.source, 'git_diff_head_plus_untracked');
            assert.match(String(result.task_scope.diff.diff_sha256), /^[0-9a-f]{64}$/);
            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('Use staged snapshot: false'));
            assert.ok(promptArtifact.includes('Tree state sha256:'));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('keeps reviewer-context git diff collection on the shared timeout wrapper with hardened flags', () => {
            const source = fs.readFileSync(path.join(process.cwd(), 'src', 'gates', 'review-context-diff.ts'), 'utf8');

            assert.equal(source.includes("childProcess.spawnSync('git'"), false);
            assert.ok(source.includes("spawnSyncWithTimeout('git'"));
            assert.ok(source.includes('timeoutMs: DEFAULT_GIT_TIMEOUT_MS'));
            assert.equal(source.includes('hashRegularFileBytes'), false);
            assert.equal(source.includes("fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-diff-'"), false);
            assert.ok(source.includes("'--no-ext-diff'"));
            assert.ok(source.includes("'--no-textconv'"));
            assert.ok(source.includes("'--no-color'"));
        });

        it('includes untracked file content for explicit changed-file review contexts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-explicit-untracked-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'new.ts'), 'export const created = true;\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-explicit-untracked', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-explicit-untracked-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-explicit-untracked',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/new.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-explicit-untracked-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-explicit-untracked-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('+export const created = true;'));
            assert.equal(result.task_scope.diff.available, true);
            assert.equal(result.task_scope.diff.source, 'git_diff_head_plus_untracked');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('keeps untracked new file content reviewable when tracked diff consumes the context budget', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-untracked-priority-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'large.ts'), 'export const baseline = true;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/large.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'large.ts'),
                `${Array.from({ length: 8000 }, (_, index) => `export const value${index} = ${index};`).join('\n')}\n`,
                'utf8'
            );
            fs.writeFileSync(path.join(repoRoot, 'src', 'new-guard.ts'), 'export const reviewableNewFile = true;\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-untracked-priority', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-untracked-priority-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-untracked-priority',
                detection_source: 'git_auto',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/large.ts', 'src/new-guard.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-untracked-priority-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-untracked-priority-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.equal(result.task_scope.diff.truncated, true);
            assert.ok(promptArtifact.includes('diff --git a/src/new-guard.ts b/src/new-guard.ts'));
            assert.ok(promptArtifact.includes('+export const reviewableNewFile = true;'));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects required code review contexts without task diff material for changed code files', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-missing-diff-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const stable = true;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-missing-diff', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-missing-diff-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-missing-diff',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/app.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: tokenConfigPath,
                    scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-missing-diff-code-scoped.json'),
                    outputPath: path.join(reviewsRoot, 'T-901-missing-diff-code-review-context.json'),
                    repoRoot
                }),
                /no task diff material.*src\/app\.ts/s
            );
            assert.equal(fs.existsSync(path.join(reviewsRoot, 'T-901-missing-diff-code-review-context.json')), false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects required scoped reviews when preflight expects metadata even if live config changed', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-missing-scoped-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('security').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export const auth = true;\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({
                enabled: false,
                enabled_depths: [1, 2],
                scoped_diffs: false
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-missing-scoped', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-missing-scoped-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-missing-scoped',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/auth.ts'],
                required_reviews: { security: true },
                triggers: { runtime_changed: true, runtime_code_changed: true, security: true },
                budget_forecast: { token_economy_active_for_depth: true },
                risk_aware_depth: { compression: { scoped_diffs: true } }
            }, null, 2), 'utf8');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'security',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: tokenConfigPath,
                    scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-missing-scoped-security-scoped.json'),
                    outputPath: path.join(reviewsRoot, 'T-901-missing-scoped-security-review-context.json'),
                    repoRoot
                }),
                /expects scoped diff metadata.*src\/auth\.ts/s
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('binds scoped diff metadata hashes into review-context validation and reuse hashing', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-scoped-binding-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('security').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export const auth = true;\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2],
                scoped_diffs: true
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-scoped-binding', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/auth.ts']);
            const preflightPath = path.join(reviewsRoot, 'T-901-scoped-binding-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-scoped-binding',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/auth.ts'],
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                },
                required_reviews: { security: true },
                triggers: { runtime_changed: true, runtime_code_changed: true, security: true },
                budget_forecast: { token_economy_active_for_depth: true },
                risk_aware_depth: { compression: { scoped_diffs: true } }
            }, null, 2), 'utf8');
            const preflightSha256 = sha256Text(fs.readFileSync(preflightPath, 'utf8'));
            const scopedDiffOutputPath = path.join(reviewsRoot, 'T-901-scoped-binding-security-scoped.diff');
            const scopedDiffMetadataPath = path.join(reviewsRoot, 'T-901-scoped-binding-security-scoped.json');
            const scopedDiffText = [
                'diff --git a/src/auth.ts b/src/auth.ts',
                'new file mode 100644',
                '--- /dev/null',
                '+++ b/src/auth.ts',
                '@@ -0,0 +1 @@',
                '+export const auth = true;',
                ''
            ].join('\n');
            fs.writeFileSync(scopedDiffOutputPath, scopedDiffText, 'utf8');
            const metadata = {
                review_type: 'security',
                preflight_path: preflightPath.replace(/\\/g, '/'),
                preflight_sha256: preflightSha256,
                detection_source: 'explicit_changed_files',
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256,
                output_path: scopedDiffOutputPath.replace(/\\/g, '/'),
                metadata_path: scopedDiffMetadataPath.replace(/\\/g, '/'),
                use_staged: false,
                include_untracked: true,
                changed_files_count: 1,
                changed_files: ['src/auth.ts'],
                matched_files_count: 1,
                matched_files: ['src/auth.ts'],
                fallback_to_full_diff: false,
                output_diff_sha256: sha256Text(scopedDiffText),
                scoped_diff_line_count: scopedDiffText.split('\n').length,
                output_diff_line_count: scopedDiffText.split('\n').length,
                hunk_level: false
            };
            fs.writeFileSync(scopedDiffMetadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

            const result = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath,
                outputPath: path.join(reviewsRoot, 'T-901-scoped-binding-security-review-context.json'),
                repoRoot
            });

            const reuseHash = computeReviewContextReuseHash(result as Record<string, unknown>);
            assert.match(String(reuseHash || ''), /^[0-9a-f]{64}$/);
            const pathOnlyMutation = cloneJson(result as Record<string, unknown>);
            pathOnlyMutation.preflight_path = 'garda-agent-orchestrator/runtime/reviews/other-preflight.json';
            pathOnlyMutation.preflight_sha256 = '9'.repeat(64);
            pathOnlyMutation.output_path = 'garda-agent-orchestrator/runtime/reviews/other-context.json';
            (pathOnlyMutation.scoped_diff as Record<string, unknown>).metadata_path = 'garda-agent-orchestrator/runtime/reviews/other-scoped.json';
            const pathOnlyMetadata = (pathOnlyMutation.scoped_diff as Record<string, unknown>).metadata as Record<string, unknown>;
            pathOnlyMetadata.preflight_path = 'garda-agent-orchestrator/runtime/reviews/other-preflight.json';
            pathOnlyMetadata.metadata_path = 'garda-agent-orchestrator/runtime/reviews/other-scoped.json';
            pathOnlyMetadata.output_path = 'garda-agent-orchestrator/runtime/reviews/other-scoped.diff';
            assert.equal(computeReviewContextReuseHash(pathOnlyMutation), reuseHash);

            const scopeMutation = cloneJson(result as Record<string, unknown>);
            ((scopeMutation.scoped_diff as Record<string, unknown>).metadata as Record<string, unknown>).scope_sha256 = 'f'.repeat(64);
            assert.notEqual(computeReviewContextReuseHash(scopeMutation), reuseHash);

            const staleMetadata = {
                ...metadata,
                preflight_sha256: '0'.repeat(64),
                changed_files_sha256: '1'.repeat(64),
                scope_content_sha256: '2'.repeat(64),
                scope_sha256: '3'.repeat(64)
            };
            fs.writeFileSync(scopedDiffMetadataPath, JSON.stringify(staleMetadata, null, 2) + '\n', 'utf8');
            assert.throws(
                () => buildReviewContext({
                    reviewType: 'security',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: tokenConfigPath,
                    scopedDiffMetadataPath,
                    outputPath: path.join(reviewsRoot, 'T-901-scoped-binding-stale-security-review-context.json'),
                    repoRoot
                }),
                (error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    assert.match(message, /stale preflight_sha256/);
                    assert.match(message, /stale changed_files_sha256/);
                    assert.match(message, /stale scope_content_sha256/);
                    assert.match(message, /stale scope_sha256/);
                    return true;
                }
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('does not require scoped diff metadata for true docs-only review contexts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-docs-only-scoped-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('security').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'docs', 'usage.md'), '# Usage\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2],
                scoped_diffs: true
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-docs-only-scoped', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-docs-only-scoped-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-docs-only-scoped',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'docs-only',
                changed_files: ['docs/usage.md'],
                required_reviews: { security: true },
                triggers: { runtime_changed: false, runtime_code_changed: false, security: true },
                budget_forecast: { token_economy_active_for_depth: true },
                risk_aware_depth: { compression: { scoped_diffs: true } }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-docs-only-scoped-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-docs-only-scoped-security-review-context.json'),
                repoRoot
            });

            assert.equal(result.scoped_diff.expected, false);
            assert.equal(result.scoped_diff.metadata, null);
            assert.equal(result.task_scope.diff.available, true);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('preserves whitespace in untracked file content for reviewer prompt artifacts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-explicit-untracked-whitespace-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'new.ts'),
                '  export const created = true;\nexport const spaced = true;   ',
                'utf8'
            );
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-explicit-untracked-whitespace', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-explicit-untracked-whitespace-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-explicit-untracked-whitespace',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/new.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-explicit-untracked-whitespace-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-explicit-untracked-whitespace-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('+  export const created = true;'));
            assert.ok(promptArtifact.includes('+export const spaced = true;   '));
            assert.equal(result.task_scope.diff.source, 'git_diff_head_plus_untracked');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('invalidates shared scoped diff cache when same preflight file content changes with identical stat output', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-diff-cache-content-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('security').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'cached.ts'), 'export const cached = "alpha";\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-diff-cache-content', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-diff-cache-content-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-diff-cache-content',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/cached.ts'],
                required_reviews: { code: true, security: false, refactor: false },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const firstResult = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-diff-cache-content-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-diff-cache-content-security-review-context.json'),
                repoRoot
            });
            const firstPromptArtifact = fs.readFileSync(firstResult.rule_context.artifact_path, 'utf8');
            assert.ok(firstPromptArtifact.includes('+export const cached = "alpha";'));

            fs.writeFileSync(path.join(repoRoot, 'src', 'cached.ts'), 'export const cached = "bravo";\n', 'utf8');
            const secondResult = buildReviewContext({
                reviewType: 'refactor',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-diff-cache-content-refactor-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-diff-cache-content-refactor-review-context.json'),
                repoRoot
            });

            const secondPromptArtifact = fs.readFileSync(secondResult.rule_context.artifact_path, 'utf8');
            assert.ok(secondPromptArtifact.includes('+export const cached = "bravo";'));
            assert.equal(secondPromptArtifact.includes('+export const cached = "alpha";'), false);
            assert.equal(secondResult.task_scope.diff.cached, false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('does not expand glob-looking changed files as git pathspecs', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-literal-pathspec-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'secret.ts'), 'export const secret = "do-not-include";\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-literal-pathspec', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-literal-pathspec-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-literal-pathspec',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/*.ts'],
                required_reviews: { code: false },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-literal-pathspec-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-literal-pathspec-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.equal(promptArtifact.includes('do-not-include'), false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects git pathspec magic in preflight changed files', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-pathspec-magic-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-pathspec-magic', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-pathspec-magic-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-pathspec-magic',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: [':(glob)src/*.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            assert.throws(() => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-pathspec-magic-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-pathspec-magic-code-review-context.json'),
                repoRoot
            }), /unsafe path/);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects preflight artifacts that escape the repo through symlinked review directories', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-preflight-link-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-preflight-outside-'));
            try {
                const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
                const runtimeRoot = path.join(orchestratorRoot, 'runtime');
                const reviewsRoot = path.join(runtimeRoot, 'reviews');
                fs.mkdirSync(runtimeRoot, { recursive: true });
                try {
                    fs.symlinkSync(outsideRoot, reviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');
                } catch (error) {
                    t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
                const preflightPath = path.join(reviewsRoot, 'T-901-preflight-link-preflight.json');
                fs.writeFileSync(preflightPath, JSON.stringify({
                    task_id: 'T-901-preflight-link',
                    detection_source: 'explicit_changed_files',
                    changed_files: ['src/app.ts'],
                    required_reviews: { code: true }
                }), 'utf8');

                assert.throws(() => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-preflight-link-code-scoped.json'),
                    outputPath: path.join(reviewsRoot, 'T-901-preflight-link-code-review-context.json'),
                    repoRoot
                }), /PreflightPath must resolve inside repo root/);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });

        it('rejects untracked symlinks that resolve outside the repo before building reviewer prompt artifacts', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-untracked-symlink-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-outside-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const outsideSecretPath = path.join(outsideRoot, 'secret.txt');
            const secret = 'outside-secret-that-must-not-enter-review-context';
            fs.writeFileSync(outsideSecretPath, `${secret}\n`, 'utf8');
            const symlinkPath = path.join(repoRoot, 'src', 'linked-secret.txt');
            try {
                fs.symlinkSync(outsideSecretPath, symlinkPath, 'file');
            } catch (error) {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
                t.skip(`symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-untracked-symlink', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-untracked-symlink-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-untracked-symlink',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/linked-secret.txt'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            assert.throws(() => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-untracked-symlink-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-untracked-symlink-code-review-context.json'),
                repoRoot
            }), /Review scope contains paths that resolve outside the repo/);
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        });

        it('rejects untracked files under symlinked directories before building reviewer prompt artifacts', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-untracked-dir-symlink-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-outside-dir-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const outsideSecretPath = path.join(outsideRoot, 'secret.txt');
            const secret = 'outside-directory-secret-that-must-not-enter-review-context';
            fs.writeFileSync(outsideSecretPath, `${secret}\n`, 'utf8');
            const symlinkDirPath = path.join(repoRoot, 'src', 'linked-outside');
            try {
                fs.symlinkSync(outsideRoot, symlinkDirPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-untracked-dir-symlink', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-untracked-dir-symlink-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-untracked-dir-symlink',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/linked-outside/secret.txt'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const snapshotBeforeExternalChange = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/linked-outside/secret.txt']
            );
            fs.writeFileSync(outsideSecretPath, `${secret}-changed\nsecond-outside-line\n`, 'utf8');
            const snapshotAfterExternalChange = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/linked-outside/secret.txt']
            );
            assert.equal(snapshotAfterExternalChange.scope_content_sha256, snapshotBeforeExternalChange.scope_content_sha256);
            assert.equal(snapshotAfterExternalChange.changed_lines_total, snapshotBeforeExternalChange.changed_lines_total);

            const fingerprintEntries = buildChangedFileFingerprintEntries(repoRoot, ['src/linked-outside/secret.txt']);
            assert.equal(fingerprintEntries[0].status, 'outside_repo');
            assert.equal(Object.prototype.hasOwnProperty.call(fingerprintEntries[0], 'sha256'), false);

            assert.throws(() => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-untracked-dir-symlink-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-untracked-dir-symlink-code-review-context.json'),
                repoRoot
            }), /Review scope contains paths that resolve outside the repo/);

            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        });

        it('bounds oversized staged diffs instead of failing on process output buffers', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-large-diff-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'large.txt'), `${'x'.repeat(70000)}\n`, 'utf8');
            runGit(repoRoot, ['add', 'src/large.txt']);
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-large-diff', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-large-diff-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-large-diff',
                detection_source: 'git_staged_only',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/large.txt'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-large-diff-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-large-diff-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('[diff truncated at 60000 chars'));
            assert.equal(result.task_scope.diff.truncated, true);
            assert.equal(typeof result.task_scope.diff.cache_path, 'string');
            assert.equal(fs.existsSync(String(result.task_scope.diff.cache_path)), true);

            const securityResult = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-large-diff-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-large-diff-security-review-context.json'),
                repoRoot
            });

            const securityPromptArtifact = fs.readFileSync(securityResult.rule_context.artifact_path, 'utf8');
            assert.ok(securityPromptArtifact.includes('[diff excerpt truncated at 20000 chars'));
            assert.ok(securityPromptArtifact.includes('full bounded scoped diff cache'));
            assert.equal(securityResult.task_scope.diff.cached, true);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('prioritizes changed test diff sections in test review prompt excerpts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-test-priority-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'gates'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            for (const ruleFile of getRulePack('test').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'large.ts'), 'export const before = true;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step.test.ts'), 'import assert from "node:assert/strict";\n', 'utf8');
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'large.ts'),
                `${'export const filler = "'.repeat(2500)}tail";\n`,
                'utf8'
            );
            fs.appendFileSync(
                path.join(repoRoot, 'tests', 'node', 'gates', 'next-step.test.ts'),
                'assert.equal("review-cycle-block-test-priority", "review-cycle-block-test-priority");\n',
                'utf8'
            );
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-test-priority', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-test-priority-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-test-priority',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'mixed',
                changed_files: [
                    'src/large.ts',
                    'tests/node/gates/next-step.test.ts'
                ],
                required_reviews: { code: true, test: true },
                triggers: { runtime_changed: true, runtime_code_changed: true, test: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'test',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-test-priority-test-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-test-priority-test-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            const testDiffIndex = promptArtifact.indexOf('diff --git a/tests/node/gates/next-step.test.ts');
            const sourceDiffIndex = promptArtifact.indexOf('diff --git a/src/large.ts');
            assert.ok(testDiffIndex >= 0, 'test diff should be visible in the test review prompt excerpt');
            assert.ok(sourceDiffIndex >= 0, 'source diff should still be present after the prioritized test diff');
            assert.ok(testDiffIndex < sourceDiffIndex, 'test diff should appear before source diff for test reviews');
            assert.ok(promptArtifact.includes('review-cycle-block-test-priority'));
            assert.ok(promptArtifact.includes('[diff excerpt truncated at 20000 chars'));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('preserves blocked reviewer launchability from current task-mode runtime evidence', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-task-mode-blocked-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-task-mode-blocked', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved',
                reviewerSubagentLaunchStatus: 'blocked',
                reviewerSubagentLaunchReason: 'Reviewer subagent launch is blocked for the persisted task-mode runtime.',
                reviewerSubagentLaunchRemediation: 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.'
            });

            const result = resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId: 'T-901-task-mode-blocked',
                allowLegacyFallback: false
            });

            assert.equal(result.execution_provider, 'Codex');
            assert.equal(result.execution_provider_source, 'explicit_provider');
            assert.equal(result.identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'blocked');
            assert.match(result.reviewer_subagent_launch_reason, /persisted task-mode runtime/i);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('builds reusable non-required code review-contexts when task-mode uses a direct explicit_provider session', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-launch-blocked-reuse-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-reuse-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-launch-reuse',
                required_reviews: { code: false, test: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-launch-reuse', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-reuse-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'explicit_provider');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects build-review-context when current task-mode runtime persists blocked reviewer launchability', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-blocked-launchability-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-blocked-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-launch-blocked',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-launch-blocked', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved',
                reviewerSubagentLaunchStatus: 'blocked',
                reviewerSubagentLaunchReason: 'Reviewer subagent launch is blocked for the persisted task-mode runtime.',
                reviewerSubagentLaunchRemediation: 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-blocked-code-review-context.json');

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
                /delegated reviewer launch is not attested/i
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('builds required review-contexts when a bridge-based provider uses its root entrypoint', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-bridge-root-entrypoint-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'GitHubCopilot'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-bridge-root-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-bridge-root',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-bridge-root', {
                provider: 'GitHubCopilot',
                canonicalSourceOfTruth: 'GitHubCopilot',
                routedTo: '.github/copilot-instructions.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-bridge-root-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('keeps review-context builds usable when routed telemetry points at a missing file', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-missing-route-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-missing-route-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-missing-route',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-missing-route', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: 'AGENTS.md',
                materializeRoutedTo: false,
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-missing-route-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
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
            const antigravityBridgePath = path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md');
            fs.mkdirSync(path.dirname(antigravityBridgePath), { recursive: true });
            fs.writeFileSync(antigravityBridgePath, '# antigravity bridge fixture\n', 'utf8');
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
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
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
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_route, 'AGENTS.md');
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
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
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
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
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
