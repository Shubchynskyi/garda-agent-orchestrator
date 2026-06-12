import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import type { SpawnedProcessInfo } from '../../core/subprocess';
import type { FullSuiteValidationCycleBinding } from './full-suite-validation';
import { fileSha256, joinOrchestratorPath, normalizePath } from '../shared/helpers';

export interface FullSuiteValidationRunMarker {
    schema_version: 1;
    task_id: string;
    status: 'running';
    started_at_utc: string;
    updated_at_utc: string;
    repo_root: string;
    cwd: string;
    command: string;
    timeout_ms: number;
    gate_pid: number;
    child_pid: number | null;
    child_command: string | null;
    child_args: string[];
    child_shell: boolean | null;
    preflight_path: string;
    preflight_sha256: string;
    cycle_binding: FullSuiteValidationCycleBinding;
}

export interface FullSuiteValidationInterruptedRunSummary {
    markerPath: string;
    taskId: string;
    startedAtUtc: string;
    updatedAtUtc: string;
    command: string;
    timeoutMs: number;
    gatePid: number;
    gateProcessAlive: boolean;
    childPid: number | null;
    childProcessAlive: boolean | null;
    childCommand: string | null;
    descendantProcessCandidates: FullSuiteValidationProcessCandidate[];
    processScanWarning: string | null;
    preflightPath: string;
    preflightSha256: string;
}

export interface FullSuiteValidationProcessCandidate {
    pid: number;
    parentPid: number | null;
    commandLine: string;
}

export interface FullSuiteValidationProcessTableSnapshot {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
}

export interface FullSuiteValidationRunMarkerInspectionOptions {
    isProcessAlive?: (pid: number | null | undefined) => boolean;
    processTableSnapshot?: FullSuiteValidationProcessTableSnapshot;
}

interface WriteRunMarkerOptions {
    repoRoot: string;
    taskId: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    cycleBinding: FullSuiteValidationCycleBinding;
}

