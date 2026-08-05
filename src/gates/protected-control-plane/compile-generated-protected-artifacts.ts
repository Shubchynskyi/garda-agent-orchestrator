import * as fs from 'node:fs';
import * as path from 'node:path';

import { fileSha256, toPlainRecord } from '../shared/hashing-metrics';
import { normalizePath } from '../shared/path-utils';
import { isOrchestratorSourceCheckout } from './protected-control-plane';

export const COMPILE_GENERATED_PROTECTED_ARTIFACT_PATHS = Object.freeze([
    'dist/publish-runtime-manifest.json'
]);

export interface CompileGeneratedProtectedArtifactEntry {
    path: string;
    before_sha256: string | null;
    after_sha256: string;
}

export interface CompileGeneratedProtectedArtifactEvidence {
    schema_version: 1;
    producer: 'compile-gate';
    source_checkout: true;
    changed_files: string[];
    entries: CompileGeneratedProtectedArtifactEntry[];
}

export interface CompileGeneratedProtectedArtifactValidation {
    allowed_changed_files: string[];
    entries: CompileGeneratedProtectedArtifactEntry[];
    violations: string[];
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function normalizePathList(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((entry) => normalizePath(entry))
            .filter(Boolean)
    )].sort();
}

function resolveCompileGeneratedProtectedArtifactPath(repoRoot: string, relativePath: string): string {
    return path.join(path.resolve(repoRoot), ...normalizePath(relativePath).split('/'));
}

export function captureCompileGeneratedProtectedArtifactHashes(
    repoRoot: string
): Record<string, string | null> {
    if (!isOrchestratorSourceCheckout(repoRoot)) {
        return {};
    }
    return Object.fromEntries(COMPILE_GENERATED_PROTECTED_ARTIFACT_PATHS.map((relativePath) => {
        const artifactPath = resolveCompileGeneratedProtectedArtifactPath(repoRoot, relativePath);
        const sha256 = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()
            ? fileSha256(artifactPath)
            : null;
        return [relativePath, sha256];
    }));
}

export function buildCompileGeneratedProtectedArtifactEvidence(
    beforeHashes: Record<string, string | null>,
    afterHashes: Record<string, string | null>
): CompileGeneratedProtectedArtifactEvidence | null {
    const entries = COMPILE_GENERATED_PROTECTED_ARTIFACT_PATHS
        .map((relativePath): CompileGeneratedProtectedArtifactEntry | null => {
            const beforeSha256 = normalizeSha256(beforeHashes[relativePath]);
            const afterSha256 = normalizeSha256(afterHashes[relativePath]);
            if (!afterSha256 || beforeSha256 === afterSha256) {
                return null;
            }
            return {
                path: relativePath,
                before_sha256: beforeSha256,
                after_sha256: afterSha256
            };
        })
        .filter((entry): entry is CompileGeneratedProtectedArtifactEntry => entry !== null);
    if (entries.length === 0) {
        return null;
    }
    return {
        schema_version: 1,
        producer: 'compile-gate',
        source_checkout: true,
        changed_files: entries.map((entry) => entry.path),
        entries
    };
}

