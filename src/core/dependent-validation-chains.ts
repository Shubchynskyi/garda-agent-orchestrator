import * as fs from 'node:fs';
import * as path from 'node:path';

const LOCK_METADATA_GRACE_MS = 30_000;
const LOCK_STALE_MS = 15 * 60 * 1000;

export type DependentValidationChainStatus =
    | 'NOT_APPLICABLE'
    | 'READY'
    | 'PRODUCER_ACTIVE'
    | 'MISSING_PRODUCER'
    | 'STALE_PRODUCER';

export interface DependentValidationChainCheckResult {
    matched: boolean;
    rule_id: string | null;
    status: DependentValidationChainStatus;
    artifact_root: string | null;
    consumer_paths: string[];
    manifest_path: string | null;
    producer_commands: string[];
    message: string | null;
}

interface ValidationChainRule {
    id: string;
    artifactRootRelative: string;
    manifestRelativePath: string;
    defaultSourceRoots: string[];
    producerCommands: string[];
    consumerLabel: string;
    detectConsumerPaths: (tokens: string[], cwd: string) => string[];
}

interface LockInspection {
    active: boolean;
    lockPath: string;
    ownerPid: number | null;
    stale: boolean;
}

interface ChainManifest {
    sourceRoots: string[];
}

interface SourceRootsInspection {
    existingRoots: string[];
    latestMtimeMs: number | null;
}

function normalizeForDisplay(targetPath: string, repoRoot: string): string {
    const relative = path.relative(repoRoot, targetPath).replace(/\\/g, '/');
    return relative && !relative.startsWith('../') ? relative : targetPath.replace(/\\/g, '/');
}

function basenameLower(text: string): string {
    return path.basename(text).trim().toLowerCase();
}

function isProcessLikelyAlive(pid: number): boolean | null {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '';
        if (errorCode === 'ESRCH') {
            return false;
        }
        if (errorCode === 'EPERM') {
            return true;
        }
        return null;
    }
}

function inspectProducerLock(lockPath: string): LockInspection {
    if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
        return {
            active: false,
            lockPath,
            ownerPid: null,
            stale: false
        };
    }

    const ageMs = Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
    const ownerPath = path.join(lockPath, 'owner.json');
    let ownerPid: number | null = null;
    if (fs.existsSync(ownerPath) && fs.statSync(ownerPath).isFile()) {
        try {
            const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
            ownerPid = Number.isInteger(parsed.pid) && Number(parsed.pid) > 0 ? Number(parsed.pid) : null;
        } catch {
            ownerPid = null;
        }
    }

    const ownerAlive = ownerPid != null ? isProcessLikelyAlive(ownerPid) : null;
    if (ownerAlive === true) {
        return {
            active: true,
            lockPath,
            ownerPid,
            stale: false
        };
    }

    if (ownerAlive === false || ageMs >= LOCK_STALE_MS) {
        return {
            active: false,
            lockPath,
            ownerPid,
            stale: true
        };
    }

    if (ownerPid == null && ageMs >= LOCK_METADATA_GRACE_MS) {
        return {
            active: false,
            lockPath,
            ownerPid: null,
            stale: true
        };
    }

    return {
        active: true,
        lockPath,
        ownerPid,
        stale: false
    };
}

function readChainManifest(manifestPath: string, defaultSourceRoots: string[]): ChainManifest | null {
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const sourceRoots = Array.isArray(parsed.sourceRoots)
            ? parsed.sourceRoots
                .map((value) => String(value || '').trim())
                .filter(Boolean)
            : defaultSourceRoots;
        return {
            sourceRoots: sourceRoots.length > 0 ? sourceRoots : defaultSourceRoots
        };
    } catch {
        return null;
    }
}

function collectLatestFileMtimeMs(rootPath: string): number | null {
    if (!fs.existsSync(rootPath)) {
        return null;
    }

    const stat = fs.statSync(rootPath);
    if (stat.isFile()) {
        return stat.mtimeMs;
    }
    if (!stat.isDirectory()) {
        return null;
    }

    let latestMtimeMs: number | null = null;
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);
        const entryMtimeMs = collectLatestFileMtimeMs(entryPath);
        if (entryMtimeMs != null && (latestMtimeMs == null || entryMtimeMs > latestMtimeMs)) {
            latestMtimeMs = entryMtimeMs;
        }
    }
    return latestMtimeMs;
}

function inspectSourceRoots(repoRoot: string, sourceRoots: string[]): SourceRootsInspection {
    let latestMtimeMs: number | null = null;
    const existingRoots: string[] = [];
    for (const sourceRoot of sourceRoots) {
        const candidate = path.resolve(repoRoot, sourceRoot);
        if (!fs.existsSync(candidate)) {
            continue;
        }
        existingRoots.push(candidate);
        const candidateMtimeMs = collectLatestFileMtimeMs(candidate);
        if (candidateMtimeMs != null && (latestMtimeMs == null || candidateMtimeMs > latestMtimeMs)) {
            latestMtimeMs = candidateMtimeMs;
        }
    }
    return {
        existingRoots,
        latestMtimeMs
    };
}

