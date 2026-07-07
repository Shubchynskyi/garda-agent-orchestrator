import {
    formatNodeFoundationTestMarker,
    NODE_FOUNDATION_TEST_MARKERS
} from './node-foundation-test-shard-markers';

type NodeTestSummaryLabel = 'fail' | 'cancelled' | 'pass' | 'tests';

const NODE_TEST_SUMMARY_LABEL_PATTERNS: Readonly<Record<NodeTestSummaryLabel, readonly RegExp[]>> = {
    fail: [
        /(?:^|\n)ℹ fail (\d+)(?:\r?\n|$)/gu,
        /(?:^|\n)# fail (\d+)(?:\r?\n|$)/gu
    ],
    cancelled: [
        /(?:^|\n)ℹ cancelled (\d+)(?:\r?\n|$)/gu,
        /(?:^|\n)# cancelled (\d+)(?:\r?\n|$)/gu
    ],
    pass: [
        /(?:^|\n)ℹ pass (\d+)(?:\r?\n|$)/gu,
        /(?:^|\n)# pass (\d+)(?:\r?\n|$)/gu
    ],
    tests: [
        /(?:^|\n)ℹ tests (\d+)(?:\r?\n|$)/gu,
        /(?:^|\n)# tests (\d+)(?:\r?\n|$)/gu
    ]
};

export function getLastNodeTestSummaryCount(content: string, label: NodeTestSummaryLabel): number | null {
    let lastCount: number | null = null;
    for (const pattern of NODE_TEST_SUMMARY_LABEL_PATTERNS[label]) {
        let match: RegExpExecArray | null = null;
        while ((match = pattern.exec(content)) !== null) {
            lastCount = Number(match[1]);
        }
    }
    return lastCount;
}

export function hasGreenNodeTestSummaryContent(content: string): boolean {
    const lastFailCount = getLastNodeTestSummaryCount(content, 'fail');
    const lastCancelledCount = getLastNodeTestSummaryCount(content, 'cancelled');
    return lastFailCount === 0 && lastCancelledCount === 0;
}

function pushUniqueFailure(failing: string[], seen: Set<string>, line: string): void {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) {
        return;
    }
    seen.add(normalized);
    failing.push(normalized);
}

export function extractFailingNodeTestLines(content: string): string[] {
    const lines = content.split(/\r?\n/u);
    const failing: string[] = [];
    const seen = new Set<string>();
    let inFailingSection = false;
    let pendingTapSubtest: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        const subtestMatch = trimmed.match(/^# Subtest: (.+)$/u);
        if (subtestMatch) {
            pendingTapSubtest = subtestMatch[1].trim();
            continue;
        }

        const notOkMatch = trimmed.match(/^not ok(?: \d+)?(?: - (.+))?$/u);
        if (notOkMatch) {
            const testName = (notOkMatch[1] || pendingTapSubtest || trimmed).trim();
            pushUniqueFailure(failing, seen, `not ok - ${testName}`);
            pendingTapSubtest = null;
            continue;
        }

        if (/^ok \d+/u.test(trimmed)) {
            pendingTapSubtest = null;
        }

        if (/^✖ failing tests:/u.test(trimmed)) {
            inFailingSection = true;
            continue;
        }
        if (inFailingSection) {
            if (/^[ℹ#] /u.test(trimmed) || trimmed.length === 0) {
                inFailingSection = false;
                continue;
            }
            if (trimmed.startsWith('✖ ')) {
                pushUniqueFailure(failing, seen, trimmed);
            }
        }
    }

    return failing;
}

function getTailLines(text: string, maxLines: number): string[] {
    if (!text) {
        return [];
    }
    return text.split(/\r?\n/u).filter((line) => line.length > 0).slice(-maxLines);
}

function isUsefulFailureTailLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
        return false;
    }
    return trimmed.includes('✖')
        || /^not ok\b/u.test(trimmed)
        || /^# Subtest:/u.test(trimmed)
        || /^(?:error|failureType|code|name|stack):/iu.test(trimmed)
        || /AssertionError|Expected|actual|not equal|fail/u.test(trimmed);
}

export interface NodeFoundationShardFailureDiagnosticInput {
    readonly shardLabel: string;
    readonly exitCode: number;
    readonly logPath: string;
    readonly logContent: string;
}

export function buildNodeFoundationShardFailureDiagnostics(
    input: NodeFoundationShardFailureDiagnosticInput
): string[] {
    const { shardLabel, exitCode, logPath, logContent } = input;
    const failCount = getLastNodeTestSummaryCount(logContent, 'fail');
    const failingTests = extractFailingNodeTestLines(logContent);
    const diagnostics: string[] = [
        formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_FAILURE_SUMMARY,
            `${shardLabel} exit=${exitCode} fail=${failCount ?? 'unknown'} log=${logPath}`
        )
    ];
    for (const line of failingTests) {
        diagnostics.push(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_FAILURE_TEST,
            `${shardLabel} ${line}`
        ));
    }

    const diagnosticTailLines = failingTests.length === 0
        ? getTailLines(logContent, 80).filter(isUsefulFailureTailLine)
        : getTailLines(logContent, 160).filter(isUsefulFailureTailLine);
    const tailLines = diagnosticTailLines.length > 0 ? diagnosticTailLines : getTailLines(logContent, 40);
    for (const line of tailLines) {
        diagnostics.push(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_FAILURE_TAIL,
            `${shardLabel} ${line}`
        ));
    }
    return diagnostics;
}
