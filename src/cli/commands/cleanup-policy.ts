import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateManagedConfigByName } from '../../schemas/config-artifacts';
import {
    readRuntimeRetentionPolicyDocument,
    resolveRuntimeRetentionPolicyConfigPath
} from '../../lifecycle/runtime-retention-policy';
import {
    parseBooleanText,
    promptSingleSelect,
    promptTextInput,
    supportsInteractivePrompts
} from './cli-helpers';

type MaybePromise<T> = T | Promise<T>;

export interface ReviewArtifactStorageDocument {
    version: number;
    retention_mode: 'none' | 'summary' | 'full';
    compress_after_days: number;
    compression_format: 'gzip';
    preserve_gate_receipts: boolean;
    gate_receipt_suffixes: string[];
    privacy_notice?: string;
    [key: string]: unknown;
}

export interface CleanupPolicyCommandOptions {
    retentionMode?: string;
    compressAfterDays?: string;
    compressionFormat?: string;
    preserveGateReceipts?: string;
    gateReceiptSuffixes?: string[];
    edit?: boolean;
    reset?: boolean;
    json?: boolean;
}

const DEFAULT_POLICY_DOCUMENT: ReviewArtifactStorageDocument = {
    version: 1,
    retention_mode: 'full',
    compress_after_days: 7,
    compression_format: 'gzip',
    preserve_gate_receipts: true,
    gate_receipt_suffixes: [
        '-task-mode.json',
        '-preflight.json',
        '-compile-gate.json',
        '-completion-gate.json',
        '-rule-pack.json',
        '-handshake.json'
    ],
    privacy_notice: "Mode 'none' deletes review artifacts after task completion, reducing forensic reproducibility. Mode 'summary' keeps only gate receipts and strips detailed diff/context artifacts. Mode 'full' preserves everything subject to age/count retention."
};

function clonePolicyDocument(document: ReviewArtifactStorageDocument): ReviewArtifactStorageDocument {
    return JSON.parse(JSON.stringify(document)) as ReviewArtifactStorageDocument;
}

export function resolveCleanupPolicyConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
}

function resolveBundledCleanupPolicyTemplatePath(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'config', 'review-artifact-storage.json');
}

function parsePolicyDocument(raw: unknown): ReviewArtifactStorageDocument {
    return validateManagedConfigByName('review-artifact-storage', raw) as ReviewArtifactStorageDocument;
}

function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function readBundledCleanupPolicyTemplate(bundleRoot: string): ReviewArtifactStorageDocument {
    const templatePath = resolveBundledCleanupPolicyTemplatePath(bundleRoot);
    if (!fs.existsSync(templatePath)) {
        return clonePolicyDocument(DEFAULT_POLICY_DOCUMENT);
    }
    try {
        return parsePolicyDocument(readJsonFile(templatePath));
    } catch {
        return clonePolicyDocument(DEFAULT_POLICY_DOCUMENT);
    }
}

export function readCleanupPolicyDocument(bundleRoot: string): ReviewArtifactStorageDocument {
    const configPath = resolveCleanupPolicyConfigPath(bundleRoot);
    if (!fs.existsSync(configPath)) {
        return readBundledCleanupPolicyTemplate(bundleRoot);
    }
    try {
        return parsePolicyDocument(readJsonFile(configPath));
    } catch (error: unknown) {
        throw new Error(
            `Review artifact storage config is invalid: ${configPath}\n` +
            (error instanceof Error ? error.message : String(error))
        );
    }
}