function resolveArtifactRootFromConsumerPath(consumerPath: string, artifactDirName: string): string | null {
    let current = path.resolve(consumerPath);
    if (basenameLower(current) === artifactDirName.toLowerCase()) {
        return current;
    }

    while (true) {
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        if (basenameLower(parent) === artifactDirName.toLowerCase()) {
            return parent;
        }
        current = parent;
    }
}

function resolveArtifactRootFromConsumerPaths(consumerPaths: string[], artifactDirName: string): string | null {
    const matchedRoots = new Set<string>();
    for (const consumerPath of consumerPaths) {
        const artifactRoot = resolveArtifactRootFromConsumerPath(consumerPath, artifactDirName);
        if (artifactRoot) {
            matchedRoots.add(path.resolve(artifactRoot));
        }
    }
    if (matchedRoots.size !== 1) {
        return null;
    }
    return [...matchedRoots][0];
}

function detectNodeFoundationConsumerPaths(tokens: string[], cwd: string): string[] {
    if (tokens.length === 0) {
        return [];
    }

    const executable = basenameLower(tokens[0]);
    if (executable !== 'node' && executable !== 'node.exe') {
        return [];
    }
    if (!tokens.includes('--test')) {
        return [];
    }

    const matched = new Set<string>();
    for (const token of tokens.slice(1)) {
        const trimmed = String(token || '').trim();
        if (!trimmed || trimmed.startsWith('-')) {
            continue;
        }
        const absoluteCandidate = path.resolve(cwd, trimmed);
        if (resolveArtifactRootFromConsumerPath(absoluteCandidate, '.node-build')) {
            matched.add(absoluteCandidate);
        }
    }

    return [...matched].sort();
}

const VALIDATION_CHAIN_RULES: readonly ValidationChainRule[] = Object.freeze([
    {
        id: 'node_foundation_build_to_compiled_tests',
        artifactRootRelative: '.node-build',
        manifestRelativePath: path.join('.node-build', 'node-foundation-manifest.json'),
        defaultSourceRoots: ['src', 'tests/node', 'scripts/node-foundation'],
        producerCommands: ['npm run build:node-foundation', 'npm test'],
        consumerLabel: 'direct .node-build Node tests',
        detectConsumerPaths: detectNodeFoundationConsumerPaths
    }
]);

function buildValidationChainMessage(
    rule: ValidationChainRule,
    cwd: string,
    status: Exclude<DependentValidationChainStatus, 'NOT_APPLICABLE' | 'READY'>,
    artifactRoot: string,
    manifestPath: string,
    consumerPaths: string[],
    details: string
): string {
    const displayArtifactRoot = normalizeForDisplay(artifactRoot, cwd);
    const displayManifestPath = normalizeForDisplay(manifestPath, cwd);
    const displayConsumerPaths = consumerPaths.map((consumerPath) => normalizeForDisplay(consumerPath, cwd)).join(', ');
    const producerCommandsText = rule.producerCommands.map((command) => `'${command}'`).join(' or ');

    return (
        `Dependent validation chain '${rule.id}' blocked ${rule.consumerLabel}: ` +
        `consumer path(s) ${displayConsumerPaths} read generated artifacts under '${displayArtifactRoot}', ` +
        `but the producer output is not ready (${status}). ${details} ` +
        `Re-run the correct producer sequentially before the consumer: ${producerCommandsText}. ` +
        `Do not run the producer and consumer in parallel. Manifest: '${displayManifestPath}'.`
    );
}