export function resolveFullSuiteValidationRunMarkerPath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-full-suite-run-marker.json`));
}

export function writeFullSuiteValidationRunMarker(options: WriteRunMarkerOptions): FullSuiteValidationRunMarker {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(options.repoRoot, options.taskId);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const now = new Date().toISOString();
    const marker: FullSuiteValidationRunMarker = {
        schema_version: 1,
        task_id: options.taskId,
        status: 'running',
        started_at_utc: now,
        updated_at_utc: now,
        repo_root: normalizePath(path.resolve(options.repoRoot)),
        cwd: normalizePath(path.resolve(options.cwd)),
        command: options.command,
        timeout_ms: options.timeoutMs,
        gate_pid: process.pid,
        child_pid: null,
        child_command: null,
        child_args: [],
        child_shell: null,
        preflight_path: options.cycleBinding.preflight_path,
        preflight_sha256: options.cycleBinding.preflight_sha256,
        cycle_binding: options.cycleBinding
    };
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    return marker;
}

export function updateFullSuiteValidationRunMarkerChildProcess(
    repoRoot: string,
    taskId: string,
    child: SpawnedProcessInfo
): void {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
    if (!fs.existsSync(markerPath)) {
        return;
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as FullSuiteValidationRunMarker;
    marker.updated_at_utc = new Date().toISOString();
    marker.child_pid = child.pid;
    marker.child_command = child.command;
    marker.child_args = child.args.map(String);
    marker.child_shell = child.shell;
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

export function clearFullSuiteValidationRunMarker(repoRoot: string, taskId: string): void {
    fs.rmSync(resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId), { force: true });
}

export function readInterruptedFullSuiteValidationRunMarker(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256?: string | null,
    expectedCompileGateTimestamp?: string | null,
    inspectionOptions: FullSuiteValidationRunMarkerInspectionOptions = {}
): FullSuiteValidationInterruptedRunSummary | null {
    const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
    if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
        return null;
    }

    let marker: FullSuiteValidationRunMarker;
    try {
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as FullSuiteValidationRunMarker;
    } catch (_error) {
        return null;
    }

    if (marker.schema_version !== 1 || marker.task_id !== taskId || marker.status !== 'running') {
        return null;
    }

    const expectedPreflightPath = normalizePath(path.resolve(preflightPath));
    const markerPreflightPath = normalizePath(path.resolve(repoRoot, marker.preflight_path));
    const expectedPreflightSha256 = preflightSha256 || fileSha256(preflightPath) || '';
    if (markerPreflightPath !== expectedPreflightPath || marker.preflight_sha256 !== expectedPreflightSha256) {
        return null;
    }
    if (
        expectedCompileGateTimestamp
        && marker.cycle_binding.compile_gate_timestamp !== expectedCompileGateTimestamp
    ) {
        return null;
    }

    const checkProcessAlive = inspectionOptions.isProcessAlive || isProcessAlive;
    const gateProcessAlive = checkProcessAlive(marker.gate_pid);
    const processScan = findDescendantProcessCandidates(marker.child_pid, inspectionOptions.processTableSnapshot);
    return {
        markerPath: normalizePath(markerPath),
        taskId,
        startedAtUtc: marker.started_at_utc,
        updatedAtUtc: marker.updated_at_utc,
        command: marker.command,
        timeoutMs: marker.timeout_ms,
        gatePid: marker.gate_pid,
        gateProcessAlive,
        childPid: marker.child_pid,
        childProcessAlive: marker.child_pid == null ? null : checkProcessAlive(marker.child_pid),
        childCommand: marker.child_command,
        descendantProcessCandidates: processScan.candidates,
        processScanWarning: processScan.warning,
        preflightPath: marker.preflight_path,
        preflightSha256: marker.preflight_sha256
    };
}

function isProcessAlive(pid: number | null | undefined): boolean {
    if (!Number.isInteger(pid) || Number(pid) <= 0) {
        return false;
    }
    try {
        process.kill(Number(pid), 0);
        return true;
    } catch (_error) {
        return false;
    }
}

function findDescendantProcessCandidates(
    rootPid: number | null | undefined,
    processTableSnapshot?: FullSuiteValidationProcessTableSnapshot
): {
    candidates: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    if (!Number.isInteger(rootPid) || Number(rootPid) <= 0) {
        return { candidates: [], warning: null };
    }
    const table = processTableSnapshot || readProcessTable();
    if (table.warning) {
        return { candidates: [], warning: table.warning };
    }
    const byParent = new Map<number, FullSuiteValidationProcessCandidate[]>();
    for (const entry of table.entries) {
        if (entry.parentPid == null) {
            continue;
        }
        const siblings = byParent.get(entry.parentPid) || [];
        siblings.push(entry);
        byParent.set(entry.parentPid, siblings);
    }

    const candidates: FullSuiteValidationProcessCandidate[] = [];
    const seen = new Set<number>();
    const pending = [Number(rootPid)];
    while (pending.length > 0) {
        const parentPid = pending.shift()!;
        for (const child of byParent.get(parentPid) || []) {
            if (seen.has(child.pid)) {
                continue;
            }
            seen.add(child.pid);
            candidates.push(child);
            pending.push(child.pid);
        }
    }
    return { candidates, warning: null };
}

function readProcessTable(): {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    try {
        return process.platform === 'win32'
            ? readWindowsProcessTable()
            : readPosixProcessTable();
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            entries: [],
            warning: `Unable to scan live process descendants: ${message}`
        };
    }
}

function readWindowsProcessTable(): {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    const output = childProcess.execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
    });
    const parsed = JSON.parse(output || '[]') as unknown;
    return {
        entries: parseWindowsProcessRows(parsed),
        warning: null
    };
}

export function parseWindowsProcessRows(rowsValue: unknown): FullSuiteValidationProcessCandidate[] {
    const rows = Array.isArray(rowsValue) ? rowsValue : [rowsValue];
    return rows
        .map(parseWindowsProcessRow)
        .filter((entry): entry is FullSuiteValidationProcessCandidate => entry !== null);
}

function parseWindowsProcessRow(row: unknown): FullSuiteValidationProcessCandidate | null {
    if (!row || typeof row !== 'object') {
        return null;
    }
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    const parentPid = Number(record.ParentProcessId);
    return {
        pid,
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        commandLine: String(record.CommandLine || '').trim()
    };
}

function readPosixProcessTable(): {
    entries: FullSuiteValidationProcessCandidate[];
    warning: string | null;
} {
    const output = childProcess.execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
        encoding: 'utf8',
        timeout: 5000
    });
    const entries = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parsePosixProcessLine)
        .filter((entry): entry is FullSuiteValidationProcessCandidate => entry !== null);
    return { entries, warning: null };
}

function parsePosixProcessLine(line: string): FullSuiteValidationProcessCandidate | null {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) {
        return null;
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    return {
        pid,
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
        commandLine: match[3].trim()
    };
}