export function buildCleanupPolicyOutput(
    action: 'show' | 'edit' | 'update' | 'reset',
    configPath: string,
    policy: ReviewArtifactStorageDocument,
    runtimeRetentionConfigPath: string,
    runtimeRetentionPolicy: Record<string, unknown>,
    jsonMode: boolean
): string {
    const operatorNotes = [
        'Runtime retention tiers: active evidence is preserved; healthy DONE tasks become ledger history only after verified ledger evidence; problem tasks keep recovery-readable evidence and may compress heavy forensic artifacts; purge requires explicit confirmation.',
        'Clean-success compile/full-suite raw logs may be intentionally omitted at gate time; warnings, failures, and non-clean runs retain raw output.'
    ];
    if (jsonMode) {
        return JSON.stringify({
            action,
            config_path: configPath,
            policy,
            runtime_retention_config_path: runtimeRetentionConfigPath,
            runtime_retention_policy: runtimeRetentionPolicy,
            operator_notes: operatorNotes
        }, null, 2);
    }

    const lines: string[] = [];
    lines.push('GARDA_CLEANUP_POLICY');
    lines.push(`Action: ${action}`);
    lines.push(`ConfigPath: ${configPath}`);
    lines.push(`RetentionMode: ${policy.retention_mode}`);
    lines.push(`CompressAfterDays: ${policy.compress_after_days}`);
    lines.push(`CompressionFormat: ${policy.compression_format}`);
    lines.push(`PreserveGateReceipts: ${policy.preserve_gate_receipts}`);
    lines.push(`GateReceiptSuffixes: ${policy.gate_receipt_suffixes.join(', ')}`);
    lines.push(`RuntimeRetentionConfigPath: ${runtimeRetentionConfigPath}`);
    lines.push(`RuntimeRetentionHealthyDoneCompactAfterDays: ${runtimeRetentionPolicy.healthy_done && typeof runtimeRetentionPolicy.healthy_done === 'object' ? String((runtimeRetentionPolicy.healthy_done as Record<string, unknown>).compact_after_days ?? 'n/a') : 'n/a'}`);
    lines.push(`RuntimeRetentionProblemCompressAfterDays: ${runtimeRetentionPolicy.problem_tasks && typeof runtimeRetentionPolicy.problem_tasks === 'object' ? String((runtimeRetentionPolicy.problem_tasks as Record<string, unknown>).compress_after_days ?? 'n/a') : 'n/a'}`);
    lines.push(`RuntimeRetentionRequireConfirmPurge: ${runtimeRetentionPolicy.purge && typeof runtimeRetentionPolicy.purge === 'object' ? String((runtimeRetentionPolicy.purge as Record<string, unknown>).require_confirm ?? 'n/a') : 'n/a'}`);
    lines.push('RuntimeRetentionTiers: active_evidence=preserve, compact_ledger_candidate=verified-ledger-history, compressed_forensic_candidate=problem-task-heavy-artifact-compression, purge=confirm-only');
    for (const note of operatorNotes) {
        lines.push(`OperatorNote: ${note}`);
    }
    if (action !== 'show') {
        lines.push('Status: UPDATED');
    }
    return lines.join('\n');
}

function parseNonNegativeInteger(value: string, flagName: string): number {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        throw new Error(`${flagName} must be a non-negative integer.`);
    }
    return parsed;
}

function hasUpdateOverrides(options: CleanupPolicyCommandOptions): boolean {
    return Boolean(
        options.reset
        || options.retentionMode !== undefined
        || options.compressAfterDays !== undefined
        || options.compressionFormat !== undefined
        || options.preserveGateReceipts !== undefined
        || options.gateReceiptSuffixes !== undefined
    );
}

export function applyCleanupPolicyOverrides(
    bundleRoot: string,
    currentPolicy: ReviewArtifactStorageDocument,
    options: CleanupPolicyCommandOptions
): ReviewArtifactStorageDocument {
    const nextPolicy = options.reset
        ? readBundledCleanupPolicyTemplate(bundleRoot)
        : clonePolicyDocument(currentPolicy);

    if (typeof options.retentionMode === 'string') {
        nextPolicy.retention_mode = options.retentionMode.trim().toLowerCase() as ReviewArtifactStorageDocument['retention_mode'];
    }

    if (typeof options.compressAfterDays === 'string') {
        nextPolicy.compress_after_days = parseNonNegativeInteger(options.compressAfterDays, '--compress-after-days');
    }

    if (typeof options.compressionFormat === 'string') {
        nextPolicy.compression_format = options.compressionFormat.trim().toLowerCase() as ReviewArtifactStorageDocument['compression_format'];
    }

    if (typeof options.preserveGateReceipts === 'string') {
        nextPolicy.preserve_gate_receipts = parseBooleanText(options.preserveGateReceipts, '--preserve-gate-receipts');
    }

    if (options.gateReceiptSuffixes !== undefined) {
        const suffixes = options.gateReceiptSuffixes
            .map((value) => String(value || '').trim())
            .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
        if (suffixes.length === 0) {
            throw new Error('--gate-receipt-suffix must provide at least one non-empty suffix.');
        }
        nextPolicy.gate_receipt_suffixes = suffixes;
    }

    return parsePolicyDocument(nextPolicy);
}

async function promptBooleanChoice(title: string, currentValue: boolean, trueLabel = 'Yes', falseLabel = 'No'): Promise<boolean> {
    const selected = await promptSingleSelect({
        title,
        defaultLabel: currentValue ? trueLabel : falseLabel,
        options: [
            { label: trueLabel, value: 'true' },
            { label: falseLabel, value: 'false' }
        ],
        defaultValue: currentValue ? 'true' : 'false'
    });
    return selected === 'true';
}

