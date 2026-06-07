import * as path from 'node:path';

import { getGateHelpEntry } from '../gate-command-help';

function toPortableRepoPath(targetRoot: string, filePath: string): string {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const resolvedFilePath = path.resolve(filePath);
    const relative = path.relative(resolvedTargetRoot, resolvedFilePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.replace(/\\/g, '/');
    }
    return filePath.replace(/\\/g, '/');
}

export function sanitizeCliValue(value: string): string {
    return String(value || '').replace(/"/g, '\'').trim();
}

export function hydrateGateUsage(
    gateName: string,
    repoRoot: string,
    replacements: Record<string, string>
): string {
    const entry = getGateHelpEntry(gateName, repoRoot);
    let usage = entry.usage[0];
    for (const [placeholder, nextValue] of Object.entries(replacements)) {
        usage = usage.split(placeholder).join(nextValue);
    }
    return usage;
}

export function buildClassifyChangeCommand(
    repoRoot: string,
    taskId: string,
    taskSummary: string,
    changedFiles: string[],
    stagedWorkspaceChangedFilesCount: number
): string {
    const gateHelp = getGateHelpEntry('classify-change', repoRoot);
    const explicitScopeCommand = hydrateGateUsage('classify-change', repoRoot, {
        '<task-id>': taskId,
        '<task summary>': sanitizeCliValue(taskSummary)
    });
    if (changedFiles.length > 0) {
        const changedFileArgs = changedFiles
            .map((filePath) => ` --changed-file "${filePath}"`)
            .join('');
        return explicitScopeCommand.replace('--changed-file "src/<file>"', changedFileArgs.trimStart());
    }
    if (stagedWorkspaceChangedFilesCount > 0) {
        return gateHelp.usage[1]
            .split('<task-id>').join(taskId)
            .split('<task summary>').join(sanitizeCliValue(taskSummary));
    }
    return explicitScopeCommand;
}

export function readRulePackStageFilesFromPayload(
    payload: Record<string, unknown> | null,
    stageKey: 'task_entry' | 'post_preflight'
): string[] {
    const stages = payload?.stages;
    if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
        return [];
    }
    const stagePayload = (stages as Record<string, unknown>)[stageKey];
    if (!stagePayload || typeof stagePayload !== 'object' || Array.isArray(stagePayload)) {
        return [];
    }
    const loadedRuleFiles = (stagePayload as Record<string, unknown>).loaded_rule_files;
    if (!Array.isArray(loadedRuleFiles)) {
        return [];
    }
    return loadedRuleFiles
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
}

