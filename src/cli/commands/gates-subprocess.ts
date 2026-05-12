import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EXIT_GENERAL_FAILURE
} from '../exit-codes';
import {
    buildWindowsBatchCommandLine,
    spawnShellCommand,
    spawnStreamed,
    spawnSyncWithTimeout
} from '../../core/subprocess';
import { assertDependentValidationChainReady } from '../../core/dependent-validation-chains';

export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 600_000;

export interface ExecuteCommandOptions {
    cwd?: string;
    envPath?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal | null;
}

export interface AsyncCommandExecutionResult {
    exitCode: number;
    outputLines: string[];
    timedOut: boolean;
    cancelled: boolean;
}

export interface SyncCommandExecutionResult {
    exitCode: number;
    outputLines: string[];
    timedOut: boolean;
}

function splitOutputLines(text: unknown): string[] {
    if (!text) {
        return [];
    }
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

function buildSubprocessEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
    if (!overrides) {
        return undefined;
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
            env[key] = undefined;
        } else {
            env[key] = value;
        }
    }
    return env;
}

export function splitCommandLine(commandText: unknown): string[] {
    const text = String(commandText || '').trim();
    if (!text) {
        return [];
    }

    const tokens: string[] = [];
    let current = '';
    let quote = '';
    let escaping = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];

        if (escaping) {
            current += character;
            escaping = false;
            continue;
        }

        if (quote) {
            if (quote === '"' && character === '\\') {
                const nextCharacter = text[index + 1];
                if (nextCharacter === '"' || nextCharacter === '\\') {
                    escaping = true;
                    continue;
                }
            }
            if (character === quote) {
                quote = '';
            } else {
                current += character;
            }
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }

        if (/\s/.test(character)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += character;
    }

    if (escaping || quote) {
        throw new Error(`Command contains unterminated escaping or quotes: ${commandText}`);
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}

function findExecutableCandidate(candidatePath: string, extensions: string[]): string | null {
    if (path.extname(candidatePath)) {
        return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile() ? candidatePath : null;
    }
    for (const extension of extensions) {
        const resolved = `${candidatePath}${extension}`;
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }
    }
    return null;
}

export function resolveExecutablePath(executableName: unknown, cwd?: string, envPath?: string): string {
    const requested = String(executableName || '').trim();
    if (!requested) {
        throw new Error('Executable name must not be empty.');
    }

    const extensions = process.platform === 'win32'
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];

    if (path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) {
        const absoluteCandidate = path.isAbsolute(requested)
            ? requested
            : path.resolve(cwd || process.cwd(), requested);
        const resolved = findExecutableCandidate(absoluteCandidate, extensions);
        if (resolved) {
            return resolved;
        }
        throw new Error(`Executable not found: ${requested}`);
    }

    const pathValue = envPath != null ? envPath : (process.env.PATH || '');
    for (const dirPath of String(pathValue).split(path.delimiter)) {
        if (!dirPath) {
            continue;
        }
        const resolved = findExecutableCandidate(path.join(dirPath, requested), extensions);
        if (resolved) {
            return resolved;
        }
    }

    if (process.platform !== 'win32') {
        return requested;
    }
    throw new Error(`${requested} is required but was not found in PATH.`);
}

export async function executeCommandAsync(commandText: string, options: ExecuteCommandOptions = {}): Promise<AsyncCommandExecutionResult> {
    const cwd = options.cwd || process.cwd();
    const tokens = splitCommandLine(commandText);
    if (tokens.length === 0) {
        throw new Error('Command must not be empty.');
    }
    assertDependentValidationChainReady(tokens, cwd);

    const executablePath = resolveExecutablePath(tokens[0], cwd, options.envPath);
    const args = tokens.slice(1);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBPROCESS_TIMEOUT_MS;
    const env = buildSubprocessEnv(options.env);

    const result = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executablePath)
        ? await spawnShellCommand(executablePath, args, {
            cwd,
            env,
            timeoutMs,
            signal: options.signal ?? undefined
        })
        : await spawnStreamed(executablePath, args, {
            cwd,
            env,
            timeoutMs,
            signal: options.signal ?? undefined
        });

    if (result.timedOut) {
        return {
            exitCode: EXIT_GENERAL_FAILURE,
            outputLines: [
                ...splitOutputLines(result.stdout),
                ...splitOutputLines(result.stderr),
                `Process timed out after ${timeoutMs} ms.`
            ],
            timedOut: true,
            cancelled: false
        };
    }

    if (result.cancelled) {
        return {
            exitCode: EXIT_GENERAL_FAILURE,
            outputLines: [
                ...splitOutputLines(result.stdout),
                ...splitOutputLines(result.stderr),
                'Process was cancelled.'
            ],
            timedOut: false,
            cancelled: true
        };
    }

    return {
        exitCode: result.exitCode,
        outputLines: [
            ...splitOutputLines(result.stdout),
            ...splitOutputLines(result.stderr)
        ],
        timedOut: false,
        cancelled: false
    };
}

export function executeCommand(commandText: string, options: ExecuteCommandOptions = {}): SyncCommandExecutionResult {
    const cwd = options.cwd || process.cwd();
    const tokens = splitCommandLine(commandText);
    if (tokens.length === 0) {
        throw new Error('Command must not be empty.');
    }
    assertDependentValidationChainReady(tokens, cwd);

    const executablePath = resolveExecutablePath(tokens[0], cwd, options.envPath);
    const args = tokens.slice(1);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_SUBPROCESS_TIMEOUT_MS;
    const env = buildSubprocessEnv(options.env);

    const result = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executablePath)
        ? spawnSyncWithTimeout(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', buildWindowsBatchCommandLine(executablePath, args)], {
            cwd,
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs
        })
        : spawnSyncWithTimeout(executablePath, args, {
            cwd,
            env,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs
        });

    const outputLines = [
        ...splitOutputLines(result.stdout),
        ...splitOutputLines(result.stderr)
    ];

    if (result.timedOut) {
        return {
            exitCode: EXIT_GENERAL_FAILURE,
            outputLines: [...outputLines, `Process timed out after ${timeoutMs} ms.`],
            timedOut: true
        };
    }

    if (result.error) {
        const errorCode = 'code' in result.error ? (result.error as NodeJS.ErrnoException).code : undefined;
        if (errorCode === 'ENOENT') {
            throw new Error(`${tokens[0]} is required but was not found in PATH.`);
        }
        throw result.error;
    }

    return {
        exitCode: result.status == null ? EXIT_GENERAL_FAILURE : result.status,
        outputLines,
        timedOut: false
    };
}
