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

export type GateChainScope = 'task' | 'review_type';
export type GateChainArtifactKind =
    | 'timeline_event'
    | 'task_mode'
    | 'rule_pack'
    | 'preflight'
    | 'compile_gate'
    | 'review_context'
    | 'review_launch'
    | 'review_invocation'
    | 'review_result'
    | 'review_receipt';

export interface GateChainEdge {
    id: string;
    producer_gate: string;
    producer_event: string;
    consumer_gate: string;
    consumer_event: string;
    same_task: boolean;
    same_cycle: boolean;
    lane_scope: GateChainScope;
    artifact: GateChainArtifactKind;
    artifact_suffix: string | null;
    missing_remediation_command: string;
    stale_consumer_remediation_command?: string;
}

export interface GateChainCommandContext {
    taskId: string;
    reviewType?: string | null;
    preflightPath?: string | null;
    reviewContextPath?: string | null;
    cliPrefix?: string | null;
    repoRoot?: string | null;
    depth?: string | number | null;
}

export interface GateChainLaunchDecision {
    status: 'pass' | 'block' | 'advisory';
    edge_id: string;
    reason: string;
    next_command: string | null;
    evidence_paths: string[];
}

const DEFAULT_GATE_CLI_PREFIX = 'node bin/garda.js';
const DEFAULT_REPO_ROOT_ARGUMENT = '.';

function defineGateChainManifest(edges: readonly GateChainEdge[]): readonly GateChainEdge[] {
    return Object.freeze(edges.map((edge) => Object.freeze({ ...edge })));
}

