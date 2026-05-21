import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { writeTimelineSummaryIndex, type TimelineSummaryIndex } from '../../../src/gate-runtime/timeline-summary';
import { buildRuntimeRetentionPreview } from '../../../src/lifecycle/runtime-retention-policy';
import {
    getManagedConfigValidators,
    validateManagedConfigByName,
    validateOptionalSkillSelectionPolicyConfig,
    validateOutputFiltersConfig,
    validatePathsConfig,
    validateTokenEconomyConfig,
    validateProfilesConfig,
    validateReviewArtifactStorageConfig,
    validateRuntimeRetentionConfig,
    validateWorkflowConfig
} from '../../../src/schemas/config-artifacts';

function readTemplateConfig(configName: string): Record<string, unknown> {
    return JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'template', 'config', `${configName}.json`), 'utf8')
    );
}

function makeRetentionPreviewWorkspace(): {
    cleanup: () => void;
    targetRoot: string;
    bundleRoot: string;
    eventsRoot: string;
} {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-retention-preview-'));
    const targetRoot = tmpDir;
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    return {
        cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
        targetRoot,
        bundleRoot,
        eventsRoot
    };
}

function writeTaskQueue(
    targetRoot: string,
    tasks: Array<{ id: string; status: string; title?: string }>
): void {
    const lines = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|'
    ];

    for (const task of tasks) {
        lines.push(
            `| ${task.id} | ${task.status} | P2 | runtime/retention | ${task.title || task.id} | gpt-5.4 | 2026-05-20 | balanced | note |`
        );
    }

    fs.writeFileSync(path.join(targetRoot, 'TASK.md'), `${lines.join('\n')}\n`, 'utf8');
}

function appendStatusEvent(bundleRoot: string, taskId: string, nextStatus: string): void {
    appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'INFO', `Status changed to ${nextStatus}.`, {
        new_status: nextStatus
    });
}

function writeTimelineSummary(
    eventsRoot: string,
    entries: TimelineSummaryIndex['entries']
): void {
    writeTimelineSummaryIndex(eventsRoot, {
        version: 2,
        updated_at_utc: new Date().toISOString(),
        entries
    });
}

function setFileAgeDays(filePath: string, ageDays: number): void {
    const timestamp = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, timestamp, timestamp);
}

test('tracked template managed configs validate successfully', () => {
    for (const configName of Object.keys(getManagedConfigValidators())) {
        const validated = validateManagedConfigByName(configName, readTemplateConfig(configName));
        assert.ok(validated);
    }
});

test('validateTokenEconomyConfig canonicalizes integer arrays and boolean-like values', () => {
    const normalized = validateTokenEconomyConfig({
        enabled: 'yes',
        enabled_depths: ['3', 1, '2', 2],
        strip_examples: 'true',
        strip_code_blocks: 1,
        scoped_diffs: 'no',
        compact_reviewer_output: false,
        fail_tail_lines: '25'
    });

    assert.equal(normalized.enabled, true);
    assert.deepEqual(normalized.enabled_depths, [1, 2, 3]);
    assert.equal(normalized.scoped_diffs, false);
    assert.equal(normalized.fail_tail_lines, 25);
});

