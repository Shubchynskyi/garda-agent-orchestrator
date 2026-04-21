import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareVersionStrings } from './generic-utils';

export interface VersionBoundUpdateMessage {
    version: string;
    title: string;
    body: string[];
}

export interface VersionedReleaseNotes {
    version: string;
    lines: string[];
}

export interface UpdateAnnouncements {
    updateMessages: VersionBoundUpdateMessage[];
    releaseNotes: VersionedReleaseNotes[];
    warnings: string[];
}

const EMPTY_ANNOUNCEMENTS: UpdateAnnouncements = {
    updateMessages: [],
    releaseNotes: [],
    warnings: []
};

function compareSafe(left: string, right: string): number | null {
    try {
        return compareVersionStrings(left, right);
    } catch {
        return null;
    }
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry.length > 0);
}

function normalizeRegistryMessage(entry: unknown): VersionBoundUpdateMessage | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    const candidate = entry as Record<string, unknown>;
    const version = String(candidate.version ?? '').trim();
    const title = String(candidate.title ?? '').trim();
    const body = normalizeStringArray(candidate.body);
    if (!version || !title) {
        return null;
    }
    return {
        version,
        title,
        body
    };
}

function extractVersionFromHeading(heading: string): string {
    const match = String(heading || '').trim().match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\b|$)/);
    return match ? match[1] : '';
}

function isVersionInClosedRange(version: string, previousVersion: string, updatedVersion: string): boolean {
    const afterPrevious = compareSafe(previousVersion, version);
    const beforeOrAtUpdated = compareSafe(version, updatedVersion);
    return afterPrevious !== null
        && beforeOrAtUpdated !== null
        && afterPrevious < 0
        && beforeOrAtUpdated <= 0;
}

function collectMessagesInRange(messages: VersionBoundUpdateMessage[], previousVersion: string, updatedVersion: string): VersionBoundUpdateMessage[] {
    return messages
        .filter((entry) => isVersionInClosedRange(entry.version, previousVersion, updatedVersion))
        .sort((left, right) => compareSafe(left.version, right.version) ?? 0);
}

function readRegistryMessages(registryPath: string, previousVersion: string, updatedVersion: string, warnings: string[]): VersionBoundUpdateMessage[] {
    if (!fs.existsSync(registryPath)) {
        return [];
    }

    try {
        const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { messages?: unknown };
        const messages = Array.isArray(raw.messages)
            ? raw.messages
                .map((entry) => normalizeRegistryMessage(entry))
                .filter((entry): entry is VersionBoundUpdateMessage => entry !== null)
            : [];
        return collectMessagesInRange(messages, previousVersion, updatedVersion);
    } catch (error: unknown) {
        warnings.push(`Failed to read update message registry at ${registryPath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

function collectReleaseNotesInRange(changelogPath: string, previousVersion: string, updatedVersion: string, warnings: string[]): VersionedReleaseNotes[] {
    if (!fs.existsSync(changelogPath)) {
        return [];
    }

    try {
        const changelogLines = fs.readFileSync(changelogPath, 'utf8').split(/\r?\n/);
        const entries: VersionedReleaseNotes[] = [];
        let currentVersion = '';
        let currentLines: string[] = [];

        function flushCurrent(): void {
            if (!currentVersion || !isVersionInClosedRange(currentVersion, previousVersion, updatedVersion)) {
                currentVersion = '';
                currentLines = [];
                return;
            }
            const normalizedLines = currentLines
                .map((line) => line.trimEnd())
                .filter((line) => line.trim().length > 0);
            if (normalizedLines.length > 0) {
                entries.push({
                    version: currentVersion,
                    lines: normalizedLines
                });
            }
            currentVersion = '';
            currentLines = [];
        }

        for (const line of changelogLines) {
            if (line.startsWith('## ')) {
                flushCurrent();
                currentVersion = extractVersionFromHeading(line.slice(3));
                currentLines = [];
                continue;
            }
            if (currentVersion) {
                currentLines.push(line);
            }
        }
        flushCurrent();

        return entries.sort((left, right) => compareSafe(left.version, right.version) ?? 0);
    } catch (error: unknown) {
        warnings.push(`Failed to read changelog release notes at ${changelogPath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

export function collectUpdateAnnouncements(bundleRoot: string, previousVersion: string, updatedVersion: string): UpdateAnnouncements {
    const normalizedPreviousVersion = String(previousVersion || '').trim();
    const normalizedUpdatedVersion = String(updatedVersion || '').trim();
    if (!normalizedPreviousVersion || !normalizedUpdatedVersion) {
        return EMPTY_ANNOUNCEMENTS;
    }

    const versionDelta = compareSafe(normalizedPreviousVersion, normalizedUpdatedVersion);
    if (versionDelta === null || versionDelta >= 0) {
        return EMPTY_ANNOUNCEMENTS;
    }

    const warnings: string[] = [];
    return {
        updateMessages: readRegistryMessages(path.join(bundleRoot, 'live', 'config', 'update-messages.json'), normalizedPreviousVersion, normalizedUpdatedVersion, warnings),
        releaseNotes: collectReleaseNotesInRange(path.join(bundleRoot, 'CHANGELOG.md'), normalizedPreviousVersion, normalizedUpdatedVersion, warnings),
        warnings
    };
}
