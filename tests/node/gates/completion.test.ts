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
    validateReviewSkillEvidence,
    STAGE_SEQUENCE_ORDER,
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
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
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
                'TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'PREFLIGHT_CLASSIFIED',
                'IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED', 'REVIEW_RECORDED', 'REVIEW_GATE_PASSED'
            );
            const result = validateStageSequence(events, true, '/timeline.jsonl');
            assert.equal(result.violations.length, 0);
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
                makeEvent('REVIEW_PHASE_STARTED', 1),
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
                makeEvent('SKILL_SELECTED', 6, { skill_id: 'testing-strategy' }),
                makeEvent('SKILL_REFERENCE_LOADED', 7, {
                    skill_id: 'testing-strategy',
                    reference_path: '/repo/garda-agent-orchestrator/live/skills/testing-strategy/SKILL.md'
                }),
                makeEvent('REVIEWER_DELEGATION_ROUTED', 8, {
                    review_type: 'test',
                    reviewer_execution_mode: 'delegated_subagent'
                }),
                makeEvent('REVIEW_RECORDED', 9, { review_type: 'test' }),
                makeEvent('REVIEW_GATE_PASSED', 10)
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

            assert.equal(
                result.violations.some((entry) => entry.includes('stale-reviewer')),
                false,
                'Repeated review attempts must bind to the latest REVIEWER_DELEGATION_ROUTED event.'
            );
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
