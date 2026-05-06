import * as fs from 'node:fs';
import * as path from 'node:path';

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function listTemplateTokens(text: string): string[] {
    const tokens = new Set<string>();
    const pattern = /\{\{([A-Z0-9_]+)\}\}/g;
    const source = String(text);
    let match = pattern.exec(source);

    while (match) {
        tokens.add(match[1]);
        match = pattern.exec(source);
    }

    return [...tokens];
}

export function replaceTemplateTokens(text: string, replacements: Record<string, string>): string {
    let result = String(text);

    for (const [key, value] of Object.entries(replacements)) {
        const pattern = new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, 'g');
        result = result.replace(pattern, String(value));
    }

    return result;
}

export type MessageTemplateId = 'final-report' | 'commit-message' | 'reviewer-prompt';
export type MessageTemplateFormat = 'markdown' | 'json';
export type MessageTemplateValidationStatus = 'PASS' | 'FAIL';

export interface MessageTemplateDefinition {
    id: MessageTemplateId;
    title: string;
    format: MessageTemplateFormat;
    builtinFileName: string;
    userFileName: string;
    requiredPlaceholders: readonly string[];
    protectedSections: readonly string[];
    builtinContent: string;
    userSeedContent: string;
}

export interface MessageTemplatePaths {
    builtinPath: string;
    userPath: string;
    liveTemplatesDir: string;
}

export interface MessageTemplateValidationIssue {
    template_id: MessageTemplateId;
    code: string;
    message: string;
}

export interface EffectiveMessageTemplate {
    template_id: MessageTemplateId;
    title: string;
    format: MessageTemplateFormat;
    builtin_path: string;
    builtin_exists: boolean;
    user_override_path: string;
    user_override_exists: boolean;
    effective_content: string;
    required_placeholders: readonly string[];
    protected_sections: readonly string[];
    validation_status: MessageTemplateValidationStatus;
    validation_issues: MessageTemplateValidationIssue[];
}

export interface MessageTemplatesValidationResult {
    status: MessageTemplateValidationStatus;
    passed: boolean;
    templates: EffectiveMessageTemplate[];
    issues: MessageTemplateValidationIssue[];
}

const FINAL_REPORT_BUILTIN = `# Final Report Template

Use this template for task closeout wording. User overrides may add wording, but protected sections remain mandatory in the effective template.

<!-- garda:protected-start gate-status -->
Gate status: {{GATE_STATUS}}
Task: {{TASK_ID}}
<!-- garda:protected-end gate-status -->

<!-- garda:protected-start review-integrity -->
Review integrity: {{REVIEW_INTEGRITY}}
<!-- garda:protected-end review-integrity -->

<!-- garda:protected-start fake-fallback-review-attestation -->
Fake/fallback/same-agent review artifacts: {{FAKE_FALLBACK_REVIEW_ARTIFACTS}}
<!-- garda:protected-end fake-fallback-review-attestation -->

<!-- garda:protected-start commit-decision -->
Commit decision: {{COMMIT_DECISION}}
<!-- garda:protected-end commit-decision -->

<!-- garda:protected-start artifact-references -->
Artifacts: {{ARTIFACT_REFERENCES}}
<!-- garda:protected-end artifact-references -->
`;

const COMMIT_MESSAGE_BUILTIN = `{
  "style": "conventional",
  "template": "{{TYPE}}({{SCOPE}}): {{SUMMARY}}",
  "protected_required_placeholders": [
    "TYPE",
    "SCOPE",
    "SUMMARY"
  ],
  "protected_commit_policy": {
    "requires_human_confirmation": true,
    "auto_commit_allowed": false
  }
}
`;

const REVIEWER_PROMPT_BUILTIN = `# Reviewer Prompt Template

Use this template as a human-visible reviewer instruction surface.

<!-- garda:protected-start review-context -->
Review type: {{REVIEW_TYPE}}
Review context path: {{REVIEW_CONTEXT_PATH}}
<!-- garda:protected-end review-context -->

<!-- garda:protected-start verdict-contract -->
Pass token: {{PASS_TOKEN}}
Fail token: {{FAIL_TOKEN}}
<!-- garda:protected-end verdict-contract -->

<!-- garda:protected-start review-integrity -->
Review integrity requirement: {{REVIEW_INTEGRITY}}
<!-- garda:protected-end review-integrity -->
`;

