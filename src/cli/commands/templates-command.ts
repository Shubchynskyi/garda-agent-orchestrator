import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import {
    MESSAGE_TEMPLATE_DEFINITIONS,
    buildEffectiveMessageTemplate,
    ensureMessageTemplateUserOverride,
    listEffectiveMessageTemplates,
    resetMessageTemplateUserOverride,
    validateEffectiveMessageTemplates,
    type EffectiveMessageTemplate,
    type MessageTemplatesValidationResult
} from '../../core/templates';
import {
    buildGuardedCommandHelpText,
    normalizePathValue,
    parseOptions,
    type PackageJsonLike
} from './cli-helpers';

type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

interface TemplatesCommandRoots {
    targetRoot: string;
    bundleRoot: string;
}

interface TemplatesBaseResult {
    action: string;
    target_root: string;
    bundle_root: string;
}

interface TemplatesListResult extends TemplatesBaseResult {
    action: 'list';
    templates: Array<{
        template_id: string;
        title: string;
        format: string;
        user_override_path: string;
        user_override_exists: boolean;
        validation_status: string;
    }>;
}

interface TemplatesShowResult extends TemplatesBaseResult {
    action: 'show';
    template: EffectiveMessageTemplate;
}

interface TemplatesPathResult extends TemplatesBaseResult {
    action: 'path';
    template_id: string;
    builtin_path: string;
    user_override_path: string;
    user_override_exists: boolean;
}

interface TemplatesEditResult extends TemplatesBaseResult {
    action: 'edit';
    template_id: string;
    user_override_path: string;
    created: boolean;
}

interface TemplatesResetResult extends TemplatesBaseResult {
    action: 'reset';
    template_id: string;
    user_override_path: string;
    removed: boolean;
}

interface TemplatesValidateResult extends TemplatesBaseResult, MessageTemplatesValidationResult {
    action: 'validate';
}

type TemplatesCommandResult =
    | TemplatesListResult
    | TemplatesShowResult
    | TemplatesPathResult
    | TemplatesEditResult
    | TemplatesResetResult
    | TemplatesValidateResult;

const TEMPLATES_SHARED_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--template': { key: 'template', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

function resolveTemplatesRoots(options: ParsedOptionsRecord): TemplatesCommandRoots {
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : explicitBundleRoot
            ? path.dirname(explicitBundleRoot)
            : normalizePathValue('.');
    const bundleRoot = explicitBundleRoot ?? path.join(targetRoot, resolveBundleName());
    return { targetRoot, bundleRoot };
}

function requireTemplateOption(options: ParsedOptionsRecord): string {
    const template = typeof options.template === 'string' ? options.template.trim() : '';
    if (!template) {
        throw new Error(`--template is required. Allowed values: ${MESSAGE_TEMPLATE_DEFINITIONS.map((entry) => entry.id).join(', ')}.`);
    }
    return template;
}

function printIssues(issues: EffectiveMessageTemplate['validation_issues']): string[] {
    return issues.map((issue) => `Issue: template=${issue.template_id}; code=${issue.code}; ${issue.message}`);
}

function formatTemplateList(result: TemplatesListResult): string {
    const lines: string[] = [
        'GARDA_TEMPLATES',
        'Action: list',
        `TargetRoot: ${result.target_root}`,
        `BundleRoot: ${result.bundle_root}`
    ];
    for (const template of result.templates) {
        lines.push(
            `Template: ${template.template_id}; format=${template.format}; ` +
            `override=${template.user_override_exists ? 'yes' : 'no'}; validation=${template.validation_status}; ` +
            `path=${template.user_override_path}`
        );
    }
    return lines.join('\n');
}

function formatTemplateShow(result: TemplatesShowResult): string {
    const template = result.template;
    return [
        'GARDA_TEMPLATES',
        'Action: show',
        `Template: ${template.template_id}`,
        `Format: ${template.format}`,
        `BuiltinPath: ${template.builtin_path}`,
        `UserOverridePath: ${template.user_override_path}`,
        `UserOverrideExists: ${template.user_override_exists}`,
        `ValidationStatus: ${template.validation_status}`,
        ...printIssues(template.validation_issues),
        '--- effective template ---',
        template.effective_content.trimEnd()
    ].join('\n');
}

function formatTemplatePath(result: TemplatesPathResult): string {
    return [
        'GARDA_TEMPLATES',
        'Action: path',
        `Template: ${result.template_id}`,
        `BuiltinPath: ${result.builtin_path}`,
        `UserOverridePath: ${result.user_override_path}`,
        `UserOverrideExists: ${result.user_override_exists}`
    ].join('\n');
}

function formatTemplateEdit(result: TemplatesEditResult): string {
    return [
        'GARDA_TEMPLATES',
        'Action: edit',
        `Template: ${result.template_id}`,
        `UserOverridePath: ${result.user_override_path}`,
        `Created: ${result.created}`,
        'NextAction: edit the user override file, then run templates validate'
    ].join('\n');
}

function formatTemplateReset(result: TemplatesResetResult): string {
    return [
        'GARDA_TEMPLATES',
        'Action: reset',
        `Template: ${result.template_id}`,
        `UserOverridePath: ${result.user_override_path}`,
        `Removed: ${result.removed}`
    ].join('\n');
}

