import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { withFilesystemLock } from '../../../src/gate-runtime/timeline/task-events-locking';
import {
    CatalogProjectionValidationError,
    type CatalogRowProvenance,
    type DerivedCatalogProjection,
    type DerivedSqliteCatalog,
    openDerivedSqliteCatalog,
    probeSqliteCatalogCapability,
    resolveDerivedSqliteCatalogPath,
    SQLITE_CATALOG_APPLICATION_ID,
    SQLITE_CATALOG_BUSY_TIMEOUT_MS,
    SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS,
    SQLITE_CATALOG_SCHEMA_VERSION
} from '../../../src/runtime/sqlite-catalog';
import {
    assessSqliteWalFilesystem,
    createSqliteWalFilesystemAssessmentSession,
    probeWindowsDriveMapping
} from '../../../src/runtime/sqlite-catalog/sqlite-catalog-filesystem';
import { SQLITE_CATALOG_MIGRATIONS } from '../../../src/runtime/sqlite-catalog/sqlite-catalog-migration';

const OBSERVED_AT_UTC = '2026-08-03T10:00:00.000Z';
const EVENT_AT_UTC = '2026-08-03T10:01:00.000Z';

function sha256(seed: string): string {
    return createHash('sha256').update(seed, 'utf8').digest('hex');
}

function createWorkspace(prefix: string): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(workspaceRoot, 'MANIFEST.md'), '# Test bundle\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'VERSION'), '1.2.0-test\n', 'utf8');
    fs.mkdirSync(path.join(workspaceRoot, 'runtime'), { recursive: true });
    return workspaceRoot;
}

