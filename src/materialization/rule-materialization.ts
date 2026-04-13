import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists, readTextFile } from '../core/fs';

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

/**
 * Selects the best source for a rule file following priority rules:
 * - 00-core.md: template > live > legacy
 * - Context rules (10-60): legacy > live > template
 * - Other rules: live > template > legacy
 */
export function selectRuleSource(ruleFile: string, options: SelectRuleSourceOptions): RuleSourceSelection | null {
    const { targetRoot, liveRuleRoot, templateRuleRoot } = options;

    const legacyCandidate = path.join(targetRoot, 'docs/agent-rules', ruleFile);
    const liveCandidate = path.join(liveRuleRoot, ruleFile);
    const templateCandidate = path.join(templateRuleRoot, ruleFile);
    const isContextRule = CONTEXT_RULE_FILES.includes(ruleFile);

    if (ruleFile === '00-core.md') {
        if (pathExists(templateCandidate)) return { path: templateCandidate, origin: 'template' };
        if (pathExists(liveCandidate)) return { path: liveCandidate, origin: 'live-existing' };
        if (pathExists(legacyCandidate)) return { path: legacyCandidate, origin: 'legacy-docs' };
    } else if (isContextRule) {
        if (pathExists(legacyCandidate)) return { path: legacyCandidate, origin: 'legacy-docs' };
        if (pathExists(liveCandidate)) return { path: liveCandidate, origin: 'live-existing' };
        if (pathExists(templateCandidate)) return { path: templateCandidate, origin: 'template' };
    } else {
        if (pathExists(liveCandidate)) return { path: liveCandidate, origin: 'live-existing' };
        if (pathExists(templateCandidate)) return { path: templateCandidate, origin: 'template' };
        if (pathExists(legacyCandidate)) return { path: legacyCandidate, origin: 'legacy-docs' };
    }

    return null;
}

/**
 * Applies project discovery overlay to context rules (10-60).
 */
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

/**
 * Applies assistant language/brevity defaults to 00-core.md.
 */
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
        .filter((entry: fs.Dirent) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md')
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