export const MESSAGE_TEMPLATE_DEFINITIONS: readonly MessageTemplateDefinition[] = Object.freeze([
    Object.freeze({
        id: 'final-report',
        title: 'Final report',
        format: 'markdown',
        builtinFileName: 'final-report.md',
        userFileName: 'final-report.user.md',
        requiredPlaceholders: Object.freeze([
            'TASK_ID',
            'GATE_STATUS',
            'REVIEW_INTEGRITY',
            'FAKE_FALLBACK_REVIEW_ARTIFACTS',
            'COMMIT_DECISION',
            'ARTIFACT_REFERENCES'
        ]),
        protectedSections: Object.freeze([
            'gate-status',
            'review-integrity',
            'fake-fallback-review-attestation',
            'commit-decision',
            'artifact-references'
        ]),
        builtinContent: FINAL_REPORT_BUILTIN,
        userSeedContent: `# Final Report User Wording

Add optional wording here. Do not add \`garda:protected-*\` markers; protected sections are merged from the built-in template.
`
    }),
    Object.freeze({
        id: 'commit-message',
        title: 'Commit message',
        format: 'json',
        builtinFileName: 'commit-message.json',
        userFileName: 'commit-message.user.json',
        requiredPlaceholders: Object.freeze(['TYPE', 'SCOPE', 'SUMMARY']),
        protectedSections: Object.freeze([]),
        builtinContent: COMMIT_MESSAGE_BUILTIN,
        userSeedContent: `{
  "style": "conventional",
  "template": "{{TYPE}}({{SCOPE}}): {{SUMMARY}}"
}
`
    }),
    Object.freeze({
        id: 'reviewer-prompt',
        title: 'Reviewer prompt',
        format: 'markdown',
        builtinFileName: 'reviewer-prompt.md',
        userFileName: 'reviewer-prompt.user.md',
        requiredPlaceholders: Object.freeze([
            'REVIEW_TYPE',
            'REVIEW_CONTEXT_PATH',
            'PASS_TOKEN',
            'FAIL_TOKEN',
            'REVIEW_INTEGRITY'
        ]),
        protectedSections: Object.freeze([
            'review-context',
            'verdict-contract',
            'review-integrity'
        ]),
        builtinContent: REVIEWER_PROMPT_BUILTIN,
        userSeedContent: `# Reviewer Prompt User Wording

Add optional reviewer instructions here. Do not add \`garda:protected-*\` markers; protected sections are merged from the built-in template.
`
    })
]);

function readTextFileIfPresent(filePath: string): string | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    return fs.readFileSync(filePath, 'utf8');
}

function ensureTrailingNewline(text: string): string {
    return text.endsWith('\n') ? text : `${text}\n`;
}

function normalizeTemplateId(value: unknown): MessageTemplateId {
    const normalized = String(value || '').trim().toLowerCase();
    const match = MESSAGE_TEMPLATE_DEFINITIONS.find((definition) => definition.id === normalized);
    if (!match) {
        throw new Error(
            `Unknown template: ${String(value || '').trim() || '<empty>'}. ` +
            `Allowed values: ${MESSAGE_TEMPLATE_DEFINITIONS.map((definition) => definition.id).join(', ')}.`
        );
    }
    return match.id;
}

export function getMessageTemplateDefinition(templateId: unknown): MessageTemplateDefinition {
    const normalized = normalizeTemplateId(templateId);
    const definition = MESSAGE_TEMPLATE_DEFINITIONS.find((entry) => entry.id === normalized);
    if (!definition) {
        throw new Error(`Unknown template: ${normalized}.`);
    }
    return definition;
}

export function resolveMessageTemplatePaths(bundleRoot: string, templateId: unknown): MessageTemplatePaths {
    const definition = getMessageTemplateDefinition(templateId);
    return {
        builtinPath: path.join(bundleRoot, 'template', 'templates', definition.builtinFileName),
        userPath: path.join(bundleRoot, 'live', 'templates', definition.userFileName),
        liveTemplatesDir: path.join(bundleRoot, 'live', 'templates')
    };
}

function findProtectedSection(content: string, sectionId: string): string | null {
    const pattern = new RegExp(
        `<!--\\s*garda:protected-start\\s+${escapeRegex(sectionId)}\\s*-->[\\s\\S]*?<!--\\s*garda:protected-end\\s+${escapeRegex(sectionId)}\\s*-->`,
        'i'
    );
    return content.match(pattern)?.[0] ?? null;
}

function mergeMarkdownTemplate(definition: MessageTemplateDefinition, builtinContent: string, userContent: string | null): string {
    if (userContent === null) {
        return ensureTrailingNewline(builtinContent);
    }
    const protectedSections = definition.protectedSections
        .map((sectionId) => findProtectedSection(builtinContent, sectionId))
        .filter((section): section is string => section !== null);
    return [
        ensureTrailingNewline(userContent).trimEnd(),
        '',
        '<!-- garda:effective-protected-sections-start -->',
        protectedSections.join('\n\n').trimEnd(),
        '<!-- garda:effective-protected-sections-end -->',
        ''
    ].join('\n');
}

