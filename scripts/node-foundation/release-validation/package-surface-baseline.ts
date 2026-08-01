import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    PACKAGE_SURFACE_LIFECYCLE_SCRIPTS,
    PACKAGE_SURFACE_RISK_SIGNALS,
    PACKAGE_SURFACE_SCHEMA_VERSION,
    type PackageSurfaceAllowedGrowth,
    type PackageSurfaceArtifact,
    type PackageSurfaceBaseline,
    type PackageSurfaceBaselineOptions,
    type PackageSurfaceBaselineUpdateOptions,
    type PackageSurfaceComparisonResult,
    type PackageSurfaceMetrics,
    type PackageSurfaceReference,
    type PackageSurfaceRiskSignals
} from './package-surface-types';

export const DEFAULT_PACKAGE_SURFACE_ALLOWED_GROWTH: PackageSurfaceAllowedGrowth = Object.freeze({
    fileCount: 10,
    unpackedSizeBytes: 256 * 1024,
    riskSignals: Object.freeze({
        child_process: 0,
        exec: 0,
        fetch: 0,
        fs: 0,
        readFile: 0,
        writeFile: 0
    })
});

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label}.${key} must be a non-empty string.`);
    }
    return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number {
    const value = record[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`${label}.${key} must be a non-negative safe integer.`);
    }
    return Number(value);
}

function emptyRiskSignals(): PackageSurfaceRiskSignals {
    return {
        child_process: 0,
        exec: 0,
        fetch: 0,
        fs: 0,
        readFile: 0,
        writeFile: 0
    };
}

function cloneAllowedGrowth(value: PackageSurfaceAllowedGrowth): PackageSurfaceAllowedGrowth {
    return {
        fileCount: value.fileCount,
        unpackedSizeBytes: value.unpackedSizeBytes,
        riskSignals: { ...value.riskSignals }
    };
}

function assertAllowedGrowth(value: PackageSurfaceAllowedGrowth): void {
    const entries: Array<readonly [string, number]> = [
        ['fileCount', value.fileCount],
        ['unpackedSizeBytes', value.unpackedSizeBytes],
        ...PACKAGE_SURFACE_RISK_SIGNALS.map(
            (signal): readonly [string, number] => [`riskSignals.${signal}`, value.riskSignals[signal]]
        )
    ];
    for (const [label, amount] of entries) {
        if (!Number.isSafeInteger(amount) || amount < 0) {
            throw new Error(`Package-surface allowedGrowth.${label} must be a non-negative safe integer.`);
        }
    }
}

export function createPackageSurfaceBaseline(
    artifact: PackageSurfaceArtifact,
    options: PackageSurfaceBaselineOptions
): PackageSurfaceBaseline {
    const rationale = String(options.rationale || '').trim();
    if (!rationale) {
        throw new Error('Package-surface baseline requires a non-empty --rationale audit note.');
    }
    assertAllowedGrowth(options.allowedGrowth);
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: { ...artifact.package },
        metrics: {
            fileCount: artifact.metrics.fileCount,
            unpackedSizeBytes: artifact.metrics.unpackedSizeBytes,
            lifecycleScripts: { ...artifact.metrics.lifecycleScripts },
            riskSignals: { ...artifact.metrics.riskSignals }
        },
        allowedGrowth: cloneAllowedGrowth(options.allowedGrowth),
        rationale
    };
}

function isBaseline(reference: PackageSurfaceReference): reference is PackageSurfaceBaseline {
    return 'allowedGrowth' in reference;
}

function pushGrowthViolation(
    violations: string[],
    label: string,
    current: number,
    reference: number,
    allowed: number
): void {
    const growth = current - reference;
    if (growth > allowed) {
        violations.push(`${label} current=${current} reference=${reference} growth=${growth} allowed=${allowed}`);
    }
}

function compareLifecycleScripts(current: Record<string, string>, reference: Record<string, string>): string[] {
    const changes: string[] = [];
    const names = [...new Set([...Object.keys(current), ...Object.keys(reference)])].sort();
    for (const name of names) {
        if (!Object.hasOwn(reference, name)) {
            changes.push(`added ${name}=${current[name]}`);
        } else if (!Object.hasOwn(current, name)) {
            changes.push(`removed ${name}=${reference[name]}`);
        } else if (current[name] !== reference[name]) {
            changes.push(`changed ${name}: ${reference[name]} -> ${current[name]}`);
        }
    }
    return changes;
}

export function comparePackageSurface(
    current: PackageSurfaceArtifact,
    reference: PackageSurfaceReference,
    referencePath: string
): PackageSurfaceComparisonResult {
    const referenceKind = isBaseline(reference) ? 'baseline' : 'prior-artifact';
    const allowedGrowth = isBaseline(reference)
        ? cloneAllowedGrowth(reference.allowedGrowth)
        : cloneAllowedGrowth(DEFAULT_PACKAGE_SURFACE_ALLOWED_GROWTH);
    const violations: string[] = [];
    if (current.package.name !== reference.package.name) {
        violations.push(`package name current=${current.package.name} reference=${reference.package.name}`);
    }
    pushGrowthViolation(
        violations,
        'fileCount',
        current.metrics.fileCount,
        reference.metrics.fileCount,
        allowedGrowth.fileCount
    );
    pushGrowthViolation(
        violations,
        'unpackedSizeBytes',
        current.metrics.unpackedSizeBytes,
        reference.metrics.unpackedSizeBytes,
        allowedGrowth.unpackedSizeBytes
    );
    const lifecycleChanges = compareLifecycleScripts(
        current.metrics.lifecycleScripts,
        reference.metrics.lifecycleScripts
    );
    if (lifecycleChanges.length > 0) {
        violations.push(`lifecycleScripts changed: ${lifecycleChanges.join('; ')}`);
    }
    for (const signal of PACKAGE_SURFACE_RISK_SIGNALS) {
        pushGrowthViolation(
            violations,
            `riskSignals.${signal}`,
            current.metrics.riskSignals[signal],
            reference.metrics.riskSignals[signal],
            allowedGrowth.riskSignals[signal]
        );
    }
    return {
        passed: violations.length === 0,
        current,
        reference,
        referenceKind,
        referencePath,
        allowedGrowth,
        violations
    };
}

export function formatPackageSurfaceComparison(result: PackageSurfaceComparisonResult): string {
    const lines = [
        result.passed ? 'PACKAGE_SURFACE_OK' : 'PACKAGE_SURFACE_FAILED',
        `Package: ${result.current.package.name}@${result.current.package.version}`,
        `Reference: ${result.referenceKind} ${result.referencePath}`,
        `FileCount: ${result.current.metrics.fileCount}`,
        `UnpackedSizeBytes: ${result.current.metrics.unpackedSizeBytes}`,
        `LifecycleScripts: ${JSON.stringify(result.current.metrics.lifecycleScripts)}`,
        `RiskSignals: ${JSON.stringify(result.current.metrics.riskSignals)}`
    ];
    for (const violation of result.violations) {
        lines.push(`- ${violation}`);
    }
    if (!result.passed) {
        lines.push(
            'Remediation: review the packed diff; for intentional growth run validate-release.js '
            + 'package-surface-baseline --confirm-baseline-update --rationale "<audited reason>" and commit the baseline diff.'
        );
    }
    return lines.join('\n');
}

export function updatePackageSurfaceBaseline(
    baselinePath: string,
    artifact: PackageSurfaceArtifact,
    options: PackageSurfaceBaselineUpdateOptions
): PackageSurfaceBaseline {
    if (!options.confirmed) {
        throw new Error('Refusing baseline update without --confirm-baseline-update.');
    }
    const baseline = createPackageSurfaceBaseline(artifact, options);
    const resolvedPath = path.resolve(baselinePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return baseline;
}

function parseRiskSignals(value: unknown, label: string): PackageSurfaceRiskSignals {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const signals = emptyRiskSignals();
    for (const signal of PACKAGE_SURFACE_RISK_SIGNALS) {
        signals[signal] = requireNonNegativeInteger(value, signal, label);
    }
    return signals;
}

function parseLifecycleScripts(value: unknown, label: string): Record<string, string> {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const scripts: Record<string, string> = {};
    for (const [name, command] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
        if (!PACKAGE_SURFACE_LIFECYCLE_SCRIPTS.includes(name as typeof PACKAGE_SURFACE_LIFECYCLE_SCRIPTS[number])) {
            throw new Error(`${label} contains unsupported lifecycle script: ${name}`);
        }
        if (typeof command !== 'string' || !command.trim()) {
            throw new Error(`${label}.${name} must be a non-empty string.`);
        }
        scripts[name] = command;
    }
    return scripts;
}

function parseMetrics(value: unknown, label: string): PackageSurfaceMetrics {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return {
        fileCount: requireNonNegativeInteger(value, 'fileCount', label),
        unpackedSizeBytes: requireNonNegativeInteger(value, 'unpackedSizeBytes', label),
        lifecycleScripts: parseLifecycleScripts(value.lifecycleScripts, `${label}.lifecycleScripts`),
        riskSignals: parseRiskSignals(value.riskSignals, `${label}.riskSignals`)
    };
}

function parsePackageIdentity(value: unknown, label: string): { name: string; version: string } {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return {
        name: requireString(value, 'name', label),
        version: requireString(value, 'version', label)
    };
}

function assertSchemaVersion(value: Record<string, unknown>, label: string): void {
    if (value.schemaVersion !== PACKAGE_SURFACE_SCHEMA_VERSION) {
        throw new Error(`${label}.schemaVersion must be ${PACKAGE_SURFACE_SCHEMA_VERSION}.`);
    }
}

export function parsePackageSurfaceArtifact(value: unknown, label = 'package-surface artifact'): PackageSurfaceArtifact {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    assertSchemaVersion(value, label);
    const manifestHash = requireString(value, 'packedFileManifestSha256', label);
    if (!/^[a-f0-9]{64}$/u.test(manifestHash)) {
        throw new Error(`${label}.packedFileManifestSha256 must be a lowercase SHA-256 digest.`);
    }
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: parsePackageIdentity(value.package, `${label}.package`),
        packedFileManifestSha256: manifestHash,
        metrics: parseMetrics(value.metrics, `${label}.metrics`)
    };
}

export function parsePackageSurfaceBaseline(value: unknown, label = 'package-surface baseline'): PackageSurfaceBaseline {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    assertSchemaVersion(value, label);
    if (!isRecord(value.allowedGrowth)) {
        throw new Error(`${label}.allowedGrowth must be an object.`);
    }
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: parsePackageIdentity(value.package, `${label}.package`),
        metrics: parseMetrics(value.metrics, `${label}.metrics`),
        allowedGrowth: {
            fileCount: requireNonNegativeInteger(value.allowedGrowth, 'fileCount', `${label}.allowedGrowth`),
            unpackedSizeBytes: requireNonNegativeInteger(
                value.allowedGrowth,
                'unpackedSizeBytes',
                `${label}.allowedGrowth`
            ),
            riskSignals: parseRiskSignals(
                value.allowedGrowth.riskSignals,
                `${label}.allowedGrowth.riskSignals`
            )
        },
        rationale: requireString(value, 'rationale', label).trim()
    };
}
