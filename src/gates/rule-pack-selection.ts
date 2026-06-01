import * as fs from 'node:fs';
import * as path from 'node:path';
import { selectRulePackFiles } from './review-context-token-economy';
import { fileSha256, normalizePath, resolvePathInsideRepo } from './helpers';
import { resolveGateExecutionPath } from './isolation-sandbox';
import {
    RULE_PACK_ENTRY_FILE_NAMES,
    RULE_PACK_STAGE_KEYS,
    type RulePackStageLabel
} from './rule-pack-types';
import { isRecord } from './rule-pack-records';

export function getRulePackStageKey(stage: RulePackStageLabel): 'task_entry' | 'post_preflight' {
    return RULE_PACK_STAGE_KEYS[stage];
}

export function getRulePackRulesRoot(repoRoot: string): string {
    return resolveGateExecutionPath(repoRoot, path.join('live', 'docs', 'agent-rules'));
}

export function getRulePackRequiredEntryFiles(repoRoot: string): string[] {
    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return RULE_PACK_ENTRY_FILE_NAMES.map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

export function getRulePackRequiredFilesFromPreflight(
    repoRoot: string,
    requiredReviews: Record<string, boolean>,
    effectiveDepth: number
): string[] {
    const fileNames = new Set<string>(RULE_PACK_ENTRY_FILE_NAMES);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return [...fileNames].map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

export function normalizeLoadedRuleFilePath(repoRoot: string, ruleFile: string): string {
    const rawValue = String(ruleFile || '').trim();
    if (!rawValue) {
        throw new Error('LoadedRuleFiles contains an empty value.');
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    const resolvedPath = (path.isAbsolute(rawValue) || rawValue.includes('/') || rawValue.includes('\\'))
        ? resolvePathInsideRepo(rawValue, repoRoot)
        : path.join(rulesRoot, rawValue);
    if (!resolvedPath) {
        throw new Error(`Loaded rule file '${rawValue}' could not be resolved.`);
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw new Error(`Loaded rule file not found: ${resolvedPath}`);
    }

    const normalizedRulesRoot = normalizePath(rulesRoot).toLowerCase();
    const normalizedResolvedPath = normalizePath(resolvedPath);
    const normalizedResolvedLower = normalizedResolvedPath.toLowerCase();
    if (
        normalizedResolvedLower !== normalizedRulesRoot
        && !normalizedResolvedLower.startsWith(`${normalizedRulesRoot}/`)
    ) {
        throw new Error(
            `Loaded rule file must resolve inside '${normalizePath(rulesRoot)}'. Got '${normalizedResolvedPath}'.`
        );
    }

    return normalizedResolvedPath;
}

export function normalizeLoadedRuleFiles(repoRoot: string, loadedRuleFiles: string[]): string[] {
    const normalized = loadedRuleFiles.map(function (ruleFile) {
        return normalizeLoadedRuleFilePath(repoRoot, ruleFile);
    });
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const ruleFile of normalized) {
        const key = ruleFile.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(ruleFile);
        }
    }
    return unique.sort();
}

export function buildRuleFileHashes(ruleFiles: string[]): Record<string, string | null> {
    return Object.fromEntries(ruleFiles.map(function (ruleFile) {
        return [ruleFile, fileSha256(ruleFile)];
    }));
}

export function sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const rightSet = new Set(right.map(function (item) {
        return item.toLowerCase();
    }));
    return left.every(function (item) {
        return rightSet.has(item.toLowerCase());
    });
}

export function normalizeRuleFileList(repoRoot: string, value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    try {
        return normalizeLoadedRuleFiles(repoRoot, value.map(function (item) { return String(item || ''); }).filter(Boolean));
    } catch {
        return [];
    }
}

export function readRuleHash(record: unknown, ruleFile: string): string | null {
    if (!isRecord(record)) {
        return null;
    }
    const exact = record[ruleFile];
    if (typeof exact === 'string' && exact.trim()) {
        return exact.trim().toLowerCase();
    }
    const normalizedRuleFile = normalizePath(ruleFile).toLowerCase();
    for (const [key, value] of Object.entries(record)) {
        if (normalizePath(key).toLowerCase() === normalizedRuleFile && typeof value === 'string' && value.trim()) {
            return value.trim().toLowerCase();
        }
    }
    return null;
}

export function findStaleLoadedRuleFile(loadedRuleHashes: unknown, loadedRuleFiles: readonly string[]): string | null {
    return loadedRuleFiles.find(function (ruleFile) {
        const previousHash = readRuleHash(loadedRuleHashes, ruleFile);
        const currentHash = fileSha256(ruleFile);
        return !previousHash || !currentHash || previousHash !== currentHash.toLowerCase();
    }) || null;
}
