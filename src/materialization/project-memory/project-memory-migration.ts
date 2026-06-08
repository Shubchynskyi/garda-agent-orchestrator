import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists, readTextFile } from '../../core/filesystem';
import {
    LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE,
    MEANINGFUL_DIFF_THRESHOLD,
    countMeaningfulAddedLines,
    extractNonEmptySections,
    getMeaningfulLines,
    isBootstrapOnlyLegacyCodeStyleRule,
    isTemplateSeedProjectMemoryFile,
    selectRuleSourceCandidates,
    stripHtmlComments
} from '../rule-materialization';

export { MEANINGFUL_DIFF_THRESHOLD, countMeaningfulAddedLines, getMeaningfulLines };

interface MigrationMapping {
    ruleFile: string;
    memoryFile: string;
    heading: string;
}

interface MigrationSection {
    heading: string;
    lines: string[];
}

interface MigrationOptions {
    bundleRoot: string;
    targetRoot: string;
    templateRoot: string;
    dryRun?: boolean;
}

interface ExtractMigrationContentOptions {
    ruleFile?: string;
    templateContent?: string;
}

export interface ProjectMemoryMigrationFile {
    ruleFile: string;
    memoryFile: string;
    origin: string;
    meaningfulLinesDetected: number;
}

export interface ProjectMemoryMigrationResult {
    status: 'already_migrated' | 'no_project_memory_dir' | 'project_memory_has_content' | 'no_significant_content' | 'migrated';
    migratedFiles: ProjectMemoryMigrationFile[];
}

/**
 * Marker file written after a successful migration so the process runs exactly once.
 */
export const MIGRATION_MARKER = '.migrated-from-rules';

export const MIGRATION_RULE_MAP: readonly MigrationMapping[] = Object.freeze([
    { ruleFile: '10-project-context.md', memoryFile: 'context.md', heading: 'Project Context' },
    { ruleFile: '20-architecture.md', memoryFile: 'architecture.md', heading: 'Architecture' },
    { ruleFile: '30-code-style.md', memoryFile: 'conventions.md', heading: 'Conventions' },
    { ruleFile: '40-commands.md', memoryFile: 'stack.md', heading: 'Technology Stack' }
]);

/**
 * Sections in context rule files that are template boilerplate and should not
 * be migrated (they are auto-generated or purely instructional).
 */
export const BOILERPLATE_SECTIONS: ReadonlySet<string> = new Set(['Purpose', 'Project Discovery Snapshot']);
const OBSOLETE_CODE_STYLE_SECTION_HEADINGS: ReadonlySet<string> = new Set([
    'Bootstrap Policy When Repository Is Empty',
    'Language-Specific Rules (Fill Only Relevant Sections)'
]);

function buildSectionMap(markdown: string): Map<string, string[]> {
    const sections = new Map<string, string[]>();
    let currentHeading: string | null = null;
    let currentLines: string[] = [];

    for (const rawLine of String(markdown || '').split(/\r?\n/)) {
        const headingMatch = /^## (.+)$/.exec(rawLine);
        if (headingMatch) {
            if (currentHeading) {
                sections.set(currentHeading, currentLines.slice());
            }
            currentHeading = headingMatch[1].trim();
            currentLines = [];
            continue;
        }

        if (currentHeading) {
            currentLines.push(rawLine);
        }
    }

    if (currentHeading) {
        sections.set(currentHeading, currentLines.slice());
    }

    return sections;
}

function buildCodeStyleBaselineLines(heading: string, templateContent: string): Set<string> {
    const legacySections = buildSectionMap(LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE);
    const templateSections = buildSectionMap(templateContent);
    return new Set([
        ...getMeaningfulLines((legacySections.get(heading) || []).join('\n')),
        ...getMeaningfulLines((templateSections.get(heading) || []).join('\n'))
    ]);
}

