import {
    buildGuardedCommandHelpText,
    parseOptions,
    type PackageJsonLike
} from './cli-helpers';
import {
    WORKFLOW_SET_DEFINITIONS,
    WORKFLOW_SHARED_DEFINITIONS,
    type ParsedOptionsRecord,
    type WorkflowExplainResult,
    type WorkflowSetResult,
    type WorkflowShowResult,
    type WorkflowValidateResult
} from './workflow-command-types';
import {
    handleExplain,
    handleShow,
    handleValidate
} from './workflow-command-readonly';
import { handleSet } from './workflow-command-set';

export function handleWorkflow(
    commandArgv: string[],
    packageJson: PackageJsonLike
): WorkflowShowResult | WorkflowSetResult | WorkflowValidateResult | WorkflowExplainResult | null {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'show';
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;
    const optionDefinitions = subcommand === 'set'
        ? WORKFLOW_SET_DEFINITIONS
        : WORKFLOW_SHARED_DEFINITIONS;
    const { options } = parseOptions(subcommandArgv, optionDefinitions);

    if (options.help) { console.log(buildGuardedCommandHelpText('workflow')); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    switch (subcommand) {
        case 'show':
            return handleShow(options as ParsedOptionsRecord);
        case 'set':
            return handleSet(options as ParsedOptionsRecord);
        case 'validate':
            return handleValidate(options as ParsedOptionsRecord);
        case 'explain':
            return handleExplain(options as ParsedOptionsRecord);
        default:
            throw new Error(`Unknown workflow action: ${subcommand}. Allowed values: show, set, validate, explain.`);
    }
}
