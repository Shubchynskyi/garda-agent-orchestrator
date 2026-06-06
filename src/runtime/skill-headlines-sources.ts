import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { pathExists } from '../core/filesystem';
import { asObjectRecord } from './skill-manifest';
import { computeSha256FromText } from './skill-headlines-hashing';
import type { SkillsHeadlinesSourceFileSnapshot } from './skill-headlines-types';

export function getLiveSkillsRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'skills');
}

export function getTemplateSkillPacksRoot(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'skill-packs');
}

export function getSkillPacksConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skill-packs.json');
}

export function getSkillsHeadlinesConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
}

export function sortDirectoryEntries(entries: fs.Dirent[]): fs.Dirent[] {
    return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

export function readJsonSourceFileSnapshot(bundleRoot: string, filePath: string): SkillsHeadlinesSourceFileSnapshot {
    const text = fs.readFileSync(filePath, 'utf8');
    return {
        filePath,
        relativePath: path.relative(path.resolve(bundleRoot), filePath).replace(/\\/g, '/'),
        stats: fs.statSync(filePath),
        text,
        parsed: asObjectRecord(JSON.parse(text))
    };
}

export function collectHeadlineSourceStateFiles(bundleRoot: string): string[] {
    const files: string[] = [];
    const skillPacksConfigPath = getSkillPacksConfigPath(bundleRoot);
    if (pathExists(skillPacksConfigPath)) {
        files.push(skillPacksConfigPath);
    }

    const templateSkillPacksRoot = getTemplateSkillPacksRoot(bundleRoot);
    if (pathExists(templateSkillPacksRoot)) {
        for (const entry of fs.readdirSync(templateSkillPacksRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const packRoot = path.join(templateSkillPacksRoot, entry.name);
            const packManifestPath = path.join(packRoot, 'pack.json');
            if (pathExists(packManifestPath)) {
                files.push(packManifestPath);
            }
            const skillsRoot = path.join(packRoot, 'skills');
            if (!pathExists(skillsRoot)) {
                continue;
            }
            for (const skillEntry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
                if (!skillEntry.isDirectory()) {
                    continue;
                }
                const skillManifestPath = path.join(skillsRoot, skillEntry.name, 'skill.json');
                if (pathExists(skillManifestPath)) {
                    files.push(skillManifestPath);
                }
            }
        }
    }

    const liveSkillsRoot = getLiveSkillsRoot(bundleRoot);
    if (pathExists(liveSkillsRoot)) {
        for (const skillEntry of fs.readdirSync(liveSkillsRoot, { withFileTypes: true })) {
            if (!skillEntry.isDirectory()) {
                continue;
            }
            const skillManifestPath = path.join(liveSkillsRoot, skillEntry.name, 'skill.json');
            if (pathExists(skillManifestPath)) {
                files.push(skillManifestPath);
            }
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

export function computeSourceStateSha256FromSnapshots(snapshots: readonly SkillsHeadlinesSourceFileSnapshot[]): string {
    const hash = createHash('sha256');
    for (const snapshot of snapshots) {
        hash.update(snapshot.relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(snapshot.text, 'utf8');
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}

export function computeSourceStateHintSha256FromSnapshots(snapshots: readonly SkillsHeadlinesSourceFileSnapshot[]): string {
    const hash = createHash('sha256');
    for (const snapshot of snapshots) {
        hash.update(snapshot.relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(computeSha256FromText(snapshot.text), 'utf8');
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}

export function computeSkillsHeadlinesSourceStateSha256(bundleRoot: string): string {
    const hash = createHash('sha256');
    const normalizedBundleRoot = path.resolve(bundleRoot);
    for (const filePath of collectHeadlineSourceStateFiles(bundleRoot)) {
        const relativePath = path.relative(normalizedBundleRoot, filePath).replace(/\\/g, '/');
        hash.update(relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(fs.readFileSync(filePath));
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}

export function computeSkillsHeadlinesSourceStateHintSha256(bundleRoot: string): string {
    const hash = createHash('sha256');
    const normalizedBundleRoot = path.resolve(bundleRoot);
    for (const filePath of collectHeadlineSourceStateFiles(bundleRoot)) {
        const relativePath = path.relative(normalizedBundleRoot, filePath).replace(/\\/g, '/');
        hash.update(relativePath, 'utf8');
        hash.update('\0', 'utf8');
        hash.update(createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), 'utf8');
        hash.update('\0', 'utf8');
    }
    return hash.digest('hex');
}
