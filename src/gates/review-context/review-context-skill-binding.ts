import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { hasSkillEntrypoint } from '../../core/review-capabilities';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';
import type { ReviewSkillBinding } from './review-context-artifacts';

export function resolveCatalogReviewSkillBinding(
    skillIds: readonly string[],
    repoRoot: string
): ReviewSkillBinding {
    const candidates = [...skillIds];
    const resolvedRepoRoot = path.resolve(repoRoot);
    const invalidSkillId = candidates.find((candidate) => (
        candidate.length === 0
        || candidate.trim() !== candidate
        || candidate === '.'
        || candidate === '..'
        || candidate.includes('/')
        || candidate.includes('\\')
        || candidate.includes('\0')
        || path.isAbsolute(candidate)
    ));
    if (invalidSkillId !== undefined) {
        throw new Error(
            `ReviewSkillId must be a single catalog path component without traversal: ${invalidSkillId}.`
        );
    }
    const resolvedSkillsRoot = path.join(resolvedRepoRoot, resolveBundleName(), 'live', 'skills');
    if (
        fs.existsSync(resolvedSkillsRoot)
        && !isPathRealpathInsideRoot(resolvedSkillsRoot, resolvedRepoRoot)
    ) {
        throw new Error(
            `ReviewSkillCatalogRoot must resolve inside repo root without symlink or junction escape: ` +
            `${normalizePath(resolvedSkillsRoot)}.`
        );
    }
    const skillId = candidates.find((candidate) => {
        const candidateRoot = path.join(resolvedSkillsRoot, candidate);
        return hasSkillEntrypoint(candidateRoot);
    }) || candidates[0] || '';
    const skillRoot = path.join(resolvedSkillsRoot, skillId);
    const skillMdPath = path.join(skillRoot, 'SKILL.md');
    const skillJsonPath = path.join(skillRoot, 'skill.json');
    const skillPath = fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile()
        ? skillMdPath
        : skillJsonPath;
    const skillExists = fs.existsSync(skillPath) && fs.statSync(skillPath).isFile();
    if (!skillExists) {
        throw new Error(
            `Review context cannot be built because immutable lane skill candidates are missing an entrypoint: ` +
            `${candidates.join(', ') || 'none'}.`
        );
    }
    if (!isPathRealpathInsideRoot(skillPath, resolvedSkillsRoot)) {
        throw new Error(
            `ReviewSkillPath must resolve inside the catalog skills root without symlink or junction escape: ` +
            `${normalizePath(skillPath)}.`
        );
    }
    return {
        skill_id: skillId,
        skill_path: normalizePath(skillPath),
        skill_sha256: fileSha256(skillPath),
        skill_directory_path: normalizePath(skillRoot),
        skill_entrypoint_exists: true,
        candidate_skill_ids: candidates
    };
}
