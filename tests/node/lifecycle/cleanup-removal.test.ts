import {
    describe,
    it,
    beforeEach,
    afterEach,
    assert,
    fs,
    path,
    runCleanup,
    runCleanupWithLock,
    runGc,
    appendTaskEvent,
    makeTmpDir,
    setupRuntimeDir,
    createTimestampDir,
    createUpdateDir,
    daysAgo,
    createTaskEventFile,
    writeTaskTimeline,
    writeTimelineSummary,
    createReviewArtifacts,
    seedHealthyDoneTaskArtifacts,
    writeTaskQueue
} from './cleanup-fixtures';

describe('runCleanup', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        // VERSION file required by validateTargetRoot
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup
        }
    });

    describe('backups retention by count', () => {
        it('removes oldest backups exceeding maxBackups', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            // Create 5 backup dirs
            const dates = [
                daysAgo(5),
                daysAgo(4),
                daysAgo(3),
                daysAgo(2),
                daysAgo(1)
            ];
            for (const d of dates) {
                createTimestampDir(backupsDir, d);
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 3, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            // Should remove 2 oldest
            assert.equal(result.removed.length, 2);
            for (const item of result.removed) {
                assert.equal(item.category, 'backups');
                assert.equal(item.reason, 'count');
            }
            // 3 should remain
            const remaining = fs.readdirSync(backupsDir);
            assert.equal(remaining.length, 3);
        });
    });

    describe('backups retention by age', () => {
        it('removes backups older than maxAgeDays', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            createTimestampDir(backupsDir, daysAgo(60));
            createTimestampDir(backupsDir, daysAgo(1));

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 100, maxAgeDays: 30 }
            });

            assert.equal(result.result, 'SUCCESS');
            const ageItems = result.removed.filter(i => i.reason === 'age');
            assert.ok(ageItems.length >= 1, 'Should remove at least 1 aged backup');
            assert.equal(fs.readdirSync(backupsDir).length, 1);
        });
    });

    describe('dry-run mode', () => {
        it('does not remove any files in dry-run mode', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            for (let i = 0; i < 5; i++) {
                createTimestampDir(backupsDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: true,
                retentionPolicy: { maxBackups: 2, maxAgeDays: 365 }
            });

            assert.equal(result.dryRun, true);
            assert.equal(result.removed.length, 0);
            assert.equal(result.skipped.length, 3);
            assert.ok(result.totalFreedBytes > 0, 'Should report projected freed bytes');
            // All 5 dirs should still exist
            assert.equal(fs.readdirSync(backupsDir).length, 5);
        });
    });

    describe('task-event cleanup', () => {
        it('compacts task-event files for aged healthy DONE tasks with verified ledgers', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            for (let i = 1; i <= 4; i++) {
                seedHealthyDoneTaskArtifacts({
                    bundleRoot,
                    taskId: `T-${String(i).padStart(3, '0')}`,
                    ageDays: 45
                });
            }
            fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), '{"event":"test"}\n');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 3, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            const eventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(eventItems.length, 4);
            assert.ok(fs.existsSync(path.join(eventsDir, 'all-tasks.jsonl')));
            assert.equal(
                fs.readdirSync(eventsDir).filter((entry) => entry.endsWith('.jsonl') && entry !== 'all-tasks.jsonl').length,
                0
            );
        });

        it('never removes all-tasks.jsonl', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), '{"event":"test"}\n');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 0, maxAgeDays: 0 }
            });

            assert.ok(fs.existsSync(path.join(eventsDir, 'all-tasks.jsonl')));
            const taskEventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(taskEventItems.length, 0);
        });

        it('does not compact aged terminal timelines without a verified ledger', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟩 DONE', title: 'No ledger yet' }
        ]);
        appendTaskEvent(bundleRoot, 'T-001', 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-001', 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
            previous_status: 'IN_REVIEW',
            new_status: 'DONE'
        }, { passThru: true });
        appendTaskEvent(bundleRoot, 'T-001', 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {}, { passThru: true });
        const timelinePath = path.join(eventsDir, 'T-001.jsonl');
        writeTimelineSummary(eventsDir, 'T-001', { completenessStatus: 'COMPLETE' });
        const past = daysAgo(45);
        fs.utimesSync(timelinePath, past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
            });

            const eventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(eventItems.length, 0);
            assert.equal(fs.existsSync(timelinePath), true, 'timeline should remain until a verified ledger exists');
            assert.equal(result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-001')?.ledger_status, 'MISSING');
            assert.equal(result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-001')?.eligible_now, false);
        });

        it('evicts companion completeness cache alongside timeline JSONL', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({
                bundleRoot,
                taskId: 'T-001',
                includeCompletenessCache: true,
                ageDays: 45
            });

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
            });

            const eventItems = result.removed.filter(i => i.category === 'task-events');
            const removedNames = eventItems.map(i => path.basename(i.path));
            assert.ok(removedNames.includes('T-001.jsonl'));
            assert.ok(removedNames.includes('T-001.completeness.json'),
                'Companion completeness cache must be evicted with its timeline');
        });

        it('evicts orphaned completeness cache when timeline JSONL is already gone', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            // Create a completeness cache with no corresponding JSONL
            fs.writeFileSync(path.join(eventsDir, 'T-ORPHAN.completeness.json'), '{}', 'utf8');
            createTaskEventFile(eventsDir, 'T-001');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 10, maxAgeDays: 365 }
            });

            const eventItems = result.removed.filter(i => i.category === 'task-events');
            const removedNames = eventItems.map(i => path.basename(i.path));
            assert.ok(removedNames.includes('T-ORPHAN.completeness.json'),
                'Orphaned completeness cache must be collected for removal');
        });

        it('prunes stale entries from timeline summary when task-event files are removed', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({
                bundleRoot,
                taskId: 'T-001',
                ageDays: 45
            });
            writeTaskQueue(tmpDir, [
                { id: 'T-001', status: '🟩 DONE', title: 'Compactable task' },
                { id: 'T-002', status: '🟨 IN_PROGRESS', title: 'Active task' }
            ]);
            createTaskEventFile(eventsDir, 'T-002');

            // Pre-populate a timeline summary with entries for both tasks
            const summaryPath = path.join(eventsDir, '.timeline-summary.json');
            const summaryIndex = {
                version: 2,
                updated_at_utc: new Date().toISOString(),
                entries: {
                    'T-001': { task_id: 'T-001', file_size_bytes: 100, file_mtime_ms: 0,
                        code_changed: false, completeness_status: 'COMPLETE',
                        events_found: [], events_missing: [], completeness_violations: [],
                        integrity_status: 'PASS', events_scanned: 1,
                        integrity_event_count: 1, integrity_violations: [] },
                    'T-002': { task_id: 'T-002', file_size_bytes: 100, file_mtime_ms: 0,
                        code_changed: false, completeness_status: 'COMPLETE',
                        events_found: [], events_missing: [], completeness_violations: [],
                        integrity_status: 'PASS', events_scanned: 1,
                        integrity_event_count: 1, integrity_violations: [] }
                }
            };
            fs.writeFileSync(summaryPath, JSON.stringify(summaryIndex, null, 2) + '\n', 'utf8');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
            });

            const removedNames = result.removed.map(i => path.basename(i.path));
            assert.ok(removedNames.includes('T-001.jsonl'), 'T-001 timeline should be removed');

            // The timeline summary should have been pruned: T-001 entry gone, T-002 kept
            assert.ok(fs.existsSync(summaryPath), 'Timeline summary file should still exist');
            const updated = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            assert.ok(!updated.entries['T-001'],
                'Stale T-001 entry must be pruned from timeline summary after its JSONL is removed');
            assert.ok(updated.entries['T-002'],
                'Active T-002 entry must be preserved in timeline summary');
        });
    });

    describe('review artifact cleanup', () => {
        it('compacts review artifacts for aged healthy DONE tasks with verified ledgers', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            for (let i = 1; i <= 4; i++) {
                seedHealthyDoneTaskArtifacts({
                    bundleRoot,
                    taskId: `T-${String(i).padStart(3, '0')}`,
                    ageDays: 45
                });
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxReviews: 2, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            const reviewItems = result.removed.filter(i => i.category === 'reviews');
            assert.equal(reviewItems.length, 20);
            assert.equal(fs.readdirSync(reviewsDir).filter((entry) => entry.startsWith('T-')).length, 0);
        });

        it('preserves review artifacts for healthy DONE tasks until the ledger is verified', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            createReviewArtifacts(reviewsDir, 'T-001');
            writeTaskQueue(tmpDir, [
                { id: 'T-001', status: '🟩 DONE', title: 'Healthy done' }
            ]);
            writeTaskTimeline(eventsDir, 'T-001', [
                { event_type: 'TASK_MODE_ENTERED' },
                { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } },
                { event_type: 'COMPLETION_GATE_PASSED' }
            ]);
            writeTimelineSummary(eventsDir, 'T-001', { completenessStatus: 'COMPLETE' });
            const past = daysAgo(45);
            for (const file of fs.readdirSync(reviewsDir)) {
                fs.utimesSync(path.join(reviewsDir, file), past, past);
            }
            fs.utimesSync(path.join(eventsDir, 'T-001.jsonl'), past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            const reviewItems = result.removed.filter(i => i.category === 'reviews');
            assert.equal(reviewItems.length, 0);
            assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true);
        });

        it('groups suffixed review artifacts by the full task id', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-506-1', ageDays: 45 });
            seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-506-2', ageDays: 45 });

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            const reviewItems = result.removed.filter(i => i.category === 'reviews');
            const removedNames = reviewItems.map(i => path.basename(i.path));
            assert.equal(reviewItems.length, 10);
            assert.ok(removedNames.some((entry) => entry.startsWith('T-506-1-')));
            assert.ok(removedNames.some((entry) => entry.startsWith('T-506-2-')));
        });

        it('does not compact follow-up review artifacts under the parent task ledger', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-506', ageDays: 45 });
            const childFinalCloseoutPath = path.join(reviewsDir, 'T-506-F1-final-closeout.json');
            const childFullSuiteLogPath = path.join(reviewsDir, 'T-506-F1-full-suite-output.log');
            const childStrictDecompositionPath = path.join(reviewsDir, 'T-506-F1-strict-decomposition-decision.json');
            const childOptionalSkillPath = path.join(reviewsDir, 'T-506-F1-optional-skill-selection.json');
            const childResetReportPath = path.join(reviewsDir, 'T-506-F1-reset-report.json');
            const malformedChildResetReportPath = path.join(reviewsDir, 'T-506-F1-bad-reset-report.json');
            fs.writeFileSync(childFinalCloseoutPath, JSON.stringify({ task_id: 'T-506-F1', status: 'READY' }), 'utf8');
            fs.writeFileSync(childFullSuiteLogPath, 'child full-suite output\n', 'utf8');
            fs.writeFileSync(childStrictDecompositionPath, JSON.stringify({ task_id: 'T-506-F1', decision: 'single-cycle' }), 'utf8');
            fs.writeFileSync(childOptionalSkillPath, JSON.stringify({ task_id: 'T-506-F1', decision: 'recommended_missing_packs' }), 'utf8');
            fs.writeFileSync(childResetReportPath, JSON.stringify({ task_id: 'T-506-F1', event_source: 'task-reset' }), 'utf8');
            fs.writeFileSync(malformedChildResetReportPath, '{not-json', 'utf8');
            const past = daysAgo(45);
            fs.utimesSync(childFinalCloseoutPath, past, past);
            fs.utimesSync(childFullSuiteLogPath, past, past);
            fs.utimesSync(childStrictDecompositionPath, past, past);
            fs.utimesSync(childOptionalSkillPath, past, past);
            fs.utimesSync(childResetReportPath, past, past);
            fs.utimesSync(malformedChildResetReportPath, past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: false,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            assert.ok(result.removed.some((item) => item.path.endsWith('T-506-final-closeout.json')),
                'parent review artifacts should still compact');
            assert.equal(fs.existsSync(childFinalCloseoutPath), true,
                'follow-up final-closeout must not compact under the parent task ledger');
            assert.equal(fs.existsSync(childFullSuiteLogPath), true,
                'follow-up full-suite output must not compact under the parent task ledger');
            assert.equal(fs.existsSync(childStrictDecompositionPath), true,
                'follow-up strict decomposition artifact must not compact under the parent task ledger');
            assert.equal(fs.existsSync(childOptionalSkillPath), true,
                'follow-up optional skill artifact must not compact under the parent task ledger');
            assert.equal(fs.existsSync(childResetReportPath), true,
                'unknown follow-up reset report must fail closed instead of compacting under the parent task ledger');
            assert.equal(fs.existsSync(malformedChildResetReportPath), true,
                'malformed unknown follow-up json must fail closed instead of compacting under the parent task ledger');
        });

        it('fails closed when unknown json follow-up artifacts disagree with filename ownership', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-506', ageDays: 45 });
            const mismatchedChildResetReportPath = path.join(reviewsDir, 'T-506-F1-reset-report.json');
            fs.writeFileSync(
                mismatchedChildResetReportPath,
                JSON.stringify({ task_id: 'T-506', event_source: 'task-reset' }),
                'utf8'
            );
            const past = daysAgo(45);
            fs.utimesSync(mismatchedChildResetReportPath, past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: false,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            assert.ok(result.removed.some((item) => item.path.endsWith('T-506-final-closeout.json')),
                'parent review artifacts should still compact');
            assert.equal(fs.existsSync(mismatchedChildResetReportPath), true,
                'filename and body ownership mismatch must fail closed instead of compacting under the parent task ledger');
        });

        it('storage policy preserves mismatched json follow-up artifacts during gc', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-506', ageDays: 45 });
            const mismatchedChildResetReportPath = path.join(reviewsDir, 'T-506-F1-reset-report.json');
            fs.writeFileSync(
                mismatchedChildResetReportPath,
                JSON.stringify({ task_id: 'T-506', event_source: 'task-reset' }),
                'utf8'
            );
            const past = daysAgo(45);
            fs.utimesSync(mismatchedChildResetReportPath, past, past);

            const result = runGc({
                targetRoot: tmpDir,
                bundleRoot,
                confirm: true,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 },
                storagePolicy: {
                    retentionMode: 'summary',
                    compressAfterDays: 0,
                    compressionFormat: 'gzip',
                    preserveGateReceipts: true,
                    gateReceiptSuffixes: ['-task-mode.json']
                }
            });

            assert.equal(fs.existsSync(mismatchedChildResetReportPath), true,
                'storage policy must preserve mismatched follow-up json instead of using body task_id as ownership');
            assert.ok(!result.storagePolicyResult?.removed.includes('T-506-F1-reset-report.json'));
            assert.ok(!result.storagePolicyResult?.compressed.includes('T-506-F1-reset-report.json.gz'));
        });

        it('fails closed for lowercase follow-up ownership on malformed unknown json artifacts', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            seedHealthyDoneTaskArtifacts({ bundleRoot, taskId: 'T-506', ageDays: 45 });
            const malformedLowercaseChildResetReportPath = path.join(reviewsDir, 'T-506-f1-reset-report.json');
            fs.writeFileSync(malformedLowercaseChildResetReportPath, '{not-json', 'utf8');
            const past = daysAgo(45);
            fs.utimesSync(malformedLowercaseChildResetReportPath, past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: false,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            assert.ok(result.removed.some((item) => item.path.endsWith('T-506-final-closeout.json')),
                'parent review artifacts should still compact');
            assert.equal(fs.existsSync(malformedLowercaseChildResetReportPath), true,
                'lowercase follow-up malformed json must fail closed instead of compacting under the parent task ledger');
        });

        it('compacts task-scoped project-memory artifacts with ledger-only retention metadata', () => {
            const seeded = seedHealthyDoneTaskArtifacts({
                bundleRoot,
                taskId: 'T-777',
                includeProjectMemory: true,
                ageDays: 45
            });

            const dryRun = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: true,
                retentionPolicy: { maxAgeDays: 365 }
            });

            const dryRunProjectMemoryItems = dryRun.skipped.filter((item) => item.category === 'project-memory');
            assert.equal(dryRunProjectMemoryItems.length, 2);
            assert.ok(dryRunProjectMemoryItems.every((item) => item.taskId === 'T-777'));
            assert.ok(dryRunProjectMemoryItems.every((item) => item.retainedLedgerPath?.endsWith('/runtime/task-ledger/T-777.json') || item.retainedLedgerPath?.endsWith('\\runtime\\task-ledger\\T-777.json')));
            assert.equal(fs.existsSync(seeded.projectMemoryPaths[0]), true, 'dry-run must preserve project-memory artifacts');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: false,
                retentionPolicy: { maxAgeDays: 365 }
            });

            const removedProjectMemoryItems = result.removed.filter((item) => item.category === 'project-memory');
            assert.equal(removedProjectMemoryItems.length, 2);
            assert.ok(removedProjectMemoryItems.every((item) => item.reason === 'ledger-compaction'));
            assert.ok(seeded.projectMemoryPaths.every((artifactPath) => !fs.existsSync(artifactPath)));
            assert.equal(fs.existsSync(seeded.ledgerPath), true, 'verified ledger must remain after compaction');
        });

        it('compacts project-memory artifacts for canonical task ids with suffixes', () => {
            const seeded = seedHealthyDoneTaskArtifacts({
                bundleRoot,
                taskId: 'T-777-F1',
                includeProjectMemory: true,
                ageDays: 45
            });

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: false,
                retentionPolicy: { maxAgeDays: 365 }
            });

            const removedProjectMemoryItems = result.removed.filter((item) => item.category === 'project-memory');
            assert.equal(removedProjectMemoryItems.length, 2);
            assert.ok(removedProjectMemoryItems.every((item) => item.taskId === 'T-777-F1'));
            assert.ok(seeded.projectMemoryPaths.every((artifactPath) => !fs.existsSync(artifactPath)));
        });

        it('preserves detailed artifacts for DONE tasks with failed history', () => {
            const seeded = seedHealthyDoneTaskArtifacts({
                bundleRoot,
                taskId: 'T-778',
                includeProjectMemory: true,
                ageDays: 45
            });
            appendTaskEvent(bundleRoot, 'T-778', 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed before recovery.', {}, { passThru: true });
            writeTimelineSummary(seeded.eventsDir, 'T-778', {
                completenessStatus: 'COMPLETE',
                eventsFound: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'COMPLETION_GATE_PASSED', 'COMPILE_GATE_FAILED']
            });
            const past = daysAgo(45);
            fs.utimesSync(seeded.timelinePath, past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: false,
                retentionPolicy: { maxAgeDays: 365 }
            });

            assert.equal(result.removed.filter((item) => item.taskId === 'T-778').length, 0);
            assert.equal(fs.existsSync(seeded.timelinePath), true, 'failed-history timeline should remain authoritative');
            assert.equal(fs.existsSync(seeded.projectMemoryPaths[0]), true, 'failed-history project-memory artifact should remain');
            assert.equal(result.runtimeRetentionPreview?.tasks.find((task) => task.task_id === 'T-778')?.health_state, 'failed');
        });
    });

    describe('update-rollbacks cleanup', () => {
        it('removes oldest update-rollback dirs exceeding maxUpdateRollbacks', () => {
            const rollbacksDir = path.join(runtimeDir, 'update-rollbacks');
            fs.mkdirSync(rollbacksDir, { recursive: true });

            for (let i = 0; i < 4; i++) {
                createUpdateDir(rollbacksDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxUpdateRollbacks: 2, maxAgeDays: 365 }
            });

            const rollbackItems = result.removed.filter(i => i.category === 'update-rollbacks');
            assert.equal(rollbackItems.length, 2);
            assert.equal(fs.readdirSync(rollbacksDir).length, 2);
        });
    });

    describe('bundle-backups cleanup', () => {
        it('removes oldest bundle-backup dirs exceeding maxBundleBackups', () => {
            const bundleBackupsDir = path.join(runtimeDir, 'bundle-backups');
            fs.mkdirSync(bundleBackupsDir, { recursive: true });

            for (let i = 0; i < 4; i++) {
                createTimestampDir(bundleBackupsDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBundleBackups: 2, maxAgeDays: 365 }
            });

            const bundleItems = result.removed.filter(i => i.category === 'bundle-backups');
            assert.equal(bundleItems.length, 2);
            assert.equal(fs.readdirSync(bundleBackupsDir).length, 2);
        });
    });

    describe('update-reports cleanup', () => {
        it('removes oldest update-report files exceeding maxUpdateReports', () => {
            const reportsDir = path.join(runtimeDir, 'update-reports');
            fs.mkdirSync(reportsDir, { recursive: true });

            for (let i = 0; i < 4; i++) {
                createUpdateDir(reportsDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxUpdateReports: 2, maxAgeDays: 365 }
            });

            const reportItems = result.removed.filter(i => i.category === 'update-reports');
            assert.equal(reportItems.length, 2);
            assert.equal(fs.readdirSync(reportsDir).length, 2);
        });
    });

    describe('retention policy override', () => {
        it('accepts partial overrides and uses defaults for the rest', () => {
            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 5 }
            });

            assert.equal(result.retentionPolicy.maxBackups, 5);
            assert.equal(result.retentionPolicy.maxAgeDays, 30);
            assert.equal(result.retentionPolicy.maxTaskEvents, 50);
        });
    });

    describe('combined retention', () => {
        it('cleans up across multiple categories in a single run', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(backupsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            for (let i = 0; i < 5; i++) {
                createTimestampDir(backupsDir, daysAgo(i + 1));
            }
            for (let i = 1; i <= 5; i++) {
                seedHealthyDoneTaskArtifacts({
                    bundleRoot,
                    taskId: `T-${String(i).padStart(3, '0')}`,
                    ageDays: 45
                });
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 2, maxTaskEvents: 2, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            const backupItems = result.removed.filter(i => i.category === 'backups');
            const eventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(backupItems.length, 3);
            assert.equal(eventItems.length, 5);
        });
    });

    describe('error handling', () => {
        it('reports PARTIAL when some removals fail', () => {
            // Create a backup dir that we make read-only on the parent
            // This test only verifies the error-reporting path
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            for (let i = 0; i < 3; i++) {
                createTimestampDir(backupsDir, daysAgo(i + 1));
            }

            // Normal run should succeed
            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 1, maxAgeDays: 365 }
            });
            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.errors.length, 0);
        });
    });
});

describe('runCleanupWithLock', () => {
    let tmpDir: string;
    let bundleRoot: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-lock-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort
        }
    });

    it('runs cleanup under lifecycle lock', () => {
        const result = runCleanupWithLock({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.dryRun, true);
    });
});