function removeWorkspace(workspaceRoot: string): void {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function provenance(
    sourceKind: string,
    sourcePath: string,
    options: {
        sequence?: number | null;
        offset?: number | null;
        timestampUtc?: string | null;
        recordSeed?: string;
    } = {}
): CatalogRowProvenance {
    return {
        sourceKind,
        sourcePath,
        sourceContentSha256: sha256(`source:${sourcePath}`),
        sourceObservedAtUtc: OBSERVED_AT_UTC,
        sourceSequence: options.sequence ?? null,
        sourceOffset: options.offset ?? null,
        sourceTimestampUtc: options.timestampUtc ?? null,
        recordContentSha256: sha256(options.recordSeed || `record:${sourcePath}`)
    };
}

function withCanonicalSources(
    projection: Omit<DerivedCatalogProjection, 'canonicalSources'>
): DerivedCatalogProjection {
    const rows = [
        ...projection.tasks,
        ...projection.lifecycleEvents,
        ...projection.reviewAttempts,
        ...projection.reviewReceipts,
        ...projection.artifacts,
        ...projection.taskLedgers,
        ...projection.retentionStates,
        ...projection.metricSamples
    ];
    const sources = new Map(rows.map((row) => {
        const source = row.provenance;
        return [`${source.sourceKind}\0${source.sourcePath}`, {
            sourceKind: source.sourceKind,
            sourcePath: source.sourcePath,
            contentSha256: source.sourceContentSha256,
            observedAtUtc: source.sourceObservedAtUtc
        }] as const;
    }));
    return { ...projection, canonicalSources: [...sources.values()] };
}

function buildFullProjection(snapshotSeed = 'full'): DerivedCatalogProjection {
    return withCanonicalSources({
        generatedAtUtc: '2026-08-03T10:10:00.000Z',
        snapshotSha256: sha256(`snapshot:${snapshotSeed}`),
        tasks: [{
            taskId: 'T-1000-2',
            status: 'IN_PROGRESS',
            priority: 'P1',
            area: 'runtime/sqlite-derived-catalog',
            title: 'Build a rebuildable SQLite catalog',
            owner: 'gpt-5.6',
            updatedText: '2026-08-03',
            profile: 'balanced',
            notes: 'Canonical files remain authoritative.',
            queuePosition: 0,
            provenance: provenance('task_queue', 'TASK.md')
        }],
        lifecycleEvents: [{
            taskId: 'T-1000-2',
            taskSequence: 1,
            eventType: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'gate',
            message: 'Task mode entered.',
            lifecyclePhase: 'implementation',
            statusSignal: 'pass',
            healthState: 'healthy',
            terminalOutcome: 'none',
            previousEventSha256: null,
            eventSha256: sha256('event:1'),
            provenance: provenance(
                'task_events',
                'runtime/task-events/T-1000-2.jsonl',
                { sequence: 1, offset: 0, timestampUtc: EVENT_AT_UTC, recordSeed: 'event-line:1' }
            )
        }],
        reviewAttempts: [{
            attemptId: 'T-1000-2:code:1',
            taskId: 'T-1000-2',
            reviewType: 'code',
            attemptNumber: 1,
            status: 'completed',
            verdict: 'PASS',
            reviewerIdentity: 'terra-high-reviewer',
            executionMode: 'delegated_subagent',
            startedAtUtc: '2026-08-03T10:02:00.000Z',
            completedAtUtc: '2026-08-03T10:03:00.000Z',
            reviewContextSha256: sha256('review-context'),
            reviewTreeStateSha256: sha256('review-tree'),
            reviewScopeSha256: sha256('review-scope'),
            codeScopeSha256: sha256('code-scope'),
            provenance: provenance(
                'review_attempt',
                'runtime/reviews/T-1000-2-code-attempt-1.json',
                { sequence: 1, timestampUtc: '2026-08-03T10:03:00.000Z' }
            )
        }],
        reviewReceipts: [{
            receiptId: 'T-1000-2:code:receipt:1',
            attemptId: 'T-1000-2:code:1',
            taskId: 'T-1000-2',
            reviewType: 'code',
            verdict: 'PASS',
            trustLevel: 'DELEGATED_ATTESTED',
            reviewerIdentity: 'terra-high-reviewer',
            reviewerExecutionMode: 'delegated_subagent',
            reusedExistingReview: false,
            recordedAtUtc: '2026-08-03T10:04:00.000Z',
            preflightSha256: sha256('preflight'),
            scopeSha256: sha256('scope'),
            reviewContextSha256: sha256('review-context'),
            reviewTreeStateSha256: sha256('review-tree'),
            reviewArtifactSha256: sha256('review-artifact'),
            provenance: provenance(
                'review_receipt',
                'runtime/reviews/T-1000-2-code-receipt.json',
                { sequence: 1, timestampUtc: '2026-08-03T10:04:00.000Z' }
            )
        }],
        artifacts: [{
            artifactId: 'review-output:code:1',
            taskId: 'T-1000-2',
            reviewAttemptId: 'T-1000-2:code:1',
            kind: 'review_output',
            path: 'runtime/reviews/T-1000-2-code.md',
            contentSha256: sha256('review-output'),
            sizeBytes: 512,
            modifiedAtUtc: '2026-08-03T10:03:00.000Z',
            provenance: provenance(
                'artifact',
                'runtime/reviews/T-1000-2-code.md',
                { timestampUtc: '2026-08-03T10:03:00.000Z' }
            )
        }],
        taskLedgers: [{
            taskId: 'T-1000-2',
            auditStatus: 'PASS',
            verificationStatus: 'VERIFIED',
            queueStatus: 'DONE',
            healthState: 'healthy',
            retentionTier: 'terminal',
            integrityStatus: 'PASS',
            pointInTimeStatus: 'CURRENT',
            blockerCount: 0,
            firstEventUtc: EVENT_AT_UTC,
            lastEventUtc: '2026-08-03T10:05:00.000Z',
            changedFilesCount: 5,
            changedLinesTotal: 700,
            generatedAtUtc: '2026-08-03T10:06:00.000Z',
            provenance: provenance(
                'task_ledger',
                'runtime/task-ledger/T-1000-2.json',
                { timestampUtc: '2026-08-03T10:06:00.000Z' }
            )
        }],
        retentionStates: [{
            retentionId: 'retention:review-output:code:1',
            taskId: 'T-1000-2',
            artifactId: 'review-output:code:1',
            state: 'retained',
            tier: 'terminal',
            eligibleAtUtc: '2026-09-03T10:00:00.000Z',
            reason: 'Terminal evidence retention window.',
            policySha256: sha256('retention-policy'),
            provenance: provenance(
                'retention_state',
                'runtime/retention/T-1000-2.json',
                { timestampUtc: '2026-08-03T10:07:00.000Z' }
            )
        }],
        metricSamples: [{
            metricId: 'metric:compile-duration:1',
            taskId: 'T-1000-2',
            name: 'compile_duration_ms',
            valueNumeric: 1420,
            valueText: null,
            unit: 'ms',
            labels: { gate: 'compile', profile: 'balanced' },
            recordedAtUtc: '2026-08-03T10:08:00.000Z',
            provenance: provenance(
                'metric_stream',
                'runtime/metrics.jsonl',
                { offset: 42, timestampUtc: '2026-08-03T10:08:00.000Z' }
            )
        }]
    });
}

function buildEmptyProjection(snapshotSeed = 'empty'): DerivedCatalogProjection {
    return withCanonicalSources({
        generatedAtUtc: '2026-08-03T11:00:00.000Z',
        snapshotSha256: sha256(`snapshot:${snapshotSeed}`),
        tasks: [],
        lifecycleEvents: [],
        reviewAttempts: [],
        reviewReceipts: [],
        artifacts: [],
        taskLedgers: [],
        retentionStates: [],
        metricSamples: []
    });
}

function requireCatalog(workspaceRoot: string): DerivedSqliteCatalog {
    const opened = openDerivedSqliteCatalog(workspaceRoot, {
        appVersion: '1.2.0-test',
        clock: () => '2026-08-03T09:00:00.000Z'
    });
    if (opened.status !== 'available') {
        assert.fail(`Expected available catalog, got ${opened.reason}: ${opened.diagnostic}`);
    }
    return opened.catalog;
}

test('node:sqlite capability probe covers prepared statements, transactions, and FTS5', () => {
    const capability = probeSqliteCatalogCapability();
    assert.equal(capability.available, true, capability.diagnostic);
    assert.equal(capability.fts5Available, true, capability.diagnostic);
    assert.match(capability.sqliteVersion || '', /^\d+\.\d+\.\d+$/u);
});

test('catalog path is workspace-local and distinct across workspaces', () => {
    const firstRoot = createWorkspace('garda-sqlite-path-a-');
    const secondRoot = createWorkspace('garda-sqlite-path-b-');
    try {
        const firstPath = resolveDerivedSqliteCatalogPath(firstRoot);
        const secondPath = resolveDerivedSqliteCatalogPath(secondRoot);
        assert.equal(firstPath, path.join(firstRoot, 'runtime', 'catalog', 'orchestration.sqlite3'));
        assert.equal(secondPath, path.join(secondRoot, 'runtime', 'catalog', 'orchestration.sqlite3'));
        assert.notEqual(firstPath, secondPath);
    } finally {
        removeWorkspace(firstRoot);
        removeWorkspace(secondRoot);
    }
});

test('open rejects a catalog directory link that resolves outside the workspace', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-linked-catalog-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-outside-'));
    const catalogDirectory = path.join(workspaceRoot, 'runtime', 'catalog');
    try {
        try {
            fs.symlinkSync(outsideRoot, catalogDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem links unavailable: ${code}`);
                return;
            }
            throw error;
        }
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'unavailable');
        if (opened.status === 'unavailable') assert.equal(opened.reason, 'unsafe_path');
        assert.equal(fs.existsSync(path.join(outsideRoot, 'orchestration.sqlite3')), false);
    } finally {
        fs.rmSync(catalogDirectory, { recursive: true, force: true });
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('open rejects a catalog file link that resolves outside the workspace', (context) => {
    const workspaceRoot = createWorkspace('garda-sqlite-linked-file-');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sqlite-file-outside-'));
    const catalogDirectory = path.join(workspaceRoot, 'runtime', 'catalog');
    const catalogPath = path.join(catalogDirectory, 'orchestration.sqlite3');
    const outsideCatalogPath = path.join(outsideRoot, 'outside.sqlite3');
    try {
        fs.mkdirSync(catalogDirectory, { recursive: true });
        fs.writeFileSync(outsideCatalogPath, 'outside-catalog-marker', 'utf8');
        try {
            fs.symlinkSync(outsideCatalogPath, catalogPath, 'file');
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (code === 'EPERM' || code === 'EACCES') {
                context.skip(`filesystem links unavailable: ${code}`);
                return;
            }
            throw error;
        }
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'unavailable');
        if (opened.status === 'unavailable') assert.equal(opened.reason, 'unsafe_path');
        assert.equal(fs.readFileSync(outsideCatalogPath, 'utf8'), 'outside-catalog-marker');
    } finally {
        removeWorkspace(workspaceRoot);
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('WAL filesystem guard rejects mapped Windows drives and known network filesystems', () => {
    const windowsDependencies = {
        platform: 'win32' as const,
        pathExists: () => true,
        realpath: () => 'Z:\\workspace\\garda-agent-orchestrator',
        statfsType: () => 0,
        windowsDriveMapping: () => 'network' as const
    };
    assert.deepEqual(
        assessSqliteWalFilesystem('Z:\\workspace\\garda-agent-orchestrator', windowsDependencies),
        {
            status: 'unsafe',
            diagnostic: 'SQLite catalog is disabled for mapped network drive Z:.'
        }
    );

    const posixDependencies = {
        platform: 'linux' as const,
        pathExists: () => true,
        realpath: () => '/mnt/shared/garda-agent-orchestrator',
        statfsType: () => 0x6969,
        windowsDriveMapping: () => 'local' as const
    };
    assert.deepEqual(
        assessSqliteWalFilesystem('/mnt/shared/garda-agent-orchestrator', posixDependencies),
        {
            status: 'unsafe',
            diagnostic: 'SQLite catalog is disabled for filesystem type 0x6969.'
        }
    );
});

test('WAL filesystem guard fails closed when Windows drive locality cannot be verified', () => {
    const assessment = assessSqliteWalFilesystem('Q:\\workspace', {
        platform: 'win32',
        pathExists: () => true,
        realpath: () => 'Q:\\workspace',
        statfsType: () => 0,
        windowsDriveMapping: () => 'unknown'
    });
    assert.deepEqual(assessment, {
        status: 'unavailable',
        diagnostic: 'Cannot verify whether Windows drive Q: is local.'
    });
});

test('Windows drive locality probe does not reuse a stale mapping classification', () => {
    let callCount = 0;
    const runCommand = (drive: string) => {
        assert.equal(drive, 'Z:');
        callCount += 1;
        return { status: callCount === 1 ? 2 : 0 };
    };

    assert.equal(probeWindowsDriveMapping('z:', runCommand), 'local');
    assert.equal(probeWindowsDriveMapping('z:', runCommand), 'network');
    assert.equal(callCount, 2);
});

test('Windows drive locality probe falls back to numeric drive type after an ambiguous net result', () => {
    const ambiguousNetResult = () => ({ status: null, error: new Error('net probe timed out') });
    const fixedDriveResult = (drive: string) => {
        assert.equal(drive, 'C:');
        return { status: 0, stdout: '3\r\n' };
    };
    const networkDriveResult = (drive: string) => {
        assert.equal(drive, 'Z:');
        return { status: 0, stdout: '4\r\n' };
    };

    assert.equal(
        probeWindowsDriveMapping('C:', ambiguousNetResult, fixedDriveResult),
        'local'
    );
    assert.equal(
        probeWindowsDriveMapping('Z:', ambiguousNetResult, networkDriveResult),
        'network'
    );
    assert.equal(
        probeWindowsDriveMapping('Q:', ambiguousNetResult, () => ({ status: 1, stdout: '' })),
        'unknown'
    );
});

test('Windows drive mapping reuse is confined to one filesystem assessment session', () => {
    let probeCount = 0;
    const dependencies = {
        platform: 'win32' as const,
        pathExists: () => true,
        realpath: () => 'Z:\\workspace\\runtime\\catalog',
        statfsType: () => 0,
        windowsDriveMapping: () => {
            probeCount += 1;
            return probeCount === 1 ? 'local' as const : 'network' as const;
        }
    };
    const firstOpenSession = createSqliteWalFilesystemAssessmentSession(dependencies);
    assert.deepEqual(firstOpenSession('Z:\\workspace'), { status: 'safe' });
    assert.deepEqual(firstOpenSession('Z:\\workspace\\runtime\\catalog'), { status: 'safe' });
    assert.equal(probeCount, 1);

    const secondOpenSession = createSqliteWalFilesystemAssessmentSession(dependencies);
    assert.deepEqual(secondOpenSession('Z:\\workspace'), {
        status: 'unsafe',
        diagnostic: 'SQLite catalog is disabled for mapped network drive Z:.'
    });
    assert.equal(probeCount, 2);
});

test('WAL filesystem guard probes the nearest existing catalog-directory ancestor', () => {
    const probedPaths: string[] = [];
    const assessment = assessSqliteWalFilesystem('/workspace/runtime/catalog', {
        platform: 'linux',
        pathExists: (candidatePath) => candidatePath === '/workspace/runtime',
        realpath: (candidatePath) => {
            probedPaths.push(candidatePath);
            return candidatePath;
        },
        statfsType: () => 0x6969,
        windowsDriveMapping: () => 'local'
    });
    assert.equal(assessment.status, 'unsafe');
    assert.deepEqual(probedPaths, ['/workspace/runtime']);
});

test('open initializes identity, migration ledger, WAL, and bounded connection policy', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-open-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const inspection = catalog.inspect();
        assert.equal(inspection.applicationId, SQLITE_CATALOG_APPLICATION_ID);
        assert.equal(inspection.schemaVersion, SQLITE_CATALOG_SCHEMA_VERSION);
        assert.equal(inspection.journalMode, 'wal');
        assert.equal(inspection.foreignKeysEnabled, true);
        assert.equal(inspection.busyTimeoutMs, SQLITE_CATALOG_BUSY_TIMEOUT_MS);
        assert.equal(inspection.generation, 0);
        assert.equal(inspection.canonicalGeneration, null);
        assert.equal(inspection.projectionStatus, 'empty');
        assert.deepEqual(Object.values(inspection.counts), Array(10).fill(0));
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(path.dirname(inspection.catalogPath)).mode & 0o777, 0o700);
            assert.equal(fs.statSync(inspection.catalogPath).mode & 0o777, 0o600);
        }
        assert.equal(
            fs.existsSync(path.join(workspaceRoot, 'runtime', 'catalog', '.maintenance.lock')),
            false
        );

        const duplicateOpen = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(duplicateOpen.status, 'unavailable');
        if (duplicateOpen.status === 'unavailable') assert.equal(duplicateOpen.reason, 'already_open');
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('open upgrades an existing schema-v1 catalog through the immutable migration ledger', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-migrate-v1-');
    const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    const migrationV1 = SQLITE_CATALOG_MIGRATIONS[0];
    const database = new DatabaseSync(catalogPath);
    try {
        database.exec(`PRAGMA application_id = ${SQLITE_CATALOG_APPLICATION_ID};`);
        database.exec(migrationV1.sql);
        database.prepare(`
            INSERT INTO schema_migrations (version, name, checksum, applied_at_utc, app_version)
            VALUES (?, ?, ?, ?, ?)
        `).run(1, migrationV1.name, migrationV1.checksum, '2026-08-03T10:00:00.000Z', '1.1.0-test');
        database.exec('PRAGMA user_version = 1;');
    } finally {
        database.close();
    }

    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const inspection = catalog.inspect();
        assert.equal(inspection.schemaVersion, SQLITE_CATALOG_SCHEMA_VERSION);
        assert.equal(inspection.canonicalGeneration, null);
        catalog.close();
        catalog = null;

        const migrated = new DatabaseSync(catalogPath, { readOnly: true });
        try {
            const versions = migrated.prepare('SELECT version FROM schema_migrations ORDER BY version')
                .all()
                .map((row) => Number((row as Record<string, unknown>).version));
            assert.deepEqual(versions, [1, 2, 3]);
        } finally {
            migrated.close();
        }
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('initial migration requires the workspace catalog maintenance lock', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-maintenance-lock-');
    const lockPath = path.join(workspaceRoot, 'runtime', 'catalog', '.maintenance.lock');
    try {
        withFilesystemLock(lockPath, { ownerLabel: 'sqlite-catalog-test' }, () => {
            const opened = openDerivedSqliteCatalog(workspaceRoot);
            assert.equal(opened.status, 'unavailable');
            if (opened.status === 'unavailable') assert.equal(opened.reason, 'locked');
        });
        const catalog = requireCatalog(workspaceRoot);
        catalog.close();
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('replaceProjection persists all normalized domains and canonical provenance', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-project-');
    const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const result = catalog.replaceProjection(buildFullProjection());
        assert.equal(result.status, 'applied');
        if (result.status === 'applied') {
            assert.equal(result.generation, 1);
            assert.deepEqual(result.counts, {
                sources: 8,
                tasks: 1,
                lifecycleEvents: 1,
                reviewAttempts: 1,
                reviewReceipts: 1,
                artifacts: 1,
                taskLedgers: 1,
                retentionStates: 1,
                metricSamples: 1,
                metricLabels: 2
            });
        }
        assert.equal(catalog.inspect().snapshotSha256, sha256('snapshot:full'));
        catalog.close();
        catalog = null;

        const database = new DatabaseSync(catalogPath, { readOnly: true });
        try {
            const task = database.prepare(
                'SELECT title, queue_position FROM task_queue_rows WHERE task_id = ?'
            ).get('T-1000-2') as Record<string, unknown>;
            assert.equal(task.title, 'Build a rebuildable SQLite catalog');
            assert.equal(task.queue_position, 0);
            const event = database.prepare(`
                SELECT event.task_sequence, event.source_sequence, source.source_path
                FROM lifecycle_events event
                JOIN canonical_sources source ON source.source_id = event.source_id
            `).get() as Record<string, unknown>;
            assert.equal(event.task_sequence, 1);
            assert.equal(event.source_sequence, 1);
            assert.equal(event.source_path, 'runtime/task-events/T-1000-2.jsonl');
            const labels = database.prepare(
                'SELECT label_key, label_value FROM metric_labels ORDER BY label_key'
            ).all() as Array<Record<string, unknown>>;
            assert.deepEqual(labels.map((row) => [row.label_key, row.label_value]), [
                ['gate', 'compile'],
                ['profile', 'balanced']
            ]);
        } finally {
            database.close();
        }

        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.inspect().generation, 1);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('typed catalog queries preserve normalized projection parity and task filtering', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-query-parity-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        const projection = buildFullProjection();
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.replaceProjection(projection).status, 'applied');

        assert.deepEqual(catalog.queryTasks(), projection.tasks);
        assert.deepEqual(catalog.queryLifecycleEvents('T-1000-2'), projection.lifecycleEvents);
        assert.deepEqual(catalog.queryReviewAttempts('T-1000-2'), projection.reviewAttempts);
        assert.deepEqual(catalog.queryReviewReceipts('T-1000-2'), projection.reviewReceipts);
        assert.deepEqual(catalog.queryArtifacts('T-1000-2'), projection.artifacts);
        assert.deepEqual(catalog.queryTaskLedgers('T-1000-2'), projection.taskLedgers);
        assert.deepEqual(catalog.queryRetentionStates('T-1000-2'), projection.retentionStates);
        assert.deepEqual(catalog.queryMetricSamples('T-1000-2'), projection.metricSamples);
        assert.deepEqual(catalog.queryTaskActivitySummaries('T-1000-2'), [{
            taskId: 'T-1000-2',
            queuePosition: 0,
            status: 'IN_PROGRESS',
            lifecycleEventCount: 1,
            firstLifecycleEventUtc: EVENT_AT_UTC,
            lastLifecycleEventUtc: EVENT_AT_UTC,
            reviewAttemptCount: 1,
            reviewReceiptCount: 1,
            artifactCount: 1,
            metricSampleCount: 1,
            auditStatus: 'PASS',
            verificationStatus: 'VERIFIED',
            healthState: 'healthy',
            retentionState: 'retained',
            retentionTier: 'terminal'
        }]);

        assert.deepEqual(catalog.queryTasks('T-9999-1'), []);
        assert.deepEqual(catalog.queryLifecycleEvents('T-9999-1'), []);
        assert.deepEqual(catalog.queryReviewAttempts('T-9999-1'), []);
        assert.deepEqual(catalog.queryReviewReceipts('T-9999-1'), []);
        assert.deepEqual(catalog.queryArtifacts('T-9999-1'), []);
        assert.deepEqual(catalog.queryTaskLedgers('T-9999-1'), []);
        assert.deepEqual(catalog.queryRetentionStates('T-9999-1'), []);
        assert.deepEqual(catalog.queryMetricSamples('T-9999-1'), []);
        assert.deepEqual(catalog.queryTaskActivitySummaries('T-9999-1'), []);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('replacement removes stale rows and advances generation atomically', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-replace-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.replaceProjection(buildFullProjection()).status, 'applied');
        const replacement = catalog.replaceProjection(buildEmptyProjection());
        assert.equal(replacement.status, 'applied');
        if (replacement.status === 'applied') {
            assert.equal(replacement.generation, 2);
            assert.deepEqual(Object.values(replacement.counts), Array(10).fill(0));
        }
        assert.equal(catalog.inspect().snapshotSha256, sha256('snapshot:empty'));
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('oversized projection requires explicit rebuild before opening a writer transaction', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-rebuild-boundary-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.replaceProjection(buildFullProjection()).status, 'applied');
        const baseline = catalog.inspect();
        const event = buildFullProjection().lifecycleEvents[0];
        const oversizedProjection: DerivedCatalogProjection = {
            ...buildEmptyProjection('oversized'),
            lifecycleEvents: Array(SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS + 1).fill(event)
        };

        const result = catalog.replaceProjection(oversizedProjection);

        assert.equal(result.status, 'rebuild_required');
        if (result.status === 'rebuild_required') {
            assert.equal(result.reason, 'projection_too_large');
            assert.equal(result.minimumRows, SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS + 1);
            assert.equal(result.maximumTransactionRows, SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS);
            assert.match(result.diagnostic, /Use explicit rebuild orchestration/u);
        }
        assert.deepEqual(catalog.inspect(), baseline);
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('failed projection transaction rolls back the previous generation', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-rollback-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        assert.equal(catalog.replaceProjection(buildFullProjection()).status, 'applied');
        const invalidProjection = buildFullProjection('duplicate-metric');
        const duplicatedMetric = invalidProjection.metricSamples[0];
        const result = catalog.replaceProjection({
            ...invalidProjection,
            metricSamples: [duplicatedMetric, { ...duplicatedMetric }]
        });
        assert.equal(result.status, 'deferred');
        if (result.status === 'deferred') assert.equal(result.reason, 'write_error');
        const inspection = catalog.inspect();
        assert.equal(inspection.generation, 1);
        assert.equal(inspection.snapshotSha256, sha256('snapshot:full'));
        assert.equal(inspection.projectionStatus, 'stale');
        assert.equal(inspection.counts.metricSamples, 1);
        assert.equal(catalog.replaceProjection(buildEmptyProjection('recovered')).status, 'applied');
        assert.equal(catalog.inspect().projectionStatus, 'ready');
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('contention is bounded and leaves the projection eligible for retry', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-busy-');
    let catalog: DerivedSqliteCatalog | null = null;
    let blocker: DatabaseSync | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        blocker = new DatabaseSync(catalog.catalogPath);
        blocker.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
        const startedAt = Date.now();
        const blocked = catalog.replaceProjection(buildEmptyProjection('blocked'));
        const elapsedMs = Date.now() - startedAt;
        assert.equal(blocked.status, 'deferred');
        if (blocked.status === 'deferred') assert.match(blocked.reason, /^(busy|locked)$/u);
        assert.ok(elapsedMs < 1_500, `expected bounded contention, got ${elapsedMs}ms`);
        blocker.exec('ROLLBACK;');
        blocker.close();
        blocker = null;
        assert.equal(catalog.replaceProjection(buildEmptyProjection('retry')).status, 'applied');
    } finally {
        if (blocker) {
            try { blocker.exec('ROLLBACK;'); } catch { /* already rolled back */ }
            blocker.close();
        }
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('foreign database identity is rejected without modifying its schema or version', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-foreign-');
    const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    const foreign = new DatabaseSync(catalogPath);
    foreign.exec('PRAGMA application_id = 123; PRAGMA user_version = 7; CREATE TABLE marker (value TEXT);');
    foreign.prepare('INSERT INTO marker (value) VALUES (?)').run('preserve-me');
    foreign.close();
    if (process.platform !== 'win32') fs.chmodSync(catalogPath, 0o644);
    try {
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'unavailable');
        if (opened.status === 'unavailable') assert.equal(opened.reason, 'foreign_database');
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(catalogPath).mode & 0o777, 0o644);
        }
        const verified = new DatabaseSync(catalogPath, { readOnly: true });
        try {
            const marker = verified.prepare('SELECT value FROM marker').get() as Record<string, unknown>;
            assert.equal(marker.value, 'preserve-me');
            const applicationId = verified.prepare('PRAGMA application_id').get() as Record<string, unknown>;
            const userVersion = verified.prepare('PRAGMA user_version').get() as Record<string, unknown>;
            assert.equal(Number(Object.values(applicationId)[0]), 123);
            assert.equal(Number(Object.values(userVersion)[0]), 7);
        } finally {
            verified.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('view-only foreign database is rejected without claiming or modifying it', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-foreign-view-');
    const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    const foreign = new DatabaseSync(catalogPath);
    foreign.exec("CREATE VIEW marker_view AS SELECT 'preserve-me' AS value;");
    foreign.close();
    try {
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'unavailable');
        if (opened.status === 'unavailable') assert.equal(opened.reason, 'foreign_database');
        const verified = new DatabaseSync(catalogPath, { readOnly: true });
        try {
            const marker = verified.prepare('SELECT value FROM marker_view').get() as Record<string, unknown>;
            assert.equal(marker.value, 'preserve-me');
            const applicationId = verified.prepare('PRAGMA application_id').get() as Record<string, unknown>;
            const userVersion = verified.prepare('PRAGMA user_version').get() as Record<string, unknown>;
            assert.equal(Number(Object.values(applicationId)[0]), 0);
            assert.equal(Number(Object.values(userVersion)[0]), 0);
        } finally {
            verified.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('corrupt catalog content selects fallback without rewriting the file', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-corrupt-');
    const catalogPath = resolveDerivedSqliteCatalogPath(workspaceRoot);
    const originalContent = 'this is not a SQLite database\n';
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, originalContent, 'utf8');
    try {
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'unavailable');
        if (opened.status === 'unavailable') assert.equal(opened.reason, 'corrupt_catalog');
        assert.equal(fs.readFileSync(catalogPath, 'utf8'), originalContent);
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('newer schema and migration checksum drift fail closed', () => {
    const newerRoot = createWorkspace('garda-sqlite-newer-');
    const checksumRoot = createWorkspace('garda-sqlite-checksum-');
    try {
        const newerCatalog = requireCatalog(newerRoot);
        const newerPath = newerCatalog.catalogPath;
        newerCatalog.close();
        const newerDatabase = new DatabaseSync(newerPath);
        newerDatabase.exec(`PRAGMA user_version = ${SQLITE_CATALOG_SCHEMA_VERSION + 1};`);
        newerDatabase.close();
        const newerOpen = openDerivedSqliteCatalog(newerRoot);
        assert.equal(newerOpen.status, 'unavailable');
        if (newerOpen.status === 'unavailable') assert.equal(newerOpen.reason, 'newer_schema');

        const checksumCatalog = requireCatalog(checksumRoot);
        const checksumPath = checksumCatalog.catalogPath;
        checksumCatalog.close();
        const checksumDatabase = new DatabaseSync(checksumPath);
        checksumDatabase.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
            .run('a'.repeat(64));
        checksumDatabase.close();
        const checksumOpen = openDerivedSqliteCatalog(checksumRoot);
        assert.equal(checksumOpen.status, 'unavailable');
        if (checksumOpen.status === 'unavailable') assert.equal(checksumOpen.reason, 'invalid_schema');
    } finally {
        removeWorkspace(newerRoot);
        removeWorkspace(checksumRoot);
    }
});

test('tampered immutable schema definitions fail closed without repair', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-schema-drift-');
    const catalog = requireCatalog(workspaceRoot);
    const catalogPath = catalog.catalogPath;
    catalog.close();
    const database = new DatabaseSync(catalogPath);
    database.exec('DROP INDEX metric_samples_name_time_idx;');
    database.close();
    try {
        const opened = openDerivedSqliteCatalog(workspaceRoot);
        assert.equal(opened.status, 'unavailable');
        if (opened.status === 'unavailable') assert.equal(opened.reason, 'invalid_schema');
        const verified = new DatabaseSync(catalogPath, { readOnly: true });
        try {
            const index = verified.prepare(`
                SELECT name FROM sqlite_schema
                WHERE type = 'index' AND name = 'metric_samples_name_time_idx'
            `).get();
            assert.equal(index, undefined);
        } finally {
            verified.close();
        }
    } finally {
        removeWorkspace(workspaceRoot);
    }
});

test('review receipts must match the task and type of their referenced attempt', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-receipt-link-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const projection = buildFullProjection('receipt-link');
        const receipt = projection.reviewReceipts[0];
        assert.throws(
            () => catalog?.replaceProjection({
                ...projection,
                reviewReceipts: [{ ...receipt, taskId: 'T-9999-1' }]
            }),
            CatalogProjectionValidationError
        );
        assert.throws(
            () => catalog?.replaceProjection({
                ...projection,
                reviewReceipts: [{ ...receipt, reviewType: 'db' }]
            }),
            CatalogProjectionValidationError
        );
        assert.equal(catalog.inspect().generation, 0);

        assert.equal(catalog.replaceProjection(projection).status, 'applied');
        catalog.close();
        catalog = null;
        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot));
        try {
            database.exec('PRAGMA foreign_keys = ON;');
            assert.throws(
                () => database.prepare(`
                    UPDATE review_receipts SET task_id = ? WHERE receipt_id = ?
                `).run('T-9999-1', receipt.receiptId),
                /FOREIGN KEY/u
            );
        } finally {
            database.close();
        }
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('artifacts and retention state must match their linked task entities', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-artifact-link-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const projection = buildFullProjection('artifact-link');
        const artifact = projection.artifacts[0];
        const retention = projection.retentionStates[0];
        assert.throws(
            () => catalog?.replaceProjection({
                ...projection,
                artifacts: [{ ...artifact, taskId: 'T-9999-1' }]
            }),
            CatalogProjectionValidationError
        );
        assert.throws(
            () => catalog?.replaceProjection({
                ...projection,
                retentionStates: [{ ...retention, taskId: 'T-9999-1' }]
            }),
            CatalogProjectionValidationError
        );

        assert.equal(catalog.replaceProjection(projection).status, 'applied');
        catalog.close();
        catalog = null;
        const database = new DatabaseSync(resolveDerivedSqliteCatalogPath(workspaceRoot));
        try {
            database.exec('PRAGMA foreign_keys = ON;');
            assert.throws(
                () => database.prepare('UPDATE artifacts SET task_id = ? WHERE artifact_id = ?')
                    .run('T-9999-1', artifact.artifactId),
                /artifact review attempt task mismatch/u
            );
            assert.throws(
                () => database.prepare('UPDATE retention_state SET task_id = ? WHERE retention_id = ?')
                    .run('T-9999-1', retention.retentionId),
                /retention artifact task mismatch/u
            );
        } finally {
            database.close();
        }
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});

test('invalid provenance is rejected before any catalog mutation', () => {
    const workspaceRoot = createWorkspace('garda-sqlite-validation-');
    let catalog: DerivedSqliteCatalog | null = null;
    try {
        catalog = requireCatalog(workspaceRoot);
        const projection = buildFullProjection();
        const invalidProjection: DerivedCatalogProjection = {
            ...projection,
            tasks: [{
                ...projection.tasks[0],
                provenance: {
                    ...projection.tasks[0].provenance,
                    sourcePath: '../outside/TASK.md'
                }
            }]
        };
        assert.throws(
            () => catalog?.replaceProjection(invalidProjection),
            CatalogProjectionValidationError
        );
        assert.equal(catalog.inspect().generation, 0);
        catalog.close();
        assert.throws(() => catalog?.inspect(), /closed/u);
        catalog = null;
    } finally {
        catalog?.close();
        removeWorkspace(workspaceRoot);
    }
});