test('validateWorkflowConfig canonicalizes scope budget guard values before guard normalization', () => {
    const normalized = validateWorkflowConfig({
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
            placement: 'before completion'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        scope_budget_guard: {
            enabled: 'false',
            profiles: ['Strict', 'balanced'],
            action: 'warn only',
            max_files: '7',
            max_changed_lines: '300',
            max_required_reviews: '3',
            max_review_tokens: '5000'
        },
        review_cycle_guard: {
            enabled: 'true',
            action: 'warn only',
            max_failed_non_test_reviews: '4',
            max_total_non_test_reviews: '9',
            excluded_review_types: ['Test', 'test'],
            auto_split_enabled: 'true'
        },
        project_memory_maintenance: {
            enabled: 'true',
            mode: 'UPDATE',
            run_before_final_closeout: 'false',
            require_user_approval_for_writes: 'yes',
            max_compact_summary_chars: '9000',
            read_strategy: 'INDEX_FIRST',
            impact_artifact_retention_days: '45'
        },
        task_reset: {
            enabled: 'yes'
        }
    });

    const guard = normalized.scope_budget_guard as Record<string, unknown>;
    assert.equal(guard.enabled, false);
    assert.deepEqual(guard.profiles, ['strict', 'balanced']);
    assert.equal(guard.action, 'WARN_ONLY');
    assert.equal(guard.max_files, 7);
    assert.equal(guard.max_changed_lines, 300);
    assert.equal(guard.max_required_reviews, 3);
    assert.equal(guard.max_review_tokens, 5000);

    const reviewCycleGuard = normalized.review_cycle_guard as Record<string, unknown>;
    assert.equal(reviewCycleGuard.enabled, true);
    assert.equal(reviewCycleGuard.action, 'WARN_ONLY');
    assert.equal(reviewCycleGuard.max_failed_non_test_reviews, 4);
    assert.equal(reviewCycleGuard.max_total_non_test_reviews, 9);
    assert.deepEqual(reviewCycleGuard.excluded_review_types, ['test']);
    assert.equal(reviewCycleGuard.auto_split_enabled, true);

    const projectMemory = normalized.project_memory_maintenance as Record<string, unknown>;
    assert.equal(projectMemory.enabled, true);
    assert.equal(projectMemory.mode, 'update');
    assert.equal(projectMemory.run_before_final_closeout, false);
    assert.equal(projectMemory.require_user_approval_for_writes, true);
    assert.equal(projectMemory.max_compact_summary_chars, 9000);
    assert.equal(projectMemory.read_strategy, 'index_first');
    assert.equal(projectMemory.impact_artifact_retention_days, 45);

    const taskReset = normalized.task_reset as Record<string, unknown>;
    assert.equal(taskReset.enabled, true);

    const fullSuiteValidation = normalized.full_suite_validation as Record<string, unknown>;
    assert.equal(fullSuiteValidation.placement, 'before_completion');
});

test('validateWorkflowConfig defaults missing full-suite placement but rejects invalid values', () => {
    const baseConfig = {
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        }
    };

    const normalized = validateWorkflowConfig(baseConfig);
    assert.equal(
        (normalized.full_suite_validation as Record<string, unknown>).placement,
        'after_compile_before_reviews'
    );

    assert.throws(
        () => validateWorkflowConfig({
            ...baseConfig,
            full_suite_validation: {
                ...baseConfig.full_suite_validation,
                placement: 'after lunch'
            }
        }),
        /full_suite_validation\.placement must be one of/
    );
});

test('validateWorkflowConfig rejects unknown task reset keys', () => {
    assert.throws(
        () => validateWorkflowConfig({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            },
            task_reset: {
                enabled: false,
                force: true
            }
        }),
        /workflow-config\.task_reset\.force is not allowed/
    );
});

test('validateWorkflowConfig rejects invalid project memory maintenance values', () => {
    const makeConfig = (projectMemory: Record<string, unknown>) => ({
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        project_memory_maintenance: projectMemory
    });

    assert.throws(
        () => validateWorkflowConfig(makeConfig({
            enabled: true,
            mode: 'audit',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 9000,
            read_strategy: 'index_first',
            impact_artifact_retention_days: 30
        })),
        /project_memory_maintenance\.mode must be one of/
    );
    assert.throws(
        () => validateWorkflowConfig(makeConfig({
            enabled: true,
            mode: 'check',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 1999,
            read_strategy: 'index_first',
            impact_artifact_retention_days: 30
        })),
        /max_compact_summary_chars must be >= 2000/
    );
    assert.throws(
        () => validateWorkflowConfig(makeConfig({
            enabled: true,
            mode: 'check',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 9000,
            read_strategy: 'full_scan',
            impact_artifact_retention_days: 30
        })),
        /project_memory_maintenance\.read_strategy must be one of/
    );
});

test('validateOutputFiltersConfig accepts context-driven parser controls from the tracked template', () => {
    const normalized = validateOutputFiltersConfig(readTemplateConfig('output-filters'));

    assert.equal(normalized.version, 2);
    const profiles = (normalized as Record<string, unknown>).profiles as Record<string, { parser: { tail_count: { context_key: string } } }>;
    assert.equal(
        profiles.compile_failure_console.parser.tail_count.context_key,
        'fail_tail_lines'
    );
});

