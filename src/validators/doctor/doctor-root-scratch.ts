import * as fs from 'node:fs';
import * as path from 'node:path';

export const FORBIDDEN_ROOT_REVIEW_SCRATCH_FILES = Object.freeze([
    'review.md',
    'review-output.md',
    'temp-review.md'
]);

export interface RootScratchArtifactEntry {
    path: string;
    name: string;
    expected_name: string;
    kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface RootScratchArtifactEvidence {
    passed: boolean;
    checked_root: string;
    forbidden_names: readonly string[];
    found: RootScratchArtifactEntry[];
    violations: string[];
}

function normalizePathForEvidence(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function entryKind(entry: fs.Dirent): RootScratchArtifactEntry['kind'] {
    if (entry.isFile()) {
        return 'file';
    }
    if (entry.isDirectory()) {
        return 'directory';
    }
    if (entry.isSymbolicLink()) {
        return 'symlink';
    }
    return 'other';
}

export function checkRootScratchArtifacts(targetRoot: string): RootScratchArtifactEvidence {
    const checkedRoot = path.resolve(targetRoot);
    const found: RootScratchArtifactEntry[] = [];
    let entries: fs.Dirent[] = [];

    try {
        entries = fs.readdirSync(checkedRoot, { withFileTypes: true });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            passed: false,
            checked_root: normalizePathForEvidence(checkedRoot),
            forbidden_names: FORBIDDEN_ROOT_REVIEW_SCRATCH_FILES,
            found,
            violations: [`Unable to inspect repository root scratch artifacts: ${message}`]
        };
    }

    const entriesByLowerName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
    for (const expectedName of FORBIDDEN_ROOT_REVIEW_SCRATCH_FILES) {
        const entry = entriesByLowerName.get(expectedName.toLowerCase());
        if (!entry) {
            continue;
        }
        found.push({
            path: normalizePathForEvidence(path.join(checkedRoot, entry.name)),
            name: entry.name,
            expected_name: expectedName,
            kind: entryKind(entry)
        });
    }

    const violations = found.map((entry) => (
        `Forbidden reviewer scratch artifact found at repository root: ${entry.name}. ` +
        'Reviewer outputs must be recorded through runtime/tmp/reviews/<task-id>/<review-type>/review-output.md ' +
        'or runtime/reviews artifacts, not ad-hoc root files.'
    ));

    return {
        passed: violations.length === 0,
        checked_root: normalizePathForEvidence(checkedRoot),
        forbidden_names: FORBIDDEN_ROOT_REVIEW_SCRATCH_FILES,
        found,
        violations
    };
}
