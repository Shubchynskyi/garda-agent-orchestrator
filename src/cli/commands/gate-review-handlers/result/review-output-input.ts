import * as fs from 'node:fs';
import * as path from 'node:path';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    resolveLegacyReviewTempRoot,
    resolveReviewScratchRoot
} from '../../../../gates/review/review-scratch-paths';
import {
    isTaskOwnedReviewTempPath
} from '../../gates-artifacts';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';

export interface ResolvedReviewOutputInput {
    reviewContent: string;
    reviewOutputPath: string;
    reviewOutputMode: 'path' | 'stdin';
    reviewOutputSourcePath: string | null;
    reviewOutputSourceMtimeUtc: string | null;
}

function getCanonicalReviewOutputArtifactPath(reviewsRoot: string, taskId: string, reviewType: string): string {
    return path.join(reviewsRoot, `${taskId}-${reviewType}-review-output.md`);
}

export let readReviewOutputFromStdin = async (): Promise<string> => {
    if (!process.stdin || process.stdin.isTTY) {
        throw new Error('ReviewOutputStdin requires piped stdin input.');
    }
    process.stdin.setEncoding('utf8');
    let content = '';
    for await (const chunk of process.stdin) {
        content += String(chunk);
    }
    return content;
};

export async function resolveReviewOutputInput(
    options: ParsedOptionsRecord,
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    readStdin: () => Promise<string> = readReviewOutputFromStdin
): Promise<ResolvedReviewOutputInput> {
    const useReviewOutputStdin = options.reviewOutputStdin === true;
    const rawReviewOutputPath = String(options.reviewOutputPath || '').trim();
    const hasReviewOutputPath = rawReviewOutputPath.length > 0;
    if (useReviewOutputStdin === hasReviewOutputPath) {
        throw new Error(
            "Review output requires exactly one input source. Provide either '--review-output-path' or '--review-output-stdin'."
        );
    }

    const reviewOutputArtifactPath = getCanonicalReviewOutputArtifactPath(reviewsRoot, taskId, reviewType);
    let reviewContent = '';
    let reviewOutputSourcePath: string | null = null;
    let reviewOutputSourceMtimeUtc: string | null = null;
    if (useReviewOutputStdin) {
        reviewContent = await readStdin();
    } else {
        const resolvedReviewOutputPath = gateHelpers.resolvePathInsideRepo(rawReviewOutputPath, repoRoot, { allowMissing: true });
        if (!resolvedReviewOutputPath) {
            throw new Error('ReviewOutputPath is required.');
        }
        const reviewOutputStat = fs.existsSync(resolvedReviewOutputPath)
            ? fs.statSync(resolvedReviewOutputPath)
            : null;
        if (!reviewOutputStat?.isFile()) {
            throw new Error(`Review output not found: ${normalizePath(resolvedReviewOutputPath)}.`);
        }
        if (!gateHelpers.isPathRealpathInsideRoot(resolvedReviewOutputPath, repoRoot)) {
            throw new Error(
                `ReviewOutputPath must resolve inside repo root without symlink or junction escape: ` +
                `${normalizePath(resolvedReviewOutputPath)}.`
            );
        }
        const lexicalReviewOutputPath = path.resolve(resolvedReviewOutputPath);
        const realReviewOutputPath = fs.realpathSync(resolvedReviewOutputPath);
        if (
            gateHelpers.normalizePath(lexicalReviewOutputPath).toLowerCase()
            !== gateHelpers.normalizePath(realReviewOutputPath).toLowerCase()
        ) {
            throw new Error(
                `ReviewOutputPath must not traverse symlinks or junctions: ` +
                `${normalizePath(resolvedReviewOutputPath)}.`
            );
        }
        const relativeReviewTempPath = path.relative(resolveReviewScratchRoot(repoRoot), resolvedReviewOutputPath);
        const isInsideReviewTemp = relativeReviewTempPath.length > 0
            && !relativeReviewTempPath.startsWith('..')
            && !path.isAbsolute(relativeReviewTempPath);
        if (isInsideReviewTemp
            && !isTaskOwnedReviewTempPath(repoRoot, taskId, resolvedReviewOutputPath)) {
            throw new Error(
                `ReviewOutputPath inside reviewer scratch storage must encode the current task id '${taskId}' ` +
                `so cleanup can attribute it safely. Use ` +
                `'garda-agent-orchestrator/runtime/tmp/reviews/${taskId}/${reviewType}/review-output.md'.`
            );
        }
        const relativeLegacyReviewTempPath = path.relative(resolveLegacyReviewTempRoot(repoRoot), resolvedReviewOutputPath);
        const isInsideLegacyReviewTemp = relativeLegacyReviewTempPath.length > 0
            && !relativeLegacyReviewTempPath.startsWith('..')
            && !path.isAbsolute(relativeLegacyReviewTempPath);
        if (isInsideLegacyReviewTemp) {
            throw new Error(
                `ReviewOutputPath must not use legacy '.review-temp'. Use ` +
                `'garda-agent-orchestrator/runtime/tmp/reviews/${taskId}/${reviewType}/review-output.md'.`
            );
        }
        reviewOutputSourcePath = resolvedReviewOutputPath;
        reviewOutputSourceMtimeUtc = reviewOutputStat.mtime.toISOString();
        reviewContent = fs.readFileSync(resolvedReviewOutputPath, 'utf8');
    }

    if (!reviewContent.trim()) {
        throw new Error(`Review output is empty: ${normalizePath(reviewOutputArtifactPath)}.`);
    }

    return {
        reviewContent,
        reviewOutputPath: reviewOutputArtifactPath,
        reviewOutputMode: useReviewOutputStdin ? 'stdin' : 'path',
        reviewOutputSourcePath: reviewOutputSourcePath && normalizePath(reviewOutputSourcePath) !== normalizePath(reviewOutputArtifactPath)
            ? reviewOutputSourcePath
            : null,
        reviewOutputSourceMtimeUtc
    };
}
