import test from 'node:test';
import assert from 'node:assert/strict';

import {
    formatNodeFoundationTestMarker,
    isNodeFoundationTestShardDiagnosticLine,
    isNodeFoundationTestShardSetupLine,
    NODE_FOUNDATION_TEST_MARKERS,
    parseNodeFoundationTestShardDoneLine,
    parseNodeFoundationTestShardLogDirLine,
    parseNodeFoundationTestShardLogLine
} from '../../../src/core/node-foundation-test-shard-markers';

test('node foundation shard marker formatter preserves legacy stdout shape', () => {
    assert.equal(
        formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.SHARD_DONE, '1/2 exit=1 duration_ms=10 timed_out=false log=shard.log'),
        'NODE_FOUNDATION_TEST_SHARD_DONE 1/2 exit=1 duration_ms=10 timed_out=false log=shard.log'
    );
    assert.equal(
        formatNodeFoundationTestMarker(NODE_FOUNDATION_TEST_MARKERS.SHARD_SLOWEST, 'none'),
        'NODE_FOUNDATION_TEST_SLOWEST none'
    );
});

test('node foundation shard marker parser accepts legacy log declarations', () => {
    assert.equal(
        parseNodeFoundationTestShardLogDirLine('NODE_FOUNDATION_TEST_SHARD_LOG_DIR .node-build/test-shard-logs/run-1'),
        '.node-build/test-shard-logs/run-1'
    );

    const logLine = parseNodeFoundationTestShardLogLine('NODE_FOUNDATION_TEST_SHARD_LOG 2/3 .node-build/logs/shard.log');
    assert.deepEqual(logLine, {
        shard: {
            shard_index: 2,
            shard_count: 3,
            label: '2/3'
        },
        log_path: '.node-build/logs/shard.log'
    });

    const doneLine = parseNodeFoundationTestShardDoneLine(
        'NODE_FOUNDATION_TEST_SHARD_DONE 2/3 exit=1 duration_ms=10 timed_out=true signal=none log=.node-build/logs/shard.log'
    );
    assert.deepEqual(doneLine, {
        shard: {
            shard_index: 2,
            shard_count: 3,
            label: '2/3'
        },
        exit: '1',
        timed_out: true,
        log_path: '.node-build/logs/shard.log'
    });
});

test('node foundation shard marker parser rejects malformed marker output', () => {
    assert.equal(parseNodeFoundationTestShardLogLine('NODE_FOUNDATION_TEST_SHARD_LOG two/3 shard.log'), null);
    assert.equal(parseNodeFoundationTestShardLogLine('NODE_FOUNDATION_TEST_SHARD_LOG 1/0 shard.log'), null);
    assert.equal(parseNodeFoundationTestShardDoneLine('NODE_FOUNDATION_TEST_SHARD_DONE 1/2 duration_ms=10 log=shard.log'), null);
    assert.equal(parseNodeFoundationTestShardLogDirLine('NODE_FOUNDATION_TEST_SHARD_LOG_DIR'), null);
});

test('node foundation shard marker predicates identify setup and diagnostics lines', () => {
    assert.equal(isNodeFoundationTestShardSetupLine('NODE_FOUNDATION_TEST_DURATION_TELEMETRY telemetry.json'), true);
    assert.equal(isNodeFoundationTestShardSetupLine('NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=1'), true);
    assert.equal(isNodeFoundationTestShardSetupLine('not ok 1 - child output started'), false);

    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1/2 pid=100'), true);
    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_LOG 1/2 shard.log'), true);
    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_PLAN source=duration'), false);
});