function formatTemplateValidate(result: TemplatesValidateResult): string {
    return [
        'GARDA_TEMPLATES',
        'Action: validate',
        `Status: ${result.status}`,
        `Passed: ${result.passed}`,
        `TargetRoot: ${result.target_root}`,
        `BundleRoot: ${result.bundle_root}`,
        ...result.templates.map((template) =>
            `Template: ${template.template_id}; validation=${template.validation_status}; override=${template.user_override_exists ? 'yes' : 'no'}`
        ),
        ...printIssues(result.issues)
    ].join('\n');
}

function printResult(result: TemplatesCommandResult, jsonMode: boolean): void {
    if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    switch (result.action) {
        case 'list':
            console.log(formatTemplateList(result));
            return;
        case 'show':
            console.log(formatTemplateShow(result));
            return;
        case 'path':
            console.log(formatTemplatePath(result));
            return;
        case 'edit':
            console.log(formatTemplateEdit(result));
            return;
        case 'reset':
            console.log(formatTemplateReset(result));
            return;
        case 'validate':
            console.log(formatTemplateValidate(result));
            return;
        default:
            throw new Error(`Unsupported templates action: ${(result as { action?: string }).action || '<unknown>'}`);
    }
}

function handleList(options: ParsedOptionsRecord): TemplatesListResult {
    const roots = resolveTemplatesRoots(options);
    const result: TemplatesListResult = {
        action: 'list',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        templates: listEffectiveMessageTemplates(roots.bundleRoot).map((template) => ({
            template_id: template.template_id,
            title: template.title,
            format: template.format,
            user_override_path: template.user_override_path,
            user_override_exists: template.user_override_exists,
            validation_status: template.validation_status
        }))
    };
    printResult(result, options.json === true);
    return result;
}

function handleShow(options: ParsedOptionsRecord): TemplatesShowResult {
    const roots = resolveTemplatesRoots(options);
    const result: TemplatesShowResult = {
        action: 'show',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        template: buildEffectiveMessageTemplate(roots.bundleRoot, requireTemplateOption(options))
    };
    printResult(result, options.json === true);
    return result;
}

function handlePath(options: ParsedOptionsRecord): TemplatesPathResult {
    const roots = resolveTemplatesRoots(options);
    const template = buildEffectiveMessageTemplate(roots.bundleRoot, requireTemplateOption(options));
    const result: TemplatesPathResult = {
        action: 'path',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        template_id: template.template_id,
        builtin_path: template.builtin_path,
        user_override_path: template.user_override_path,
        user_override_exists: template.user_override_exists
    };
    printResult(result, options.json === true);
    return result;
}

function handleEdit(options: ParsedOptionsRecord): TemplatesEditResult {
    const roots = resolveTemplatesRoots(options);
    const templateId = requireTemplateOption(options);
    const before = buildEffectiveMessageTemplate(roots.bundleRoot, templateId);
    const paths = ensureMessageTemplateUserOverride(roots.bundleRoot, templateId);
    const after = buildEffectiveMessageTemplate(roots.bundleRoot, templateId);
    const result: TemplatesEditResult = {
        action: 'edit',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        template_id: after.template_id,
        user_override_path: paths.userPath,
        created: before.user_override_exists === false
    };
    printResult(result, options.json === true);
    return result;
}

function handleReset(options: ParsedOptionsRecord): TemplatesResetResult {
    const roots = resolveTemplatesRoots(options);
    const templateId = requireTemplateOption(options);
    const reset = resetMessageTemplateUserOverride(roots.bundleRoot, templateId);
    const template = buildEffectiveMessageTemplate(roots.bundleRoot, templateId);
    const result: TemplatesResetResult = {
        action: 'reset',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        template_id: template.template_id,
        user_override_path: reset.paths.userPath,
        removed: reset.removed
    };
    printResult(result, options.json === true);
    return result;
}

function handleValidate(options: ParsedOptionsRecord): TemplatesValidateResult {
    const roots = resolveTemplatesRoots(options);
    const validation = validateEffectiveMessageTemplates(roots.bundleRoot, options.template);
    const result: TemplatesValidateResult = {
        action: 'validate',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        ...validation
    };
    printResult(result, options.json === true);
    return result;
}

export function handleTemplates(
    commandArgv: string[],
    packageJson: PackageJsonLike
): TemplatesCommandResult | null {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'list';
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;
    const { options } = parseOptions(subcommandArgv, TEMPLATES_SHARED_DEFINITIONS);

    if (options.help) { console.log(buildGuardedCommandHelpText('templates')); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    switch (subcommand) {
        case 'list':
            return handleList(options as ParsedOptionsRecord);
        case 'show':
            return handleShow(options as ParsedOptionsRecord);
        case 'path':
            return handlePath(options as ParsedOptionsRecord);
        case 'edit':
            return handleEdit(options as ParsedOptionsRecord);
        case 'validate':
            return handleValidate(options as ParsedOptionsRecord);
        case 'reset':
            return handleReset(options as ParsedOptionsRecord);
        default:
            throw new Error('Unknown templates action: ' + subcommand + '. Allowed values: list, show, path, edit, validate, reset.');
    }
}
