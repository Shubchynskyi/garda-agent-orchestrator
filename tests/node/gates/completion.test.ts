import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    collectOrderedTimelineEvents,
    extractMarkdownSectionLines,
    formatCompletionGateResult,
    isMeaningfulReviewEntry,
    getFindingsBySeverity,
    runCompletionGate,
    validateStageSequence,
    detectCodeChanged,
    preflightRequiresAnyReview,
    validateReviewSkillEvidence,
    STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER,
    isTrivialReview
} from '../../../src/gates/completion';
import { computeProtectedSnapshotDigest, fileSha256, normalizePath } from '../../../src/gates/helpers';

import type { TimelineEventEntry } from '../../../src/gates/completion';

describe('gates/completion', () => {
    describe('runCompletionGate protected control-plane diff gate', () => {
        function writeJson(filePath: string, value: unknown): void {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
        }

        function writeRuleFile(repoRoot: string, relativePath: string): string {
            const fullPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', relativePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, `# ${relativePath}\n`, 'utf8');
            return normalizePath(fullPath);
        }

        function createCompletionWorkspace(
            orchestratorWork: boolean,
            protectedPreflightMode: 'none' | 'snapshot' | 'digest'
        ) {
            const repoRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-protected-'));
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'T-1010.jsonl');
            const taskId = 'T-1010';
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
            const rulePackPath = path.join(reviewsRoot, `${taskId}-rule-pack.json`);
            const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
            const reviewPath = path.join(reviewsRoot, `${taskId}-review-gate.json`);
            const docImpactPath = path.join(reviewsRoot, `${taskId}-doc-impact.json`);
            const noOpPath = path.join(reviewsRoot, `${taskId}-no-op.json`);
            const handshakePath = path.join(reviewsRoot, `${taskId}-handshake.json`);
            const shellSmokePath = path.join(reviewsRoot, `${taskId}-shell-smoke.json`);
            const protectedManifestPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'protected-control-plane-manifest.json');
            const protectedFilePath = path.join(repoRoot, 'garda-agent-orchestrator', 'src', 'cli', 'main.ts');

            const requiredRuleFiles = [
                writeRuleFile(repoRoot, '00-core.md'),
                writeRuleFile(repoRoot, '40-commands.md'),
                writeRuleFile(repoRoot, '80-task-workflow.md'),
                writeRuleFile(repoRoot, '90-skill-catalog.md')
            ];

            fs.mkdirSync(path.dirname(protectedFilePath), { recursive: true });
            fs.writeFileSync(protectedFilePath, 'console.log("before");\n', 'utf8');

            const preflightProtectedSnapshot = {
                'garda-agent-orchestrator/src/cli/main.ts': fileSha256(protectedFilePath)
            };
            const triggers = protectedPreflightMode === 'snapshot'
                ? {
                    protected_control_plane_snapshot: preflightProtectedSnapshot
                }
                : protectedPreflightMode === 'digest'
                    ? {
                        protected_control_plane_snapshot_sha256: computeProtectedSnapshotDigest(
                            preflightProtectedSnapshot as Record<string, string>
                        )
                    }
                    : {};

            writeJson(preflightPath, {
                task_id: taskId,
                changed_files: [],
                metrics: {
                    changed_lines_total: 0
                },
                required_reviews: {},
                triggers
            });

            writeJson(taskModePath, {
                timestamp_utc: '2026-04-02T17:00:00.000Z',
                event_source: 'enter-task-mode',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                entry_mode: 'EXPLICIT_TASK_EXECUTION',
                requested_depth: 2,
                effective_depth: 2,
                task_summary: 'Protect orchestrator control plane',
                orchestrator_work: orchestratorWork,
                provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                routed_to: 'AGENTS.md',
                actor: 'orchestrator'
            });

            writeJson(rulePackPath, {
                timestamp_utc: '2026-04-02T17:00:01.000Z',
                event_source: 'load-rule-pack',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                latest_stage: 'POST_PREFLIGHT',
                stages: {
                    post_preflight: {
                        timestamp_utc: '2026-04-02T17:00:01.000Z',
                        stage: 'POST_PREFLIGHT',
                        status: 'PASSED',
                        outcome: 'PASS',
                        actor: 'orchestrator',
                        required_rule_files: requiredRuleFiles,
                        loaded_rule_files: requiredRuleFiles,
                        missing_rule_files: [],
                        extra_rule_files: [],
                        required_rule_hashes: {},
                        loaded_rule_hashes: {},
                        required_rule_count: requiredRuleFiles.length,
                        loaded_rule_count: requiredRuleFiles.length,
                        effective_depth: 2,
                        preflight_path: normalizePath(preflightPath),
                        preflight_hash_sha256: fileSha256(preflightPath),
                        required_reviews: {},
                        violations: []
                    }
                }
            });

            writeJson(compilePath, { status: 'PASSED', outcome: 'PASS' });
            writeJson(reviewPath, { status: 'PASSED', outcome: 'PASS' });
            writeJson(docImpactPath, { status: 'PASSED', outcome: 'PASS' });
            writeJson(noOpPath, {
                timestamp_utc: '2026-04-02T17:00:02.500Z',
                event_source: 'record-no-op',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                classification: 'AUDIT_ONLY',
                reason: 'Completion fixture for protected control-plane tests.',
                actor: 'orchestrator',
                preflight_path: normalizePath(preflightPath)
            });

            writeJson(handshakePath, {
                schema_version: 1,
                timestamp_utc: '2026-04-02T16:59:59.000Z',
                event_source: 'handshake-diagnostics',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'materialized-bundle',
                cli_path: 'node garda-agent-orchestrator/bin/garda.js',
                effective_cwd: normalizePath(repoRoot),
                workspace_root: normalizePath(repoRoot),
                diagnostics: [],
                violations: []
            });

            writeJson(shellSmokePath, {
                schema_version: 1,
                timestamp_utc: '2026-04-02T16:59:59.200Z',
                event_source: 'shell-smoke-preflight',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_context: 'materialized-bundle',
                effective_cwd: normalizePath(repoRoot),
                workspace_root: normalizePath(repoRoot),
                probes: [],
                violations: []
            });

            fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
            const handshakeArtifactHash = fileSha256(handshakePath);
            const shellSmokeArtifactHash = fileSha256(shellSmokePath);
            fs.writeFileSync(
                timelinePath,
                [
                    { event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-04-02T17:00:00.000Z' },
                    { event_type: 'RULE_PACK_LOADED', timestamp_utc: '2026-04-02T17:00:01.000Z' },
                    { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED', timestamp_utc: '2026-04-02T16:59:59.500Z', details: { artifact_hash: handshakeArtifactHash } },
                    { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED', timestamp_utc: '2026-04-02T16:59:59.700Z', details: { artifact_hash: shellSmokeArtifactHash } },
                    { event_type: 'PREFLIGHT_CLASSIFIED', timestamp_utc: '2026-04-02T17:00:01.500Z' },
                    { event_type: 'IMPLEMENTATION_STARTED', timestamp_utc: '2026-04-02T17:00:01.750Z' },
                    { event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-04-02T17:00:02.000Z' },
                    { event_type: 'REVIEW_PHASE_STARTED', timestamp_utc: '2026-04-02T17:00:03.000Z' },
                    { event_type: 'REVIEW_GATE_PASSED', timestamp_utc: '2026-04-02T17:00:04.000Z' }
                ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
                'utf8'
            );

            return {
                repoRoot,
                preflightPath,
                taskModePath,
                rulePackPath,
                compilePath,
                reviewPath,
                docImpactPath,
                noOpPath,
                handshakePath,
                shellSmokePath,
                protectedManifestPath,
                timelinePath,
                protectedFilePath
            };
        }

        it('fails ordinary tasks when protected control-plane files changed after preflight', () => {
            const workspace = createCompletionWorkspace(false, 'digest');

            try {
                fs.writeFileSync(workspace.protectedFilePath, 'console.log("after");\n', 'utf8');

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'FAILED');
                assert.ok(
                    result.violations.some((entry) => String(entry).includes('Control-plane files were modified in a non-orchestrator task'))
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('keeps backward compatibility when old preflight artifacts have no protected snapshot digest', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                fs.writeFileSync(workspace.protectedFilePath, 'console.log("after");\n', 'utf8');

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'PASSED');
                assert.equal(
                    result.violations.some((entry) => String(entry).includes('Control-plane files were modified in a non-orchestrator task')),
                    false
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('keeps backward compatibility with old full protected snapshots', () => {
            const workspace = createCompletionWorkspace(false, 'snapshot');

            try {
                fs.writeFileSync(workspace.protectedFilePath, 'console.log("after");\n', 'utf8');

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'FAILED');
                assert.ok(
                    result.violations.some((entry) => String(entry).includes('garda-agent-orchestrator/src/cli/main.ts'))
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('fails ordinary tasks when trusted protected baseline was already drifted before task start', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                writeJson(workspace.protectedManifestPath, {
                    schema_version: 1,
                    event_source: 'refresh-protected-control-plane-manifest',
                    timestamp_utc: '2026-04-02T16:59:00.000Z',
                    workspace_root: normalizePath(workspace.repoRoot),
                    orchestrator_root: normalizePath(path.join(workspace.repoRoot, 'garda-agent-orchestrator')),
                    protected_roots: ['garda-agent-orchestrator/src/cli'],
                    protected_snapshot: {
                        'garda-agent-orchestrator/src/cli/main.ts': 'stale-manifest-hash'
                    },
                    is_source_checkout: false
                });

                const preflight = JSON.parse(fs.readFileSync(workspace.preflightPath, 'utf8'));
                preflight.triggers.protected_control_plane_manifest_status = 'DRIFT';
                preflight.triggers.protected_control_plane_manifest_changed_files = ['garda-agent-orchestrator/src/cli/main.ts'];
                writeJson(workspace.preflightPath, preflight);

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'FAILED');
                assert.ok(
                    result.violations.some((entry) => String(entry).includes('Trusted protected control-plane manifest was already drifted before task start'))
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('passes docs-only completion cycles with no required reviews and no recorded review artifacts', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                const preflight = JSON.parse(fs.readFileSync(workspace.preflightPath, 'utf8')) as Record<string, any>;
                preflight.scope_category = 'docs-only';
                preflight.changed_files = ['docs/runbook.md'];
                preflight.metrics = {
                    ...preflight.metrics,
                    changed_lines_total: 12,
                    code_like_changed_count: 0,
                    runtime_code_like_changed_count: 0
                };
                preflight.required_reviews = {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                };
                writeJson(workspace.preflightPath, preflight);
                const rulePack = JSON.parse(fs.readFileSync(workspace.rulePackPath, 'utf8')) as Record<string, any>;
                const stages = rulePack.stages as Record<string, any>;
                const postPreflight = stages?.post_preflight as Record<string, any> | undefined;
                if (postPreflight) {
                    postPreflight.preflight_hash_sha256 = fileSha256(workspace.preflightPath);
                }
                writeJson(workspace.rulePackPath, rulePack);

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'PASSED');
                assert.equal(
                    result.violations.some((entry) => String(entry).includes('REVIEW_RECORDED')),
                    false
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('ignores stale optional review artifacts when the latest cycle requires no reviews', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                const preflight = JSON.parse(fs.readFileSync(workspace.preflightPath, 'utf8')) as Record<string, any>;
                preflight.scope_category = 'docs-only';
                preflight.changed_files = ['docs/runbook.md'];
                preflight.metrics = {
                    ...preflight.metrics,
                    changed_lines_total: 12,
                    code_like_changed_count: 0,
                    runtime_code_like_changed_count: 0
                };
                preflight.required_reviews = {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                };
                writeJson(workspace.preflightPath, preflight);
                const rulePack = JSON.parse(fs.readFileSync(workspace.rulePackPath, 'utf8')) as Record<string, any>;
                const stages = rulePack.stages as Record<string, any>;
                const postPreflight = stages?.post_preflight as Record<string, any> | undefined;
                if (postPreflight) {
                    postPreflight.preflight_hash_sha256 = fileSha256(workspace.preflightPath);
                }
                writeJson(workspace.rulePackPath, rulePack);

                const staleReviewPath = path.join(path.dirname(workspace.preflightPath), 'T-1010-code.md');
                fs.writeFileSync(
                    staleReviewPath,
                    [
                        '# Review',
                        '## Findings by Severity',
                        '- High: stale historical finding that should not block a no-review cycle.',
                        '## Residual Risks',
                        '- none',
                        '## Verdict',
                        'REVIEW FAILED'
                    ].join('\n') + '\n',
                    'utf8'
                );

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'PASSED');
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('passes docs-only completion cycles for legacy minimal preflight artifacts without recorded reviews', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                const preflight = JSON.parse(fs.readFileSync(workspace.preflightPath, 'utf8')) as Record<string, any>;
                preflight.changed_files = ['docs/runbook.md'];
                preflight.metrics = {
                    changed_lines_total: 12
                };
                preflight.required_reviews = {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                };
                delete preflight.scope_category;
                delete preflight.triggers?.runtime_code_changed;
                writeJson(workspace.preflightPath, preflight);
                const rulePack = JSON.parse(fs.readFileSync(workspace.rulePackPath, 'utf8')) as Record<string, any>;
                const stages = rulePack.stages as Record<string, any>;
                const postPreflight = stages?.post_preflight as Record<string, any> | undefined;
                if (postPreflight) {
                    postPreflight.preflight_hash_sha256 = fileSha256(workspace.preflightPath);
                }
                writeJson(workspace.rulePackPath, rulePack);

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'PASSED');
                assert.equal(
                    result.violations.some((entry) => String(entry).includes('REVIEW_RECORDED')),
                    false
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('passes fast-path code completion cycles when preflight required no reviews and no reviews were recorded', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                const preflight = JSON.parse(fs.readFileSync(workspace.preflightPath, 'utf8')) as Record<string, any>;
                preflight.scope_category = 'code';
                preflight.changed_files = ['src/small-fast-path.ts'];
                preflight.metrics = {
                    changed_lines_total: 8,
                    code_like_changed_count: 1,
                    runtime_code_like_changed_count: 1
                };
                preflight.required_reviews = {
                    code: false,
                    test: false
                };
                preflight.triggers = {
                    ...preflight.triggers,
                    runtime_code_changed: true
                };
                writeJson(workspace.preflightPath, preflight);
                const rulePack = JSON.parse(fs.readFileSync(workspace.rulePackPath, 'utf8')) as Record<string, any>;
                const stages = rulePack.stages as Record<string, any>;
                const postPreflight = stages?.post_preflight as Record<string, any> | undefined;
                if (postPreflight) {
                    postPreflight.preflight_hash_sha256 = fileSha256(workspace.preflightPath);
                }
                writeJson(workspace.rulePackPath, rulePack);

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'PASSED');
                assert.equal(
                    result.violations.some((entry) => String(entry).includes('REVIEW_RECORDED')),
                    false
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });

        it('fails when the current cycle required reviews but REVIEW_RECORDED is missing', () => {
            const workspace = createCompletionWorkspace(false, 'none');

            try {
                const preflight = JSON.parse(fs.readFileSync(workspace.preflightPath, 'utf8')) as Record<string, any>;
                preflight.scope_category = 'code';
                preflight.changed_files = ['src/review-required.ts'];
                preflight.metrics = {
                    changed_lines_total: 24,
                    code_like_changed_count: 1,
                    runtime_code_like_changed_count: 1
                };
                preflight.required_reviews = {
                    code: true,
                    test: false
                };
                preflight.triggers = {
                    ...preflight.triggers,
                    runtime_code_changed: true
                };
                writeJson(workspace.preflightPath, preflight);
                const rulePack = JSON.parse(fs.readFileSync(workspace.rulePackPath, 'utf8')) as Record<string, any>;
                const stages = rulePack.stages as Record<string, any>;
                const postPreflight = stages?.post_preflight as Record<string, any> | undefined;
                if (postPreflight) {
                    postPreflight.preflight_hash_sha256 = fileSha256(workspace.preflightPath);
                }
                writeJson(workspace.rulePackPath, rulePack);

                const result = runCompletionGate({
                    repoRoot: workspace.repoRoot,
                    preflightPath: workspace.preflightPath,
                    taskModePath: workspace.taskModePath,
                    rulePackPath: workspace.rulePackPath,
                    compileEvidencePath: workspace.compilePath,
                    reviewEvidencePath: workspace.reviewPath,
                    docImpactPath: workspace.docImpactPath,
                    noOpArtifactPath: workspace.noOpPath,
                    handshakePath: workspace.handshakePath,
                    shellSmokePath: workspace.shellSmokePath,
                    timelinePath: workspace.timelinePath
                });

                assert.equal(result.status, 'FAILED');
                assert.equal(
                    result.violations.some((entry) => String(entry).includes('REVIEW_RECORDED')),
                    true
                );
            } finally {
                fs.rmSync(workspace.repoRoot, { recursive: true, force: true });
            }
        });
    });

    describe('collectOrderedTimelineEvents', () => {
        it('continues scanning valid events after an invalid JSON line', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-timeline-'));
            const timelinePath = path.join(tempDir, 'timeline.jsonl');

            try {
                fs.writeFileSync(
                    timelinePath,
                    [
                        JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00.000Z' }),
                        '{"event_type":',
                        JSON.stringify({ event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-01-01T00:02:00.000Z' }),
                        JSON.stringify({ event_type: 'REVIEW_GATE_PASSED', timestamp_utc: '2026-01-01T00:03:00.000Z' })
                    ].join('\n') + '\n',
                    'utf8'
                );

                const errors: string[] = [];
                const events = collectOrderedTimelineEvents(timelinePath, errors);

                assert.equal(errors.length, 1);
                assert.deepEqual(
                    events.map((entry) => entry.event_type),
                    ['TASK_MODE_ENTERED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED']
                );
                assert.deepEqual(
                    events.map((entry) => entry.sequence),
                    [0, 2, 3]
                );
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('extractMarkdownSectionLines', () => {
        it('extracts lines under matching heading', () => {
            const lines = [
                '## Introduction',
                'Some intro text.',
                '',
                '## Findings by Severity',
                '- Critical: SQL injection',
                '- High: XSS vulnerability',
                '',
                '## Residual Risks',
                '- None'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.ok(result.length >= 2);
            assert.ok(result.some(l => l.includes('Critical')));
        });

        it('stops at next heading', () => {
            const lines = [
                '## Findings by Severity',
                '- Low: minor issue',
                '## Next Section',
                '- irrelevant'
            ];
            const result = extractMarkdownSectionLines(lines, 'Findings by Severity');
            assert.equal(result.length, 1);
        });
    });

    describe('isMeaningfulReviewEntry', () => {
        it('returns false for "none" variations', () => {
            assert.equal(isMeaningfulReviewEntry('none'), false);
            assert.equal(isMeaningfulReviewEntry('N/A'), false);
        });
        it('returns true for real content', () => {
            assert.equal(isMeaningfulReviewEntry('Found a bug'), true);
        });
    });

    describe('validateStageSequence', () => {
        function makeEvents(...types: (string | { type: string, details: any })[]): TimelineEventEntry[] {
            return types.map((t, i) => {
                const type = typeof t === 'string' ? t : t.type;
                const details = typeof t === 'object' ? t.details : null;
                return {
                    event_type: type,
                    timestamp_utc: `2026-01-01T00:0${i}:00.000Z`,
                    sequence: i,
                    details
                };
            });
        }

        it('passes when stages are in correct order for code-changing task', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED', 'REVIEW_RECORDED', 'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
        });

        it('requires canonical preflight and implementation stages for non-code tasks too', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.observed_order, [...NON_CODE_STAGE_SEQUENCE_ORDER]);
        });

        it('rejects non-code latest-cycle review evidence when preflight and implementation only exist in an older cycle', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, false, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'PREFLIGHT_CLASSIFIED' from an older execution cycle.")));
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
        });

        it('does not require REVIEW_RECORDED when the current code-changing cycle required zero reviews', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl', false);
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.expected_order, [...NON_CODE_STAGE_SEQUENCE_ORDER]);
        });

        it('still requires REVIEW_RECORDED when the current code-changing cycle required reviews', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl', true);
            assert.ok(result.violations.some((item) => item.includes("latest 'REVIEW_GATE_PASSED' evidence")));
            assert.ok(result.violations.some((item) => item.includes("'REVIEW_RECORDED'")));
        });

        it('uses the latest coherent cycle instead of the first stale stage occurrences', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
            assert.deepEqual(result.observed_order, [...STAGE_SEQUENCE_ORDER]);
        });

        it('does not let an early task-entry rule-pack misorder poison a later valid cycle', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                { type: 'RULE_PACK_LOADED', details: { stage: 'TASK_ENTRY' } },
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
        });

        it('rejects backfilling compile evidence from an older cycle when the latest cycle is misordered', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        });

        it('rejects latest-cycle review evidence when compile and implementation only exist in an older cycle', () => {
            const events = makeEvents(
                'TASK_MODE_ENTERED',
                'HANDSHAKE_DIAGNOSTICS_RECORDED',
                'SHELL_SMOKE_PREFLIGHT_RECORDED',
                'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'PREFLIGHT_CLASSIFIED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_RECORDED',
                'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
            assert.ok(result.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        });
    });

    describe('detectCodeChanged', () => {
        it('detects when preflight requires any review', () => {
            assert.equal(preflightRequiresAnyReview({
                required_reviews: {
                    code: false,
                    test: true
                }
            }), true);
            assert.equal(preflightRequiresAnyReview({
                required_reviews: {
                    code: false,
                    test: false
                }
            }), false);
        });

        it('returns false for docs-only preflight with non-zero diff but no code-like changes or required reviews', () => {
            const result = detectCodeChanged({
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 12,
                    code_like_changed_count: 0,
                    runtime_code_like_changed_count: 0
                },
                required_reviews: {
                    code: false,
                    test: false
                },
                triggers: {
                    runtime_code_changed: false
                }
            });

            assert.equal(result, false);
        });

        it('returns false for other explicit non-code scope categories without required reviews', () => {
            const scopeCategories = ['config-only', 'audit-only', 'empty'];
            for (const scopeCategory of scopeCategories) {
                const result = detectCodeChanged({
                    scope_category: scopeCategory,
                    changed_files: scopeCategory === 'empty' ? [] : [`meta/${scopeCategory}.txt`],
                    metrics: {
                        changed_lines_total: scopeCategory === 'empty' ? 0 : 5,
                        code_like_changed_count: 0,
                        runtime_code_like_changed_count: 0
                    },
                    required_reviews: {
                        code: false,
                        test: false
                    },
                    triggers: {
                        runtime_code_changed: false
                    }
                });

                assert.equal(result, false, `Expected ${scopeCategory} to remain non-code.`);
            }
        });

        it('returns false for legacy docs-only preflight artifacts without new classifier fields', () => {
            const result = detectCodeChanged({
                changed_files: ['docs/runbook.md'],
                metrics: {
                    changed_lines_total: 12
                },
                required_reviews: {
                    code: false,
                    test: false
                }
            });

            assert.equal(result, false);
        });

        it('uses workspace paths config for legacy fallback classification', () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-completion-paths-'));

            try {
                const configPath = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify({
                    runtime_roots: ['docs/'],
                    code_like_regexes: ['\\.md$']
                }, null, 2), 'utf8');

                const result = detectCodeChanged({
                    changed_files: ['docs/runbook.md'],
                    metrics: {
                        changed_lines_total: 12
                    },
                    required_reviews: {
                        code: false,
                        test: false
                    }
                }, tempDir);

                assert.equal(result, true);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('returns true when reviews are required even if code-like metrics are absent', () => {
            const result = detectCodeChanged({
                changed_files: ['src/main.ts'],
                required_reviews: {
                    code: true,
                    test: true
                }
            });

            assert.equal(result, true);
        });
    });

    describe('validateReviewSkillEvidence', () => {
        function makeEvent(
            eventType: string,
            sequence: number,
            details: Record<string, unknown> | null = null
        ): TimelineEventEntry {
            return {
                event_type: eventType,
                timestamp_utc: `2026-01-01T00:0${sequence}:00.000Z`,
                sequence,
                details
            };
        }

        it('returns no violations when code changed and review telemetry plus artifacts are present', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'test' }),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'test',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'test' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
            ];
            const requiredReviews = { code: true, test: true };
            const reviewArtifacts = {
                code: {
                    path: '/reviews/T-123-code.md',
                    reviewContext: {
                        reviewer_routing: {
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'provider_entrypoint',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-123',
                        review_type: 'code',
                        preflight_sha256: null,
                        scope_sha256: null,
                        review_context_sha256: null,
                        review_artifact_sha256: null,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                },
                test: {
                    path: '/reviews/T-123-test.md',
                    reviewContext: {
                        reviewer_routing: {
                            canonical_source_of_truth: 'Codex',
                            execution_provider: 'Codex',
                            execution_provider_source: 'provider_entrypoint',
                            identity_status: 'resolved',
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:test-reviewer'
                        }
                    },
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-123',
                        review_type: 'test',
                        preflight_sha256: null,
                        scope_sha256: null,
                        review_context_sha256: null,
                        review_artifact_sha256: null,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:test-reviewer',
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            };

            const fsMock = require('node:fs');
            const originalExists = fsMock.existsSync;
            const originalRead = fsMock.readFileSync;
            
            // normalize slashes for cross-platform matching in mocks
            const norm = (p: string) => p.replace(/\\/g, '/');

            fsMock.existsSync = (p: string) => norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md') || originalExists(p);
            fsMock.readFileSync = (p: string, e: string) => {
                if (norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md')) {
                    return '# Review\nVerified changes in `src/main.ts`. This content is now intentionally made much longer so that it easily exceeds the thirty word minimum threshold required to pass the triviality check implemented in the completion gate logic.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
                }
                return originalRead(p, e);
            };

            try {
                // timelinePath must be such that construction yields the mocked paths
                const result = validateReviewSkillEvidence(
                    events,
                    requiredReviews,
                    reviewArtifacts,
                    true,
                    '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                    'Codex',
                    'Codex'
                );
                if (result.violations.length > 0) {
                    console.log('VIOLATIONS:', result.violations);
                }
                assert.equal(result.violations.length, 0);
                assert.deepEqual(result.reviewer_execution_modes, ['delegated_subagent']);
            } finally {
                fsMock.existsSync = originalExists;
                fsMock.readFileSync = originalRead;
            }
        });

        it('fails when downstream test review starts before upstream code review is recorded in the same cycle', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'test' }),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'test',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),
                makeEvent('REVIEW_PHASE_STARTED', 6, { review_type: 'code' }),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
            ];
            const requiredReviews = { code: true, test: true };
            const reviewArtifacts = {
                code: {
                    path: '/reviews/T-123-code.md',
                    reviewContext: {
                        reviewer_routing: {
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:code-reviewer'
                        }
                    },
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-123',
                        review_type: 'code',
                        preflight_sha256: null,
                        scope_sha256: null,
                        review_context_sha256: null,
                        review_artifact_sha256: null,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:code-reviewer',
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                },
                test: {
                    path: '/reviews/T-123-test.md',
                    reviewContext: {
                        reviewer_routing: {
                            actual_execution_mode: 'delegated_subagent',
                            reviewer_session_id: 'agent:test-reviewer'
                        }
                    },
                    receipt: {
                        schema_version: 2,
                        task_id: 'T-123',
                        review_type: 'test',
                        preflight_sha256: null,
                        scope_sha256: null,
                        review_context_sha256: null,
                        review_artifact_sha256: null,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:test-reviewer',
                        reviewer_fallback_reason: null,
                        recorded_at_utc: '2026-01-01T00:00:00.000Z'
                    }
                }
            };

            const fsMock = require('node:fs');
            const originalExists = fsMock.existsSync;
            const originalRead = fsMock.readFileSync;
            const norm = (p: string) => p.replace(/\\/g, '/');

            fsMock.existsSync = (p: string) => norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md') || originalExists(p);
            fsMock.readFileSync = (p: string, e: string) => {
                if (norm(p).includes('T-123-code.md') || norm(p).includes('T-123-test.md')) {
                    return '# Review\nValidated `src/gates/completion.ts` and the matching review context ordering for this review type. This review text is intentionally detailed enough to exceed the triviality filter and documents why the recovery-cycle evidence is acceptable.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nREVIEW PASSED';
                }
                return originalRead(p, e);
            };

            try {
                const result = validateReviewSkillEvidence(
                    events,
                    requiredReviews,
                    reviewArtifacts,
                    true,
                    '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                    'Codex'
                );
                assert.ok(
                    result.violations.some((entry) => entry.includes("Required review 'test' started before upstream review 'code' completed")),
                    JSON.stringify(result, null, 2)
                );
            } finally {
                fsMock.existsSync = originalExists;
                fsMock.readFileSync = originalRead;
            }
        });

        it('fails when downstream test review starts before required non-test upstream reviews are recorded in the same cycle', () => {
            const upstreamReviewTypes = [
                'api',
                'db',
                'security',
                'refactor',
                'performance',
                'infra',
                'dependency'
            ] as const;
            const skillIds: Record<typeof upstreamReviewTypes[number], string> = {
                api: 'api-review',
                db: 'db-review',
                security: 'security-review',
                refactor: 'refactor-review',
                performance: 'performance-review',
                infra: 'infra-review',
                dependency: 'dependency-review'
            };
            const verdictTokens: Record<typeof upstreamReviewTypes[number], string> = {
                api: 'API REVIEW PASSED',
                db: 'DB REVIEW PASSED',
                security: 'SECURITY REVIEW PASSED',
                refactor: 'REFACTOR REVIEW PASSED',
                performance: 'PERFORMANCE REVIEW PASSED',
                infra: 'INFRA REVIEW PASSED',
                dependency: 'DEPENDENCY REVIEW PASSED'
            };

            const fsMock = require('node:fs');
            const originalExists = fsMock.existsSync;
            const originalRead = fsMock.readFileSync;
            const norm = (p: string) => p.replace(/\\/g, '/');

            try {
                for (const upstreamReviewType of upstreamReviewTypes) {
                    const events = [
                        makeEvent('COMPILE_GATE_PASSED', 0),
                        makeEvent('REVIEW_PHASE_STARTED', 1, { review_type: 'test' }),
                        makeEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),
                        makeEvent('SKILL_REFERENCE_LOADED', 3, {
                            skill_id: 'testing-strategy',
                            reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                        }),
                        makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                            review_type: 'test',
                            reviewer_execution_mode: 'delegated_subagent'
                        }),
                        makeEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),
                        makeEvent('REVIEW_PHASE_STARTED', 6, { review_type: upstreamReviewType }),
                        makeEvent('SKILL_SELECTED', 7, { skill_id: skillIds[upstreamReviewType] }),
                        makeEvent('SKILL_REFERENCE_LOADED', 8, {
                            skill_id: skillIds[upstreamReviewType],
                            reference_path: `/repo/garda-agent-orchestrator/live/skills/${skillIds[upstreamReviewType]}/SKILL.md`
                        }),
                        makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                            review_type: upstreamReviewType,
                            reviewer_execution_mode: 'delegated_subagent'
                        }),
                        makeEvent('REVIEW_RECORDED', 10, { review_type: upstreamReviewType }),
                        makeEvent('REVIEW_GATE_PASSED', 11)
                    ];
                    const requiredReviews = { [upstreamReviewType]: true, test: true };
                    const reviewArtifacts = {
                        [upstreamReviewType]: {
                            path: `/reviews/T-123-${upstreamReviewType}.md`,
                            reviewContext: {
                                reviewer_routing: {
                                    actual_execution_mode: 'delegated_subagent',
                                    reviewer_session_id: `agent:${upstreamReviewType}-reviewer`
                                }
                            },
                            receipt: {
                                schema_version: 2,
                                task_id: 'T-123',
                                review_type: upstreamReviewType,
                                preflight_sha256: null,
                                scope_sha256: null,
                                review_context_sha256: null,
                                review_artifact_sha256: null,
                                reviewer_execution_mode: 'delegated_subagent',
                                reviewer_identity: `agent:${upstreamReviewType}-reviewer`,
                                reviewer_fallback_reason: null,
                                recorded_at_utc: '2026-01-01T00:00:00.000Z'
                            }
                        },
                        test: {
                            path: '/reviews/T-123-test.md',
                            reviewContext: {
                                reviewer_routing: {
                                    actual_execution_mode: 'delegated_subagent',
                                    reviewer_session_id: 'agent:test-reviewer'
                                }
                            },
                            receipt: {
                                schema_version: 2,
                                task_id: 'T-123',
                                review_type: 'test',
                                preflight_sha256: null,
                                scope_sha256: null,
                                review_context_sha256: null,
                                review_artifact_sha256: null,
                                reviewer_execution_mode: 'delegated_subagent',
                                reviewer_identity: 'agent:test-reviewer',
                                reviewer_fallback_reason: null,
                                recorded_at_utc: '2026-01-01T00:00:00.000Z'
                            }
                        }
                    };

                    fsMock.existsSync = (p: string) => (
                        norm(p).includes(`T-123-${upstreamReviewType}.md`)
                        || norm(p).includes('T-123-test.md')
                        || originalExists(p)
                    );
                    fsMock.readFileSync = (p: string, e: string) => {
                        if (norm(p).includes(`T-123-${upstreamReviewType}.md`)) {
                            return `# Review\nValidated the ${upstreamReviewType} sequencing contract with enough detail to satisfy authenticity checks.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\n${verdictTokens[upstreamReviewType]}`;
                        }
                        if (norm(p).includes('T-123-test.md')) {
                            return '# Review\nValidated the downstream test review artifact for the sequencing contract with enough detail to satisfy authenticity checks.\n## Findings by Severity\nnone\n## Residual Risks\nnone\n## Verdict\nTEST REVIEW PASSED';
                        }
                        return originalRead(p, e);
                    };

                    const result = validateReviewSkillEvidence(
                        events,
                        requiredReviews,
                        reviewArtifacts,
                        true,
                        '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                        'Codex'
                    );
                    assert.ok(
                        result.violations.some((entry) => entry.includes(`Required review 'test' started before upstream review '${upstreamReviewType}' completed`)),
                        `${upstreamReviewType}: ${JSON.stringify(result, null, 2)}`
                    );
                }
            } finally {
                fsMock.existsSync = originalExists;
                fsMock.readFileSync = originalRead;
            }
        });

        it('uses the latest reviewer routing telemetry for repeated review attempts', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:stale-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:fresh-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                execution_provider_source: 'provider_entrypoint',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:fresh-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:fresh-reviewer',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex',
                'Codex',
                false,
                'provider_entrypoint'
            );

            assert.equal(result.violations.length, 0, JSON.stringify(result, null, 2));
        });

        it('fails when the latest reviewer routing telemetry records a different reviewer identity', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:fresh-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_PHASE_STARTED', 6),
                makeEvent('SKILL_SELECTED', 7, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 8, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 9, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:stale-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 10, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 11)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:fresh-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:fresh-reviewer',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some((entry) => (
                entry.includes('REVIEWER_DELEGATION_ROUTED telemetry')
                && entry.includes('agent:stale-reviewer')
                && entry.includes('agent:fresh-reviewer')
            )));
        });

        it('fails when delegation-required provider records same-agent fallback for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'test',
                    reviewer_execution_mode: 'same_agent_fallback'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'test' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { test: true },
                {
                    test: {
                        path: '/reviews/T-123-test.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'same_agent_fallback',
                                reviewer_session_id: 'self:T-123'
                            }
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some((entry) => entry.includes('delegated_subagent')));
        });

        it('fails when review-context omits canonical_source_of_truth for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                execution_provider: 'Codex',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex',
                'Codex'
            );

            assert.ok(result.violations.some((entry) => entry.includes('missing canonical_source_of_truth')));
        });

        it('fails when review-context omits execution_provider_source for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex',
                'Codex',
                false,
                'provider_entrypoint'
            );

            assert.ok(result.violations.some((entry) => entry.includes('missing execution_provider_source')));
        });

        it('fails when canonical SourceOfTruth is unavailable for required review validation', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                canonical_source_of_truth: 'Codex',
                                execution_provider: 'Codex',
                                identity_status: 'resolved',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex',
                null
            );

            assert.ok(result.violations.some((entry) => entry.includes('missing canonical SourceOfTruth')));
        });

        it('fails when review-context omits execution_provider and identity_status for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                source_of_truth: 'Codex',
                                canonical_source_of_truth: 'Codex',
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex',
                'Codex'
            );

            assert.ok(result.violations.some((entry) => entry.includes('missing execution_provider')));
            assert.ok(result.violations.some((entry) => entry.includes('missing identity_status')));
        });

        it('fails when a single-agent provider records delegated_subagent for a required review', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Qwen'
            );

            assert.ok(result.violations.some((entry) => entry.includes('single-agent providers')));
        });

        it('fails when review-context uses an invalid reviewer execution mode', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_magic',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some((entry) => entry.includes('invalid reviewer_routing.actual_execution_mode')));
        });

        it('fails when receipt reviewer identity disagrees with review-context reviewer session', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:other-reviewer',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some((entry) => entry.includes('inconsistent reviewer identity')));
        });

        it('fails when receipt execution mode disagrees with review-context execution mode', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: 'self:T-123',
                            reviewer_fallback_reason: 'provider limitation',
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Antigravity'
            );

            assert.ok(result.violations.some(v => v.includes('inconsistent execution mode')));
        });

        it('fails when telemetry execution mode contradicts review-context execution mode', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'same_agent_fallback',
                                reviewer_session_id: 'self:T-123'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: 'self:T-123',
                            reviewer_fallback_reason: 'provider limitation',
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Antigravity'
            );

            assert.ok(result.violations.some(v =>
                v.includes('inconsistent execution mode') && v.includes('REVIEWER_DELEGATION_ROUTED')
            ));
        });

        it('fails when code changed but review telemetry is missing', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('REVIEW_GATE_PASSED', 2)
            ];
            const requiredReviews = { code: true };
            const result = validateReviewSkillEvidence(events, requiredReviews, {}, true, '/T-123.jsonl', 'Codex');
            assert.ok(result.violations.some(v => v.includes('SKILL_SELECTED telemetry') && v.includes("'code'")));
        });

        it('fails when reviewer delegation telemetry is missing', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEW_RECORDED', 4, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 5)
            ];
            const requiredReviews = { code: true };
            const result = validateReviewSkillEvidence(
                events,
                requiredReviews,
                { code: { path: '/reviews/T-123-code.md' } },
                true,
                '/T-123.jsonl',
                'Codex'
            );
            assert.ok(result.violations.some(v => v.includes('REVIEWER_DELEGATION_ROUTED telemetry')));
        });

        // T-1005: Receipt field presence enforcement tests
        it('fails when receipt is missing reviewer_execution_mode', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: null,
                            reviewer_identity: 'agent:code-reviewer',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some(v => v.includes('receipt is missing reviewer_execution_mode')));
        });

        it('fails when receipt is missing reviewer_identity', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: null,
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some(v => v.includes('receipt is missing reviewer_identity')));
        });

        it('fails when receipt uses same_agent_fallback without reviewer_fallback_reason', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'same_agent_fallback',
                                reviewer_session_id: 'self:T-123',
                                fallback_reason: null
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: 'self:T-123',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Qwen'
            );

            assert.ok(result.violations.some(v =>
                v.includes('same_agent_fallback') && v.includes('reviewer_fallback_reason')
            ));
        });

        it('fails when receipt claims delegated_subagent on delegation-required provider but execution mode is fallback', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'self:T-123'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'same_agent_fallback',
                                reviewer_session_id: 'self:T-123',
                                fallback_reason: 'provider does not support delegation'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: 'self:T-123',
                            reviewer_fallback_reason: 'provider does not support delegation',
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Codex'
            );

            assert.ok(result.violations.some(v =>
                v.includes('receipt must use delegated_subagent') && v.includes('Codex')
            ));
            assert.ok(result.violations.some(v =>
                v.includes('same_agent_fallback') && v.includes('fallback is not allowed')
            ));
        });

        it('fails when receipt uses delegated_subagent on single-agent provider', () => {
            const events = [
                makeEvent('COMPILE_GATE_PASSED', 0),
                makeEvent('REVIEW_PHASE_STARTED', 1),
                makeEvent('SKILL_SELECTED', 2, { skill_id: 'code-review' }),
                makeEvent('SKILL_REFERENCE_LOADED', 3, {
                    skill_id: 'code-review',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/code-review/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 4, {
                    review_type: 'code',
                    reviewer_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }),
                makeEvent('REVIEW_RECORDED', 5, { review_type: 'code' }),
                makeEvent('REVIEW_GATE_PASSED', 6)
            ];
            const result = validateReviewSkillEvidence(
                events,
                { code: true },
                {
                    code: {
                        path: '/reviews/T-123-code.md',
                        reviewContext: {
                            reviewer_routing: {
                                actual_execution_mode: 'delegated_subagent',
                                reviewer_session_id: 'agent:code-reviewer'
                            }
                        },
                        receipt: {
                            schema_version: 2,
                            task_id: 'T-123',
                            review_type: 'code',
                            preflight_sha256: null,
                            scope_sha256: null,
                            review_context_sha256: null,
                            review_artifact_sha256: null,
                            reviewer_execution_mode: 'delegated_subagent',
                            reviewer_identity: 'agent:code-reviewer',
                            reviewer_fallback_reason: null,
                            recorded_at_utc: '2026-01-01T00:00:00.000Z'
                        }
                    }
                },
                true,
                '/repo/garda-agent-orchestrator/runtime/task-events/T-123.jsonl',
                'Gemini'
            );

            assert.ok(result.violations.some(v =>
                v.includes('receipt cannot use delegated_subagent') && v.includes('Gemini')
            ));
        });
    });

    describe('formatCompletionGateResult', () => {
        it('includes TrustStatus when review receipts carry trust levels', () => {
            const output = formatCompletionGateResult({
                task_id: 'T-1001',
                status: 'PASSED',
                outcome: 'PASS',
                review_artifacts: {
                    code: {
                        receipt: {
                            trust_level: 'LOCAL_AUDITED'
                        }
                    }
                }
            });

            assert.match(output, /TrustStatus: LOCAL_AUDITED/);
        });
    });
});