function countLegacyBootstrapNovelLines(content: string, templateContent: string): number {
    const meaningfulLines = getMeaningfulLines(content);
    const knownBootstrapLines = new Set([
        ...getMeaningfulLines(LEGACY_BOOTSTRAP_CODE_STYLE_TEMPLATE),
        ...getMeaningfulLines(templateContent)
    ]);
    return meaningfulLines.filter((line) => !knownBootstrapLines.has(line)).length;
}

function buildCodeStyleSectionBlocks(lines: string[]): string[][] {
    const blocks: string[][] = [];
    let currentBlock: string[] = [];

    const flush = () => {
        if (currentBlock.length > 0) {
            blocks.push(currentBlock);
            currentBlock = [];
        }
    };

    for (const rawLine of lines) {
        const trimmedLine = rawLine.trim();
        if (!trimmedLine) {
            flush();
            continue;
        }

        const isIndentedContinuation = /^[ \t]+/.test(rawLine);
        const startsTopLevelListItem = !isIndentedContinuation && /^([-*+]|\d+\.)\s/.test(trimmedLine);
        const currentBlockStartsWithTopLevelListItem = currentBlock.length > 0
            && !/^[ \t]+/.test(currentBlock[0])
            && /^([-*+]|\d+\.)\s/.test(currentBlock[0].trim());

        if (
            currentBlock.length > 0
            && !isIndentedContinuation
            && (startsTopLevelListItem || currentBlockStartsWithTopLevelListItem)
        ) {
            flush();
        }

        currentBlock.push(rawLine);
    }

    flush();
    return blocks;
}

function extractNovelCodeStyleSectionLines(lines: string[], templateContent: string, heading: string): string[] {
    const baselineLines = buildCodeStyleBaselineLines(heading, templateContent);
    return buildCodeStyleSectionBlocks(lines)
        .filter((block) =>
            getMeaningfulLines(block.join('\n')).some((line) => !baselineLines.has(line))
        )
        .flat();
}

/**
 * One-time migration: copies user-authored content from context rule files
 * into the corresponding project-memory/ seed files.
 *
 * Guards:
 * 1. Marker file already exists → skip (already migrated).
 * 2. project-memory/ dir absent → skip.
 * 3. project-memory/ already has substantive content → skip.
 *
 * For each mapping the function:
 *   a. Checks existing rule sources in priority order (legacy > live > template).
 *   b. Skips sources that are template-only or bootstrap-only.
 *   c. Diffs against the template; skips if ≤ threshold meaningful lines differ.
 *   d. Extracts user-authored sections from the first qualifying source and writes them to the memory file.
 *
 * Finally writes the marker file and returns a result object suitable for
 * inclusion in the init report.
 *
 * IMPORTANT: call this BEFORE rule materialization so the current live/legacy
 * content has not yet been overwritten.
 *
 * @param {object} options
 * @param {string} options.bundleRoot
 * @param {string} options.targetRoot
 * @param {string} options.templateRoot
 * @param {boolean} [options.dryRun=false]
 * @returns {{ status: string, migratedFiles: Array }}
 */
