import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH,
    sha256Hex
} from '../../core/project-memory';
import { isPlainObject } from '../../core/config-merge';
import { fileSha256, normalizePath } from '../shared/helpers';
import { readJsonFileIfPresent, toRepoPath, uniqueSorted } from './project-memory-impact-common';
import {
    type ProjectMemoryImpactArtifact,
    type ProjectMemoryImpactReason
} from './project-memory-impact-types';

interface ImpactRule {
    name: string;
    matches: (repoPath: string) => boolean;
    memoryFiles: readonly string[];
    reason: string;
}

const IMPACT_RULES: readonly ImpactRule[] = Object.freeze([
    Object.freeze({
        name: 'cli-command-surface',
        matches: (repoPath: string) => repoPath.startsWith('src/cli/commands/'),
        memoryFiles: Object.freeze(['commands.md', 'module-map.md', 'compact.md']),
        reason: 'Changed CLI command surface or command implementation.'
    }),
    Object.freeze({
        name: 'gate-runtime',
        matches: (repoPath: string) => repoPath.startsWith('src/gates/'),
        memoryFiles: Object.freeze(['risks.md', 'commands.md', 'decisions.md', 'compact.md']),
        reason: 'Changed gate/runtime workflow behavior.'
    }),
    Object.freeze({
        name: 'lifecycle-runtime',
        matches: (repoPath: string) => repoPath.startsWith('src/lifecycle/'),
        memoryFiles: Object.freeze(['decisions.md', 'module-map.md', 'risks.md', 'compact.md']),
        reason: 'Changed lifecycle/update/runtime maintenance behavior.'
    }),
    Object.freeze({
        name: 'materialization-runtime',
        matches: (repoPath: string) => repoPath.startsWith('src/materialization/'),
        memoryFiles: Object.freeze(['module-map.md', 'risks.md', 'compact.md']),
        reason: 'Changed materialization or project bootstrap behavior.'
    }),
    Object.freeze({
        name: 'project-memory-template',
        matches: (repoPath: string) => repoPath.startsWith('template/docs/project-memory/'),
        memoryFiles: Object.freeze(['compact.md']),
        reason: 'Changed project-memory template guidance.'
    }),
    Object.freeze({
        name: 'toolchain-config',
        matches: (repoPath: string) => repoPath === 'package.json'
            || repoPath.startsWith('tsconfig')
            || repoPath === 'package-lock.json',
        memoryFiles: Object.freeze(['stack.md', 'commands.md', 'decisions.md', 'compact.md']),
        reason: 'Changed toolchain, dependencies, or package metadata.'
    }),
    Object.freeze({
        name: 'agent-workflow-rules',
        matches: (repoPath: string) => repoPath === 'AGENTS.md'
            || repoPath === 'CLAUDE.md'
            || repoPath === 'GEMINI.md'
            || repoPath === 'QWEN.md'
            || repoPath.startsWith('.agents/workflows/')
            || repoPath.startsWith('template/docs/agent-rules/')
            || repoPath.startsWith('garda-agent-orchestrator/live/docs/agent-rules/'),
        memoryFiles: Object.freeze(['commands.md', 'decisions.md', 'compact.md']),
        reason: 'Changed agent workflow or rule entrypoint guidance.'
    }),
    Object.freeze({
        name: 'cli-reference-docs',
        matches: (repoPath: string) => repoPath === 'docs/cli-reference.md'
            || repoPath === 'README.md'
            || repoPath === 'HOW_TO.md',
        memoryFiles: Object.freeze(['commands.md', 'compact.md']),
        reason: 'Changed durable command or operator documentation.'
    })
]);

