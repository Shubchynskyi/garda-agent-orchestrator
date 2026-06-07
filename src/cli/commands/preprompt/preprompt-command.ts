import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    PackageJsonLike,
    parseOptions
} from '../cli-helpers';
import { resolveTargetRoot } from '../workspace-helpers';
import type { ParsedOptionsRecord } from '../shared-command-utils';
import { buildTaskBrief } from './preprompt-task-context';
import {
    buildPrepromptHelpText,
    formatTaskBriefText,
    getOptionalSkillTaskStartBlocker
} from './preprompt-task-format';

export function handlePreprompt(commandArgv: string[], packageJson: PackageJsonLike): void {
    if (commandArgv.length === 0 || commandArgv[0] === '--help' || commandArgv[0] === '-h') {
        console.log(buildPrepromptHelpText());
        return;
    }

    const subcommand = String(commandArgv[0] || '').trim().toLowerCase();
    if (subcommand !== 'task') {
        throw new Error(`Unsupported preprompt subcommand: ${commandArgv[0]}`);
    }

    const definitions = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--json': { key: 'json', type: 'boolean' },
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(commandArgv.slice(1), definitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help === true) {
        console.log(buildPrepromptHelpText());
        return;
    }
    if (options.version === true) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = resolveTargetRoot(options.targetRoot);
    const taskId = String(options.taskId || '').trim();
    if (!taskId) {
        throw new Error('TaskId must not be empty.');
    }

    const result = buildTaskBrief(
        targetRoot,
        taskId,
        typeof options.initAnswersPath === 'string' ? options.initAnswersPath : undefined
    );
    const optionalSkillTaskStartBlocker = getOptionalSkillTaskStartBlocker(result);
    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        if (optionalSkillTaskStartBlocker) {
            process.exitCode = EXIT_GATE_FAILURE;
        }
        return;
    }
    console.log(formatTaskBriefText(result));
    if (optionalSkillTaskStartBlocker) {
        process.exitCode = EXIT_GATE_FAILURE;
    }
}