function parseJsonObject(text: string, templateId: MessageTemplateId, issues: MessageTemplateValidationIssue[]): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            issues.push({
                template_id: templateId,
                code: 'json_template_not_object',
                message: 'JSON template content must be an object.'
            });
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch (error: unknown) {
        issues.push({
            template_id: templateId,
            code: 'json_template_parse_failed',
            message: `JSON template content is invalid: ${error instanceof Error ? error.message : String(error)}`
        });
        return null;
    }
}

function mergeJsonTemplate(
    definition: MessageTemplateDefinition,
    builtinContent: string,
    userContent: string | null,
    issues: MessageTemplateValidationIssue[]
): string {
    const builtin = parseJsonObject(builtinContent, definition.id, issues) ?? {};
    const user = userContent === null ? {} : parseJsonObject(userContent, definition.id, issues) ?? {};
    const protectedKeys = new Set(['protected_required_placeholders', 'protected_commit_policy']);
    for (const key of Object.keys(user)) {
        if (protectedKeys.has(key)) {
            issues.push({
                template_id: definition.id,
                code: 'user_override_protected_key',
                message: `User override must not set protected key '${key}'.`
            });
        }
    }
    const effective = {
        ...builtin,
        ...Object.fromEntries(Object.entries(user).filter(([key]) => !protectedKeys.has(key))),
        protected_required_placeholders: builtin.protected_required_placeholders,
        protected_commit_policy: builtin.protected_commit_policy
    };
    return `${JSON.stringify(effective, null, 2)}\n`;
}

function validateNoTemplateAutoCommit(definition: MessageTemplateDefinition, effectiveContent: string): MessageTemplateValidationIssue[] {
    const normalized = effectiveContent.toLowerCase();
    if (
        /\b(?:git\s+commit|human-commit|auto-commit|autocommit)\b/u.test(normalized)
        || /\bcommit\s+(?:automatically|without\s+(?:asking|confirmation))\b/u.test(normalized)
    ) {
        return [{
            template_id: definition.id,
            code: 'auto_commit_instruction_forbidden',
            message: 'Effective template must not instruct the agent to commit automatically.'
        }];
    }
    return [];
}

function validateNoManualTaskStatusSync(definition: MessageTemplateDefinition, effectiveContent: string): MessageTemplateValidationIssue[] {
    const normalized = effectiveContent.toLowerCase();
    if (
        /\b(?:manually|manual)\s+(?:mark|sync|update)[\s\S]{0,80}task\.md[\s\S]{0,80}\b(?:done|in_review|in_progress|blocked)\b/u
        .test(normalized)
    ) {
        return [{
            template_id: definition.id,
            code: 'manual_task_status_sync_forbidden',
            message: 'Effective template must not ask agents to manually synchronize active TASK.md lifecycle status.'
        }];
    }
    return [];
}

function validateEffectiveTemplate(
    definition: MessageTemplateDefinition,
    effectiveContent: string,
    userContent: string | null,
    priorIssues: MessageTemplateValidationIssue[]
): MessageTemplateValidationIssue[] {
    const issues = [...priorIssues];
    if (userContent !== null && /<!--\s*garda:protected-(?:start|end)\b/iu.test(userContent)) {
        issues.push({
            template_id: definition.id,
            code: 'user_override_protected_section',
            message: 'User override must not define or edit garda protected sections.'
        });
    }
    const tokens = new Set(listTemplateTokens(effectiveContent));
    for (const placeholder of definition.requiredPlaceholders) {
        if (!tokens.has(placeholder)) {
            issues.push({
                template_id: definition.id,
                code: 'required_placeholder_missing',
                message: `Required placeholder '{{${placeholder}}}' is missing from the effective template.`
            });
        }
    }
    for (const sectionId of definition.protectedSections) {
        if (!findProtectedSection(effectiveContent, sectionId)) {
            issues.push({
                template_id: definition.id,
                code: 'protected_section_missing',
                message: `Protected section '${sectionId}' is missing from the effective template.`
            });
        }
    }
    issues.push(...validateNoTemplateAutoCommit(definition, effectiveContent));
    issues.push(...validateNoManualTaskStatusSync(definition, effectiveContent));
    if (definition.id === 'commit-message') {
        const parsed = parseJsonObject(effectiveContent, definition.id, issues);
        const template = typeof parsed?.template === 'string' ? parsed.template : '';
        if (!template.trim()) {
            issues.push({
                template_id: definition.id,
                code: 'commit_message_template_missing',
                message: 'Commit message template JSON must include a non-empty template string.'
            });
        }
        const templateTokens = new Set(listTemplateTokens(template));
        for (const placeholder of definition.requiredPlaceholders) {
            if (!templateTokens.has(placeholder)) {
                issues.push({
                    template_id: definition.id,
                    code: 'commit_message_template_placeholder_missing',
                    message: `Commit message template string is missing required placeholder '{{${placeholder}}}'.`
                });
            }
        }
        const policy = parsed?.protected_commit_policy && typeof parsed.protected_commit_policy === 'object'
            && !Array.isArray(parsed.protected_commit_policy)
            ? parsed.protected_commit_policy as Record<string, unknown>
            : null;
        if (!policy || policy.requires_human_confirmation !== true || policy.auto_commit_allowed !== false) {
            issues.push({
                template_id: definition.id,
                code: 'commit_policy_invalid',
                message: 'Commit message template must preserve protected human-confirmation and no-auto-commit policy.'
            });
        }
    }
    return issues;
}