test('validatePathsConfig rejects invalid ordinary doc path patterns', () => {
    const makeConfig = (ordinaryDocPaths: string[]) => ({
        metrics_path: 'garda-agent-orchestrator/runtime/metrics.jsonl',
        runtime_roots: ['src/'],
        fast_path_roots: ['src/'],
        triggers: { test: ['(^|/)tests?/'] },
        ordinary_doc_paths: ordinaryDocPaths
    });

    assert.throws(
        () => validatePathsConfig(makeConfig(['/tmp/notes.md'])),
        /relative repository path/
    );
    assert.throws(
        () => validatePathsConfig(makeConfig(['../plan.md'])),
        /must not contain '\.\.' path segments/
    );
    assert.throws(
        () => validatePathsConfig(makeConfig(['**/*.md'])),
        /repository-wide wildcard/
    );
});


test('validateProfilesConfig validates template profiles.json', () => {
    const normalized = validateProfilesConfig(readTemplateConfig('profiles'));
    assert.equal(normalized.version, 1);
    assert.equal(normalized.active_profile, 'balanced');

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    assert.ok(builtIn.balanced);
    assert.ok(builtIn.fast);
    assert.ok(builtIn.strict);
    assert.ok(builtIn['docs-only']);
    assert.equal(Object.keys(builtIn).length, 4);

    const user = normalized.user_profiles as Record<string, unknown>;
    assert.equal(Object.keys(user).length, 0);
});

test('validateProfilesConfig normalizes boolean-like review_policy values', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'test',
        built_in_profiles: {
            test: {
                description: 'Test profile',
                depth: 2,
                review_policy: { code: 'yes', db: 'auto', security: 'false' },
                token_economy: { enabled: 'true' },
                skills: { auto_suggest: 1 }
            }
        },
        user_profiles: {}
    });

    const builtIn = normalized.built_in_profiles as Record<string, Record<string, unknown>>;
    const policy = builtIn.test.review_policy as Record<string, unknown>;
    assert.equal(policy.code, true);
    assert.equal(policy.db, 'auto');
    assert.equal(policy.security, false);
});

test('validateProfilesConfig rejects active_profile pointing to nonexistent profile', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'nonexistent',
            built_in_profiles: {
                balanced: {
                    description: 'Test', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /does not match any/);
});

test('validateProfilesConfig rejects user profile name conflicting with built-in', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Test', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {
                balanced: {
                    description: 'Conflict', depth: 1,
                    review_policy: { code: false },
                    token_economy: { enabled: false },
                    skills: { auto_suggest: false }
                }
            }
        });
    }, /conflicts with a built-in/);
});

test('validateOptionalSkillSelectionPolicyConfig validates the tracked template', () => {
    const normalized = validateOptionalSkillSelectionPolicyConfig(readTemplateConfig('optional-skill-selection-policy'));
    assert.equal(normalized.version, 1);
    assert.equal(normalized.mode, 'advisory');
});

test('validateManagedConfigByName handles optional-skill-selection-policy', () => {
    const config = readTemplateConfig('optional-skill-selection-policy');
    const result = validateManagedConfigByName('optional-skill-selection-policy', config);
    assert.equal(result.mode, 'advisory');
});

test('validateProfilesConfig rejects empty built_in_profiles', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'any',
            built_in_profiles: {},
            user_profiles: {}
        });
    }, /at least one profile/);
});

test('validateProfilesConfig rejects depth outside 1-3 range', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad depth', depth: 5,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /must be <= 3/);
});

