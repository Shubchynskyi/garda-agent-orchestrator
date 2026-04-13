import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SKILL_TELEMETRY_ACTOR,
    SKILL_TELEMETRY_EVENT_TYPES,
    buildSkillTelemetryDetails,
    emitSkillTelemetryEvent,
    emitSkillSuggestedEvent,
    emitSkillSelectedEvent,
    emitSkillReferenceLoadedEvent
} from '../../../src/runtime/skill-telemetry';

import { inspectTaskEventFile } from '../../../src/gate-runtime/task-events';

// ---- Constants & schema stability ----

test('SKILL_TELEMETRY_EVENT_TYPES exposes exactly three event types', () => {
    const keys = Object.keys(SKILL_TELEMETRY_EVENT_TYPES).sort();
    assert.deepEqual(keys, ['SKILL_REFERENCE_LOADED', 'SKILL_SELECTED', 'SKILL_SUGGESTED']);
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_SUGGESTED, 'SKILL_SUGGESTED');
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_SELECTED, 'SKILL_SELECTED');
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_REFERENCE_LOADED, 'SKILL_REFERENCE_LOADED');
});

test('SKILL_TELEMETRY_EVENT_TYPES is frozen', () => {
    assert.ok(Object.isFrozen(SKILL_TELEMETRY_EVENT_TYPES));
});

test('SKILL_TELEMETRY_ACTOR is skill-telemetry', () => {
    assert.equal(SKILL_TELEMETRY_ACTOR, 'skill-telemetry');
});

// ---- buildSkillTelemetryDetails schema ----

test('buildSkillTelemetryDetails always includes core keys', () => {
    const details = buildSkillTelemetryDetails({});
    assert.equal(details.telemetry_type, 'skill_activation');
    assert.equal(details.skill_id, null);
    assert.equal(details.reference_path, null);
    assert.equal(details.trigger_reason, null);
    assert.ok(!('score' in details));
    assert.ok(!('pack_id' in details));
    assert.ok(!('matches' in details));
});

test('buildSkillTelemetryDetails populates optional fields when provided', () => {
    const details = buildSkillTelemetryDetails({
        skillId: 'frontend-react',
        packId: 'frontend-react',
        referencePath: 'live/skills/frontend-react/SKILL.md',
        triggerReason: 'context_match',
        score: 94,
        matches: { stack_signals: ['react'] }
    });
    assert.equal(details.telemetry_type, 'skill_activation');
    assert.equal(details.skill_id, 'frontend-react');
    assert.equal(details.pack_id, 'frontend-react');
    assert.equal(details.reference_path, 'live/skills/frontend-react/SKILL.md');
    assert.equal(details.trigger_reason, 'context_match');
    assert.equal(details.score, 94);
    assert.deepEqual(details.matches, { stack_signals: ['react'] });
});

test('buildSkillTelemetryDetails includes score 0 when explicitly set', () => {
    const details = buildSkillTelemetryDetails({ score: 0 });
    assert.equal(details.score, 0);
});

// ---- emitSkillTelemetryEvent ----

test('emitSkillTelemetryEvent returns null for missing bundleRoot', () => {
    const result = emitSkillTelemetryEvent(null, 'T-TEL', 'SKILL_SUGGESTED', 'msg', {});
    assert.equal(result, null);
});

test('emitSkillTelemetryEvent returns null for missing taskId', () => {
    const result = emitSkillTelemetryEvent('/some/root', '', 'SKILL_SUGGESTED', 'msg', {});
    assert.equal(result, null);
});

test('emitSkillTelemetryEvent does not throw on invalid bundleRoot', () => {
    // Non-blocking: must not throw even if the filesystem path is garbage.
    const result = emitSkillTelemetryEvent(
        'Z:\\nonexistent\\path\\that\\definitely\\does\\not\\exist',
        'T-TEL',
        'SKILL_SUGGESTED',
        'msg',
        { skillId: 'test-skill' }
    );
    assert.equal(result, null);
});

