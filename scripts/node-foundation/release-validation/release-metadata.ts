import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    formatGitFailure,
    isGitTracked,
    readTextFileIfExists,
    runGit
} from './shared';

export interface ReleaseMetadataContractResult {
    passed: boolean;
    details: string[];
}

const MARKDOWN_REFERENCE_DEFINITION_PATTERN = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:(?:"[^"]*")|(?:'[^']*')|(?:\([^)]*\))))?[ \t]*$/gmu;
const MARKDOWN_REFERENCE_USE_PATTERN = /!?\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/gu;
const MARKDOWN_SHORTCUT_REFERENCE_USE_PATTERN = /(?<!!)(?<!\\)(?<!\])\[([^\]\r\n]+)\](?![\[(]|[ \t]*:)/gu;
const HTML_LINK_TARGET_PATTERN = /<(?:a|area)\b[^>]*\bhref[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')[^>]*>/giu;
const HTML_ANCHOR_PATTERN = /<[^>]+\b(?:id|name)[ \t]*=[ \t]*(?:"([^"]+)"|'([^']+)')[^>]*>/giu;

interface MarkdownTargets {
    targets: string[];
    undefinedReferences: string[];
}

function normalizeMarkdownTarget(rawTarget: string): string {
    const trimmed = rawTarget.trim();
    if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function stripFencedMarkdownCode(markdown: string): string {
    return markdown.replace(
        /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^[ \t]{0,3}\1[ \t]*$/gmu,
        ''
    );
}

function prepareMarkdownForLinkScan(markdown: string): string {
    return stripFencedMarkdownCode(markdown).replace(/(`+)([^\r\n]*?)\1/gu, '');
}

function prepareMarkdownForAnchorScan(markdown: string): string {
    return stripFencedMarkdownCode(markdown).replace(/(`+)([^\r\n]*?)\1/gu, '$2');
}

function collectInlineMarkdownTargets(markdown: string): string[] {
    const targets: string[] = [];
    for (let cursor = 0; cursor < markdown.length - 1; cursor += 1) {
        if (markdown[cursor] !== ']' || markdown[cursor + 1] !== '(') {
            continue;
        }

        let targetStart = cursor + 2;
        while (targetStart < markdown.length && /[ \t\r\n]/u.test(markdown[targetStart])) {
            targetStart += 1;
        }
        if (targetStart >= markdown.length) {
            continue;
        }

        if (markdown[targetStart] === '<') {
            let targetEnd = targetStart + 1;
            while (targetEnd < markdown.length && markdown[targetEnd] !== '>') {
                targetEnd += markdown[targetEnd] === '\\' ? 2 : 1;
            }
            if (targetEnd < markdown.length) {
                targets.push(markdown.slice(targetStart + 1, targetEnd));
                cursor = targetEnd;
            }
            continue;
        }

        let targetEnd = targetStart;
        let nestedParentheses = 0;
        let escaped = false;
        while (targetEnd < markdown.length) {
            const character = markdown[targetEnd];
            if (escaped) {
                escaped = false;
                targetEnd += 1;
                continue;
            }
            if (character === '\\') {
                escaped = true;
                targetEnd += 1;
                continue;
            }
            if (character === '(') {
                nestedParentheses += 1;
                targetEnd += 1;
                continue;
            }
            if (character === ')') {
                if (nestedParentheses === 0) {
                    break;
                }
                nestedParentheses -= 1;
                targetEnd += 1;
                continue;
            }
            if (/[ \t\r\n]/u.test(character) && nestedParentheses === 0) {
                break;
            }
            targetEnd += 1;
        }
        if (targetEnd > targetStart) {
            targets.push(markdown.slice(targetStart, targetEnd).replace(/\\([()])/gu, '$1'));
            cursor = targetEnd;
        }
    }
    return targets;
}

function normalizeReferenceLabel(label: string): string {
    return label.trim().replace(/[ \t\r\n]+/gu, ' ').toLocaleLowerCase('en-US');
}

function collectMarkdownTargets(markdown: string): MarkdownTargets {
    const source = prepareMarkdownForLinkScan(markdown);
    const targets = collectInlineMarkdownTargets(source);
    const definitions = new Map<string, string>();

    for (const match of source.matchAll(MARKDOWN_REFERENCE_DEFINITION_PATTERN)) {
        const label = normalizeReferenceLabel(match[1] || '');
        const target = normalizeMarkdownTarget(match[2] || match[3] || '');
        if (label && target && !definitions.has(label)) {
            definitions.set(label, target);
            targets.push(target);
        }
    }

    const undefinedReferences: string[] = [];
    for (const match of source.matchAll(MARKDOWN_REFERENCE_USE_PATTERN)) {
        const label = normalizeReferenceLabel(match[2] || match[1] || '');
        if (label && !definitions.has(label)) {
            undefinedReferences.push(label);
        }
    }
    for (const match of source.matchAll(MARKDOWN_SHORTCUT_REFERENCE_USE_PATTERN)) {
        const label = normalizeReferenceLabel(match[1] || '');
        const isTaskCheckbox = label === '' || label.toLocaleLowerCase('en-US') === 'x';
        const isFootnote = label.startsWith('^');
        if (!isTaskCheckbox && !isFootnote && !definitions.has(label)) {
            undefinedReferences.push(label);
        }
    }
    for (const match of source.matchAll(HTML_LINK_TARGET_PATTERN)) {
        const target = normalizeMarkdownTarget(match[1] || match[2] || '');
        if (target) {
            targets.push(target);
        }
    }

    return {
        targets: [...new Set(targets)],
        undefinedReferences: [...new Set(undefinedReferences)]
    };
}

function normalizeHeadingText(heading: string): string {
    return heading
        .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/!?\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
        .replace(/<[^>]+>/gu, '')
        .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu, '')
        .replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/gu, '$1')
        .replace(/[*_~`]/gu, '');
}

function githubHeadingSlug(heading: string): string {
    return normalizeHeadingText(heading)
        .trim()
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- \t]/gu, '')
        .replace(/[ \t]+/gu, '-');
}

function collectMarkdownAnchors(markdown: string): Set<string> {
    const source = prepareMarkdownForAnchorScan(markdown);
    const baseSlugCounts = new Map<string, number>();
    const anchors = new Set<string>();
    const headings: string[] = [];

    for (const match of source.matchAll(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)) {
        headings.push(match[1] || '');
    }
    for (const match of source.matchAll(/^([^\r\n]+)\r?\n[ \t]{0,3}(?:=+|-+)[ \t]*$/gmu)) {
        headings.push(match[1] || '');
    }
    for (const heading of headings) {
        const baseSlug = githubHeadingSlug(heading);
        if (!baseSlug) {
            continue;
        }
        const duplicateIndex = baseSlugCounts.get(baseSlug) || 0;
        anchors.add(duplicateIndex === 0 ? baseSlug : `${baseSlug}-${duplicateIndex}`);
        baseSlugCounts.set(baseSlug, duplicateIndex + 1);
    }
    for (const match of source.matchAll(HTML_ANCHOR_PATTERN)) {
        const anchor = match[1] || match[2] || '';
        if (anchor) {
            anchors.add(anchor);
        }
    }
    return anchors;
}

function pathIsInsideRoot(rootPath: string, candidatePath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath)
    );
}

type RepositoryPathResolution =
    | { status: 'inside'; realPath: string }
    | { status: 'missing' }
    | { status: 'outside' }
    | { status: 'unresolvable' };

function resolveRepositoryPath(
    lexicalRoot: string,
    realRoot: string,
    candidatePath: string
): RepositoryPathResolution {
    if (!pathIsInsideRoot(lexicalRoot, candidatePath)) {
        return { status: 'outside' };
    }
    if (!fs.existsSync(candidatePath)) {
        return { status: 'missing' };
    }
    try {
        const realPath = fs.realpathSync.native(candidatePath);
        return pathIsInsideRoot(realRoot, realPath)
            ? { status: 'inside', realPath }
            : { status: 'outside' };
    } catch (_error) {
        return { status: 'unresolvable' };
    }
}

export function validateReleaseTagAssignment(
    repoRoot: string,
    version: string | null
): ReleaseMetadataContractResult {
    if (!version) {
        return {
            passed: false,
            details: ['Package version is unavailable, so release-tag uniqueness cannot be checked.']
        };
    }

    const tagName = `v${version}`;
    const tagRef = `refs/tags/${tagName}`;
    const tagLookup = runGit(repoRoot, ['show-ref', '--verify', '--quiet', tagRef]);
    if (tagLookup.status === 1 && !tagLookup.error) {
        return {
            passed: true,
            details: [`Local release tag ${tagName} is not assigned yet.`]
        };
    }
    if (tagLookup.status !== 0 || tagLookup.error) {
        return {
            passed: false,
            details: [formatGitFailure(`Unable to inspect local release tag ${tagName}`, tagLookup)]
        };
    }

    const tagCommit = runGit(repoRoot, ['rev-parse', '--verify', `${tagRef}^{commit}`]);
    const headCommit = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (tagCommit.status !== 0 || tagCommit.error) {
        return {
            passed: false,
            details: [formatGitFailure(`Unable to resolve local release tag ${tagName}`, tagCommit)]
        };
    }
    if (headCommit.status !== 0 || headCommit.error) {
        return {
            passed: false,
            details: [formatGitFailure('Unable to resolve release candidate HEAD', headCommit)]
        };
    }

    const tagSha = String(tagCommit.stdout || '').trim();
    const headSha = String(headCommit.stdout || '').trim();
    return {
        passed: false,
        details: [
            tagSha === headSha
                ? `Local release tag ${tagName} already exists at HEAD ${headSha}; release readiness requires an unassigned version.`
                : `Local release tag ${tagName} already points at ${tagSha || 'unknown'}, while the release candidate HEAD is ${headSha || 'unknown'}.`
        ]
    };
}

export function validateChangelogReleaseSection(
    repoRoot: string,
    version: string | null
): ReleaseMetadataContractResult {
    const relativePath = 'CHANGELOG.md';
    const changelog = readTextFileIfExists(path.join(repoRoot, relativePath));
    if (changelog === null) {
        return { passed: false, details: [`Missing ${relativePath}.`] };
    }

    const headings = [...changelog.matchAll(/^##[ \t]+([^\s#]+)[ \t]*$/gmu)];
    const targetVersion = version || 'unknown';
    const matchingHeadings = headings.filter((match) => match[1] === targetVersion);
    const firstReleaseVersion = headings[0]?.[1] || 'missing';
    let targetSectionHasEntries = false;
    const targetHeading = matchingHeadings[0];
    if (targetHeading && targetHeading.index !== undefined) {
        const contentStart = targetHeading.index + targetHeading[0].length;
        const remaining = changelog.slice(contentStart);
        const nextHeadingOffset = remaining.search(/^##[ \t]+/mu);
        const section = nextHeadingOffset === -1 ? remaining : remaining.slice(0, nextHeadingOffset);
        targetSectionHasEntries = /^-[ \t]+\S/mu.test(section);
    }

    const normalizedChangelog = changelog.replace(/\r\n?/gu, '\n');
    let releasedHistoryPreserved = true;
    let releasedHistoryDetail = 'released history baseline=none';
    const releaseTags = runGit(repoRoot, ['tag', '--list', 'v[0-9]*', '--sort=-version:refname']);
    let previousReleaseVersion: string | undefined;
    if (releaseTags.status !== 0 || releaseTags.error) {
        releasedHistoryPreserved = false;
        releasedHistoryDetail = formatGitFailure('Unable to enumerate released changelog history', releaseTags);
    } else {
        previousReleaseVersion = String(releaseTags.stdout || '')
            .split(/\r?\n/u)
            .map((tag) => tag.trim())
            .find((tag) => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag) && tag !== `v${targetVersion}`)
            ?.slice(1);
    }
    if (releasedHistoryPreserved && previousReleaseVersion) {
        const historyTag = `v${previousReleaseVersion}`;
        const taggedChangelog = runGit(repoRoot, ['show', `refs/tags/${historyTag}:CHANGELOG.md`]);
        if (taggedChangelog.status !== 0 || taggedChangelog.error) {
            releasedHistoryPreserved = false;
            releasedHistoryDetail = formatGitFailure(
                `Unable to load released changelog history from ${historyTag}`,
                taggedChangelog
            );
        } else {
            const currentHistoryHeading = [...normalizedChangelog.matchAll(/^##[ \t]+([^\s#]+)[ \t]*$/gmu)]
                .find((match) => match[1] === previousReleaseVersion);
            const normalizedTaggedChangelog = String(taggedChangelog.stdout || '').replace(/\r\n?/gu, '\n');
            const taggedHistoryHeading = [...normalizedTaggedChangelog.matchAll(/^##[ \t]+([^\s#]+)[ \t]*$/gmu)]
                .find((match) => match[1] === previousReleaseVersion);
            releasedHistoryPreserved = currentHistoryHeading?.index !== undefined
                && taggedHistoryHeading?.index !== undefined
                && normalizedChangelog.slice(currentHistoryHeading.index)
                    === normalizedTaggedChangelog.slice(taggedHistoryHeading.index);
            releasedHistoryDetail = `released history baseline=${historyTag}; preserved=${releasedHistoryPreserved}`;
        }
    }

    const tracked = isGitTracked(repoRoot, relativePath);
    const passed = Boolean(version)
        && tracked
        && firstReleaseVersion === targetVersion
        && matchingHeadings.length === 1
        && targetSectionHasEntries
        && releasedHistoryPreserved;
    return {
        passed,
        details: [
            `${relativePath} tracked=${tracked}`,
            `first release heading=${firstReleaseVersion}`,
            `Release ${targetVersion} heading count=${matchingHeadings.length}`,
            `Release ${targetVersion} has entries=${targetSectionHasEntries}`,
            releasedHistoryDetail
        ]
    };
}

export function validateTrackedMarkdownLinks(repoRoot: string): ReleaseMetadataContractResult {
    const trackedMarkdown = runGit(repoRoot, ['ls-files', '-z', '--', '*.md']);
    if (trackedMarkdown.status !== 0 || trackedMarkdown.error) {
        return {
            passed: false,
            details: [formatGitFailure('Unable to enumerate tracked Markdown files', trackedMarkdown)]
        };
    }

    const normalizedRoot = path.resolve(repoRoot);
    let realRoot = '';
    try {
        realRoot = fs.realpathSync.native(normalizedRoot);
    } catch (_error) {
        return {
            passed: false,
            details: ['Repository root cannot be resolved for Markdown link validation.']
        };
    }
    const relativePaths = String(trackedMarkdown.stdout || '')
        .split('\0')
        .map((entry) => entry.trim())
        .filter((entry) => Boolean(entry) && entry !== 'TASK.md');
    const brokenLinks: string[] = [];
    const anchorCache = new Map<string, Set<string> | null>();
    let localTargetsChecked = 0;

    for (const relativePath of relativePaths) {
        const sourcePath = path.join(normalizedRoot, ...relativePath.split('/'));
        const sourceResolution = resolveRepositoryPath(normalizedRoot, realRoot, sourcePath);
        if (sourceResolution.status !== 'inside') {
            const reason = sourceResolution.status === 'missing'
                ? 'tracked file missing'
                : 'tracked file resolves outside repository';
            brokenLinks.push(`${relativePath} (${reason})`);
            continue;
        }
        const markdown = readTextFileIfExists(sourceResolution.realPath);
        if (markdown === null) {
            brokenLinks.push(`${relativePath} (tracked file missing)`);
            continue;
        }
        const markdownTargets = collectMarkdownTargets(markdown);
        for (const label of markdownTargets.undefinedReferences) {
            brokenLinks.push(`${relativePath} -> [${label}] (undefined reference)`);
        }
        for (const target of markdownTargets.targets) {
            if (!target || target.startsWith('/')) {
                continue;
            }
            if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
                continue;
            }

            const fragmentOffset = target.indexOf('#');
            const rawFragment = fragmentOffset === -1 ? '' : target.slice(fragmentOffset + 1);
            const pathAndQuery = fragmentOffset === -1 ? target : target.slice(0, fragmentOffset);
            const targetPath = pathAndQuery.split('?')[0];
            if (!targetPath && !rawFragment) {
                continue;
            }
            let decodedTarget = '';
            let decodedFragment = '';
            try {
                decodedTarget = decodeURIComponent(targetPath);
                decodedFragment = decodeURIComponent(rawFragment);
            } catch (_error) {
                brokenLinks.push(`${relativePath} -> ${target} (invalid URI encoding)`);
                continue;
            }
            const resolvedTarget = decodedTarget
                ? path.resolve(path.dirname(sourcePath), decodedTarget)
                : sourcePath;
            const targetResolution = resolveRepositoryPath(normalizedRoot, realRoot, resolvedTarget);
            if (targetResolution.status === 'outside') {
                brokenLinks.push(`${relativePath} -> ${target} (outside repository)`);
                continue;
            }
            if (targetResolution.status === 'missing') {
                brokenLinks.push(`${relativePath} -> ${target} (missing target)`);
                continue;
            }
            if (targetResolution.status === 'unresolvable') {
                brokenLinks.push(`${relativePath} -> ${target} (unresolvable target)`);
                continue;
            }
            localTargetsChecked += 1;

            if (!decodedFragment) {
                continue;
            }
            const anchorDocumentPath = fs.statSync(targetResolution.realPath).isDirectory()
                ? path.join(resolvedTarget, 'README.md')
                : resolvedTarget;
            if (!/\.md(?:own)?$/iu.test(anchorDocumentPath)) {
                continue;
            }
            const anchorResolution = resolveRepositoryPath(normalizedRoot, realRoot, anchorDocumentPath);
            if (anchorResolution.status === 'outside') {
                brokenLinks.push(`${relativePath} -> ${target} (outside repository)`);
                continue;
            }
            if (anchorResolution.status !== 'inside') {
                brokenLinks.push(`${relativePath} -> ${target} (missing anchor document)`);
                continue;
            }
            let anchors = anchorCache.get(anchorResolution.realPath);
            if (anchors === undefined) {
                const anchorDocument = readTextFileIfExists(anchorResolution.realPath);
                anchors = anchorDocument === null ? null : collectMarkdownAnchors(anchorDocument);
                anchorCache.set(anchorResolution.realPath, anchors);
            }
            if (anchors === null) {
                brokenLinks.push(`${relativePath} -> ${target} (missing anchor document)`);
                continue;
            }
            if (!anchors.has(decodedFragment)) {
                brokenLinks.push(`${relativePath} -> ${target} (missing anchor)`);
            }
        }
    }

    const details = [
        `Tracked Markdown files checked: ${relativePaths.length}`,
        `Local link destinations checked: ${localTargetsChecked}`,
        `Broken relative links: ${brokenLinks.length}`
    ];
    details.push(...brokenLinks.slice(0, 40));
    if (brokenLinks.length > 40) {
        details.push(`... ${brokenLinks.length - 40} more broken relative links`);
    }
    return { passed: brokenLinks.length === 0, details };
}
