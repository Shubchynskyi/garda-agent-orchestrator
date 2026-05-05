import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists, readTextFile } from '../core/filesystem';

interface SelectRuleSourceOptions {
    targetRoot: string;
    liveRuleRoot: string;
    templateRuleRoot: string;
}

interface RuleSourceSelection {
    path: string;
    origin: 'template' | 'live-existing' | 'legacy-docs';
}

interface ProjectMemorySummarySection {
    heading: string;
    content: string;
}

export const RULE_FILES = Object.freeze([
    '00-core.md', '10-project-context.md', '15-project-memory.md',
    '20-architecture.md', '30-code-style.md', '35-strict-coding-rules.md',
    '40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md',
    '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'
]);

export const GENERATED_RULE_FILES = Object.freeze(['15-project-memory.md']);

export const CONTEXT_RULE_FILES = Object.freeze([
    '10-project-context.md', '20-architecture.md', '30-code-style.md',
    '40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md'
]);

export const DISCOVERY_AUGMENTED_RULE_FILES = CONTEXT_RULE_FILES;

export const LANGUAGE_PLACEHOLDER = '{{ASSISTANT_RESPONSE_LANGUAGE}}';
export const BREVITY_PLACEHOLDER = '{{ASSISTANT_RESPONSE_BREVITY}}';
export const MEANINGFUL_DIFF_THRESHOLD = 5;

export const LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE = [
    '# Code Style',
    '',
    'Primary entry point: selected source-of-truth entrypoint for this workspace.',
    '',
    '## Purpose',
    'Define style rules for languages that actually exist in this repository.',
    '',
    '## Global Rules',
    '- Prefer small, testable functions and explicit naming.',
    '- Keep public APIs stable and documented.',
    '- Follow explicit project rules first, not vague habit or local drift.',
    '- If formatter or linter exists, treat it as source of truth.',
    '- Do not copy inconsistent, legacy, or obviously low-quality patterns just because they already exist in the repository.',
    '',
    '## Style Priority Order',
    '- Rules written in this file are the primary source of truth.',
    '- Formatter, linter, and static-analysis configs come next.',
    '- Strong, consistent patterns from high-quality project modules may refine local style decisions.',
    '- Common best practices are the fallback when project-specific guidance is missing.',
    '',
    '## Bootstrap Policy When Repository Is Empty',
    '- If there is little or no real project code yet, do not invent a silent style policy.',
    '- Ask the user a mandatory question: accept the default policy of explicit rules + tooling + common best practices, or provide custom project-specific style rules now.',
    '- Record that answer here before broad implementation starts.',
    '- If the default policy is accepted, state it explicitly instead of leaving the section vague.',
    '- As soon as stable project-specific rules exist, replace this bootstrap policy with concrete repository-specific guidance.',
    '',
    '## Language-Specific Rules (Fill Only Relevant Sections)',
    '',
    '### Java or Kotlin (if present)',
    '- DTO and domain mapping style: `TODO`',
    '- Null-safety and error handling approach: `TODO`',
    '- Transaction and persistence conventions: `TODO`',
    '',
    '### TypeScript or JavaScript (if present)',
    '- Type strictness level and runtime validation strategy: `TODO`',
    '- Component and state management conventions: `TODO`',
    '- API contract and schema handling: `TODO`',
    '',
    '### Python (if present)',
    '- Type hinting policy and linting rules: `TODO`',
    '- Async patterns and dependency management: `TODO`',
    '- Framework-specific conventions: `TODO`',
    '',
    '### Go (if present)',
    '- Package boundaries and interface patterns: `TODO`',
    '- Error wrapping and logging rules: `TODO`',
    '',
    '### Rust (if present)',
    '- Ownership and error handling conventions: `TODO`',
    '- Module and crate organization rules: `TODO`',
    '',
    '## Definition of Done for Style',
    '- Rules above must match actual stack from `live/project-discovery.md`.',
    '- Outdated language sections must be removed or explicitly marked as not applicable.'
].join('\n');

