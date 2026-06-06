export interface FullSuiteValidationCommandOptions {
    taskId?: unknown;
    preflightPath?: unknown;
    repoRoot?: unknown;
}

export interface FullSuiteValidationCommandResult {
    outputText: string;
    exitCode: number;
}
