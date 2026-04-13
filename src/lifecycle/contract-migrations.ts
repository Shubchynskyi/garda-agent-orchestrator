import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists, readTextFile } from '../core/fs';
import { getTaskModeRuleSectionMigrations, RuleContractSectionMigration } from '../materialization/rule-contracts';

export interface ContractMigrationResult {
    appliedCount: number;
    appliedFiles: string[];
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectNewline(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeNewlines(content: string, newline: string): string {
    return content.replace(/\r?\n/g, newline);
}

function getHeadingLevel(heading: string): number {
    const headingPrefixMatch = heading.trim().match(/^(#+)\s+/);
    if (!headingPrefixMatch) {
        throw new Error(`Contract migration heading must be a markdown heading: '${heading}'.`);
    }
    return headingPrefixMatch[1].length;
}

function getSectionBounds(content: string, heading: string): { start: number; end: number } | null {
    const headingPattern = new RegExp(`^${escapeRegex(heading)}\\s*$`, 'm');
    const headingMatch = headingPattern.exec(content);
    if (!headingMatch) {
        return null;
    }

    const headingLevel = getHeadingLevel(heading);

    const sectionStart = headingMatch.index;
    const searchStart = sectionStart + headingMatch[0].length;
    const remainder = content.slice(searchStart);
    const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
    const nextHeadingMatch = nextHeadingPattern.exec(remainder);
    const sectionEnd = nextHeadingMatch
        ? searchStart + nextHeadingMatch.index
        : content.length;

    return { start: sectionStart, end: sectionEnd };
}

function extractSectionOrThrow(content: string, heading: string, sourcePath: string): string {
    const bounds = getSectionBounds(content, heading);
    if (!bounds) {
        throw new Error(`Contract migration template section '${heading}' not found in '${sourcePath}'.`);
    }
    return content.slice(bounds.start, bounds.end).trim();
}

function replaceOrAppendSection(content: string, heading: string, replacement: string, newline: string): string {
    const normalizedReplacement = normalizeNewlines(replacement, newline).trimEnd();
    const bounds = getSectionBounds(content, heading);
    if (!bounds) {
        const trimmedContent = content.trimEnd();
        if (!trimmedContent) {
            return `${normalizedReplacement}${newline}`;
        }
        return `${trimmedContent}${newline}${newline}${normalizedReplacement}${newline}`;
    }

    const before = content.slice(0, bounds.start).trimEnd();
    const after = content.slice(bounds.end).trimStart();
    let result = before ? `${before}${newline}${newline}` : '';
    result += normalizedReplacement;
    if (after) {
        result += `${newline}${newline}${after}`;
    } else {
        result += newline;
    }
    return result;
}

function applySectionMigration(rootPath: string, migration: RuleContractSectionMigration): boolean {
    const livePath = path.join(rootPath, migration.liveRelativePath);
    if (!pathExists(livePath)) {
        return false;
    }

    const currentContent = readTextFile(livePath);
    const hasAllRequiredSnippets = migration.requiredSnippets.every((snippet) => currentContent.includes(snippet));
    if (hasAllRequiredSnippets) {
        return false;
    }

    const templatePath = path.join(rootPath, migration.templateRelativePath);
    if (!pathExists(templatePath)) {
        throw new Error(`Contract migration template file not found: ${templatePath}`);
    }

    const templateContent = readTextFile(templatePath);
    const templateSection = extractSectionOrThrow(templateContent, migration.heading, templatePath);
    const newline = detectNewline(currentContent || templateContent);
    const updatedContent = replaceOrAppendSection(currentContent, migration.heading, templateSection, newline);

    if (updatedContent === currentContent) {
        return false;
    }

    fs.writeFileSync(livePath, updatedContent, 'utf8');
    return true;
}

export function runContractMigrations(options: { rootPath: string }): ContractMigrationResult {
    const rootPath = path.resolve(options.rootPath);
    const appliedFiles = new Set<string>();
    const orderedMigrations = [...getTaskModeRuleSectionMigrations()].sort((left, right) => {
        if (left.liveRelativePath !== right.liveRelativePath) {
            return left.liveRelativePath.localeCompare(right.liveRelativePath);
        }

        // Replace broader parent sections before inserting narrower subsections.
        // Otherwise a later parent-section migration can erase a newly inserted child block.
        return getHeadingLevel(left.heading) - getHeadingLevel(right.heading);
    });

    for (const migration of orderedMigrations) {
        if (applySectionMigration(rootPath, migration)) {
            appliedFiles.add(migration.liveRelativePath);
        }
    }

    const appliedFileList = Array.from(appliedFiles).sort();
    return {
        appliedCount: appliedFileList.length,
        appliedFiles: appliedFileList
    };
}
