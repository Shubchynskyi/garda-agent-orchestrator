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
import {
    buildNodeFoundationShardFailureDiagnostics,
    extractFailingNodeTestLines,
    getLastNodeTestSummaryCount,
    hasGreenNodeTestSummaryContent
} from '../../../src/core/node-foundation-test-shard-log-analysis';

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
    assert.equal(
        isNodeFoundationTestShardSetupLine(
            'NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED reason=partial_test_selection option=--test-name-pattern'
        ),
        true
    );
    assert.equal(isNodeFoundationTestShardSetupLine('NODE_FOUNDATION_TEST_SHARD_RUNTIME timeout_ms=1'), true);
    assert.equal(isNodeFoundationTestShardSetupLine('NODE_FOUNDATION_TEST_SHARD_COMPARISON current_estimated_wall_ms=1'), true);
    assert.equal(isNodeFoundationTestShardSetupLine('not ok 1 - child output started'), false);

    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_TIMEOUT 1/2 pid=100'), true);
    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_LOG 1/2 shard.log'), true);
    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_PLAN source=duration'), false);
    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_FAILURE_SUMMARY 1/1 exit=1 fail=1 log=shard.log'), true);
    assert.equal(isNodeFoundationTestShardDiagnosticLine('NODE_FOUNDATION_TEST_SHARD_FAILURE_TEST 1/1 ✖ tests/node/example.test.ts'), true);
});

test('node foundation shard log analysis extracts failing tests and builds diagnostics', () => {
    const logContent = [
        'ok 1 - passing test',
        '✖ failing tests:',
        '✖ tests/node/reports/local-ui-server-actions.test.ts',
        'ℹ tests 2',
        'ℹ pass 1',
        'ℹ fail 1',
        'ℹ cancelled 0'
    ].join('\n');

    assert.equal(getLastNodeTestSummaryCount(logContent, 'fail'), 1);
    assert.equal(hasGreenNodeTestSummaryContent(logContent), false);
    assert.deepEqual(extractFailingNodeTestLines(logContent), [
        '✖ tests/node/reports/local-ui-server-actions.test.ts'
    ]);

    const diagnostics = buildNodeFoundationShardFailureDiagnostics({
        shardLabel: '1/1',
        exitCode: 1,
        logPath: '.node-build/test-shard-logs/run-1/shard-01-of-01.log',
        logContent
    });
    assert.ok(diagnostics.some((line) => line.includes('NODE_FOUNDATION_TEST_SHARD_FAILURE_SUMMARY 1/1 exit=1 fail=1')));
    assert.ok(diagnostics.some((line) =>
        line.includes('NODE_FOUNDATION_TEST_SHARD_FAILURE_TEST 1/1 ✖ tests/node/reports/local-ui-server-actions.test.ts')
    ));
});

test('node foundation shard log analysis treats green summaries as non-failure diagnostics', () => {
    const logContent = [
        'ok 1 - apparent pass',
        'ℹ tests 1',
        'ℹ pass 1',
        'ℹ fail 0',
        'ℹ cancelled 0'
    ].join('\n');

    assert.equal(hasGreenNodeTestSummaryContent(logContent), true);
    assert.deepEqual(extractFailingNodeTestLines(logContent), []);
});

test('node foundation shard log analysis parses TAP reporter summaries and not ok lines', () => {
    const logContent = [
        '# Subtest: local UI idle expiry closes the server without browser heartbeat',
        'not ok 412 - local UI idle expiry closes the server without browser heartbeat',
        '  ---',
        '  duration_ms: 5012.4',
        '  error: \'server did not close after idle expiry\'',
        '  ...',
        '1..1803',
        '# tests 2058',
        '# suites 58',
        '# pass 2057',
        '# fail 1',
        '# cancelled 0'
    ].join('\n');

    assert.equal(getLastNodeTestSummaryCount(logContent, 'fail'), 1);
    assert.equal(getLastNodeTestSummaryCount(logContent, 'pass'), 2057);
    assert.equal(hasGreenNodeTestSummaryContent(logContent), false);
    assert.deepEqual(extractFailingNodeTestLines(logContent), [
        'not ok - local UI idle expiry closes the server without browser heartbeat'
    ]);

    const diagnostics = buildNodeFoundationShardFailureDiagnostics({
        shardLabel: '1/1',
        exitCode: 1,
        logPath: '.node-build/test-shard-logs/run-2422/shard-01-of-01.log',
        logContent
    });
    assert.ok(diagnostics.some((line) => line.includes('NODE_FOUNDATION_TEST_SHARD_FAILURE_SUMMARY 1/1 exit=1 fail=1')));
    assert.ok(diagnostics.some((line) =>
        line.includes('NODE_FOUNDATION_TEST_SHARD_FAILURE_TEST 1/1 not ok - local UI idle expiry closes the server without browser heartbeat')
    ));
    assert.ok(diagnostics.some((line) => line.includes('NODE_FOUNDATION_TEST_SHARD_FAILURE_TAIL 1/1 not ok 412')));
});