export function buildEffectiveMessageTemplate(bundleRoot: string, templateId: unknown): EffectiveMessageTemplate {
    const definition = getMessageTemplateDefinition(templateId);
    const paths = resolveMessageTemplatePaths(bundleRoot, definition.id);
    const builtinFromFile = readTextFileIfPresent(paths.builtinPath);
    const builtinContent = builtinFromFile ?? definition.builtinContent;
    const userContent = readTextFileIfPresent(paths.userPath);
    const mergeIssues: MessageTemplateValidationIssue[] = [];
    const effectiveContent = definition.format === 'json'
        ? mergeJsonTemplate(definition, builtinContent, userContent, mergeIssues)
        : mergeMarkdownTemplate(definition, builtinContent, userContent);
    const validationIssues = validateEffectiveTemplate(definition, effectiveContent, userContent, mergeIssues);
    return {
        template_id: definition.id,
        title: definition.title,
        format: definition.format,
        builtin_path: paths.builtinPath,
        builtin_exists: builtinFromFile !== null,
        user_override_path: paths.userPath,
        user_override_exists: userContent !== null,
        effective_content: effectiveContent,
        required_placeholders: definition.requiredPlaceholders,
        protected_sections: definition.protectedSections,
        validation_status: validationIssues.length === 0 ? 'PASS' : 'FAIL',
        validation_issues: validationIssues
    };
}

export function listEffectiveMessageTemplates(bundleRoot: string): EffectiveMessageTemplate[] {
    return MESSAGE_TEMPLATE_DEFINITIONS.map((definition) => buildEffectiveMessageTemplate(bundleRoot, definition.id));
}

export function validateEffectiveMessageTemplates(
    bundleRoot: string,
    templateId?: unknown
): MessageTemplatesValidationResult {
    const templates = templateId === undefined || templateId === null || String(templateId).trim() === ''
        ? listEffectiveMessageTemplates(bundleRoot)
        : [buildEffectiveMessageTemplate(bundleRoot, templateId)];
    const issues = templates.flatMap((template) => template.validation_issues);
    return {
        status: issues.length === 0 ? 'PASS' : 'FAIL',
        passed: issues.length === 0,
        templates,
        issues
    };
}

export function ensureMessageTemplateUserOverride(bundleRoot: string, templateId: unknown): MessageTemplatePaths {
    const definition = getMessageTemplateDefinition(templateId);
    const paths = resolveMessageTemplatePaths(bundleRoot, definition.id);
    fs.mkdirSync(paths.liveTemplatesDir, { recursive: true });
    const readmePath = path.join(paths.liveTemplatesDir, 'README.md');
    if (!fs.existsSync(readmePath)) {
        fs.writeFileSync(
            readmePath,
            [
                '# User Message Templates',
                '',
                'Files in this directory are user-owned overrides.',
                'Protected Garda sections and required placeholders are merged from built-in templates.',
                'Run `garda templates validate` after editing.',
                ''
            ].join('\n'),
            'utf8'
        );
    }
    if (!fs.existsSync(paths.userPath)) {
        fs.writeFileSync(paths.userPath, definition.userSeedContent, 'utf8');
    }
    return paths;
}

export function resetMessageTemplateUserOverride(bundleRoot: string, templateId: unknown): {
    paths: MessageTemplatePaths;
    removed: boolean;
} {
    const definition = getMessageTemplateDefinition(templateId);
    const paths = resolveMessageTemplatePaths(bundleRoot, definition.id);
    const removed = fs.existsSync(paths.userPath);
    if (removed) {
        fs.rmSync(paths.userPath, { force: true });
    }
    return { paths, removed };
}