test('validateProfilesConfig allows active_profile to reference a user profile', () => {
    const normalized = validateProfilesConfig({
        version: 1,
        active_profile: 'custom',
        built_in_profiles: {
            balanced: {
                description: 'Built-in', depth: 2,
                review_policy: { code: true },
                token_economy: { enabled: true },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {
            custom: {
                description: 'Custom', depth: 1,
                review_policy: { code: false },
                token_economy: { enabled: false },
                skills: { auto_suggest: false }
            }
        }
    });

    assert.equal(normalized.active_profile, 'custom');
    const user = normalized.user_profiles as Record<string, Record<string, unknown>>;
    assert.ok(user.custom);
});

test('validateProfilesConfig rejects unknown token_economy keys', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad key', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true, unknown_key: true },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        });
    }, /not a recognized token_economy key/);
});

test('validateProfilesConfig rejects unknown skills keys', () => {
    assert.throws(() => {
        validateProfilesConfig({
            version: 1,
            active_profile: 'bad',
            built_in_profiles: {
                bad: {
                    description: 'Bad key', depth: 2,
                    review_policy: { code: true },
                    token_economy: { enabled: true },
                    skills: { auto_suggest: true, unknown_skill: false }
                }
            },
            user_profiles: {}
        });
    }, /not a recognized skills key/);
});


test('validateReviewArtifactStorageConfig normalizes valid config', () => {
    const input = {
        version: 1,
        retention_mode: 'summary',
        compress_after_days: 14,
        compression_format: 'gzip',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json', '-preflight.json'],
        privacy_notice: 'Test notice.'
    };
    const result = validateReviewArtifactStorageConfig(input);
    assert.equal(result.version, 1);
    assert.equal(result.retention_mode, 'summary');
    assert.equal(result.compress_after_days, 14);
    assert.equal(result.compression_format, 'gzip');
    assert.equal(result.preserve_gate_receipts, true);
    assert.deepEqual(result.gate_receipt_suffixes, ['-task-mode.json', '-preflight.json']);
    assert.equal(result.privacy_notice, 'Test notice.');
});

test('validateReviewArtifactStorageConfig accepts none mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'none',
        compress_after_days: 0,
        compression_format: 'gzip',
        preserve_gate_receipts: false,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'none');
    assert.equal(result.preserve_gate_receipts, false);
});

test('validateReviewArtifactStorageConfig accepts full mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'full',
        compress_after_days: 7,
        compression_format: 'gzip',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'full');
});

test('validateReviewArtifactStorageConfig rejects invalid retention_mode', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'invalid',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /retention_mode must be one of/);
});

test('validateReviewArtifactStorageConfig rejects invalid compression_format', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: 7,
            compression_format: 'brotli',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /compression_format must be one of/);
});

test('validateReviewArtifactStorageConfig rejects negative compress_after_days', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: -1,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        });
    }, /must be >= 0/);
});

test('validateReviewArtifactStorageConfig rejects empty gate_receipt_suffixes', () => {
    assert.throws(() => {
        validateReviewArtifactStorageConfig({
            version: 1,
            retention_mode: 'full',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: []
        });
    }, /must not be empty/);
});

test('validateReviewArtifactStorageConfig normalizes case of retention_mode', () => {
    const result = validateReviewArtifactStorageConfig({
        version: 1,
        retention_mode: 'SUMMARY',
        compress_after_days: 0,
        compression_format: 'GZIP',
        preserve_gate_receipts: true,
        gate_receipt_suffixes: ['-task-mode.json']
    });
    assert.equal(result.retention_mode, 'summary');
    assert.equal(result.compression_format, 'gzip');
});

test('validateReviewArtifactStorageConfig validates template config', () => {
    const config = readTemplateConfig('review-artifact-storage');
    const result = validateReviewArtifactStorageConfig(config);
    assert.equal(result.retention_mode, 'full');
    assert.equal(result.compress_after_days, 7);
});

test('validateManagedConfigByName handles review-artifact-storage', () => {
    const config = readTemplateConfig('review-artifact-storage');
    const result = validateManagedConfigByName('review-artifact-storage', config);
    assert.equal(result.retention_mode, 'full');
});

