import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    parseTimestamp,
    formatTimestamp,
    auditCommandCompactness,
    auditGateCommand,
    getCommandAuditFromDetails,
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    formatTaskEventsSummaryText,
    getOutputTelemetryFromPayload,
    taskCycleScopeBindingsMatch,
    TaskEventsSummaryResult
} from '../../../../src/gates/task-events-summary';
import { runTaskEventsSummaryCommand } from '../../../../src/cli/commands/gate-flows/task/task-summary-flow';

describe('gates/task-events-summary', () => {
    describe('parseTimestamp', () => {
        it('parses ISO 8601 timestamp', () => {
            const date = parseTimestamp('2024-01-15T10:30:00Z');
            assert.ok(date instanceof Date);
            assert.ok(date.getTime() > 0);
        });
        it('returns epoch for null', () => {
            const date = parseTimestamp(null);
            assert.equal(date.getTime(), 0);
        });
        it('returns epoch for empty string', () => {
            const date = parseTimestamp('');
            assert.equal(date.getTime(), 0);
        });
    });

    describe('formatTimestamp', () => {
        it('formats Date to ISO string', () => {
            const result = formatTimestamp(new Date('2024-01-15T10:30:00Z'));
            assert.ok(result!.includes('2024-01-15'));
        });
        it('formats string timestamp', () => {
            const result = formatTimestamp('2024-01-15T10:30:00Z');
            assert.ok(result!.includes('2024-01-15'));
        });
        it('returns null for null', () => {
            assert.equal(formatTimestamp(null), null);
        });
    });

});