export const GATE_CHAIN_MANIFEST: readonly GateChainEdge[] = defineGateChainManifest([
    {
        id: 'task-mode-to-task-entry-rules',
        producer_gate: 'enter-task-mode',
        producer_event: 'TASK_MODE_ENTERED',
        consumer_gate: 'load-rule-pack:TASK_ENTRY',
        consumer_event: 'RULE_PACK_LOADED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'task',
        artifact: 'task_mode',
        artifact_suffix: '-task-mode.json',
        missing_remediation_command:
            '{cli} gate enter-task-mode --task-id "{taskId}" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "{depth}" --task-summary "<task summary>" --provider "<provider>" --repo-root "{repoRoot}"'
    },
    {
        id: 'task-entry-rules-to-handshake',
        producer_gate: 'load-rule-pack:TASK_ENTRY',
        producer_event: 'RULE_PACK_LOADED',
        consumer_gate: 'handshake-diagnostics',
        consumer_event: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'task',
        artifact: 'rule_pack',
        artifact_suffix: '-rule-pack.json',
        missing_remediation_command:
            '{cli} gate load-rule-pack --task-id "{taskId}" --stage "TASK_ENTRY" --repo-root "{repoRoot}"'
    },
    {
        id: 'handshake-to-shell-smoke',
        producer_gate: 'handshake-diagnostics',
        producer_event: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
        consumer_gate: 'shell-smoke-preflight',
        consumer_event: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'task',
        artifact: 'timeline_event',
        artifact_suffix: '-handshake.json',
        missing_remediation_command:
            '{cli} gate handshake-diagnostics --task-id "{taskId}" --repo-root "{repoRoot}"',
        stale_consumer_remediation_command:
            '{cli} gate shell-smoke-preflight --task-id "{taskId}" --repo-root "{repoRoot}"'
    },
    {
        id: 'shell-smoke-to-preflight',
        producer_gate: 'shell-smoke-preflight',
        producer_event: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
        consumer_gate: 'classify-change',
        consumer_event: 'PREFLIGHT_CLASSIFIED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'task',
        artifact: 'timeline_event',
        artifact_suffix: '-shell-smoke.json',
        missing_remediation_command:
            '{cli} gate shell-smoke-preflight --task-id "{taskId}" --repo-root "{repoRoot}"'
    },
    {
        id: 'preflight-to-post-preflight-rules',
        producer_gate: 'classify-change',
        producer_event: 'PREFLIGHT_CLASSIFIED',
        consumer_gate: 'load-rule-pack:POST_PREFLIGHT',
        consumer_event: 'RULE_PACK_LOADED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'task',
        artifact: 'preflight',
        artifact_suffix: '-preflight.json',
        missing_remediation_command:
            '{cli} gate classify-change --task-id "{taskId}" --task-intent "<task summary>" --output-path "{preflightPath}" --repo-root "{repoRoot}"'
    },
    {
        id: 'post-preflight-rules-to-compile',
        producer_gate: 'load-rule-pack:POST_PREFLIGHT',
        producer_event: 'RULE_PACK_LOADED',
        consumer_gate: 'compile-gate',
        consumer_event: 'COMPILE_GATE_PASSED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'task',
        artifact: 'rule_pack',
        artifact_suffix: '-rule-pack.json',
        missing_remediation_command:
            '{cli} gate load-rule-pack --task-id "{taskId}" --stage "POST_PREFLIGHT" --preflight-path "{preflightPath}" --repo-root "{repoRoot}"'
    },
    {
        id: 'compile-to-review-context',
        producer_gate: 'compile-gate',
        producer_event: 'COMPILE_GATE_PASSED',
        consumer_gate: 'build-review-context',
        consumer_event: 'REVIEW_PHASE_STARTED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'compile_gate',
        artifact_suffix: '-compile-gate.json',
        missing_remediation_command:
            '{cli} gate compile-gate --task-id "{taskId}" --preflight-path "{preflightPath}" --repo-root "{repoRoot}"'
    },
    {
        id: 'review-context-to-routing',
        producer_gate: 'build-review-context',
        producer_event: 'REVIEW_PHASE_STARTED',
        consumer_gate: 'record-review-routing',
        consumer_event: 'REVIEWER_DELEGATION_ROUTED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_context',
        artifact_suffix: '-{reviewType}-review-context.json',
        missing_remediation_command:
            '{cli} gate build-review-context --review-type "{reviewType}" --depth "{depth}" --preflight-path "{preflightPath}" --repo-root "{repoRoot}"'
    },
    {
        id: 'review-routing-to-launch-prepared',
        producer_gate: 'record-review-routing',
        producer_event: 'REVIEWER_DELEGATION_ROUTED',
        consumer_gate: 'prepare-reviewer-launch',
        consumer_event: 'REVIEWER_LAUNCH_PREPARED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_context',
        artifact_suffix: '-{reviewType}-review-context.json',
        missing_remediation_command:
            '{cli} gate record-review-routing --task-id "{taskId}" --review-type "{reviewType}" --review-context-path "{reviewContextPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent>" --repo-root "{repoRoot}"'
    },
    {
        id: 'review-launch-prepared-to-launch-completed',
        producer_gate: 'prepare-reviewer-launch',
        producer_event: 'REVIEWER_LAUNCH_PREPARED',
        consumer_gate: 'complete-reviewer-launch',
        consumer_event: 'REVIEWER_LAUNCH_COMPLETED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_launch',
        artifact_suffix: '-{reviewType}-reviewer-launch.json',
        missing_remediation_command:
            '{cli} gate prepare-reviewer-launch --task-id "{taskId}" --review-type "{reviewType}" --review-context-path "{reviewContextPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent>" --reviewer-launch-artifact-path "<reviewer-launch.json>" --repo-root "{repoRoot}"'
    },
    {
        id: 'review-launch-completed-to-invocation',
        producer_gate: 'complete-reviewer-launch',
        producer_event: 'REVIEWER_LAUNCH_COMPLETED',
        consumer_gate: 'record-review-invocation',
        consumer_event: 'REVIEWER_INVOCATION_ATTESTED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_launch',
        artifact_suffix: '-{reviewType}-reviewer-launch.json',
        missing_remediation_command:
            '{cli} gate complete-reviewer-launch --task-id "{taskId}" --review-type "{reviewType}" --review-context-path "{reviewContextPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent>" --reviewer-launch-artifact-path "<reviewer-launch.json>" --provider-invocation-id "<actual-invocation-id>" --launched-at-utc "<ISO-8601>" --attestation-source "<provider-source>" --fork-context false --repo-root "{repoRoot}"'
    },
    {
        id: 'review-invocation-to-result',
        producer_gate: 'record-review-invocation',
        producer_event: 'REVIEWER_INVOCATION_ATTESTED',
        consumer_gate: 'record-review-result',
        consumer_event: 'REVIEW_RECORDED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_invocation',
        artifact_suffix: '-{reviewType}-reviewer-launch.json',
        missing_remediation_command:
            '{cli} gate record-review-invocation --task-id "{taskId}" --review-type "{reviewType}" --review-context-path "{reviewContextPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent>" --reviewer-launch-artifact-path "<reviewer-launch.json>" --repo-root "{repoRoot}"'
    },
    {
        id: 'review-result-to-receipt',
        producer_gate: 'record-review-result',
        producer_event: 'REVIEW_RECORDED',
        consumer_gate: 'record-review-receipt',
        consumer_event: 'REVIEW_RECEIPT_RECORDED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_result',
        artifact_suffix: '-{reviewType}.md',
        missing_remediation_command:
            '{cli} gate record-review-result --task-id "{taskId}" --review-type "{reviewType}" --preflight-path "{preflightPath}" --review-output-path "<review-output.md>" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent>" --repo-root "{repoRoot}"'
    },
    {
        id: 'review-receipt-to-review-gate',
        producer_gate: 'record-review-receipt',
        producer_event: 'REVIEW_RECEIPT_RECORDED',
        consumer_gate: 'required-reviews-check',
        consumer_event: 'REVIEW_GATE_PASSED',
        same_task: true,
        same_cycle: true,
        lane_scope: 'review_type',
        artifact: 'review_receipt',
        artifact_suffix: '-{reviewType}-receipt.json',
        missing_remediation_command:
            '{cli} gate record-review-receipt --task-id "{taskId}" --review-type "{reviewType}" --preflight-path "{preflightPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent>" --repo-root "{repoRoot}"'
    }
]);

