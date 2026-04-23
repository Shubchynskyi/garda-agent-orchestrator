import { NODE_ENGINE_RANGE } from '../core/constants';

export interface RuntimeMismatchEvidence {
    passed: boolean;
    current_node_version: string;
    required_range: string;
    violations: string[];
}

/**
 * Parse a `>=X.Y.Z` range and test whether the running Node.js version
 * satisfies it.  Handles optional `v` prefix and missing minor/patch.
 */
export function checkRuntimeMismatch(): RuntimeMismatchEvidence {
    const currentVersion = process.version;
    const requiredRange = NODE_ENGINE_RANGE;
    const violations: string[] = [];

    const rangeMatch = requiredRange.match(/^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!rangeMatch) {
        violations.push('Unable to parse engine range: ' + requiredRange);
        return { passed: false, current_node_version: currentVersion, required_range: requiredRange, violations };
    }

    const requiredMajor = Number(rangeMatch[1]);
    const requiredMinor = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : 0;
    const requiredPatch = rangeMatch[3] !== undefined ? Number(rangeMatch[3]) : 0;

    const versionMatch = currentVersion.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!versionMatch) {
        violations.push('Unable to parse current Node.js version: ' + currentVersion);
        return { passed: false, current_node_version: currentVersion, required_range: requiredRange, violations };
    }

    const currentMajor = Number(versionMatch[1]);
    const currentMinor = Number(versionMatch[2]);
    const currentPatch = Number(versionMatch[3]);

    const satisfies =
        currentMajor > requiredMajor ||
        (currentMajor === requiredMajor && currentMinor > requiredMinor) ||
        (currentMajor === requiredMajor && currentMinor === requiredMinor && currentPatch >= requiredPatch);

    if (!satisfies) {
        violations.push(
            'Node.js ' + currentVersion + ' does not satisfy required range ' + requiredRange +
            '. Upgrade to ' + NODE_ENGINE_RANGE + ' or later.'
        );
    }

    return {
        passed: violations.length === 0,
        current_node_version: currentVersion,
        required_range: requiredRange,
        violations
    };
}