test('emitSkillTelemetryEvent writes valid integrity-chained event', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillTelemetryEvent(
            tempDir,
            'T-TEL-001',
            SKILL_TELEMETRY_EVENT_TYPES.SKILL_SUGGESTED,
            'Skill suggested: frontend-react',
            { skillId: 'frontend-react', triggerReason: 'context_match', score: 94 },
            { passThru: true }
        );

        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-TEL-001.jsonl');
        assert.ok(fs.existsSync(eventFile));

        const result = inspectTaskEventFile(eventFile, 'T-TEL-001');
        assert.equal(result.status, 'PASS');
        assert.equal(result.matching_events, 1);
        assert.equal(result.integrity_event_count, 1);
        assert.equal(result.violations.length, 0);

        const line = fs.readFileSync(eventFile, 'utf8').trim();
        const event = JSON.parse(line);
        assert.equal(event.task_id, 'T-TEL-001');
        assert.equal(event.event_type, 'SKILL_SUGGESTED');
        assert.equal(event.outcome, 'INFO');
        assert.equal(event.actor, SKILL_TELEMETRY_ACTOR);
        assert.equal(event.details.telemetry_type, 'skill_activation');
        assert.equal(event.details.skill_id, 'frontend-react');
        assert.equal(event.details.trigger_reason, 'context_match');
        assert.equal(event.details.score, 94);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('emitSkillTelemetryEvent chains multiple events correctly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillTelemetryEvent(tempDir, 'T-TEL-002', 'SKILL_SUGGESTED', 'first', { skillId: 'a' }, { passThru: true });
        emitSkillTelemetryEvent(tempDir, 'T-TEL-002', 'SKILL_SELECTED', 'second', { skillId: 'a' }, { passThru: true });
        emitSkillTelemetryEvent(tempDir, 'T-TEL-002', 'SKILL_REFERENCE_LOADED', 'third', { referencePath: 'ref.md' }, { passThru: true });

        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-TEL-002.jsonl');
        const result = inspectTaskEventFile(eventFile, 'T-TEL-002');
        assert.equal(result.status, 'PASS');
        assert.equal(result.matching_events, 3);
        assert.equal(result.integrity_event_count, 3);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// ---- Typed emit helpers ----

test('emitSkillSuggestedEvent writes correct event shape', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillSuggestedEvent(
            tempDir,
            'T-TEL-SUG',
            { id: 'node-backend', pack: 'node-backend', score: 80, matches: { stack_signals: ['express'] } },
            'context_match',
            { passThru: true }
        );

        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-TEL-SUG.jsonl');
        const event = JSON.parse(fs.readFileSync(eventFile, 'utf8').trim());
        assert.equal(event.event_type, 'SKILL_SUGGESTED');
        assert.equal(event.details.skill_id, 'node-backend');
        assert.equal(event.details.pack_id, 'node-backend');
        assert.equal(event.details.trigger_reason, 'context_match');
        assert.equal(event.details.score, 80);
        assert.deepEqual(event.details.matches, { stack_signals: ['express'] });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('emitSkillSelectedEvent writes correct event shape', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillSelectedEvent(
            tempDir,
            'T-TEL-SEL',
            'frontend-react',
            'frontend-react',
            'user_selected',
            { passThru: true }
        );

        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-TEL-SEL.jsonl');
        const event = JSON.parse(fs.readFileSync(eventFile, 'utf8').trim());
        assert.equal(event.event_type, 'SKILL_SELECTED');
        assert.equal(event.details.skill_id, 'frontend-react');
        assert.equal(event.details.pack_id, 'frontend-react');
        assert.equal(event.details.trigger_reason, 'user_selected');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('emitSkillReferenceLoadedEvent writes correct event shape', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillReferenceLoadedEvent(
            tempDir,
            'T-TEL-REF',
            'live/skills/code-review/SKILL.md',
            'code-review',
            'bridge_route',
            { passThru: true }
        );

        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-TEL-REF.jsonl');
        const event = JSON.parse(fs.readFileSync(eventFile, 'utf8').trim());
        assert.equal(event.event_type, 'SKILL_REFERENCE_LOADED');
        assert.equal(event.details.skill_id, 'code-review');
        assert.equal(event.details.reference_path, 'live/skills/code-review/SKILL.md');
        assert.equal(event.details.trigger_reason, 'bridge_route');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('emitSkillReferenceLoadedEvent defaults trigger_reason to bridge_route', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillReferenceLoadedEvent(
            tempDir,
            'T-TEL-DEF',
            'live/references/api-spec.yaml',
            null,
            undefined,
            { passThru: true }
        );

        const eventFile = path.join(tempDir, 'runtime', 'task-events', 'T-TEL-DEF.jsonl');
        const event = JSON.parse(fs.readFileSync(eventFile, 'utf8').trim());
        assert.equal(event.details.trigger_reason, 'bridge_route');
        assert.equal(event.details.skill_id, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// ---- All events land in all-tasks.jsonl aggregate ----

test('skill telemetry events are appended to all-tasks.jsonl', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skill-telemetry-'));
    try {
        emitSkillSuggestedEvent(tempDir, 'T-TEL-AGG', { id: 'a', pack: 'a', score: 50 }, 'test', { passThru: true });
        emitSkillSelectedEvent(tempDir, 'T-TEL-AGG', 'a', 'a', 'test', { passThru: true });

        const allTasksFile = path.join(tempDir, 'runtime', 'task-events', 'all-tasks.jsonl');
        assert.ok(fs.existsSync(allTasksFile));
        const lines = fs.readFileSync(allTasksFile, 'utf8').split('\n').filter((line) => line.trim());
        assert.equal(lines.length, 2);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