export function migrateContextRulesToProjectMemory(options: MigrationOptions): ProjectMemoryMigrationResult {
    const { bundleRoot, targetRoot, templateRoot, dryRun = false } = options;
    const projectMemoryDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
    const markerPath = path.join(projectMemoryDir, MIGRATION_MARKER);
    const templateRuleRoot = path.join(templateRoot, 'docs', 'agent-rules');
    const liveRuleRoot = path.join(bundleRoot, 'live', 'docs', 'agent-rules');

    // Guard 1: already migrated
    if (pathExists(markerPath)) {
        return { status: 'already_migrated', migratedFiles: [] };
    }

    // Guard 2: project-memory dir must exist
    if (!pathExists(projectMemoryDir)) {
        return { status: 'no_project_memory_dir', migratedFiles: [] };
    }

    // Guard 3: project-memory must contain only template seeds
    if (!isProjectMemoryOnlySeeds(projectMemoryDir)) {
        return { status: 'project_memory_has_content', migratedFiles: [] };
    }

    const migratedFiles: ProjectMemoryMigrationFile[] = [];

    for (const mapping of MIGRATION_RULE_MAP) {
        const { ruleFile, memoryFile, heading } = mapping;

        // Need the template version for comparison
        const templatePath = path.join(templateRuleRoot, ruleFile);
        if (!pathExists(templatePath)) continue;
        const templateContent = readTextFile(templatePath);

        const sources = selectRuleSourceCandidates(ruleFile, { targetRoot, liveRuleRoot, templateRuleRoot });
        for (const source of sources) {
            if (source.origin === 'template') {
                continue;
            }

            const liveContent = readTextFile(source.path);
            const legacyBootstrapNovelLines = ruleFile === '30-code-style.md'
                ? countLegacyBootstrapNovelLines(liveContent, templateContent)
                : 0;

            if (
                ruleFile === '30-code-style.md'
                && isBootstrapOnlyLegacyCodeStyleRule(liveContent, templateContent)
                && legacyBootstrapNovelLines === 0
            ) {
                continue;
            }

            const addedLines = countMeaningfulAddedLines(liveContent, templateContent);
            const meaningfulLinesDetected = ruleFile === '30-code-style.md' && legacyBootstrapNovelLines > 0
                ? legacyBootstrapNovelLines
                : addedLines;

            if (meaningfulLinesDetected <= 0 || (
                ruleFile !== '30-code-style.md' && meaningfulLinesDetected <= MEANINGFUL_DIFF_THRESHOLD
            )) {
                continue;
            }

            const extracted = extractMigrationContent(liveContent, heading, { ruleFile, templateContent });
            if (!extracted || !extracted.trim()) {
                continue;
            }

            const destPath = path.join(projectMemoryDir, memoryFile);
            if (!dryRun) {
                fs.writeFileSync(destPath, extracted, 'utf8');
            }

            migratedFiles.push({
                ruleFile,
                memoryFile,
                origin: source.origin,
                meaningfulLinesDetected
            });
            break;
        }
    }

    // Write marker (even when migratedFiles is empty we still mark so we don't re-scan)
    if (!dryRun) {
        const markerLines = [
            `migrated_at: ${new Date().toISOString()}`,
            `threshold: ${MEANINGFUL_DIFF_THRESHOLD}`,
            `files_migrated: ${migratedFiles.length}`,
            ''
        ];
        if (migratedFiles.length > 0) {
            for (const f of migratedFiles) {
                markerLines.push(
                    `${f.ruleFile} -> ${f.memoryFile} (origin=${f.origin}, lines=${f.meaningfulLinesDetected})`
                );
            }
            markerLines.push('');
        }
        fs.writeFileSync(markerPath, markerLines.join('\n'), 'utf8');
    }

    return {
        status: migratedFiles.length > 0 ? 'migrated' : 'no_significant_content',
        migratedFiles
    };
}


/**
 * Returns true when every .md file in the project-memory directory (excluding
 * README.md and the marker) contains only template seed content (headings and
 * HTML-comment placeholders with no real prose).
 */
export function isProjectMemoryOnlySeeds(projectMemoryDir: string): boolean {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(projectMemoryDir, { withFileTypes: true });
    } catch {
        return true; // unreadable → treat as empty
    }

    const mdFiles = entries
        .filter((e: fs.Dirent) =>
            e.isFile() &&
            e.name.toLowerCase().endsWith('.md') &&
            e.name.toLowerCase() !== 'readme.md' &&
            !e.name.toLowerCase().endsWith('.template.md')
        )
        .map((e: fs.Dirent) => e.name);

    for (const fileName of mdFiles) {
        const content = readTextFile(path.join(projectMemoryDir, fileName));
        if (isTemplateSeedProjectMemoryFile(projectMemoryDir, fileName, content)) {
            continue;
        }
        const sections = extractNonEmptySections(content);
        if (sections.length > 0) return false;
    }

    return true;
}

