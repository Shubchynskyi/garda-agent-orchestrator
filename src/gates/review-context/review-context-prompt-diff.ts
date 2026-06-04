import { normalizePath } from '../shared/helpers';

function isTestLikeChangedFile(filePath: string): boolean {
    const normalized = normalizePath(filePath).toLowerCase();
    return normalized.includes('/test/')
        || normalized.includes('/tests/')
        || normalized.includes('/__tests__/')
        || /(^|\/)tests?\//u.test(normalized)
        || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(normalized);
}

function splitGitDiffSections(diffText: string): string[] {
    const starts = [...diffText.matchAll(/^diff --git /gmu)].map((match) => match.index ?? -1).filter((index) => index >= 0);
    if (starts.length === 0) {
        return [diffText];
    }
    return starts.map((start, index) => diffText.slice(start, starts[index + 1] ?? diffText.length));
}

function getDiffSectionFilePath(section: string): string {
    const firstLine = section.split(/\r?\n/, 1)[0] || '';
    const match = /^diff --git a\/.+ b\/(.+)$/u.exec(firstLine);
    return match ? normalizePath(match[1] || '') : '';
}

function getPromptDiffSectionPriority(reviewType: string, filePath: string): number {
    const normalized = normalizePath(filePath).toLowerCase();
    if (reviewType === 'test') {
        return isTestLikeChangedFile(normalized) ? 0 : 1;
    }
    if (reviewType !== 'api') {
        return 0;
    }
    if (normalized === 'src/gates/rule-pack/rule-pack.ts') {
        return 0;
    }
    if (normalized.startsWith('src/cli/') || normalized.startsWith('src/compat/')) {
        return 1;
    }
    if (normalized === 'docs/cli-reference.md') {
        return 2;
    }
    if (normalized.startsWith('tests/node/cli/') || normalized === 'tests/node/gates/review-context/build-review-context.test.ts') {
        return 3;
    }
    if (normalized.startsWith('src/gates/')) {
        return 4;
    }
    if (isTestLikeChangedFile(normalized)) {
        return 5;
    }
    if (normalized.startsWith('docs/') || normalized.startsWith('template/')) {
        return 6;
    }
    if (normalized.startsWith('src/') && !isTestLikeChangedFile(normalized)) {
        return 4;
    }
    if (normalized.startsWith('bin/') || normalized.startsWith('scripts/')) {
        return 4;
    }
    return 5;
}

export function prioritizePromptDiffForReview(reviewType: string, diffText: string): string {
    if ((reviewType !== 'test' && reviewType !== 'api') || !diffText.trim()) {
        return diffText;
    }
    const sections = splitGitDiffSections(diffText);
    if (sections.length <= 1) {
        return diffText;
    }
    return sections
        .map((section, index) => ({
            section,
            index,
            priority: getPromptDiffSectionPriority(reviewType, getDiffSectionFilePath(section))
        }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map((entry) => entry.section)
        .join('');
}
