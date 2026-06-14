export const NODE_FOUNDATION_TEST_MARKERS = {
    DURATION_TELEMETRY: 'NODE_FOUNDATION_TEST_DURATION_TELEMETRY',
    DURATION_TELEMETRY_UPDATED: 'NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATED',
    SHARD_PLAN: 'NODE_FOUNDATION_TEST_SHARD_PLAN',
    SHARD_SLOWEST: 'NODE_FOUNDATION_TEST_SLOWEST',
    SHARD_LOG_DIR: 'NODE_FOUNDATION_TEST_SHARD_LOG_DIR',
    SHARD_RUNTIME: 'NODE_FOUNDATION_TEST_SHARD_RUNTIME',
    SHARD_START: 'NODE_FOUNDATION_TEST_SHARD_START',
    SHARD_LOG: 'NODE_FOUNDATION_TEST_SHARD_LOG',
    SHARD_DONE: 'NODE_FOUNDATION_TEST_SHARD_DONE',
    SHARD_CLEANUP_GRACE_EXPIRED: 'NODE_FOUNDATION_TEST_SHARD_CLEANUP_GRACE_EXPIRED',
    SHARD_TIMEOUT: 'NODE_FOUNDATION_TEST_SHARD_TIMEOUT',
    SHARD_HEARTBEAT: 'NODE_FOUNDATION_TEST_SHARD_HEARTBEAT',
    SHARD_GREEN_EXIT_MISMATCH: 'NODE_FOUNDATION_TEST_SHARD_GREEN_EXIT_MISMATCH',
    SHARD_GREEN_EXIT_TAIL: 'NODE_FOUNDATION_TEST_SHARD_GREEN_EXIT_TAIL',
    SHARD_ISOLATION_FAIL: 'NODE_FOUNDATION_TEST_SHARD_ISOLATION_FAIL',
    SHARD_ISOLATION_TAIL: 'NODE_FOUNDATION_TEST_SHARD_ISOLATION_TAIL',
    SHARD_ISOLATION_NO_REPRO: 'NODE_FOUNDATION_TEST_SHARD_ISOLATION_NO_REPRO',
    SHARD_ISOLATION_CAPPED: 'NODE_FOUNDATION_TEST_SHARD_ISOLATION_CAPPED'
} as const;

export type NodeFoundationTestMarker =
    typeof NODE_FOUNDATION_TEST_MARKERS[keyof typeof NODE_FOUNDATION_TEST_MARKERS];

export interface NodeFoundationShardLabel {
    readonly shard_index: number;
    readonly shard_count: number;
    readonly label: string;
}

export interface NodeFoundationShardLogLine {
    readonly shard: NodeFoundationShardLabel;
    readonly log_path: string;
}

export interface NodeFoundationShardDoneLine extends NodeFoundationShardLogLine {
    readonly exit: string;
    readonly timed_out: boolean | null;
}

export const NODE_FOUNDATION_TEST_TRUSTED_SHARD_SETUP_MARKERS: readonly NodeFoundationTestMarker[] = [
    NODE_FOUNDATION_TEST_MARKERS.DURATION_TELEMETRY,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_RUNTIME,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_START
];

export const NODE_FOUNDATION_TEST_SHARD_DIAGNOSTIC_MARKERS: readonly NodeFoundationTestMarker[] = [
    NODE_FOUNDATION_TEST_MARKERS.SHARD_DONE,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_TIMEOUT,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_CLEANUP_GRACE_EXPIRED,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_LOG,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_GREEN_EXIT_MISMATCH,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_GREEN_EXIT_TAIL,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_FAIL,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_TAIL,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_NO_REPRO,
    NODE_FOUNDATION_TEST_MARKERS.SHARD_ISOLATION_CAPPED
];

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatNodeFoundationTestMarker(marker: NodeFoundationTestMarker, fields = ''): string {
    const trimmedFields = fields.trim();
    return trimmedFields ? `${marker} ${trimmedFields}` : marker;
}

export function nodeFoundationTestMarkerPattern(
    marker: NodeFoundationTestMarker,
    suffixPattern = '.*'
): RegExp {
    return new RegExp(`^${escapeRegExp(marker)}(?:\\s+${suffixPattern})?$`, 'u');
}

function nodeFoundationTestMarkerPayloadPattern(
    marker: NodeFoundationTestMarker,
    suffixPattern: string
): RegExp {
    return new RegExp(`^${escapeRegExp(marker)}\\s+${suffixPattern}$`, 'u');
}

export function nodeFoundationTestMarkerWordPattern(marker: NodeFoundationTestMarker): RegExp {
    return new RegExp(`\\b${escapeRegExp(marker)}\\b`, 'u');
}

export function lineHasNodeFoundationTestMarker(line: string, marker: NodeFoundationTestMarker): boolean {
    return nodeFoundationTestMarkerWordPattern(marker).test(line);
}

export function isNodeFoundationTestShardSetupLine(line: string): boolean {
    return NODE_FOUNDATION_TEST_TRUSTED_SHARD_SETUP_MARKERS.some((marker) => (
        nodeFoundationTestMarkerPattern(marker).test(line)
    ));
}

export function isNodeFoundationTestShardDiagnosticLine(line: string): boolean {
    return NODE_FOUNDATION_TEST_SHARD_DIAGNOSTIC_MARKERS.some((marker) => (
        lineHasNodeFoundationTestMarker(line, marker)
    ));
}

export function parseNodeFoundationTestShardLogDirLine(line: string): string | null {
    const match = line.match(nodeFoundationTestMarkerPayloadPattern(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_LOG_DIR,
        '(.+)'
    ));
    return match && typeof match[1] === 'string' ? match[1] : null;
}

function parseShardLabel(rawLabel: string): NodeFoundationShardLabel | null {
    const match = rawLabel.match(/^(\d+)\/(\d+)$/u);
    if (!match || typeof match[1] !== 'string' || typeof match[2] !== 'string') {
        return null;
    }
    const shardIndex = Number.parseInt(match[1], 10);
    const shardCount = Number.parseInt(match[2], 10);
    if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardIndex < 1 || shardCount < 1) {
        return null;
    }
    return {
        shard_index: shardIndex,
        shard_count: shardCount,
        label: rawLabel
    };
}

export function parseNodeFoundationTestShardLogLine(line: string): NodeFoundationShardLogLine | null {
    const match = line.match(nodeFoundationTestMarkerPayloadPattern(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_LOG,
        '(\\d+\\/\\d+)\\s+(.+)'
    ));
    if (
        !match
        || typeof match[1] !== 'string'
        || typeof match[2] !== 'string'
    ) {
        return null;
    }
    const shard = parseShardLabel(match[1]);
    if (!shard) {
        return null;
    }
    return {
        shard,
        log_path: match[2]
    };
}

export function parseNodeFoundationTestShardDoneLine(line: string): NodeFoundationShardDoneLine | null {
    const match = line.match(nodeFoundationTestMarkerPayloadPattern(
        NODE_FOUNDATION_TEST_MARKERS.SHARD_DONE,
        '(\\d+\\/\\d+)\\s+exit=(\\S+).*\\slog=(.+)'
    ));
    if (
        !match
        || typeof match[1] !== 'string'
        || typeof match[2] !== 'string'
        || typeof match[3] !== 'string'
    ) {
        return null;
    }
    const shard = parseShardLabel(match[1]);
    if (!shard) {
        return null;
    }
    const timedOutMatch = line.match(/\btimed_out=(true|false)\b/u);
    return {
        shard,
        exit: match[2],
        timed_out: timedOutMatch ? timedOutMatch[1] === 'true' : null,
        log_path: match[3]
    };
}