export function evaluateDependentValidationChain(tokens: string[], cwd: string): DependentValidationChainCheckResult {
    const resolvedCwd = path.resolve(cwd || '.');
    for (const rule of VALIDATION_CHAIN_RULES) {
        const consumerPaths = rule.detectConsumerPaths(tokens, resolvedCwd);
        if (consumerPaths.length === 0) {
            continue;
        }

        const artifactDirName = path.basename(rule.artifactRootRelative);
        const artifactRoot = resolveArtifactRootFromConsumerPaths(consumerPaths, artifactDirName)
            || path.resolve(resolvedCwd, rule.artifactRootRelative);
        const repoRoot = path.dirname(artifactRoot);
        const manifestPath = path.join(artifactRoot, path.basename(rule.manifestRelativePath));
        const lockInspection = inspectProducerLock(`${artifactRoot}.lock`);
        if (lockInspection.active) {
            const ownerText = lockInspection.ownerPid != null ? ` by pid ${lockInspection.ownerPid}` : '';
            return {
                matched: true,
                rule_id: rule.id,
                status: 'PRODUCER_ACTIVE',
                artifact_root: artifactRoot,
                consumer_paths: consumerPaths,
                manifest_path: manifestPath,
                producer_commands: [...rule.producerCommands],
                message: buildValidationChainMessage(
                    rule,
                    resolvedCwd,
                    'PRODUCER_ACTIVE',
                    artifactRoot,
                    manifestPath,
                    consumerPaths,
                    `The producer lock '${normalizeForDisplay(lockInspection.lockPath, resolvedCwd)}' is still active${ownerText}.`
                )
            };
        }

        const manifest = readChainManifest(manifestPath, rule.defaultSourceRoots);
        if (manifest == null) {
            return {
                matched: true,
                rule_id: rule.id,
                status: 'MISSING_PRODUCER',
                artifact_root: artifactRoot,
                consumer_paths: consumerPaths,
                manifest_path: manifestPath,
                producer_commands: [...rule.producerCommands],
                message: buildValidationChainMessage(
                    rule,
                    resolvedCwd,
                    'MISSING_PRODUCER',
                    artifactRoot,
                    manifestPath,
                    consumerPaths,
                    'No trusted producer manifest was found for this generated artifact root.'
                )
            };
        }

        const missingConsumerPath = consumerPaths.find((consumerPath) => !fs.existsSync(consumerPath));
        if (missingConsumerPath) {
            return {
                matched: true,
                rule_id: rule.id,
                status: 'MISSING_PRODUCER',
                artifact_root: artifactRoot,
                consumer_paths: consumerPaths,
                manifest_path: manifestPath,
                producer_commands: [...rule.producerCommands],
                message: buildValidationChainMessage(
                    rule,
                    resolvedCwd,
                    'MISSING_PRODUCER',
                    artifactRoot,
                    manifestPath,
                    consumerPaths,
                    `Consumer target '${normalizeForDisplay(missingConsumerPath, resolvedCwd)}' does not exist in the generated artifact root.`
                )
            };
        }

        const sourceInspection = inspectSourceRoots(repoRoot, manifest.sourceRoots);
        if (sourceInspection.existingRoots.length === 0) {
            return {
                matched: true,
                rule_id: rule.id,
                status: 'MISSING_PRODUCER',
                artifact_root: artifactRoot,
                consumer_paths: consumerPaths,
                manifest_path: manifestPath,
                producer_commands: [...rule.producerCommands],
                message: buildValidationChainMessage(
                    rule,
                    resolvedCwd,
                    'MISSING_PRODUCER',
                    artifactRoot,
                    manifestPath,
                    consumerPaths,
                    'The producer manifest did not reference any source roots that exist in the current workspace.'
                )
            };
        }

        if (sourceInspection.latestMtimeMs == null) {
            return {
                matched: true,
                rule_id: rule.id,
                status: 'MISSING_PRODUCER',
                artifact_root: artifactRoot,
                consumer_paths: consumerPaths,
                manifest_path: manifestPath,
                producer_commands: [...rule.producerCommands],
                message: buildValidationChainMessage(
                    rule,
                    resolvedCwd,
                    'MISSING_PRODUCER',
                    artifactRoot,
                    manifestPath,
                    consumerPaths,
                    'The producer manifest only referenced empty source roots, so freshness could not be validated.'
                )
            };
        }

        const latestSourceMtimeMs = sourceInspection.latestMtimeMs;
        const manifestMtimeMs = fs.statSync(manifestPath).mtimeMs;
        if (latestSourceMtimeMs != null && latestSourceMtimeMs > manifestMtimeMs + 1000) {
            return {
                matched: true,
                rule_id: rule.id,
                status: 'STALE_PRODUCER',
                artifact_root: artifactRoot,
                consumer_paths: consumerPaths,
                manifest_path: manifestPath,
                producer_commands: [...rule.producerCommands],
                message: buildValidationChainMessage(
                    rule,
                    resolvedCwd,
                    'STALE_PRODUCER',
                    artifactRoot,
                    manifestPath,
                    consumerPaths,
                    'The generated artifact manifest is older than the latest source input for this validation chain.'
                )
            };
        }

        return {
            matched: true,
            rule_id: rule.id,
            status: 'READY',
            artifact_root: artifactRoot,
            consumer_paths: consumerPaths,
            manifest_path: manifestPath,
            producer_commands: [...rule.producerCommands],
            message: null
        };
    }

    return {
        matched: false,
        rule_id: null,
        status: 'NOT_APPLICABLE',
        artifact_root: null,
        consumer_paths: [],
        manifest_path: null,
        producer_commands: [],
        message: null
    };
}

export function assertDependentValidationChainReady(tokens: string[], cwd: string): void {
    const result = evaluateDependentValidationChain(tokens, cwd);
    if (!result.matched || result.status === 'READY') {
        return;
    }
    throw new Error(result.message || 'Dependent validation chain is not ready.');
}
