import * as crypto from 'node:crypto';
import * as path from 'node:path';

export type ProjectMemoryReadRole = 'read_first' | 'focused';

export interface ProjectMemoryFileDefinition {
    fileName: string;
    purpose: string;
    readRole: ProjectMemoryReadRole;
}

export const PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH = 'docs/project-memory';
export const PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH = `live/${PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH}`;
export const PROJECT_MEMORY_TEMPLATE_DIRECTORY_RELATIVE_PATH = `template/${PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH}`;
export const PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH = 'runtime/project-memory';
export const PROJECT_MEMORY_BOOTSTRAP_REPORT_FILE = 'bootstrap-report.json';
export const PROJECT_MEMORY_SUMMARY_RULE_FILE = '15-project-memory.md';
export const PROJECT_MEMORY_SUMMARY_RULE_RELATIVE_PATH = `live/docs/agent-rules/${PROJECT_MEMORY_SUMMARY_RULE_FILE}`;
export const DEFAULT_PROJECT_MEMORY_MAX_COMPACT_SUMMARY_CHARS = 12_000;
export const DEFAULT_PROJECT_MEMORY_GENERATED_SUMMARY_MAX_CHARS = 12_000;

export const PROJECT_MEMORY_MAP_READ_GUIDANCE = [
    'Project memory is a compact project map for orientation, not proof.',
    'Read README.md, then compact.md, then only focused files relevant to the task.',
    'Verify memory facts against source, tests, config, docs, and gate evidence before changing behavior.'
].join(' ');

export const PROJECT_MEMORY_MAP_WRITE_CONTRACT = [
    'Write durable current-state contracts only: module ownership, workflow invariants, commands, decisions, risks, and active unknowns.',
    'Do not store repeated task narratives, transient failures, large command outputs, or duplicated known orchestrator issues.',
    'Task ids are optional provenance only and should not be the default heading structure.'
].join(' ');

export const PROJECT_MEMORY_FILE_DEFINITIONS = Object.freeze([
    {
        fileName: 'README.md',
        purpose: 'Index, ownership protocol, read order, and map write contract.',
        readRole: 'read_first'
    },
    {
        fileName: 'compact.md',
        purpose: 'Bounded task-start project map and routing hints, not task history.',
        readRole: 'read_first'
    },
    {
        fileName: 'context.md',
        purpose: 'Business domain, project goals, and high-level scope.',
        readRole: 'focused'
    },
    {
        fileName: 'stack.md',
        purpose: 'Languages, frameworks, infrastructure, dependencies, and unknown/custom stack fallback.',
        readRole: 'focused'
    },
    {
        fileName: 'architecture.md',
        purpose: 'System architecture, component boundaries, and integration points.',
        readRole: 'focused'
    },
    {
        fileName: 'module-map.md',
        purpose: 'Repository areas, path ownership, and where to inspect for common changes.',
        readRole: 'focused'
    },
    {
        fileName: 'commands.md',
        purpose: 'Current build, test, dev, release, and verification commands.',
        readRole: 'focused'
    },
    {
        fileName: 'conventions.md',
        purpose: 'Coding standards, naming rules, and workflow conventions beyond agent-rules.',
        readRole: 'focused'
    },
    {
        fileName: 'decisions.md',
        purpose: 'Durable architectural and process decisions grouped by theme.',
        readRole: 'focused'
    },
    {
        fileName: 'risks.md',
        purpose: 'Active risk map, fragile paths, security notes, and compatibility constraints.',
        readRole: 'focused'
    }
] as const satisfies readonly ProjectMemoryFileDefinition[]);

export const PROJECT_MEMORY_REQUIRED_FILE_NAMES = Object.freeze(
    PROJECT_MEMORY_FILE_DEFINITIONS.map((definition) => definition.fileName)
);

export const PROJECT_MEMORY_READ_FIRST_FILE_NAMES = Object.freeze(
    PROJECT_MEMORY_FILE_DEFINITIONS
        .filter((definition) => definition.readRole === 'read_first')
        .map((definition) => definition.fileName)
);

export const PROJECT_MEMORY_FOCUSED_FILE_NAMES = Object.freeze(
    PROJECT_MEMORY_FILE_DEFINITIONS
        .filter((definition) => definition.readRole === 'focused')
        .map((definition) => definition.fileName)
);

export function toProjectMemoryPosixPath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

export function buildProjectMemorySourceRelativePath(fileName?: string): string {
    return fileName
        ? `${PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH}/${fileName}`
        : PROJECT_MEMORY_DIRECTORY_RELATIVE_PATH;
}

export function buildProjectMemoryLiveRelativePath(fileName?: string): string {
    return fileName
        ? `${PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH}/${fileName}`
        : PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH;
}

export function resolveLiveProjectMemoryDir(bundleRoot: string): string {
    return path.join(bundleRoot, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH);
}

export function resolveTemplateProjectMemoryDir(bundleRoot: string): string {
    return path.join(bundleRoot, PROJECT_MEMORY_TEMPLATE_DIRECTORY_RELATIVE_PATH);
}

export function resolveRuntimeProjectMemoryDir(bundleRoot: string): string {
    return path.join(bundleRoot, PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH);
}

export function resolveProjectMemoryBootstrapReportPath(bundleRoot: string): string {
    return path.join(resolveRuntimeProjectMemoryDir(bundleRoot), PROJECT_MEMORY_BOOTSTRAP_REPORT_FILE);
}

export function normalizeProjectMemoryMarkdown(content: string): string {
    return String(content || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

export function stripProjectMemoryHtmlComments(text: string): string {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}

export function getProjectMemoryMeaningfulLines(text: string): string[] {
    return stripProjectMemoryHtmlComments(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) =>
            line.length > 0
            && !line.match(/^#+\s/)
            && !line.match(/^\|[-:\s|]+\|$/)
            && line !== '---'
            && line !== '```'
            && line !== '```text'
            && line !== '```bash'
            && line !== '`TODO`'
            && line !== 'TODO'
            && line !== '-'
            && line !== '- '
        );
}

export function hasSubstantiveProjectMemoryContent(text: string): boolean {
    return getProjectMemoryMeaningfulLines(text).length > 0;
}

export function sha256Hex(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}
