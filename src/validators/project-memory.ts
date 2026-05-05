import * as path from 'node:path';
import {
    DEFAULT_PROJECT_MEMORY_MAX_COMPACT_SUMMARY_CHARS,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    buildProjectMemorySourceRelativePath,
    hasSubstantiveProjectMemoryContent,
    normalizeProjectMemoryMarkdown
} from '../core/project-memory';
import { pathExists, readTextFile } from '../core/filesystem';

export type ProjectMemoryValidationMode = 'check' | 'strict';
export type ProjectMemoryValidationSeverity = 'warning' | 'error';

export interface ProjectMemoryValidationIssue {
    code: string;
    severity: ProjectMemoryValidationSeverity;
    file?: string;
    message: string;
}

export interface ProjectMemoryValidationOptions {
    mode?: ProjectMemoryValidationMode;
    templateProjectMemoryDir?: string | null;
    maxCompactSummaryChars?: number;
}

export interface ProjectMemoryValidationResult {
    passed: boolean;
    mode: ProjectMemoryValidationMode;
    projectMemoryDir: string;
    requiredFiles: string[];
    missingFiles: string[];
    templateSeedFiles: string[];
    placeholderFiles: string[];
    contentFiles: string[];
    compactCharCount: number | null;
    maxCompactSummaryChars: number;
    issues: ProjectMemoryValidationIssue[];
}

function issueSeverityForMode(mode: ProjectMemoryValidationMode): ProjectMemoryValidationSeverity {
    return mode === 'strict' ? 'error' : 'warning';
}

function readTemplateSeed(templateProjectMemoryDir: string | null | undefined, fileName: string): string | null {
    if (!templateProjectMemoryDir) {
        return null;
    }
    const templatePath = path.join(templateProjectMemoryDir, fileName);
    if (!pathExists(templatePath)) {
        return null;
    }
    return readTextFile(templatePath);
}

function isTemplateSeedFile(
    templateProjectMemoryDir: string | null | undefined,
    fileName: string,
    content: string
): boolean {
    const templateContent = readTemplateSeed(templateProjectMemoryDir, fileName);
    if (templateContent === null) {
        return false;
    }
    return normalizeProjectMemoryMarkdown(content) === normalizeProjectMemoryMarkdown(templateContent);
}

function makeIssue(
    code: string,
    severity: ProjectMemoryValidationSeverity,
    message: string,
    file?: string
): ProjectMemoryValidationIssue {
    return file === undefined
        ? { code, severity, message }
        : { code, severity, file, message };
}

export function validateProjectMemoryBootstrap(
    projectMemoryDir: string,
    options: ProjectMemoryValidationOptions = {}
): ProjectMemoryValidationResult {
    const mode = options.mode || 'check';
    const maxCompactSummaryChars = options.maxCompactSummaryChars ?? DEFAULT_PROJECT_MEMORY_MAX_COMPACT_SUMMARY_CHARS;
    const issues: ProjectMemoryValidationIssue[] = [];
    const missingFiles: string[] = [];
    const templateSeedFiles: string[] = [];
    const placeholderFiles: string[] = [];
    const contentFiles: string[] = [];
    let compactCharCount: number | null = null;

    if (!pathExists(projectMemoryDir)) {
        issues.push(makeIssue(
            'project_memory_directory_missing',
            issueSeverityForMode(mode),
            `Project memory directory is missing: ${projectMemoryDir}.`
        ));
        return {
            passed: !issues.some((issue) => issue.severity === 'error'),
            mode,
            projectMemoryDir,
            requiredFiles: [...PROJECT_MEMORY_REQUIRED_FILE_NAMES],
            missingFiles: [...PROJECT_MEMORY_REQUIRED_FILE_NAMES],
            templateSeedFiles,
            placeholderFiles,
            contentFiles,
            compactCharCount,
            maxCompactSummaryChars,
            issues
        };
    }

    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        const filePath = path.join(projectMemoryDir, fileName);
        const sourceRelativePath = buildProjectMemorySourceRelativePath(fileName);
        if (!pathExists(filePath)) {
            missingFiles.push(fileName);
            issues.push(makeIssue(
                'required_file_missing',
                issueSeverityForMode(mode),
                `Required project-memory file is missing: ${sourceRelativePath}.`,
                sourceRelativePath
            ));
            continue;
        }

        let content = '';
        try {
            content = readTextFile(filePath);
        } catch {
            issues.push(makeIssue(
                'required_file_unreadable',
                issueSeverityForMode(mode),
                `Required project-memory file could not be read: ${sourceRelativePath}.`,
                sourceRelativePath
            ));
            continue;
        }

        if (fileName === 'compact.md') {
            compactCharCount = content.length;
            if (content.length > maxCompactSummaryChars) {
                issues.push(makeIssue(
                    'compact_overflow',
                    issueSeverityForMode(mode),
                    `Project-memory compact.md is ${content.length} chars; limit is ${maxCompactSummaryChars}.`,
                    sourceRelativePath
                ));
            }
        }

        if (isTemplateSeedFile(options.templateProjectMemoryDir, fileName, content)) {
            templateSeedFiles.push(fileName);
            continue;
        }

        if (hasSubstantiveProjectMemoryContent(content)) {
            contentFiles.push(fileName);
        } else {
            placeholderFiles.push(fileName);
            issues.push(makeIssue(
                'required_file_placeholder_only',
                issueSeverityForMode(mode),
                `Required project-memory file has no substantive content: ${sourceRelativePath}.`,
                sourceRelativePath
            ));
        }
    }

    const requiredFileCount = PROJECT_MEMORY_REQUIRED_FILE_NAMES.length;
    const missingOrSeedCount = missingFiles.length + templateSeedFiles.length + placeholderFiles.length;
    if (requiredFileCount > 0 && missingOrSeedCount === requiredFileCount) {
        issues.push(makeIssue(
            'project_memory_placeholder_heavy',
            issueSeverityForMode(mode),
            'Project memory is still placeholder-heavy; add durable project facts before relying on it for task orientation.'
        ));
    }

    return {
        passed: !issues.some((issue) => issue.severity === 'error'),
        mode,
        projectMemoryDir,
        requiredFiles: [...PROJECT_MEMORY_REQUIRED_FILE_NAMES],
        missingFiles,
        templateSeedFiles,
        placeholderFiles,
        contentFiles,
        compactCharCount,
        maxCompactSummaryChars,
        issues
    };
}

export function formatProjectMemoryValidationSummary(result: ProjectMemoryValidationResult): string {
    const status = result.passed ? 'PROJECT_MEMORY_VALIDATION_PASSED' : 'PROJECT_MEMORY_VALIDATION_FAILED';
    const lines = [
        status,
        `Mode: ${result.mode}`,
        `ProjectMemoryDir: ${result.projectMemoryDir}`,
        `RequiredFiles: ${result.requiredFiles.length}`,
        `MissingFiles: ${result.missingFiles.length}`,
        `TemplateSeedFiles: ${result.templateSeedFiles.length}`,
        `PlaceholderFiles: ${result.placeholderFiles.length}`,
        `ContentFiles: ${result.contentFiles.length}`,
        `CompactChars: ${result.compactCharCount === null ? 'n/a' : result.compactCharCount}`,
        `CompactLimit: ${result.maxCompactSummaryChars}`
    ];

    for (const issue of result.issues) {
        const fileSuffix = issue.file ? ` ${issue.file}` : '';
        lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}${fileSuffix}: ${issue.message}`);
    }

    return lines.join('\n');
}
