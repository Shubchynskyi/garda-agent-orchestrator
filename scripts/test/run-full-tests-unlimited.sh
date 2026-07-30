#!/usr/bin/env bash

set -uo pipefail

# Requested base shard count; the scheduler may add isolated and serial shards.
SHARD_COUNT=2
# Maximum number of shard processes running at the same time.
SHARD_CONCURRENCY=2
# Maximum node:test file workers inside each shard process.
# Two shards therefore use at most 16 file workers instead of 48 on this host.
NODE_TEST_CONCURRENCY=8

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "Unable to locate the repository root from: $SCRIPT_DIR" >&2
    exit 2
fi
REPO_ROOT="$(cd -- "$REPO_ROOT" && pwd)"
RUN_ID="$(date +'%Y%m%d-%H%M%S')"
RUN_ROOT="$REPO_ROOT/garda-agent-orchestrator/runtime/tmp/full-test-runs/$RUN_ID"
SHARD_LOG_DIR="$RUN_ROOT/shards"
MAIN_LOG="$RUN_ROOT/full-suite.log"
FAILED_TESTS_FILE="$RUN_ROOT/failed-tests.txt"
FAILED_SHARDS_FILE="$RUN_ROOT/failed-shards.txt"
COMPILED_RUNNER="$REPO_ROOT/.scripts-build/scripts/node-foundation/test.js"

mkdir -p "$SHARD_LOG_DIR"
cd "$REPO_ROOT"

if [[ ! -f "$COMPILED_RUNNER" ]]; then
    {
        echo "Compiled test runner not found: $COMPILED_RUNNER"
        echo "Run 'npm run build:scripts' once, then rerun this script."
    } | tee "$MAIN_LOG"
    exit 2
fi

export GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS=0

TEST_STARTED_AT_EPOCH_SECONDS="$(date +%s)"

node "$COMPILED_RUNNER" \
    --garda-shards "$SHARD_COUNT" \
    --garda-shard-concurrency "$SHARD_CONCURRENCY" \
    --garda-shard-log-dir "$SHARD_LOG_DIR" \
    --test-concurrency "$NODE_TEST_CONCURRENCY" \
    tests/node/core \
    tests/node/gate-runtime \
    tests/node/schemas \
    tests/node/validators \
    tests/node/repo \
    tests/node/reports \
    tests/node/compat \
    tests/node/policy \
    tests/node/runtime \
    tests/node/gates \
    tests/node/cli \
    tests/node/lifecycle \
    tests/node/bin \
    tests/node/materialization \
    2>&1 | tee "$MAIN_LOG"

TEST_EXIT_CODE="${PIPESTATUS[0]}"
TEST_FINISHED_AT_EPOCH_SECONDS="$(date +%s)"
TOTAL_DURATION_SECONDS="$((TEST_FINISHED_AT_EPOCH_SECONDS - TEST_STARTED_AT_EPOCH_SECONDS))"
printf -v TOTAL_DURATION_HMS '%02d:%02d:%02d' \
    "$((TOTAL_DURATION_SECONDS / 3600))" \
    "$(((TOTAL_DURATION_SECONDS % 3600) / 60))" \
    "$((TOTAL_DURATION_SECONDS % 60))"
unset GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS

shopt -s nullglob
SHARD_LOG_FILES=("$SHARD_LOG_DIR"/shard-*-of-*.log)
shopt -u nullglob
EXECUTED_SHARD_COUNT="${#SHARD_LOG_FILES[@]}"

while IFS= read -r failureSummary; do
    shardFraction="${failureSummary%% *}"
    shardNumber="${shardFraction%%/*}"
    shardTotal="${shardFraction##*/}"
    printf -v expectedShardLogName 'shard-%02d-of-%02d.log' "$shardNumber" "$shardTotal"
    if [[ -f "$SHARD_LOG_DIR/$expectedShardLogName" ]]; then
        printf '%s\n' "$failureSummary"
    fi