test('validateRuntimeRetentionConfig normalizes valid config', () => {
    const result = validateRuntimeRetentionConfig({
        version: 1,
        active_tasks: {
            protect_runtime_grace_days: '7',
            protect_current_cycle_artifacts: 'true'
        },
        healthy_done: {
            compact_after_days: '30',
            require_ledger: 'yes',
            retain_task_events_until_ledger_verified: 1
        },
        problem_tasks: {
            compress_after_days: '45',
            preserve_detailed_evidence: 'true'
        },
        purge: {
            require_confirm: 'true'
        },
        daily_maintenance: {
            enabled: 'false',
            max_tasks_per_run: '25'
        }
    });
    assert.equal(result.version, 1);
    assert.equal((result.active_tasks as Record<string, unknown>).protect_runtime_grace_days, 7);
    assert.equal((result.active_tasks as Record<string, unknown>).protect_current_cycle_artifacts, true);
    assert.equal((result.healthy_done as Record<string, unknown>).compact_after_days, 30);
    assert.equal((result.problem_tasks as Record<string, unknown>).compress_after_days, 45);
    assert.equal((result.purge as Record<string, unknown>).require_confirm, true);
    assert.equal((result.daily_maintenance as Record<string, unknown>).max_tasks_per_run, 25);
});

test('validateRuntimeRetentionConfig validates template config', () => {
    const config = readTemplateConfig('runtime-retention');
    const result = validateRuntimeRetentionConfig(config);
    assert.equal(result.version, 1);
    assert.equal((result.healthy_done as Record<string, unknown>).compact_after_days, 30);
});

test('validateManagedConfigByName handles runtime-retention', () => {
    const config = readTemplateConfig('runtime-retention');
    const result = validateManagedConfigByName('runtime-retention', config);
    assert.equal((result.problem_tasks as Record<string, unknown>).preserve_detailed_evidence, true);
});

test('buildRuntimeRetentionPreview classifies complete DONE tasks as compact ledger candidates', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-401';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Completed retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'DONE');
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: ['STATUS_CHANGED', 'COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.task_count, 1);
        assert.equal(preview.eligible_now_count, 0);
        assert.equal(preview.tiers.compact_ledger_candidate, 1);
        assert.equal(preview.health_states.healthy_done, 1);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['task-events']);
        assert.equal(preview.tasks[0].health_state, 'healthy_done');
        assert.equal(preview.tasks[0].retention_tier, 'compact_ledger_candidate');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('Heavy artifacts stay authoritative until a ledger exists')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview classifies blocked tasks as compressed forensic candidates', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-402';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'BLOCKED', title: 'Blocked retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'BLOCKED');
        appendTaskEvent(workspace.bundleRoot, taskId, 'TASK_BLOCKED', 'FAIL', 'Task is blocked.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'INCOMPLETE',
                events_found: ['STATUS_CHANGED', 'TASK_BLOCKED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.blocked, 1);
        assert.equal(preview.tiers.compressed_forensic_candidate, 1);
        assert.equal(preview.tasks[0].health_state, 'blocked');
        assert.equal(preview.tasks[0].retention_tier, 'compressed_forensic_candidate');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, true);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('blocked')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview classifies failed tasks as compressed forensic candidates', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-403';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Failed retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'DONE');
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'INCOMPLETE',
                events_found: ['STATUS_CHANGED', 'COMPILE_GATE_FAILED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.failed, 1);
        assert.equal(preview.tasks[0].health_state, 'failed');
        assert.equal(preview.tasks[0].retention_tier, 'compressed_forensic_candidate');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, true);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('failed gate')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview does not classify problematic DONE history as healthy_done', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-403-F1';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Problematic done retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'DONE');
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed.', {});
        appendTaskEvent(workspace.bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'COMPLETE',
                events_found: ['STATUS_CHANGED', 'COMPILE_GATE_FAILED', 'COMPLETION_GATE_PASSED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 3,
                integrity_event_count: 3,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.healthy_done ?? 0, 0);
        assert.equal(preview.health_states.failed, 1);
        assert.equal(preview.tasks[0].health_state, 'failed');
        assert.equal(preview.tasks[0].retention_tier, 'compressed_forensic_candidate');
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('failed gate')));
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview owns lowercase follow-up review artifacts when JSON task_id differs only by case', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-506-f1';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Lowercase follow-up retention task' }]);
        const reviewRoot = path.join(workspace.bundleRoot, 'runtime', 'reviews');
        fs.mkdirSync(reviewRoot, { recursive: true });
        const reviewArtifactPath = path.join(reviewRoot, `${taskId}-reset-report.json`);
        fs.writeFileSync(reviewArtifactPath, JSON.stringify({ task_id: 'T-506-F1', status: 'PASS' }), 'utf8');
        setFileAgeDays(reviewArtifactPath, 45);

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: reviewArtifactPath, category: 'reviews' }]
        );

        assert.equal(preview.task_count, 1);
        assert.equal(preview.tasks[0].task_id, taskId);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['reviews']);
        assert.equal(preview.tasks[0].candidate_count, 1);
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview owns review artifacts with expanded known suffixes', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-507';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'DONE', title: 'Known suffix retention task' }]);
        const reviewRoot = path.join(workspace.bundleRoot, 'runtime', 'reviews');
        fs.mkdirSync(reviewRoot, { recursive: true });
        const reviewArtifactPaths = [
            path.join(reviewRoot, `${taskId}-test-review-output.md`),
            path.join(reviewRoot, `${taskId}-full-suite-validation.json`),
            path.join(reviewRoot, `${taskId}-refactor-scoped.diff`)
        ];
        fs.writeFileSync(reviewArtifactPaths[0], '# Test Review\n\nTEST REVIEW PASSED\n', 'utf8');
        fs.writeFileSync(reviewArtifactPaths[1], JSON.stringify({ status: 'PASS' }), 'utf8');
        fs.writeFileSync(reviewArtifactPaths[2], 'diff --git a/file b/file\n', 'utf8');
        for (const reviewArtifactPath of reviewArtifactPaths) {
            setFileAgeDays(reviewArtifactPath, 45);
        }

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            reviewArtifactPaths.map((reviewArtifactPath) => ({ path: reviewArtifactPath, category: 'reviews' }))
        );

        assert.equal(preview.task_count, 1);
        assert.equal(preview.tasks[0].task_id, taskId);
        assert.deepEqual(preview.tasks[0].candidate_categories, ['reviews']);
        assert.equal(preview.tasks[0].candidate_count, 3);
    } finally {
        workspace.cleanup();
    }
});

