import type * as childProcess from 'node:child_process';

export interface GitCommandTrace<T> {
    commands: string[][];
    value: T;
}

function gitCommandArgs(file: string, args: readonly string[] | undefined): string[] | null {
    if (file !== 'git' || !Array.isArray(args)) {
        return null;
    }
    const normalizedArgs = args.map(String);
    return normalizedArgs[0] === '-C'
        ? normalizedArgs.slice(2)
        : normalizedArgs;
}

export function traceGitCommands<T>(action: () => T): GitCommandTrace<T> {
    const childProcessModule = require('node:child_process') as typeof import('node:child_process');
    const originalExecFileSync = childProcessModule.execFileSync;
    const originalSpawnSync = childProcessModule.spawnSync;
    const commands: string[][] = [];
    childProcessModule.execFileSync = ((
        file: string,
        args?: readonly string[],
        options?: childProcess.ExecFileSyncOptions
    ) => {
        const commandArgs = gitCommandArgs(file, args);
        if (commandArgs) {
            commands.push(commandArgs);
        }
        return Reflect.apply(originalExecFileSync, childProcessModule, [file, args, options]);
    }) as typeof childProcessModule.execFileSync;
    childProcessModule.spawnSync = ((
        file: string,
        args?: readonly string[],
        options?: childProcess.SpawnSyncOptions
    ) => {
        const commandArgs = gitCommandArgs(file, args);
        if (commandArgs) {
            commands.push(commandArgs);
        }
        return Reflect.apply(originalSpawnSync, childProcessModule, [file, args, options]);
    }) as typeof childProcessModule.spawnSync;
    try {
        return { commands, value: action() };
    } finally {
        childProcessModule.execFileSync = originalExecFileSync;
        childProcessModule.spawnSync = originalSpawnSync;
    }
}