async function promptRetentionMode(currentMode: ReviewArtifactStorageDocument['retention_mode']): Promise<ReviewArtifactStorageDocument['retention_mode']> {
    const selected = await promptSingleSelect({
        title: 'Retention mode',
        defaultLabel: currentMode,
        options: [
            { label: 'full - keep artifacts, compress older ones', value: 'full' },
            { label: 'summary - keep only gate receipts', value: 'summary' },
            { label: 'none - delete completed review artifacts', value: 'none' }
        ],
        defaultValue: currentMode
    });
    return selected as ReviewArtifactStorageDocument['retention_mode'];
}

async function promptNonNegativeInteger(title: string, defaultValue: number): Promise<number> {
    let currentDefault = String(defaultValue);
    for (;;) {
        const answer = await promptTextInput(title, currentDefault);
        try {
            return parseNonNegativeInteger(answer, title);
        } catch (error: unknown) {
            console.log(error instanceof Error ? error.message : String(error));
            currentDefault = answer || currentDefault;
        }
    }
}

async function promptForCleanupPolicyEdit(
    bundleRoot: string,
    currentPolicy: ReviewArtifactStorageDocument
): Promise<ReviewArtifactStorageDocument> {
    const nextPolicy = clonePolicyDocument(currentPolicy);
    const bundledDefaults = readBundledCleanupPolicyTemplate(bundleRoot);

    nextPolicy.retention_mode = await promptRetentionMode(nextPolicy.retention_mode);
    if (nextPolicy.retention_mode === 'full') {
        nextPolicy.compress_after_days = await promptNonNegativeInteger(
            'Compress artifacts after N days',
            nextPolicy.compress_after_days
        );
    }
    nextPolicy.preserve_gate_receipts = await promptBooleanChoice(
        'Preserve gate receipts',
        nextPolicy.preserve_gate_receipts,
        'Yes',
        'No'
    );
    const resetSuffixes = await promptBooleanChoice(
        'Use bundled default receipt suffixes',
        nextPolicy.gate_receipt_suffixes.join('|') === bundledDefaults.gate_receipt_suffixes.join('|'),
        'Use bundled defaults',
        'Keep current set'
    );
    if (resetSuffixes) {
        nextPolicy.gate_receipt_suffixes = [...bundledDefaults.gate_receipt_suffixes];
    }

    return parsePolicyDocument(nextPolicy);
}

export function handleCleanupPolicyCommand(
    bundleRoot: string,
    options: CleanupPolicyCommandOptions
): MaybePromise<void> {
    const configPath = resolveCleanupPolicyConfigPath(bundleRoot);
    const currentPolicy = readCleanupPolicyDocument(bundleRoot);
    const runtimeRetentionConfigPath = resolveRuntimeRetentionPolicyConfigPath(bundleRoot);
    const runtimeRetentionPolicy = readRuntimeRetentionPolicyDocument(bundleRoot) as Record<string, unknown>;

    if (options.edit) {
        if (options.json === true) {
            throw new Error('--json is not supported with interactive cleanup policy editing.');
        }
        if (!supportsInteractivePrompts()) {
            throw new Error('Interactive cleanup policy editing requires a TTY terminal.');
        }
        return (async () => {
            const nextPolicy = await promptForCleanupPolicyEdit(bundleRoot, currentPolicy);
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify(nextPolicy, null, 2) + '\n', 'utf8');
            console.log(buildCleanupPolicyOutput('edit', configPath, nextPolicy, runtimeRetentionConfigPath, runtimeRetentionPolicy, false));
        })();
    }

    if (!hasUpdateOverrides(options)) {
        console.log(buildCleanupPolicyOutput('show', configPath, currentPolicy, runtimeRetentionConfigPath, runtimeRetentionPolicy, options.json === true));
        return;
    }

    const nextPolicy = applyCleanupPolicyOverrides(bundleRoot, currentPolicy, options);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(nextPolicy, null, 2) + '\n', 'utf8');

    const action = options.reset && !(
        options.retentionMode !== undefined
        || options.compressAfterDays !== undefined
        || options.compressionFormat !== undefined
        || options.preserveGateReceipts !== undefined
        || options.gateReceiptSuffixes !== undefined
    )
        ? 'reset'
        : 'update';
    console.log(buildCleanupPolicyOutput(action, configPath, nextPolicy, runtimeRetentionConfigPath, runtimeRetentionPolicy, options.json === true));
}
