import type { ProjectMemoryBrief } from './preprompt-task-context';

export function buildPrepromptHelpText(): string {
    return [
        'Command: preprompt task',
        'Build a read-only JSON task brief with current workspace/task context and exact next commands.',
        '',
        'Usage:',
        '  garda preprompt task --task-id "<task-id>" --json --target-root "."',
        '  garda preprompt task --task-id "<task-id>" --target-root "."',
        '',
        'Options:',
        '  --task-id <task-id>        Required task id from TASK.md.',
        '  --json                     Emit machine-readable JSON.',
        '  --target-root <path>      Optional workspace root. Defaults to ".".',
        '  --init-answers-path <p>   Optional init-answers artifact path override.',
        '  -h, --help                Show this help and exit.'
    ].join('\n');
}

export function formatTaskBriefText(result: Record<string, unknown>): string {
    const task = result.task as Record<string, unknown>;
    const projectMemory = result.project_memory as ProjectMemoryBrief | undefined;
    const commands = result.commands as Record<string, unknown>;
    const optionalSkillTaskStartBlocker = getOptionalSkillTaskStartBlocker(result);
    const lines = [
        'GARDA_PREPROMPT_TASK',
        `Task: ${String(task?.id || '')}`,
        `CurrentStage: ${String(task?.current_stage || 'unknown')}`
    ];
    if (projectMemory) {
        lines.push(
            `ProjectMemoryStatus: ${projectMemory.status}`,
            `ProjectMemoryState: initialized=${projectMemory.initialization_state.initialized}; validated=${projectMemory.initialization_state.validated}; pending=${projectMemory.initialization_state.pending}`,
            `ProjectMemorySummaryRule: ${projectMemory.summary_rule}`,
            'ProjectMemoryReadFirst:',
            ...projectMemory.read_first.map((entry) => `  - ${entry}`),
            'ProjectMemorySuggested:',
            ...(projectMemory.suggested_files.length > 0
                ? projectMemory.suggested_files.map((entry) => `  - ${entry}`)
                : ['  none']),
            `ProjectMemoryFallback: ${projectMemory.unknown_custom_stack_fallback}`,
            'ProjectMemoryTaskStartGuidance:',
            ...projectMemory.task_start_guidance.map((entry) => `  - ${entry}`)
        );
        if (projectMemory.init_refresh_prompt) {
            lines.push(`ProjectMemoryInitRefreshPrompt: ${projectMemory.init_refresh_prompt}`);
        }
        if (projectMemory.warnings.length > 0) {
            lines.push(
                'ProjectMemoryWarnings:',
                ...projectMemory.warnings.map((entry) => `  - ${entry}`)
            );
        }
    }
    if (optionalSkillTaskStartBlocker) {
        lines.push(`OptionalSkillTaskStartBlocker: ${optionalSkillTaskStartBlocker}`);
    }
    const optionalSkillTaskStartInstruction = getOptionalSkillTaskStartInstruction(result);
    if (optionalSkillTaskStartInstruction) {
        lines.push(`OptionalSkillTaskStartInstruction: ${optionalSkillTaskStartInstruction}`);
    }
    const startupScopeBlocker = String(commands?.startup_scope_blocker || '').trim();
    if (startupScopeBlocker) {
        lines.push(`StartupScopeBlocker: ${startupScopeBlocker}`);
    }
    const startupCommands = Array.isArray(commands?.startup_commands) ? commands.startup_commands : [];
    lines.push(
        'StartupCommands:',
        ...(startupCommands.length > 0
            ? startupCommands.map((entry) => `  - ${String(entry)}`)
            : ['  none'])
    );
    const postImplementationCommands = Array.isArray(commands?.post_implementation_commands)
        ? commands.post_implementation_commands
        : [];
    if (postImplementationCommands.length > 0) {
        lines.push(
            'PostImplementationCommands:',
            ...postImplementationCommands.map((entry) => `  - ${String(entry)}`)
        );
    } else if (String(commands?.post_implementation_sequence_blocker || '').trim()) {
        lines.push(`PostImplementationBlocker: ${String(commands.post_implementation_sequence_blocker).trim()}`);
    }
    return `${lines.join('\n')}\n`;
}

export function getOptionalSkillTaskStartBlocker(result: Record<string, unknown>): string | null {
    const diagnostics = result.diagnostics;
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
        return null;
    }
    const optionalSkills = (diagnostics as Record<string, unknown>).optional_skills;
    if (!optionalSkills || typeof optionalSkills !== 'object' || Array.isArray(optionalSkills)) {
        return null;
    }
    const policyMode = String(
        (optionalSkills as Record<string, unknown>).current_policy_mode
        || (optionalSkills as Record<string, unknown>).policy_mode
        || ''
    ).trim().toLowerCase();
    const blocker = String((optionalSkills as Record<string, unknown>).blocker || '').trim();
    if (!blocker) {
        return null;
    }
    if (!policyMode) {
        return blocker;
    }
    if (policyMode !== 'required' && policyMode !== 'strict') {
        return null;
    }
    return blocker;
}

export function getOptionalSkillTaskStartInstruction(result: Record<string, unknown>): string | null {
    const diagnostics = result.diagnostics;
    if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
        return null;
    }
    const optionalSkills = (diagnostics as Record<string, unknown>).optional_skills;
    if (!optionalSkills || typeof optionalSkills !== 'object' || Array.isArray(optionalSkills)) {
        return null;
    }
    const instruction = String((optionalSkills as Record<string, unknown>).task_start_instruction || '').trim();
    return instruction || null;
}
