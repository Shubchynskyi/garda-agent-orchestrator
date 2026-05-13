import { resolveBundleName } from './constants';

export function buildTaskStartNavigatorPrompt(taskId = '<task-id>'): string {
    return `Execute task ${taskId} from TASK.md strictly through the orchestrator. Use \`next-step\` as the navigator; when independent review is required, launch a sub-agent using your internal tools.`;
}

export function buildActiveProfileGuidance(activeProfile?: string | null, cliCommand = 'node bin/garda.js'): string {
    const prefix = activeProfile
        ? `Current active profile: ${activeProfile}.`
        : 'Active profile selection comes from the workspace profile config.';
    return `${prefix} Inspect, switch, or create profiles with \`${cliCommand} profile current|list|use|create --target-root "."\`.`;
}

export function buildDualCliActiveProfileGuidance(activeProfile?: string | null): string {
    const prefix = activeProfile
        ? `Current active profile: ${activeProfile}.`
        : 'Active profile selection comes from the workspace profile config.';
    return `${prefix} Inspect, switch, or create profiles with \`node bin/garda.js profile current|list|use|create --target-root "."\` in a self-hosted source checkout, or \`node ${resolveBundleName()}/bin/garda.js profile current|list|use|create --target-root "."\` inside a materialized/deployed workspace.`;
}

export function buildNextStepNavigatorGuidance(cliCommand = 'node bin/garda.js'): string {
    return `Run \`${cliCommand} next-step "<task-id>" --repo-root "."\` before the first gate, after every suggested command, and after any gate failure. Follow only the single command it prints.`;
}

export function buildFullSuiteDisabledGuidance(cliCommand = 'node bin/garda.js'): string {
    return `Full repository test validation after each task is currently disabled. Do not silently enable it; ask for explicit permission or show: \`${cliCommand} workflow set --full-suite-enabled true --full-suite-command "<project test command>" --target-root "."\`. If a valid command is already configured, use \`${cliCommand} workflow set --full-suite-enabled true --target-root "."\`.`;
}
