import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    LIFECYCLE_EVENT_TYPES,
    MANDATORY_CODE_CHANGE_EVENTS,
    MANDATORY_NON_CODE_EVENTS,
    getMandatoryEvents,
    validateTimelineCompleteness,
    emitMandatoryCompletionGateEvent,
    emitMandatoryImplementationStartedEvent,
    emitMandatoryPreflightFailedEvent,
    emitMandatoryPreflightStartedEvent,
    emitMandatoryReviewPhaseStartedEvent,
    emitPlanCreatedEvent,
    emitPreflightStartedEvent,
    emitPreflightFailedEvent,
    emitImplementationStartedEvent,
    emitReviewPhaseStartedEvent,
    emitCompletionGateEvent,
    emitStatusChangedEvent,
    emitProviderRoutingEvent
} from '../../../src/gate-runtime/lifecycle-events';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-events-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

describe('gate-runtime/lifecycle-events', () => {

    describe('LIFECYCLE_EVENT_TYPES', () => {
        it('defines all expected event type keys', () => {
            assert.ok(LIFECYCLE_EVENT_TYPES.TASK_MODE_ENTERED);
            assert.ok(LIFECYCLE_EVENT_TYPES.PLAN_CREATED);
            assert.ok(LIFECYCLE_EVENT_TYPES.RULE_PACK_LOADED);
            assert.ok(LIFECYCLE_EVENT_TYPES.PREFLIGHT_STARTED);
            assert.ok(LIFECYCLE_EVENT_TYPES.PREFLIGHT_CLASSIFIED);
            assert.ok(LIFECYCLE_EVENT_TYPES.PREFLIGHT_FAILED);
            assert.ok(LIFECYCLE_EVENT_TYPES.IMPLEMENTATION_STARTED);
            assert.ok(LIFECYCLE_EVENT_TYPES.COMPILE_GATE_PASSED);
            assert.ok(LIFECYCLE_EVENT_TYPES.COMPILE_GATE_FAILED);
            assert.ok(LIFECYCLE_EVENT_TYPES.REVIEW_PHASE_STARTED);
            assert.ok(LIFECYCLE_EVENT_TYPES.REVIEW_GATE_PASSED);
            assert.ok(LIFECYCLE_EVENT_TYPES.REVIEW_GATE_FAILED);
            assert.ok(LIFECYCLE_EVENT_TYPES.DOC_IMPACT_ASSESSED);
            assert.ok(LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_PASSED);
            assert.ok(LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_FAILED);
            assert.ok(LIFECYCLE_EVENT_TYPES.STATUS_CHANGED);
            assert.ok(LIFECYCLE_EVENT_TYPES.PROVIDER_ROUTING_DECISION);
        });

        it('is frozen', () => {
            assert.ok(Object.isFrozen(LIFECYCLE_EVENT_TYPES));
        });
    });

    describe('getMandatoryEvents', () => {
        it('returns code-change mandatory events when codeChanged is true', () => {
            const events = getMandatoryEvents(true);
            assert.deepStrictEqual([...events], [...MANDATORY_CODE_CHANGE_EVENTS]);
            assert.ok(events.includes('PREFLIGHT_CLASSIFIED'));
        });

        it('returns non-code mandatory events when codeChanged is false', () => {
            const events = getMandatoryEvents(false);
            assert.deepStrictEqual([...events], [...MANDATORY_NON_CODE_EVENTS]);
            assert.ok(!events.includes('PREFLIGHT_CLASSIFIED'));
        });

        it('both sets include COMPLETION_GATE_PASSED', () => {
            assert.ok(MANDATORY_CODE_CHANGE_EVENTS.includes('COMPLETION_GATE_PASSED'));
            assert.ok(MANDATORY_NON_CODE_EVENTS.includes('COMPLETION_GATE_PASSED'));
        });
    });

    describe('validateTimelineCompleteness', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = createTempDir();
        });

        afterEach(() => {
            removeTempDir(tempDir);
        });

        it('returns MISSING_TIMELINE for non-existent file', () => {
            const result = validateTimelineCompleteness(
                path.join(tempDir, 'nonexistent.jsonl'),
                'T-TEST',
                false
            );
            assert.equal(result.status, 'MISSING_TIMELINE');
            assert.ok(result.violations.length > 0);
            assert.ok(!result.timeline_exists);
        });

        it('returns COMPLETE when all mandatory events present (non-code)', () => {
            const eventsDir = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const timelinePath = path.join(eventsDir, 'T-TEST.jsonl');

            // Write all mandatory non-code events
            const events = [
                'TASK_MODE_ENTERED',
                'RULE_PACK_LOADED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'COMPLETION_GATE_PASSED'
            ];
            const lines = events.map((et, idx) => JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-TEST',
                event_type: et,
                outcome: 'PASS',
                actor: 'gate',
                message: 'test',
                details: {},
                integrity: { schema_version: 1, task_sequence: idx + 1, prev_event_sha256: null }
            }));
            fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');

            const result = validateTimelineCompleteness(timelinePath, 'T-TEST', false);
            assert.equal(result.status, 'COMPLETE');
            assert.equal(result.events_missing.length, 0);
            assert.ok(result.timeline_exists);
        });

        it('returns INCOMPLETE when missing COMPLETION_GATE_PASSED', () => {
            const eventsDir = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const timelinePath = path.join(eventsDir, 'T-TEST.jsonl');

            const events = [
                'TASK_MODE_ENTERED',
                'RULE_PACK_LOADED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED'
            ];
            const lines = events.map((et, idx) => JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-TEST',
                event_type: et,
                outcome: 'PASS',
                actor: 'gate',
                message: 'test',
                details: {}
            }));
            fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');

            const result = validateTimelineCompleteness(timelinePath, 'T-TEST', false);
            assert.equal(result.status, 'INCOMPLETE');
            assert.ok(result.events_missing.includes('COMPLETION_GATE_PASSED'));
        });

        it('requires code-change lifecycle events for code-changing tasks', () => {
            const eventsDir = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const timelinePath = path.join(eventsDir, 'T-TEST.jsonl');

            const events = [
                'TASK_MODE_ENTERED',
                'RULE_PACK_LOADED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED',
                'COMPLETION_GATE_PASSED'
            ];
            const lines = events.map((et, idx) => JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-TEST',
                event_type: et,
                outcome: 'PASS',
                actor: 'gate',
                message: 'test',
                details: {}
            }));
            fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');

            const result = validateTimelineCompleteness(timelinePath, 'T-TEST', true);
            assert.equal(result.status, 'INCOMPLETE');
            assert.ok(result.events_missing.includes('PREFLIGHT_CLASSIFIED'));
            assert.ok(result.events_missing.includes('IMPLEMENTATION_STARTED'));
        });

        it('accepts REVIEW_GATE_PASSED_WITH_OVERRIDE as satisfying REVIEW_GATE_PASSED', () => {
            const eventsDir = path.join(tempDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const timelinePath = path.join(eventsDir, 'T-TEST.jsonl');

            const events = [
                'TASK_MODE_ENTERED',
                'RULE_PACK_LOADED',
                'COMPILE_GATE_PASSED',
                'REVIEW_PHASE_STARTED',
                'REVIEW_GATE_PASSED_WITH_OVERRIDE',
                'COMPLETION_GATE_PASSED'
            ];
            const lines = events.map((et, idx) => JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-TEST',
                event_type: et,
                outcome: 'PASS',
                actor: 'gate',
                message: 'test',
                details: {}
            }));
            fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');

            const result = validateTimelineCompleteness(timelinePath, 'T-TEST', false);
            assert.equal(result.status, 'COMPLETE');
            assert.ok(result.events_found.includes('REVIEW_GATE_PASSED'));
        });
    });

    describe('stage emit helpers', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = createTempDir();
            fs.mkdirSync(path.join(tempDir, 'runtime', 'task-events'), { recursive: true });
        });

        afterEach(() => {
            removeTempDir(tempDir);
        });

        it('emits plan, preflight, implementation, and review-phase events', () => {
            emitPlanCreatedEvent(tempDir, 'T-STAGE', { task_summary: 'Implement change' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            emitPreflightStartedEvent(tempDir, 'T-STAGE', { task_intent: 'Implement change' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            emitImplementationStartedEvent(tempDir, 'T-STAGE', { preflight_path: '/tmp/preflight.json' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            emitReviewPhaseStartedEvent(tempDir, 'T-STAGE', { review_type: 'code' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-STAGE.jsonl');
            const events = fs.readFileSync(timelinePath, 'utf8')
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as Record<string, unknown>);

            assert.deepEqual(events.map(event => event.event_type), [
                'PLAN_CREATED',
                'PREFLIGHT_STARTED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED'
            ]);
            const planDetails = events[0].details as Record<string, unknown>;
            const reviewDetails = events[3].details as Record<string, unknown>;
            assert.equal(planDetails.task_summary, 'Implement change');
            assert.equal(reviewDetails.review_type, 'code');
        });

        it('emits PREFLIGHT_FAILED with FAIL outcome', () => {
            emitPreflightFailedEvent(tempDir, 'T-STAGE', { error: 'missing scope' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-STAGE.jsonl');
            const event = JSON.parse(fs.readFileSync(timelinePath, 'utf8').trim());
            assert.equal(event.event_type, 'PREFLIGHT_FAILED');
            assert.equal(event.outcome, 'FAIL');
            assert.equal(event.details.error, 'missing scope');
        });

        it('mandatory emit helpers append the same stage events', () => {
            emitMandatoryPreflightStartedEvent(tempDir, 'T-MANDATORY', { task_intent: 'Implement change' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            emitMandatoryPreflightFailedEvent(tempDir, 'T-MANDATORY', { error: 'boom' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            emitMandatoryImplementationStartedEvent(tempDir, 'T-MANDATORY', { preflight_path: '/tmp/preflight.json' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            emitMandatoryReviewPhaseStartedEvent(tempDir, 'T-MANDATORY', { review_type: 'code' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-MANDATORY.jsonl');
            const events = fs.readFileSync(timelinePath, 'utf8')
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as Record<string, unknown>);

            assert.deepEqual(events.map(event => event.event_type), [
                'PREFLIGHT_STARTED',
                'PREFLIGHT_FAILED',
                'IMPLEMENTATION_STARTED',
                'REVIEW_PHASE_STARTED'
            ]);
        });

        it('mandatory emit-once helpers do not duplicate existing stage entries', () => {
            emitMandatoryImplementationStartedEvent(tempDir, 'T-ONCE', { preflight_path: '/tmp/preflight.json' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });
            const secondResult = emitMandatoryImplementationStartedEvent(tempDir, 'T-ONCE', { preflight_path: '/tmp/preflight.json' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-ONCE.jsonl');
            const lines = fs.readFileSync(timelinePath, 'utf8').trim().split('\n');
            assert.equal(lines.length, 1);
            assert.equal(secondResult, null);
        });
    });

    describe('emitCompletionGateEvent', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = createTempDir();
            fs.mkdirSync(path.join(tempDir, 'runtime', 'task-events'), { recursive: true });
        });

        afterEach(() => {
            removeTempDir(tempDir);
        });

        it('emits COMPLETION_GATE_PASSED event on success', () => {
            emitCompletionGateEvent(tempDir, 'T-EMIT-TEST', true, { status: 'PASSED' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-EMIT-TEST.jsonl');
            assert.ok(fs.existsSync(timelinePath), 'Timeline file should exist');

            const content = fs.readFileSync(timelinePath, 'utf8').trim();
            const event = JSON.parse(content);
            assert.equal(event.event_type, 'COMPLETION_GATE_PASSED');
            assert.equal(event.outcome, 'PASS');
            assert.equal(event.task_id, 'T-EMIT-TEST');
        });

        it('emits COMPLETION_GATE_FAILED event on failure', () => {
            emitCompletionGateEvent(tempDir, 'T-EMIT-TEST', false, { status: 'FAILED' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-EMIT-TEST.jsonl');
            const content = fs.readFileSync(timelinePath, 'utf8').trim();
            const event = JSON.parse(content);
            assert.equal(event.event_type, 'COMPLETION_GATE_FAILED');
            assert.equal(event.outcome, 'FAIL');
        });

        it('mandatory completion helper emits completion events too', () => {
            emitMandatoryCompletionGateEvent(tempDir, 'T-EMIT-MANDATORY', true, { status: 'PASSED' }, {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-EMIT-MANDATORY.jsonl');
            const event = JSON.parse(fs.readFileSync(timelinePath, 'utf8').trim());
            assert.equal(event.event_type, 'COMPLETION_GATE_PASSED');
            assert.equal(event.outcome, 'PASS');
        });

        it('returns null for missing repoRoot', () => {
            const result = emitCompletionGateEvent('', 'T-EMIT-TEST', true, {});
            assert.equal(result, null);
        });

        it('returns null for missing taskId', () => {
            const result = emitCompletionGateEvent(tempDir, '', true, {});
            assert.equal(result, null);
        });
    });

    describe('emitStatusChangedEvent', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = createTempDir();
            fs.mkdirSync(path.join(tempDir, 'runtime', 'task-events'), { recursive: true });
        });

        afterEach(() => {
            removeTempDir(tempDir);
        });

        it('emits STATUS_CHANGED event with transition details', () => {
            emitStatusChangedEvent(tempDir, 'T-STATUS', 'TODO', 'IN_PROGRESS', {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-STATUS.jsonl');
            assert.ok(fs.existsSync(timelinePath));

            const content = fs.readFileSync(timelinePath, 'utf8').trim();
            const event = JSON.parse(content);
            assert.equal(event.event_type, 'STATUS_CHANGED');
            assert.equal(event.outcome, 'INFO');
            assert.ok(event.message.includes('TODO'));
            assert.ok(event.message.includes('IN_PROGRESS'));
            assert.equal(event.details.previous_status, 'TODO');
            assert.equal(event.details.new_status, 'IN_PROGRESS');
        });
    });

    describe('emitProviderRoutingEvent', () => {
        let tempDir: string;

        beforeEach(() => {
            tempDir = createTempDir();
            fs.mkdirSync(path.join(tempDir, 'runtime', 'task-events'), { recursive: true });
        });

        afterEach(() => {
            removeTempDir(tempDir);
        });

        it('emits PROVIDER_ROUTING_DECISION event', () => {
            emitProviderRoutingEvent(tempDir, 'T-ROUTE', 'GitHubCopilot', 'orchestration', 'bridge_profile', {
                eventsRoot: path.join(tempDir, 'runtime', 'task-events')
            });

            const timelinePath = path.join(tempDir, 'runtime', 'task-events', 'T-ROUTE.jsonl');
            assert.ok(fs.existsSync(timelinePath));

            const content = fs.readFileSync(timelinePath, 'utf8').trim();
            const event = JSON.parse(content);
            assert.equal(event.event_type, 'PROVIDER_ROUTING_DECISION');
            assert.equal(event.outcome, 'INFO');
            assert.equal(event.details.provider, 'GitHubCopilot');
            assert.equal(event.details.routed_to, 'orchestration');
            assert.equal(event.details.reason, 'bridge_profile');
        });

        it('returns null for missing inputs', () => {
            assert.equal(emitProviderRoutingEvent('', 'T-X', 'p', 'r', 'x'), null);
            assert.equal(emitProviderRoutingEvent(tempDir, '', 'p', 'r', 'x'), null);
        });
    });
});
