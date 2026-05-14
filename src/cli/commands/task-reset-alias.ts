import { PRIMARY_CLI_NAME } from '../../core/constants';
import { isCanonicalTaskId } from '../../core/task-ids';

export interface TaskResetAliasResolution {
    commandArgv: string[];
    invokedCommand: string;
}

const TASK_RESET_PLACEHOLDER = '<task-id>';

function normalizeToken(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function compactToken(value: unknown): string {
    return normalizeToken(value).replace(/[_\-\s]+/g, '');
}

function normalizeTaskResetTaskIdHint(taskId: string): string {
    return /^t-\d+(?:-\d+)*$/iu.test(taskId) ? taskId.toUpperCase() : taskId;
}

function isTaskResetPositionalTaskId(value: unknown): boolean {
    const token = String(value || '').trim();
    return token.length > 0 && !token.startsWith('-') && isCanonicalTaskId(token);
}

function normalizeAliasArgv(argv: string[]): string[] {
    if (argv.some((arg) => arg === '--task-id' || arg.startsWith('--task-id='))) {
        return argv;
    }
    const [first, ...rest] = argv;
    if (isTaskResetPositionalTaskId(first)) {
        return ['--task-id', normalizeTaskResetTaskIdHint(first.trim()), ...rest];
    }
    return argv;
}

export function extractTaskResetTaskIdHint(argv: string[]): string {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--task-id') {
            const next = String(argv[index + 1] || '').trim();
            return next || TASK_RESET_PLACEHOLDER;
        }
        if (arg.startsWith('--task-id=')) {
            const value = arg.slice('--task-id='.length).trim();
            return value || TASK_RESET_PLACEHOLDER;
        }
    }

    const positionalTaskId = argv.find((arg) => isTaskResetPositionalTaskId(arg));
    return positionalTaskId ? normalizeTaskResetTaskIdHint(positionalTaskId.trim()) : TASK_RESET_PLACEHOLDER;
}

export function buildTaskResetGuardedCommandHelp(taskId: string = TASK_RESET_PLACEHOLDER): string {
    return [
        `  ${PRIMARY_CLI_NAME} gate task-reset --task-id "${taskId}" --reopen --dry-run --repo-root "."`,
        `  ${PRIMARY_CLI_NAME} gate task-reset --task-id "${taskId}" --reopen --confirm --repo-root "."`,
        `  ${PRIMARY_CLI_NAME} gate task-reset --task-id "${taskId}" --discard --confirm --repo-root "."`
    ].join('\n');
}

export function buildTaskResetCommandRemediation(invokedCommand: string, argv: string[] = []): string {
    const taskId = extractTaskResetTaskIdHint(argv);
    return [
        `Unsupported command: ${invokedCommand}`,
        'Use the guarded task reset gate instead:',
        buildTaskResetGuardedCommandHelp(taskId)
    ].join('\n');
}

export function buildTaskResetMissingTaskIdMessage(): string {
    return [
        'TaskId must not be empty.',
        'Use one of:',
        buildTaskResetGuardedCommandHelp()
    ].join('\n');
}

export function resolveTaskResetAlias(argv: string[]): TaskResetAliasResolution | null {
    const first = normalizeToken(argv[0]);
    const second = normalizeToken(argv[1]);
    if (first === 'task-reset') {
        return {
            commandArgv: normalizeAliasArgv(argv.slice(1)),
            invokedCommand: 'task-reset'
        };
    }
    if (first === 'task' && second === 'reset') {
        return {
            commandArgv: normalizeAliasArgv(argv.slice(2)),
            invokedCommand: 'task reset'
        };
    }
    return null;
}

export function buildTaskResetNearMissError(argv: string[]): string | null {
    const first = normalizeToken(argv[0]);
    const second = normalizeToken(argv[1]);
    const firstCompact = compactToken(first);
    const secondCompact = compactToken(second);

    if (firstCompact === 'taskreset' || firstCompact === 'resettask') {
        return buildTaskResetCommandRemediation(first || String(argv[0] || ''), argv.slice(1));
    }
    if ((first === 'task' || first === 'tasks') && (secondCompact === 'taskreset' || secondCompact === 'resettask')) {
        return buildTaskResetCommandRemediation(`${first} ${second}`.trim(), argv.slice(2));
    }
    if (first === 'tasks' && second === 'reset') {
        return buildTaskResetCommandRemediation('tasks reset', argv.slice(2));
    }
    return null;
}
