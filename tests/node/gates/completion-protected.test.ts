import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runCompletionGate
} from '../../../src/gates/completion';
import { computeProtectedSnapshotDigest, fileSha256, normalizePath } from '../../../src/gates/helpers';
describe('gates/completion — protected control-plane', () => {
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
});
