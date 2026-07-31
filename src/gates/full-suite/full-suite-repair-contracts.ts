import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../core/constants';
import { normalizePath } from '../shared/helpers';
import { buildOperatorNextActionBlock } from '../shared/operator-action-output';

export const REPAIR_ARTIFACT_SCHEMA_VERSION = 2;
export const WIP_MANIFEST_SCHEMA_VERSION = 3;

export interface FullSuiteRepairTaskProposal {
    suggested_task_id: string;
    title: string;
    area: string;
    rationale: string;
}

export interface RepairTaskProposalReadResult {
    proposal: FullSuiteRepairTaskProposal | null;
    violations: string[];
}

export interface FullSuiteRepairTaskMaterializationResult {
    status: 'MATERIALIZED' | 'ALREADY_MATERIALIZED' | 'BLOCKED';
    task_id: string;
    child_task_id: string | null;
    child_task_ids: string[];
    artifact_path: string;
    wip_manifest_path: string | null;
    split_required_artifact_path: string | null;
    violations: string[];
    output_lines: string[];
}

export interface MaterializeFullSuiteRepairTaskParams {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    fullSuiteArtifactPath?: string;
    reviewsRoot?: string;
}

export interface FullSuiteRepairWipRestoreResult {
    status: 'RESTORED' | 'DRY_RUN_OK' | 'BLOCKED';
    manifest_path: string;
    restored_files: string[];
    violations: string[];
    output_lines: string[];
}

export interface RestoreFullSuiteRepairWipParams {
    repoRoot: string;
    taskId: string;
    fullSuiteArtifactPath: string;
    manifestPath: string;
    childTaskId?: string | null;
    reviewsRoot?: string;
    dryRun?: boolean;
}

export interface CapturedPatchEvidence {
    path: string;
    sha256: string;
    bytes: number;
    empty: boolean;
}

export interface PatchPathRecord {
    paths: string[];
}

export interface RestorePatchSnapshots {
    staged: Buffer | null;
    unstaged: Buffer | null;
}

export interface RestoreMutationInspection {
    violations: string[];
    patchSnapshots: RestorePatchSnapshots;
}

export interface CapturedTrackedFileEvidence {
    path: string;
    head_sha256: string | null;
    worktree_sha256: string | null;
    staged: boolean;
    unstaged: boolean;
}

export interface CapturedUntrackedFileEvidence {
    path: string;
    artifact_path: string;
    sha256: string;
    bytes: number;
    mode: number;
}

export interface RepairWipManifest {
    schema_version: number;
    kind: 'full_suite_repair_wip';
    status: 'suspended';
    task_id: string;
    child_task_ids: string[];
    created_at_utc: string;
    base_commit: string;
    preflight_path: string;
    preflight_sha256: string;
    full_suite_artifact_path: string;
    full_suite_artifact_sha256: string;
    patches: {
        staged: CapturedPatchEvidence;
        unstaged: CapturedPatchEvidence;
    };
    tracked_files: CapturedTrackedFileEvidence[];
    untracked_files: CapturedUntrackedFileEvidence[];
    unrelated_untracked_files: string[];
}

export interface TaskQueueRowsMaterializationResult {
    outcome: string;
    task_path: string;
    parent_linked: boolean;
    child_created: boolean;
    error_message: string | null;
}

export interface ParentResumeStatusResult {
    outcome: 'updated' | 'already_synced' | 'task_file_missing' | 'task_not_found' | 'blocked_status' | 'write_failed';
    task_path: string;
    task_id: string;
    previous_status: string | null;
    next_status: 'IN_PROGRESS';
    error_message: string | null;
}

export interface TrackedChangeFiles {
    staged: Set<string>;
    unstaged: Set<string>;
    all: string[];
}

export interface PreflightChangedFileScope {
    allowed: Set<string>;
    violations: string[];
}

export function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

export function buildNextStepCommand(repoRoot: string, taskId: string | null | undefined): string | null {
    const normalizedTaskId = String(taskId || '').trim();
    return normalizedTaskId
        ? `${buildCliPrefix(repoRoot)} next-step "${normalizedTaskId}" --repo-root "."`
        : null;
}

export function quoteCommandValue(value: string): string {
    return `'${normalizePath(value).replace(/'/g, `''`)}'`;
}