test('buildRuntimeRetentionPreview keeps active tasks in protected evidence tier', () => {
    const workspace = makeRetentionPreviewWorkspace();
    try {
        const taskId = 'T-404';
        writeTaskQueue(workspace.targetRoot, [{ id: taskId, status: 'IN_PROGRESS', title: 'Active retention task' }]);
        appendStatusEvent(workspace.bundleRoot, taskId, 'IN_PROGRESS');
        appendTaskEvent(workspace.bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {});
        const taskEventPath = path.join(workspace.eventsRoot, `${taskId}.jsonl`);
        setFileAgeDays(taskEventPath, 45);
        writeTimelineSummary(workspace.eventsRoot, {
            [taskId]: {
                task_id: taskId,
                file_size_bytes: fs.statSync(taskEventPath).size,
                file_mtime_ms: Math.floor(fs.statSync(taskEventPath).mtimeMs),
                code_changed: false,
                completeness_status: 'INCOMPLETE',
                events_found: ['STATUS_CHANGED', 'TASK_MODE_ENTERED'],
                events_missing: [],
                completeness_violations: [],
                integrity_status: 'PASS',
                events_scanned: 2,
                integrity_event_count: 2,
                integrity_violations: []
            }
        });

        const preview = buildRuntimeRetentionPreview(
            workspace.targetRoot,
            workspace.bundleRoot,
            [{ path: taskEventPath, category: 'task-events' }]
        );

        assert.equal(preview.health_states.active, 1);
        assert.equal(preview.tiers.active_evidence, 1);
        assert.equal(preview.tasks[0].health_state, 'active');
        assert.equal(preview.tasks[0].retention_tier, 'active_evidence');
        assert.equal(preview.tasks[0].ledger_status, 'MISSING');
        assert.equal(preview.tasks[0].eligible_now, false);
        assert.ok(preview.tasks[0].reasons.some((reason) => reason.includes('protected')));
    } finally {
        workspace.cleanup();
    }
});
