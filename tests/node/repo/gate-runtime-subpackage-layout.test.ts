import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import * as legacyTaskEventsIo from '../../../src/gate-runtime/task-events-io';
import * as canonicalTaskEventsIo from '../../../src/gate-runtime/timeline/task-events-io';
import * as legacyTimelineSummary from '../../../src/gate-runtime/timeline-summary';
import * as canonicalTimelineSummary from '../../../src/gate-runtime/timeline/timeline-summary';

test('rejects forged facade ownership for canonical gate-runtime modules', () => {
    assert.notEqual(
        legacyTaskEventsIo,
        canonicalTaskEventsIo,
        'the compatibility facade namespace must not replace the canonical implementation owner'
    );
});

const COMPLETED_TIMELINE_MIGRATIONS = [
    'task-events-helpers',
    'task-events-integrity',
    'task-events-io',
    'task-events-locking-support',
    'timeline-summary'
] as const;

function collectTypeScriptFiles(rootPath: string): string[] {
    const files: string[] = [];
    const pendingDirectories = [rootPath];
    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop() as string;
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(entryPath);
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                files.push(entryPath);
            }
        }
    }
    return files.sort();
}

function collectRelativeModuleSpecifiers(sourceText: string): string[] {
    const specifiers: string[] = [];
    const moduleSpecifierPattern = /\b(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
    for (const match of sourceText.matchAll(moduleSpecifierPattern)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) {
            specifiers.push(specifier);
        }
    }
    return specifiers;
}

test('remaining timeline implementations live under the canonical subpackage', () => {
    const repoRoot = getRepoRoot();
    const runtimeRoot = path.join(repoRoot, 'src', 'gate-runtime');
    const canonicalRoot = path.join(runtimeRoot, 'timeline');

    for (const moduleName of COMPLETED_TIMELINE_MIGRATIONS) {
        const canonicalSource = fs.readFileSync(path.join(canonicalRoot, `${moduleName}.ts`), 'utf8');
        assert.equal(
            fs.readFileSync(path.join(runtimeRoot, `${moduleName}.ts`), 'utf8').trim(),
            `export * from './timeline/${moduleName}';`
        );
        assert.doesNotMatch(
            canonicalSource.trim(),
            /^export \* from '\.\.\/[^']+';$/,
            `${moduleName} must be owned by timeline/ instead of re-exporting a root implementation`
        );
    }
});

test('rejects forged canonical gate-runtime imports through root compatibility facades', () => {
    assert.notEqual(
        path.resolve('src/gate-runtime/task-events-io.ts'),
        path.resolve('src/gate-runtime/timeline/task-events-io.ts'),
        'the public facade and canonical implementation must remain distinct ownership paths'
    );
    const repoRoot = getRepoRoot();
    const runtimeRoot = path.join(repoRoot, 'src', 'gate-runtime');
    const canonicalRoots = [
        path.join(runtimeRoot, 'review'),
        path.join(runtimeRoot, 'timeline')
    ];
    const rootFacadePaths = new Set<string>();

    for (const sourcePath of collectTypeScriptFiles(runtimeRoot)) {
        if (path.dirname(sourcePath) !== runtimeRoot) {
            continue;
        }
        const sourceText = fs.readFileSync(sourcePath, 'utf8').trim();
        if (/^export \* from '\.\/(?:review|timeline)\/[^']+';$/.test(sourceText)) {
            rootFacadePaths.add(path.resolve(sourcePath).toLowerCase());
        }
    }

    const legacyResolutions: string[] = [];
    for (const canonicalRoot of canonicalRoots) {
        for (const sourcePath of collectTypeScriptFiles(canonicalRoot)) {
            const sourceText = fs.readFileSync(sourcePath, 'utf8');
            for (const specifier of collectRelativeModuleSpecifiers(sourceText)) {
                const resolvedPath = `${path.resolve(path.dirname(sourcePath), specifier)}.ts`.toLowerCase();
                if (rootFacadePaths.has(resolvedPath)) {
                    legacyResolutions.push(`${path.relative(repoRoot, sourcePath)} -> ${specifier}`);
                }
            }
        }
    }

    assert.ok(rootFacadePaths.size >= 30, 'expected the stable root compatibility surface to be detected');
    assert.deepEqual(legacyResolutions, []);
});

test('canonical subpackage barrels expose the timeline and review entrypoints', () => {
    const repoRoot = getRepoRoot();
    const runtimeRoot = path.join(repoRoot, 'src', 'gate-runtime');
    const timelineIndex = fs.readFileSync(path.join(runtimeRoot, 'timeline', 'index.ts'), 'utf8');
    const reviewIndex = fs.readFileSync(path.join(runtimeRoot, 'review', 'index.ts'), 'utf8');

    assert.match(timelineIndex, /export \* from '\.\/timeline-summary';/);
    assert.match(timelineIndex, /export \* from '\.\/task-events';/);
    assert.match(reviewIndex, /export \* from '\.\/review-context';/);
    assert.match(reviewIndex, /export \* from '\.\/review-artifacts';/);
});

test('deprecated root facades preserve the materialized runtime API', () => {
    assert.equal(legacyTaskEventsIo.appendTaskEvent, canonicalTaskEventsIo.appendTaskEvent);
    assert.equal(
        legacyTimelineSummary.collectTimelineSummaryForStatus,
        canonicalTimelineSummary.collectTimelineSummaryForStatus
    );
});
