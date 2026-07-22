import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { readBoundedJsonlTail } from '../../../src/core/bounded-jsonl-tail';

test('readBoundedJsonlTail retains only the newest bounded records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-tail-'));
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(
            filePath,
            Array.from({ length: 8 }, (_, index) => JSON.stringify({ sequence: index + 1 })).join('\n') + '\n',
            'utf8'
        );

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, {
            maxBytes: 1024,
            maxLines: 4,
            maxEvents: 2,
            maxParseAttempts: 3
        });

        assert.deepEqual(result.records.map((event) => event.sequence), [7, 8]);
        assert.equal(result.truncated, true);
        assert.equal(result.invalidJson, false);
        assert.equal(result.retainedLineCount, 4);
        assert.equal(result.parseAttempts, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readBoundedJsonlTail enforces the parse-attempt ceiling independently of the event ceiling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-parse-limit-'));
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(
            filePath,
            Array.from({ length: 6 }, (_, index) => JSON.stringify({ sequence: index + 1 })).join('\n') + '\n',
            'utf8'
        );

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, {
            maxBytes: 1024,
            maxLines: 6,
            maxEvents: 6,
            maxParseAttempts: 2
        });

        assert.deepEqual(result.records.map((event) => event.sequence), [5, 6]);
        assert.equal(result.truncated, true);
        assert.equal(result.invalidJson, false);
        assert.equal(result.parseAttempts, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readBoundedJsonlTail stops at malformed retained JSON instead of scanning unbounded input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bounded-jsonl-invalid-'));
    try {
        const filePath = path.join(root, 'events.jsonl');
        fs.writeFileSync(filePath, '{"sequence":1}\n{"sequence":\n{"sequence":3}\n', 'utf8');

        const result = readBoundedJsonlTail<{ sequence: number }>(filePath, {
            maxBytes: 1024,
            maxLines: 8,
            maxEvents: 8,
            maxParseAttempts: 8
        });

        assert.equal(result.invalidJson, true);
        assert.equal(result.parseAttempts, 2);
        assert.deepEqual(result.records.map((event) => event.sequence), [3]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