export function toRepoRelativeCommandPath(repoRoot: string, filePath: string): string {
    const relativePath = path.relative(repoRoot, filePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return normalizePath(filePath);
    }
    return normalizePath(relativePath);
}

export function buildRestoreFullSuiteRepairWipCommand(params: {
    repoRoot: string;
    taskId: string;
    fullSuiteArtifactPath: string;
    manifestPath: string;
    childTaskId?: string | null;
}): string {
    const parts = [
        `${buildCliPrefix(params.repoRoot)} gate restore-full-suite-repair-wip`,
        '--task-id', quoteCommandValue(params.taskId),
        '--full-suite-artifact-path', quoteCommandValue(toRepoRelativeCommandPath(params.repoRoot, params.fullSuiteArtifactPath)),
        '--manifest-path', quoteCommandValue(toRepoRelativeCommandPath(params.repoRoot, params.manifestPath))
    ];
    const normalizedChildTaskId = String(params.childTaskId || '').trim();
    if (normalizedChildTaskId) {
        parts.push('--child-task-id', quoteCommandValue(normalizedChildTaskId));
    }
    parts.push('--repo-root', quoteCommandValue('.'));
    return parts.join(' ');
}

export function formatFullSuiteRepairOutput(params: {
    repoRoot: string;
    taskId?: string | null;
    gate?: string | null;
    status: string;
    action: string;
    reason?: string | null;
    command?: string | null;
    commandReference?: string | null;
    detailsPath?: string | null;
    detailsHint?: string | null;
    legacyLines: string[];
}): string[] {
    const explicitCommand = Object.prototype.hasOwnProperty.call(params, 'command')
        ? params.command || null
        : undefined;
    const command = explicitCommand === undefined && params.status !== 'BLOCKED'
        ? buildNextStepCommand(params.repoRoot, params.taskId)
        : explicitCommand || null;
    const commandReference = !command && params.status === 'BLOCKED'
        ? params.commandReference || 'resolve blockers listed in details before retrying'
        : params.commandReference;
    return [
        ...buildOperatorNextActionBlock({
            status: params.status,
            gate: params.gate || 'full-suite-repair-task',
            action: params.action,
            reason: params.reason,
            command,
            commandReference,
            detailsPath: params.detailsPath,
            detailsHint: params.detailsHint
        }),
        '',
        ...params.legacyLines
    ];
}

export function nowIso(): string {
    return new Date().toISOString();
}

export function stableTimestampSlug(timestampUtc: string): string {
    return timestampUtc.replace(/[^0-9A-Za-z]+/gu, '-').replace(/^-|-$/gu, '');
}

export function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function sha256FileRequired(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function validateTaskTableTextField(value: unknown, fieldName: string): { value: string | null; violations: string[] } {
    const text = String(value || '').trim();
    const violations: string[] = [];
    if (!text) {
        violations.push(`repair_task_proposal.${fieldName} must not be empty.`);
        return { value: null, violations };
    }
    if (/[\u0000-\u001F\u007F|]/u.test(text)) {
        violations.push(`repair_task_proposal.${fieldName} must not contain control characters or Markdown table delimiters.`);
        return { value: null, violations };
    }
    return { value: text, violations };
}

export function validateRepairChildTaskId(value: unknown, parentTaskId: string): { value: string | null; violations: string[] } {
    const text = String(value || '').trim();
    if (!text) {
        return {
            value: null,
            violations: ['repair_task_proposal.suggested_task_id must not be empty.']
        };
    }
    const expectedPattern = new RegExp(`^${escapeRegExp(parentTaskId)}-F[1-9][0-9]*$`, 'u');
    if (!expectedPattern.test(text)) {
        return {
            value: null,
            violations: [`repair_task_proposal.suggested_task_id must match ${parentTaskId}-F<number>.`]
        };
    }
    return { value: text, violations: [] };
}

export function fileBytes(filePath: string): number {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? fs.statSync(filePath).size
        : 0;
}

export function normalizeGitPath(value: string): string {
    return value.replace(/\\/gu, '/').replace(/^\/+/u, '');
}

export function resolveRepoPath(repoRoot: string, relativePath: string): string {
    const normalized = normalizeGitPath(relativePath);
    const resolved = path.resolve(repoRoot, normalized);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Path escapes repo root: ${relativePath}`);
    }
    return resolved;
}