function normalizeSeedMarkdown(content: string): string {
    return String(content || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function removeSectionByHeading(markdown: string, sectionHeading: string): string {
    const lines = markdown.split(/\r?\n/);
    const result: string[] = [];
    let skipping = false;

    for (const line of lines) {
        const h2 = line.match(/^## (.+)$/);
        if (h2) {
            skipping = h2[1].trim() === sectionHeading;
        }
        if (!skipping) {
            result.push(line);
        }
    }

    return result.join('\n');
}

export function getMeaningfulLines(text: string): string[] {
    let cleaned = stripHtmlComments(text);
    cleaned = removeSectionByHeading(cleaned, 'Project Discovery Snapshot');

    return cleaned
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) =>
            line.length > 0 &&
            !line.match(/^#+\s/) &&
            line !== '```' &&
            line !== '```text' &&
            line !== '```bash' &&
            !line.match(/^\|[-:\s|]+\|$/) &&
            line !== '---' &&
            line !== '`TODO`' &&
            line !== 'TODO'
        );
}

export function countMeaningfulAddedLines(liveContent: string, templateContent: string): number {
    const templateSet = new Set(getMeaningfulLines(templateContent));
    const liveLines = getMeaningfulLines(liveContent);
    return liveLines.filter((line: string) => !templateSet.has(line)).length;
}

export function countLegacyBootstrapNovelLines(content: string, templateContent: string): number {
    const meaningfulLines = getMeaningfulLines(content);
    const knownBootstrapLines = new Set([
        ...getMeaningfulLines(LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE),
        ...getMeaningfulLines(templateContent)
    ]);
    return meaningfulLines.filter((line) => !knownBootstrapLines.has(line)).length;
}

export function isBootstrapOnlyLegacyCodeStyleRule(content: string, templateContent: string): boolean {
    const normalized = normalizeSeedMarkdown(content);
    if (!normalized) {
        return false;
    }

    const stillLooksLikeLegacyBootstrap = normalized.includes('## Bootstrap Policy When Repository Is Empty')
        && normalized.includes('## Language-Specific Rules (Fill Only Relevant Sections)');

    return stillLooksLikeLegacyBootstrap
        && countLegacyBootstrapNovelLines(normalized, templateContent) <= MEANINGFUL_DIFF_THRESHOLD;
}

export function resolveTemplateProjectMemoryDir(projectMemoryDir: string): string | null {
    const templateDir = path.resolve(projectMemoryDir, '..', '..', '..', 'template', 'docs', 'project-memory');
    return pathExists(templateDir) ? templateDir : null;
}

export function isTemplateSeedProjectMemoryFile(projectMemoryDir: string, fileName: string, content: string): boolean {
    const templateDir = resolveTemplateProjectMemoryDir(projectMemoryDir);
    if (!templateDir) {
        return false;
    }
    const templatePath = path.join(templateDir, fileName);
    if (!pathExists(templatePath)) {
        return false;
    }

    const templateContent = readTextFile(templatePath);
    return normalizeSeedMarkdown(content) === normalizeSeedMarkdown(templateContent);
}

function resolveExistingRuleSourceCandidates(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    const { targetRoot, liveRuleRoot, templateRuleRoot } = options;

    const legacyCandidate = path.join(targetRoot, 'docs/agent-rules', ruleFile);
    const liveCandidate = path.join(liveRuleRoot, ruleFile);
    const templateCandidate = path.join(templateRuleRoot, ruleFile);
    const isContextRule = CONTEXT_RULE_FILES.includes(ruleFile);
    const candidates: RuleSourceSelection[] = [];

    if (ruleFile === '00-core.md') {
        candidates.push(
            { path: templateCandidate, origin: 'template' },
            { path: liveCandidate, origin: 'live-existing' },
            { path: legacyCandidate, origin: 'legacy-docs' }
        );
    } else if (isContextRule) {
        candidates.push(
            { path: legacyCandidate, origin: 'legacy-docs' },
            { path: liveCandidate, origin: 'live-existing' },
            { path: templateCandidate, origin: 'template' }
        );
    } else {
        candidates.push(
            { path: liveCandidate, origin: 'live-existing' },
            { path: templateCandidate, origin: 'template' },
            { path: legacyCandidate, origin: 'legacy-docs' }
        );
    }

    return candidates.filter((candidate) => pathExists(candidate.path));
}

function resolveRuleSourceCandidates(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    const { templateRuleRoot } = options;
    const templateCandidate = path.join(templateRuleRoot, ruleFile);
    const existingCandidates = resolveExistingRuleSourceCandidates(ruleFile, options);
    if (ruleFile !== '30-code-style.md' || !pathExists(templateCandidate)) {
        return existingCandidates;
    }

    const templateContent = readTextFile(templateCandidate);
    return existingCandidates.filter((candidate) => candidate.origin === 'template' || !isBootstrapOnlyLegacyCodeStyleRule(
        readTextFile(candidate.path),
        templateContent
    ));
}

/**
 * Selects the best source for a rule file following priority rules:
 * - 00-core.md: template > live > legacy
 * - Context rules (10-60): legacy > live > template
 * - Other rules: live > template > legacy
 */
export function selectRuleSource(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection | null {
    return resolveRuleSourceCandidates(ruleFile, options)[0] ?? null;
}

/**
 * Returns all existing source candidates for a rule file in the same priority
 * order used by selectRuleSource().
 */
export function selectRuleSources(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    return resolveRuleSourceCandidates(ruleFile, options);
}

/**
 * Returns all existing source candidates for a rule file in priority order
 * without applying bootstrap-only legacy filtering. Use this when the caller
 * needs to inspect potentially disposable legacy content before deciding.
 */
export function selectRuleSourceCandidates(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection[] {
    return resolveExistingRuleSourceCandidates(ruleFile, options);
}

export function applyContextDefaults(content: string, ruleFile: string, discoveryOverlay: string | null | undefined): string {
    if (!DISCOVERY_AUGMENTED_RULE_FILES.includes(ruleFile) || !discoveryOverlay) {
        return content;
    }

    let updated = content.trimEnd();
    const overlayPattern = /^## Project Discovery Snapshot[\s\S]*?(?=^## |\z)/m;
    if (overlayPattern.test(updated)) {
        updated = updated.replace(overlayPattern, discoveryOverlay);
        return updated + '\r\n';
    }

    return updated + '\r\n\r\n' + discoveryOverlay + '\r\n';
}

export function applyAssistantDefaults(content: string, ruleFile: string, assistantLanguage: string, assistantBrevity: string): string {
    if (ruleFile !== '00-core.md') return content;

    let updated = content
        .replace(new RegExp(escapeRegex(LANGUAGE_PLACEHOLDER), 'g'), assistantLanguage)
        .replace(new RegExp(escapeRegex(BREVITY_PLACEHOLDER), 'g'), assistantBrevity);

    updated = updated.replace(
        /^Respond in .+ for explanations and assistance\.$/m,
        `Respond in ${assistantLanguage} for explanations and assistance.`
    );
    updated = updated.replace(
        /^1\. Respond in .+\.$/m,
        `1. Respond in ${assistantLanguage}.`
    );
    updated = updated.replace(
        /^Default response brevity: .+\.$/m,
        `Default response brevity: ${assistantBrevity}.`
    );
    updated = updated.replace(
        /^2\. Keep responses .+ unless the user explicitly asks for more or less detail\.$/m,
        `2. Keep responses ${assistantBrevity} unless the user explicitly asks for more or less detail.`
    );

    return updated;
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a read-only summary of project-memory sources for agent-rules.
 * If the directory is absent or has no substantive content, returns a stub.
 */
export function generateProjectMemorySummary(projectMemoryDir: string, timestampIso: string): string {
    const HEADER = '<!-- DO NOT EDIT — regenerated from project-memory/ -->';
    const TITLE = '# 15 · Project Memory Summary';

    const preamble = [
        HEADER, '',
        TITLE, '',
        `Generated at: ${timestampIso}`, '',
        '> Auto-generated from `docs/project-memory/`. Edit source files there;',
        '> this summary regenerates on every init, reinit, and update.', ''
    ];

    if (!pathExists(projectMemoryDir)) {
        return [...preamble,
            '## Status', '',
            'No `docs/project-memory/` directory found.',
            'Populate it with project knowledge files to enable this summary.', '',
            'Run init or reinit to seed the default category templates.'
        ].join('\r\n');
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(projectMemoryDir, { withFileTypes: true });
    } catch {
        return [...preamble,
            '## Status', '',
            'Could not read `docs/project-memory/` directory.'
        ].join('\r\n');
    }

    const mdFiles = entries
        .filter((entry: fs.Dirent) => {
            const fileName = entry.name.toLowerCase();
            return entry.isFile()
                && fileName.endsWith('.md')
                && fileName !== 'readme.md'
                && !fileName.endsWith('.template.md');
        })
        .map((entry: fs.Dirent) => entry.name)
        .sort();

    if (mdFiles.length === 0) {
        return [...preamble,
            '## Status', '',
            '`docs/project-memory/` contains no content files yet.',
            'Populate it with project knowledge to enable this summary.', '',
            'Available category templates: `context.md`, `architecture.md`, `conventions.md`, `stack.md`, `decisions.md`.'
        ].join('\r\n');
    }

    const lines = [...preamble];
    const provenanceRows: Array<{ heading: string; source: string }> = [];
    let hasContent = false;

    for (const fileName of mdFiles) {
        const filePath = path.join(projectMemoryDir, fileName);
        const raw = readTextFile(filePath);
        if (isTemplateSeedProjectMemoryFile(projectMemoryDir, fileName, raw)) {
            continue;
        }
        const sections = extractNonEmptySections(raw);

        if (sections.length === 0) continue;
        hasContent = true;

        lines.push(`## From \`${fileName}\``, '');

        for (const section of sections) {
            lines.push(`### ${section.heading}`, '');
            lines.push(section.content, '');
            provenanceRows.push({ heading: section.heading, source: fileName });
        }
    }

    if (!hasContent) {
        lines.push(
            '## Status', '',
            'All `docs/project-memory/` files exist but contain only placeholder templates.',
            'Fill in the sections with real project knowledge to enable this summary.', ''
        );
    }

    if (provenanceRows.length > 0) {
        lines.push('---', '', '## Provenance', '',
            '| Section | Source |',
            '|---|---|');
        for (const row of provenanceRows) {
            lines.push(`| ${row.heading} | \`docs/project-memory/${row.source}\` |`);
        }
        lines.push('');
    }

    return lines.join('\r\n');
}

/**
 * Extracts level-2 heading sections that have non-empty content after stripping HTML comments.
 * Comments are stripped from the full text first so headings inside comments are ignored.
 */
export function extractNonEmptySections(markdown: string): ProjectMemorySummarySection[] {
    const cleaned = stripHtmlComments(markdown);
    const lines = cleaned.split(/\r?\n/);
    const sections: ProjectMemorySummarySection[] = [];
    let currentHeading: string | null = null;
    let currentLines: string[] = [];

    for (const line of lines) {
        const h2Match = line.match(/^##\s+(.+)$/);
        if (h2Match) {
            if (currentHeading !== null) {
                const content = currentLines.join('\n').trim();
                if (content) {
                    sections.push({ heading: currentHeading, content });
                }
            }
            currentHeading = h2Match[1].trim();
            currentLines = [];
        } else if (currentHeading !== null) {
            currentLines.push(line);
        }
    }

    if (currentHeading !== null) {
        const content = currentLines.join('\n').trim();
        if (content) {
            sections.push({ heading: currentHeading, content });
        }
    }

    return sections;
}

export function stripHtmlComments(text: string): string {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}
