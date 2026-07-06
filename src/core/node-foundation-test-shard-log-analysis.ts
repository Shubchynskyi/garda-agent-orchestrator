import {
    formatNodeFoundationTestMarker,
    NODE_FOUNDATION_TEST_MARKERS
} from './node-foundation-test-shard-markers';

export function getLastNodeTestSummaryCount(content: string, label: 'fail' | 'cancelled'): number | null {
    const regex = new RegExp(`(?:^|\\n)ℹ ${label} (\\d+)(?:\\r?\\n|$)`, 'gu');
    let lastCount: number | null = null;
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(content)) !== null) {
        lastCount = Number(match[1]);
    }
    return lastCount;
}

export function hasGreenNodeTestSummaryContent(content: string): boolean {
    const lastFailCount = getLastNodeTestSummaryCount(content, 'fail');
    const lastCancelledCount = getLastNodeTestSummaryCount(content, 'cancelled');
    return lastFailCount === 0 && lastCancelledCount === 0;
}

export function extractFailingNodeTestLines(content: string): string[] {
    const lines = content.split(/\r?\n/u);
    const failing: string[] = [];
    let inFailingSection = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^✖ failing tests:/u.test(trimmed)) {
            inFailingSection = true;
            continue;
        }
        if (inFailingSection) {
            if (/^ℹ /u.test(trimmed) || trimmed.length === 0) {
                inFailingSection = false;
                continue;
            }
            if (trimmed.startsWith('✖ ')) {
                failing.push(trimmed);
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
        ? getTailLines(logContent, 40)
        : getTailLines(logContent, 120).filter((line) => (
            line.includes('✖')
            || /AssertionError|Expected|actual|not equal|fail/u.test(line)
        ));
    const tailLines = diagnosticTailLines.length > 0 ? diagnosticTailLines : getTailLines(logContent, 40);
    for (const line of tailLines) {
        diagnostics.push(formatNodeFoundationTestMarker(
            NODE_FOUNDATION_TEST_MARKERS.SHARD_FAILURE_TAIL,
            `${shardLabel} ${line}`
        ));
    }
    return diagnostics;
}