function normalizeGateName(gateName: string): string {
    return gateName.trim().toLowerCase();
}

export function getGateChainEdgesForConsumer(consumerGate: string): GateChainEdge[] {
    const normalizedConsumerGate = normalizeGateName(consumerGate);
    return GATE_CHAIN_MANIFEST
        .filter((edge) => normalizeGateName(edge.consumer_gate) === normalizedConsumerGate)
        .map((edge) => ({ ...edge }));
}

export function getGateChainEdgesForProducer(producerGate: string): GateChainEdge[] {
    const normalizedProducerGate = normalizeGateName(producerGate);
    return GATE_CHAIN_MANIFEST
        .filter((edge) => normalizeGateName(edge.producer_gate) === normalizedProducerGate)
        .map((edge) => ({ ...edge }));
}

export function getGateChainEdgeById(edgeId: string): GateChainEdge | null {
    const normalizedEdgeId = edgeId.trim().toLowerCase();
    const edge = GATE_CHAIN_MANIFEST.find((candidate) => candidate.id.toLowerCase() === normalizedEdgeId);
    return edge ? { ...edge } : null;
}

function renderGateChainCommand(template: string, context: GateChainCommandContext): string {
    const values: Record<string, string> = {
        cli: String(context.cliPrefix || DEFAULT_GATE_CLI_PREFIX),
        taskId: context.taskId,
        reviewType: String(context.reviewType || '<review-type>'),
        preflightPath: String(context.preflightPath || `garda-agent-orchestrator/runtime/reviews/${context.taskId}-preflight.json`),
        reviewContextPath: String(
            context.reviewContextPath
            || `garda-agent-orchestrator/runtime/reviews/${context.taskId}-${context.reviewType || '<review-type>'}-review-context.json`
        ),
        repoRoot: String(context.repoRoot || DEFAULT_REPO_ROOT_ARGUMENT),
        depth: String(context.depth || '2')
    };
    return template.replace(/\{([A-Za-z]+)\}/g, (match, key: string) => values[key] ?? match);
}

export function buildGateChainRemediationCommand(edge: GateChainEdge, context: GateChainCommandContext): string {
    return renderGateChainCommand(edge.missing_remediation_command, context);
}

export function buildGateChainLaunchDecision(options: {
    edgeId: string;
    status: GateChainLaunchDecision['status'];
    reason: string;
    context: GateChainCommandContext;
    evidencePaths?: readonly string[];
    remediationKind?: 'missing_producer' | 'stale_consumer';
}): GateChainLaunchDecision {
    const edge = getGateChainEdgeById(options.edgeId);
    const evidencePaths = [...(options.evidencePaths || [])].map((entry) => String(entry || '').trim()).filter(Boolean);
    const remediationTemplate = options.remediationKind === 'stale_consumer'
        ? edge?.stale_consumer_remediation_command
        : edge?.missing_remediation_command;
    return {
        status: options.status,
        edge_id: edge?.id || options.edgeId,
        reason: options.reason,
        next_command: edge && remediationTemplate && options.status === 'block'
            ? renderGateChainCommand(remediationTemplate, options.context)
            : null,
        evidence_paths: evidencePaths
    };
}

export function formatGateChainLaunchDecision(decision: GateChainLaunchDecision): string {
    const evidenceText = decision.evidence_paths.length > 0
        ? ` Evidence: ${decision.evidence_paths.join(', ')}.`
        : '';
    const nextCommandText = decision.next_command
        ? ` NextCommand: ${decision.next_command}.`
        : '';
    return `GateChain ${decision.edge_id} ${decision.status}: ${decision.reason}.${evidenceText}${nextCommandText}`;
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
