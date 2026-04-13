import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    type WhyBlockedResult,
    getWhyBlocked,
    formatWhyBlockedResult
} from '../../../src/validators/why-blocked';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTaskMd(rows: string[]): string {
    const header = '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |';
    const sep    = '|---|---|---|---|---|---|---|---|---|';
    return `<!-- garda-agent-orchestrator:managed-start -->\n# TASK.md\n\n## Active Queue\n${header}\n${sep}\n${rows.join('\n')}\n<!-- garda-agent-orchestrator:managed-end -->\n`;
}

// ── getWhyBlocked ─────────────────────────────────────────────────────────────

test('getWhyBlocked returns no blocked tasks when TASK.md is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, false);
        assert.deepEqual(result.blocked_tasks, []);
        assert.deepEqual(result.lock_observations, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked returns no blocked tasks when all tasks are DONE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-001 | 🟩 DONE | P0 | area | Title | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, false);
        assert.deepEqual(result.blocked_tasks, []);
        assert.deepEqual(result.lock_observations, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked detects BLOCKED task', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-002 | 🟥 BLOCKED | P1 | area | Blocked task | me | 2026-01-01 | default | blocked_reason_code=EXTERNAL_DEPENDENCY |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.equal(result.blocked_tasks.length, 1);
        assert.equal(result.blocked_tasks[0].task.id, 'T-002');
        assert.equal(result.blocked_tasks[0].task.status, 'BLOCKED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked extracts blocked_reason_code from notes column', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    try {
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-003 | 🟥 BLOCKED | P2 | area | Some task | me | 2026-01-01 | strict | blocked_reason_code=REVIEW_DEPENDENCY |']),
            'utf8'
        );

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.blocked_tasks.length, 1);

        const reasons = result.blocked_tasks[0].blocking_reasons;
        const explicitReason = reasons.find(function (r) { return r.reason_code === 'REVIEW_DEPENDENCY'; });
        assert.ok(explicitReason !== undefined, 'Expected blocking reason REVIEW_DEPENDENCY from notes');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked detects IN_PROGRESS task with missing timeline events', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-010 | 🟨 IN_PROGRESS | P1 | area | Active task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        // Write a partial timeline (only TASK_MODE_ENTERED, missing RULE_PACK_LOADED etc.)
        const event = JSON.stringify({
            timestamp_utc: new Date().toISOString(),
            task_id: 'T-010',
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'orchestrator',
            message: 'Test'
        });
        fs.writeFileSync(path.join(eventsDir, 'T-010.jsonl'), event + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.has_blocked_tasks, true);
        assert.equal(result.in_progress_tasks.length, 1);

        const analysed = result.in_progress_tasks[0];
        assert.equal(analysed.task.id, 'T-010');
        assert.ok(analysed.missing_events.length > 0, 'Expected missing events for incomplete timeline');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked returns empty in_progress_tasks when timeline is complete', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-011 | 🟨 IN_PROGRESS | P1 | area | Healthy task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );

        // Write complete non-code-change timeline
        const events = [
            'TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'
        ];
        const lines = events.map(function (eventType) {
            return JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-011',
                event_type: eventType,
                outcome: 'PASS',
                actor: 'gate',
                message: 'Test'
            });
        });
        fs.writeFileSync(path.join(eventsDir, 'T-011.jsonl'), lines.join('\n') + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        // With complete timeline and no failed gates => not stalled
        assert.equal(result.in_progress_tasks.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getWhyBlocked surfaces stale task-event lock as blocking reason for matching task', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-blocked-lock-test-'));
    const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
    const eventsDir = path.join(bundleDir, 'runtime', 'task-events');

    try {
        fs.mkdirSync(path.join(eventsDir, '.T-005.lock'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'TASK.md'),
            makeTaskMd(['| T-005 | 🟨 IN_PROGRESS | P1 | area | Active task | me | 2026-01-01 | default | Notes |']),
            'utf8'
        );
        fs.writeFileSync(path.join(eventsDir, '.T-005.lock', 'owner.json'), JSON.stringify({
            pid: 999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const result = getWhyBlocked(tmpDir);
        assert.equal(result.in_progress_tasks.length, 1);
        assert.equal(result.lock_observations.length, 1);
        assert.ok(result.in_progress_tasks[0].blocking_reasons.some(function (reason) {
            return reason.reason_code === 'STALE_TASK_EVENT_LOCK';
        }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ── formatWhyBlockedResult ────────────────────────────────────────────────────

test('formatWhyBlockedResult says no blocked tasks when result is clean', () => {
    const result: WhyBlockedResult = {
        has_blocked_tasks: false,
        blocked_tasks: [],
        in_progress_tasks: [],
        lock_observations: [],
        summary_lines: ['No blocked or stalled tasks found.']
    };

    const output = formatWhyBlockedResult(result);
    assert.ok(output.includes('WhyBlocked'));
    assert.ok(output.includes('No blocked or stalled tasks found.'));
});

test('formatWhyBlockedResult renders BLOCKED task section', () => {
    const result: WhyBlockedResult = {
        has_blocked_tasks: true,
        blocked_tasks: [{
            task: {
                id: 'T-050',
                status: 'BLOCKED',
                priority: 'P1',
                area: 'cli',
                title: 'Test blocked task',
                owner: 'me',
                updated: '2026-01-01',
                profile: 'default',
                notes: ''
            },
            blocking_reasons: [{
                reason_code: 'EXTERNAL_DEPENDENCY',
                description: 'Depends on external API',
                remediation: 'Wait for API team.'
            }],
            missing_events: [],
            failed_gates: [],
            timeline_status: 'MISSING',
            related_locks: []
        }],
        in_progress_tasks: [],
        lock_observations: [],
        summary_lines: ['Blocked tasks: 1']
    };

    const output = formatWhyBlockedResult(result);
    assert.ok(output.includes('BLOCKED: T-050'));
    assert.ok(output.includes('Test blocked task'));
    assert.ok(output.includes('[EXTERNAL_DEPENDENCY]'));
    assert.ok(output.includes('Wait for API team.'));
    assert.ok(output.includes('Blocked tasks: 1'));
});

test('formatWhyBlockedResult renders STALLED task with missing events', () => {
    const result: WhyBlockedResult = {
        has_blocked_tasks: true,
        blocked_tasks: [],
        in_progress_tasks: [{
            task: {
                id: 'T-020',
                status: 'IN_PROGRESS',
                priority: 'P2',
                area: 'cli',
                title: 'Stalled task',
                owner: 'me',
                updated: '2026-01-01',
                profile: 'strict',
                notes: ''
            },
            blocking_reasons: [{
                reason_code: 'TIMELINE_INCOMPLETE',
                description: 'Missing 2 events',
                remediation: 'Re-run gate commands.'
            }],
            missing_events: ['COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED'],
            failed_gates: [],
            timeline_status: 'PRESENT',
            related_locks: [{
                lock_name: '.T-020.lock',
                lock_path: '/tmp/test/runtime/task-events/.T-020.lock',
                scope: 'task' as const,
                task_id: 'T-020',
                status: 'STALE' as const,
                age_ms: 1200,
                owner_pid: 999999,
                owner_hostname: 'stale-host',
                owner_created_at_utc: '2026-03-30T10:00:00.000Z',
                owner_alive: false,
                owner_metadata_status: 'ok',
                stale_reason: 'owner_dead',
                remediation: 'Run doctor cleanup.'
            }]
        }],
        lock_observations: [{
            lock_name: '.T-020.lock',
            lock_path: '/tmp/test/runtime/task-events/.T-020.lock',
            scope: 'task' as const,
            task_id: 'T-020',
            status: 'STALE' as const,
            age_ms: 1200,
            owner_pid: 999999,
            owner_hostname: 'stale-host',
            owner_created_at_utc: '2026-03-30T10:00:00.000Z',
            owner_alive: false,
            owner_metadata_status: 'ok',
            stale_reason: 'owner_dead',
            remediation: 'Run doctor cleanup.'
        }],
        summary_lines: ['In-progress tasks with gate issues: 1']
    };

    const output = formatWhyBlockedResult(result);
    assert.ok(output.includes('Task-Event Locks'));
    assert.ok(output.includes('STALLED: T-020'));
    assert.ok(output.includes('Related locks: .T-020.lock:STALE'));
    assert.ok(output.includes('COMPILE_GATE_PASSED'));
    assert.ok(output.includes('REVIEW_PHASE_STARTED'));
    assert.ok(output.includes('[TIMELINE_INCOMPLETE]'));
});