done < <(
    grep -E '^NODE_FOUNDATION_TEST_SHARD_FAILURE_SUMMARY[[:space:]]+' "$MAIN_LOG" \
        | sed -E 's/^NODE_FOUNDATION_TEST_SHARD_FAILURE_SUMMARY[[:space:]]+//' || true
) | sort -u > "$FAILED_SHARDS_FILE"

while IFS= read -r failureSummary; do
    shardFraction="${failureSummary%% *}"
    shardNumber="${shardFraction%%/*}"
    shardTotal="${shardFraction##*/}"
    printf -v shardLogName 'shard-%02d-of-%02d.log' "$shardNumber" "$shardTotal"
    awk -v shard="$shardLogName" '
        /^✖ failing tests:$/ {
            delete locations
            delete testNames
            failureCount = 0
            captureFailures = 1
            next
        }
        captureFailures && /^test at / {
            location = $0
            sub(/^test at /, "", location)
            while ((getline testLine) > 0 && testLine == "") {
            }
            if (testLine ~ /^✖ /) {
                sub(/^✖ /, "", testLine)
                sub(/ \([0-9.]+ms\)$/, "", testLine)
                failureCount += 1
                locations[failureCount] = location
                testNames[failureCount] = testLine
            }
        }
        END {
            for (failureIndex = 1; failureIndex <= failureCount; failureIndex += 1) {
                printf "%s\t%s\t%s\n", shard, locations[failureIndex], testNames[failureIndex]
            }
        }
    ' "$SHARD_LOG_DIR/$shardLogName"
done < "$FAILED_SHARDS_FILE" | sort -u > "$FAILED_TESTS_FILE"

{
    echo
    echo '================================================================'
    echo 'FINAL TEST RESULT'
    echo '================================================================'
    if [[ "$TEST_EXIT_CODE" -eq 0 ]]; then
        echo 'Status: PASSED'
    else
        echo 'Status: FAILED'
    fi
    echo "ExitCode: $TEST_EXIT_CODE"
    echo "ConfiguredShardCount: $SHARD_COUNT"
    echo "ShardConcurrency: $SHARD_CONCURRENCY"
    echo "NodeTestConcurrencyPerShard: $NODE_TEST_CONCURRENCY"
    echo "ExecutedShards: $EXECUTED_SHARD_COUNT"
    echo "DurationSeconds: $TOTAL_DURATION_SECONDS"
    echo "Duration: $TOTAL_DURATION_HMS"
    echo "MainLog: $MAIN_LOG"
    echo "ShardLogs: $SHARD_LOG_DIR"
    echo
    echo 'FAILED TESTS'
    echo '----------------------------------------------------------------'
    if [[ -s "$FAILED_TESTS_FILE" ]]; then
        cat "$FAILED_TESTS_FILE"
    elif [[ "$TEST_EXIT_CODE" -eq 0 ]]; then
        echo 'NONE'
    else
        echo 'No named test was extracted; inspect FAILED SHARDS below.'
    fi
    echo
    echo 'FAILED SHARDS / INFRASTRUCTURE FAILURES'
    echo '----------------------------------------------------------------'
    if [[ -s "$FAILED_SHARDS_FILE" ]]; then
        cat "$FAILED_SHARDS_FILE"
    else
        echo 'NONE'
    fi
    echo '================================================================'
} | tee -a "$MAIN_LOG"

echo
echo "Full log: $MAIN_LOG"
echo "Shard logs: $SHARD_LOG_DIR"
echo "Failed tests: $FAILED_TESTS_FILE"
echo "Executed shards: $EXECUTED_SHARD_COUNT"
echo "Node test concurrency per shard: $NODE_TEST_CONCURRENCY"
echo "Duration: $TOTAL_DURATION_HMS ($TOTAL_DURATION_SECONDS seconds)"
echo "Exit code: $TEST_EXIT_CODE"

exit "$TEST_EXIT_CODE"