export function validateCompileGeneratedProtectedArtifactEvidence(options: {
    repoRoot: string;
    compileEvidence: Record<string, unknown> | null;
    taskId: string;
    preflightPath: string;
    preflightSha256: string;
    currentProtectedSnapshot: Record<string, string>;
}): CompileGeneratedProtectedArtifactValidation {
    const rawEvidence = toPlainRecord(options.compileEvidence?.compile_generated_protected_artifacts);
    if (!rawEvidence) {
        return { allowed_changed_files: [], entries: [], violations: [] };
    }
    const violations: string[] = [];
    const compileEvidence = options.compileEvidence || {};
    if (
        String(compileEvidence.status || '').trim().toUpperCase() !== 'PASSED'
        || String(compileEvidence.outcome || '').trim().toUpperCase() !== 'PASS'
    ) {
        violations.push('Compile-generated protected artifact evidence requires a PASSED compile-gate artifact.');
    }
    if (String(compileEvidence.task_id || '').trim() !== options.taskId) {
        violations.push('Compile-generated protected artifact evidence task_id does not match the completion task.');
    }
    if (normalizePath(compileEvidence.preflight_path) !== normalizePath(options.preflightPath)) {
        violations.push('Compile-generated protected artifact evidence preflight_path does not match the completion preflight.');
    }
    if (
        normalizeSha256(compileEvidence.preflight_hash_sha256) !== normalizeSha256(options.preflightSha256)
    ) {
        violations.push('Compile-generated protected artifact evidence preflight hash does not match the completion preflight.');
    }
    if (
        Number(rawEvidence.schema_version) !== 1
        || rawEvidence.producer !== 'compile-gate'
        || rawEvidence.source_checkout !== true
        || !isOrchestratorSourceCheckout(options.repoRoot)
    ) {
        violations.push('Compile-generated protected artifact evidence has invalid provenance.');
    }

    const rawEntries = Array.isArray(rawEvidence.entries) ? rawEvidence.entries : [];
    if (rawEntries.length === 0) {
        violations.push('Compile-generated protected artifact evidence has no changed entries.');
    }
    const allowedPaths = new Set(COMPILE_GENERATED_PROTECTED_ARTIFACT_PATHS);
    const seenPaths = new Set<string>();
    const entries: CompileGeneratedProtectedArtifactEntry[] = [];
    for (const rawEntry of rawEntries) {
        const entry = toPlainRecord(rawEntry);
        const relativePath = normalizePath(entry?.path);
        const beforeSha256 = entry?.before_sha256 == null ? null : normalizeSha256(entry.before_sha256);
        const afterSha256 = normalizeSha256(entry?.after_sha256);
        if (
            !entry
            || !allowedPaths.has(relativePath)
            || seenPaths.has(relativePath)
            || (entry.before_sha256 != null && !beforeSha256)
            || !afterSha256
            || beforeSha256 === afterSha256
        ) {
            violations.push(`Compile-generated protected artifact entry is invalid for '${relativePath || 'unknown path'}'.`);
            continue;
        }
        seenPaths.add(relativePath);
        const currentArtifactSha256 = normalizeSha256(fileSha256(
            resolveCompileGeneratedProtectedArtifactPath(options.repoRoot, relativePath)
        ));
        if (currentArtifactSha256 !== afterSha256) {
            violations.push(
                `Compile-generated protected artifact '${relativePath}' changed after compile-gate evidence was recorded.`
            );
            continue;
        }
        entries.push({
            path: relativePath,
            before_sha256: beforeSha256,
            after_sha256: afterSha256
        });
    }
    const declaredChangedFiles = normalizePathList(rawEvidence.changed_files);
    const acceptedChangedFiles = entries.map((entry) => entry.path).sort();
    if (
        declaredChangedFiles.length !== acceptedChangedFiles.length
        || declaredChangedFiles.some((entry, index) => entry !== acceptedChangedFiles[index])
    ) {
        violations.push('Compile-generated protected artifact changed_files do not match the validated entries.');
    }
    return {
        allowed_changed_files: violations.length === 0 ? acceptedChangedFiles : [],
        entries: violations.length === 0 ? entries : [],
        violations
    };
}

export function reconstructProtectedSnapshotBeforeCompileGeneratedArtifacts(
    currentSnapshot: Record<string, string>,
    entries: CompileGeneratedProtectedArtifactEntry[]
): Record<string, string> {
    const reconstructed = { ...currentSnapshot };
    for (const entry of entries) {
        if (entry.before_sha256) {
            reconstructed[entry.path] = entry.before_sha256;
        } else {
            delete reconstructed[entry.path];
        }
    }
    return reconstructed;
}