export function buildLoadRulePackCommand(
    repoRoot: string,
    taskId: string,
    targetRoot: string,
    stage: 'TASK_ENTRY' | 'POST_PREFLIGHT',
    loadedRuleFiles: string[]
): string {
    const gateHelp = getGateHelpEntry('load-rule-pack', repoRoot);
    const usageIndex = stage === 'TASK_ENTRY' ? 0 : 1;
    let command = gateHelp.usage[usageIndex].split('<task-id>').join(taskId);
    if (stage === 'POST_PREFLIGHT') {
        const defaultPreflightPath = path.join(targetRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-preflight.json`);
        command = command.replace(
            /--preflight-path "[^"]+"/,
            `--preflight-path "${toPortableRepoPath(targetRoot, defaultPreflightPath)}"`
        );
        command = command.replace(/ --loaded-rule-file "<task-specific-downstream-rule-file>"/g, '');
        command = command.replace(/ --loaded-rule-file "<additional-task-specific-rule-file>"/g, '');
    }
    if (loadedRuleFiles.length === 0) {
        return command;
    }
    const normalizedRuleFileArgs = loadedRuleFiles
        .map((ruleFile) => ` --loaded-rule-file "${toPortableRepoPath(targetRoot, ruleFile)}"`)
        .join('');
    command = command.replace(/ --loaded-rule-file "[^"]+"/g, '');
    return command.replace(' --repo-root "."', `${normalizedRuleFileArgs} --repo-root "."`);
}

export function buildStartupScopeBlocker(
    changedFiles: string[],
    workspaceChangedFilesCount: number,
    stagedWorkspaceChangedFilesCount: number
): string | null {
    if (changedFiles.length > 0 || workspaceChangedFilesCount <= 0 || stagedWorkspaceChangedFilesCount > 0) {
        return null;
    }
    return 'Workspace is already dirty, but no reusable preflight scope or staged-only task diff was detected. Enter task mode first, then rerun classify-change with explicit --changed-file entries or stage only the intended task diff before using --use-staged.';
}

export function buildOptionalSkillActivationCommand(repoRoot: string, taskId: string, skillId: string): string {
    return getGateHelpEntry('activate-optional-skill', repoRoot).usage[0]
        .split('<task-id>').join(taskId)
        .split('<selected-skill-id>').join(skillId);
}

export function buildStartupCommands(
    repoRoot: string,
    targetRoot: string,
    taskId: string,
    taskSummary: string,
    provider: string,
    depth: number,
    orchestratorWork: boolean,
    changedFiles: string[],
    stagedWorkspaceChangedFilesCount: number,
    taskEntryRuleFiles: string[],
    postPreflightRuleFiles: string[]
): string[] {
    const enterTaskModeBase = hydrateGateUsage('enter-task-mode', repoRoot, {
        '<task-id>': taskId,
        '<1|2|3>': String(depth),
        '<task summary>': sanitizeCliValue(taskSummary),
        '<runtime-provider>': provider,
        '<provider>': provider
    });
    const enterTaskModeCommand = orchestratorWork
        ? enterTaskModeBase.replace('--provider', '--orchestrator-work --provider')
        : enterTaskModeBase;

    return [
        enterTaskModeCommand,
        buildLoadRulePackCommand(repoRoot, taskId, targetRoot, 'TASK_ENTRY', taskEntryRuleFiles),
        hydrateGateUsage('handshake-diagnostics', repoRoot, {
            '<task-id>': taskId,
            '<runtime-provider>': provider
        }),
        hydrateGateUsage('shell-smoke-preflight', repoRoot, {
            '<task-id>': taskId,
            '<runtime-provider>': provider
        }),
        buildClassifyChangeCommand(repoRoot, taskId, taskSummary, changedFiles, stagedWorkspaceChangedFilesCount),
        buildLoadRulePackCommand(repoRoot, taskId, targetRoot, 'POST_PREFLIGHT', postPreflightRuleFiles)
    ];
}

export function buildPostImplementationCommands(
    repoRoot: string,
    taskId: string,
    requiredReviewTypes: string[],
    depth: number
): string[] {
    const taskAuditSummaryUsage = getGateHelpEntry('task-audit-summary', repoRoot).usage[1];
    const buildReviewContextUsage = getGateHelpEntry('build-review-context', repoRoot).usage[0];
    const commands = [
        hydrateGateUsage('compile-gate', repoRoot, { '<task-id>': taskId })
    ];
    for (const reviewType of requiredReviewTypes) {
        commands.push(
            buildReviewContextUsage
                .split('<task-id>').join(taskId)
                .split('<1|2|3>').join(String(depth))
                .replace('"<code|db|security|refactor|api|test|performance|infra|dependency>"', `"${reviewType}"`)
        );
    }
    commands.push(
        hydrateGateUsage('required-reviews-check', repoRoot, { '<task-id>': taskId }),
        hydrateGateUsage('doc-impact-gate', repoRoot, {
            '<task-id>': taskId,
            '<why>': 'Update the rationale for the actual behavior/doc impact.'
        }),
        hydrateGateUsage('completion-gate', repoRoot, { '<task-id>': taskId }),
        taskAuditSummaryUsage.split('<task-id>').join(taskId)
    );
    return commands;
}