export function readPreflightChangedFiles(preflightPath: string | null): {
    changedFiles: string[];
    preflightHash: string | null;
    readable: boolean;
    invalidReason: string | null;
} {
    if (!preflightPath || !fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            changedFiles: [],
            preflightHash: null,
            readable: false,
            invalidReason: preflightPath ? 'Preflight artifact is missing.' : 'Preflight artifact path is not set.'
        };
    }
    const parsed = readJsonFileIfPresent(preflightPath);
    if (!isPlainObject(parsed)) {
        return {
            changedFiles: [],
            preflightHash: fileSha256(preflightPath),
            readable: false,
            invalidReason: 'Preflight artifact is not valid JSON object evidence.'
        };
    }
    const changed = Array.isArray(parsed.changed_files)
        ? parsed.changed_files.map((value) => String(value || '')).filter(Boolean)
        : [];
    return {
        changedFiles: changed,
        preflightHash: fileSha256(preflightPath),
        readable: true,
        invalidReason: null
    };
}

function appendTemplateCorrespondingFile(repoPath: string, files: Set<string>): void {
    const prefix = 'template/docs/project-memory/';
    if (!repoPath.startsWith(prefix)) {
        return;
    }
    const fileName = repoPath.slice(prefix.length);
    if ((PROJECT_MEMORY_REQUIRED_FILE_NAMES as readonly string[]).includes(fileName)) {
        files.add(fileName);
    }
}

export function routeProjectMemoryImpact(changedFiles: readonly string[]): {
    affectedFileNames: string[];
    reasons: ProjectMemoryImpactReason[];
} {
    const affected = new Set<string>();
    const reasons: ProjectMemoryImpactReason[] = [];

    for (const rawFile of changedFiles) {
        const repoPath = toRepoPath(rawFile);
        if (!repoPath || repoPath.startsWith(`${PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH}/`)) {
            continue;
        }
        if (repoPath.startsWith(PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH + '/')) {
            continue;
        }
        if (repoPath.startsWith('tests/') || repoPath.includes('/fixtures/')) {
            continue;
        }

        const fileReasons = new Set<string>();
        const fileSuggestions = new Set<string>();
        for (const rule of IMPACT_RULES) {
            if (!rule.matches(repoPath)) {
                continue;
            }
            for (const fileName of rule.memoryFiles) {
                fileSuggestions.add(fileName);
                affected.add(fileName);
            }
            fileReasons.add(rule.reason);
        }
        appendTemplateCorrespondingFile(repoPath, fileSuggestions);
        appendTemplateCorrespondingFile(repoPath, affected);

        if (fileSuggestions.size > 0) {
            reasons.push({
                changed_file: repoPath,
                reason: uniqueSorted(fileReasons).join(' '),
                suggested_memory_files: uniqueSorted(fileSuggestions)
            });
        }
    }

    return {
        affectedFileNames: uniqueSorted(affected),
        reasons
    };
}

export function buildAffectedMemoryPaths(bundleName: string, fileNames: readonly string[]): string[] {
    return fileNames.map((fileName) =>
        toRepoPath(path.posix.join(bundleName, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH, fileName))
    );
}

export function readCompactState(memoryDir: string, maxChars: number): ProjectMemoryImpactArtifact['compact'] {
    const compactPath = path.join(memoryDir, 'compact.md');
    if (!fs.existsSync(compactPath) || !fs.statSync(compactPath).isFile()) {
        return {
            path: normalizePath(compactPath),
            exists: false,
            char_count: null,
            max_chars: maxChars,
            sha256: null,
            status: 'MISSING'
        };
    }
    const content = fs.readFileSync(compactPath, 'utf8');
    return {
        path: normalizePath(compactPath),
        exists: true,
        char_count: content.length,
        max_chars: maxChars,
        sha256: sha256Hex(content),
        status: content.length > maxChars ? 'OVERFLOW' : 'OK'
    };
}

export function buildImpactFingerprint(input: {
    taskId: string;
    preflightHash: string | null;
    changedFiles: string[];
    affectedMemoryFiles: string[];
    reasons: ProjectMemoryImpactReason[];
}): string {
    return sha256Hex(JSON.stringify({
        task_id: input.taskId,
        preflight_hash_sha256: input.preflightHash,
        changed_files: input.changedFiles,
        affected_memory_files: input.affectedMemoryFiles,
        reasons: input.reasons
    }));
}