/**
 * Extracts migrateable content from a context rule file.
 *
 * - Parses the file into H2 sections.
 * - Drops known boilerplate sections (Purpose, Project Discovery Snapshot).
 * - Replaces the H1 heading with the project-memory target heading.
 * - Adds a migration provenance comment.
 */
export function extractMigrationContent(
    ruleContent: string,
    targetHeading: string,
    options: ExtractMigrationContentOptions = {}
): string {
    const lines = ruleContent.split(/\r?\n/);
    const sections: MigrationSection[] = [];
    let current: MigrationSection | null = null;
    let preambleLines: string[] = [];

    for (const line of lines) {
        const h2 = line.match(/^## (.+)$/);
        if (h2) {
            if (current) sections.push(current);
            current = { heading: h2[1].trim(), lines: [] };
        } else if (current) {
            current.lines.push(line);
        } else {
            preambleLines.push(line);
        }
    }
    if (current) sections.push(current);

    // Keep only non-boilerplate sections that have real content after stripping comments
    const kept = sections.flatMap((section: MigrationSection) => {
        if (BOILERPLATE_SECTIONS.has(section.heading)) {
            return [];
        }

        if (options.ruleFile === '30-code-style.md' && options.templateContent) {
            if (OBSOLETE_CODE_STYLE_SECTION_HEADINGS.has(section.heading)) {
                return [];
            }
            const novelLines = extractNovelCodeStyleSectionLines(section.lines, options.templateContent, section.heading);
            if (novelLines.length === 0) {
                return [];
            }
            return [{ heading: section.heading, lines: novelLines }];
        }

        const body = stripHtmlComments(section.lines.join('\n')).trim();
        if (body.length === 0) {
            return [];
        }

        return [section];
    });

    if (kept.length === 0) return '';

    const output = [
        `# ${targetHeading}`,
        '',
        '<!-- Migrated from agent-rules context file. Review and restructure as needed. -->'
    ];

    for (const section of kept) {
        output.push('');
        output.push(`## ${section.heading}`);
        output.push('');
        const body = section.lines.join('\n').trimEnd();
        if (body.trim()) {
            output.push(body.trim());
        }
    }

    output.push('');
    return output.join('\n');
}


export function buildMigrationReportLines(migrationResult: ProjectMemoryMigrationResult): string[] {
    const lines = ['', '## Project-Memory Migration (T-075)'];

    if (migrationResult.status === 'already_migrated') {
        lines.push('- Status: skipped (marker file present; migration already completed).');
        return lines;
    }
    if (migrationResult.status === 'no_project_memory_dir') {
        lines.push('- Status: skipped (project-memory directory does not exist).');
        return lines;
    }
    if (migrationResult.status === 'project_memory_has_content') {
        lines.push('- Status: skipped (project-memory already contains user content).');
        return lines;
    }
    if (migrationResult.status === 'no_significant_content') {
        lines.push('- Status: no migration needed (context rules match template or have minimal edits).');
        lines.push(`- Detection threshold: >${MEANINGFUL_DIFF_THRESHOLD} meaningful lines.`);
        lines.push('- Marker file written to prevent future re-scanning.');
        return lines;
    }

    // status === 'migrated'
    lines.push('- Status: **migrated** user-authored content from context rules into `docs/project-memory/`.');
    lines.push(`- Detection threshold: >${MEANINGFUL_DIFF_THRESHOLD} meaningful lines.`);
    lines.push(`- Files migrated: ${migrationResult.migratedFiles.length}`);
    lines.push('');
    lines.push('| Rule File | Memory File | Origin | Lines Detected |');
    lines.push('|---|---|---|---|');
    for (const f of migrationResult.migratedFiles) {
        lines.push(`| ${f.ruleFile} | ${f.memoryFile} | ${f.origin} | ${f.meaningfulLinesDetected} |`);
    }
    lines.push('');
    lines.push('- Marker file written: `docs/project-memory/.migrated-from-rules`.');
    lines.push('- Context rules will revert to template-driven on next materialization.');

    return lines;
}
