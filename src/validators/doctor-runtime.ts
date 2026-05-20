import { NODE_ENGINE_RANGE } from '../core/constants';

export interface RuntimeMismatchEvidence {
    passed: boolean;
    current_node_version: string;
    required_range: string;
    violations: string[];
    warnings?: string[];
}

export interface RuntimeMismatchCheckOptions {
    currentVersion?: string;
    requiredRange?: string;
}

/**
 * Parse the small npm-engine subset this runtime publishes and test whether
 * the running Node.js version satisfies it. Handles `>=X.Y.Z`, `^X.Y.Z`, OR
 * ranges separated by `||`, optional `v` prefixes, and missing minor/patch.
 */
interface ParsedNodeVersion {
    major: number;
    minor: number;
    patch: number;
}

function parseNodeVersion(value: string): ParsedNodeVersion | null {
    const versionMatch = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!versionMatch) {
        return null;
    }
    return {
        major: Number(versionMatch[1]),
        minor: versionMatch[2] !== undefined ? Number(versionMatch[2]) : 0,
        patch: versionMatch[3] !== undefined ? Number(versionMatch[3]) : 0
    };
}

function compareNodeVersions(left: ParsedNodeVersion, right: ParsedNodeVersion): number {
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    return left.patch - right.patch;
}

function satisfiesComparator(current: ParsedNodeVersion, comparator: string): boolean | null {
    const normalized = comparator.trim();
    if (normalized.startsWith('>=')) {
        const minimum = parseNodeVersion(normalized.slice(2).trim());
        return minimum ? compareNodeVersions(current, minimum) >= 0 : null;
    }

    if (normalized.startsWith('^')) {
        const minimum = parseNodeVersion(normalized.slice(1).trim());
        if (!minimum) return null;
        const upperBound = { major: minimum.major + 1, minor: 0, patch: 0 };
        return compareNodeVersions(current, minimum) >= 0 && compareNodeVersions(current, upperBound) < 0;
    }

    return null;
}

export function nodeVersionSatisfiesRange(currentVersion: string, requiredRange: string): boolean | null {
    const parsedCurrent = parseNodeVersion(currentVersion);
    if (!parsedCurrent) {
        return null;
    }

    return parsedNodeVersionSatisfiesRange(parsedCurrent, requiredRange);
}

function parsedNodeVersionSatisfiesRange(parsedCurrent: ParsedNodeVersion, requiredRange: string): boolean | null {
    const comparators = requiredRange.split('||').map((item) => item.trim()).filter(Boolean);
    if (comparators.length === 0) {
        return null;
    }

    for (const comparator of comparators) {
        const result = satisfiesComparator(parsedCurrent, comparator);
        if (result === null) {
            return null;
        }
        if (result) {
            return true;
        }
    }

    return false;
}

export function checkRuntimeMismatch(options?: RuntimeMismatchCheckOptions): RuntimeMismatchEvidence {
    const currentVersion = options?.currentVersion || process.version;
    const requiredRange = options?.requiredRange || NODE_ENGINE_RANGE;
    const violations: string[] = [];
    const warnings: string[] = [];

    const parsedCurrent = parseNodeVersion(currentVersion);
    if (!parsedCurrent) {
        violations.push('Unable to parse current Node.js version: ' + currentVersion);
        return { passed: false, current_node_version: currentVersion, required_range: requiredRange, violations, warnings };
    }

    const satisfies = parsedNodeVersionSatisfiesRange(parsedCurrent, requiredRange);
    if (satisfies === null) {
        violations.push('Unable to parse engine range: ' + requiredRange);
        return { passed: false, current_node_version: currentVersion, required_range: requiredRange, violations, warnings };
    }

    if (!satisfies) {
        warnings.push(
            'Node.js ' + currentVersion + ' is outside the tested support matrix ' + requiredRange +
            '. Execution is allowed, but this runtime is not covered by CI or release validation.'
        );
    }

    return {
        passed: violations.length === 0,
        current_node_version: currentVersion,
        required_range: requiredRange,
        violations,
        warnings
    };
}
