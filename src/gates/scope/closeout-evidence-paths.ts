import { normalizePath } from '../shared/helpers';

const CLOSEOUT_DOC_PATH_PATTERNS = [
    '^garda-agent-orchestrator/live/docs/project-memory/'
] as const;

function isCloseoutDocumentationPath(filePath: string): boolean {
    return CLOSEOUT_DOC_PATH_PATTERNS.some((pattern) => new RegExp(pattern, 'i').test(filePath));
}

export function isCloseoutEvidencePath(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath);
    if (!normalizedPath) {
        return false;
    }
    if (normalizedPath === 'TASK.md') {
        return true;
    }
    if (normalizedPath.startsWith('.agents/')) {
        return true;
    }
    if (normalizedPath.startsWith('garda-agent-orchestrator/runtime/')) {
        return true;
    }
    return isCloseoutDocumentationPath(normalizedPath);
}

export function isReviewReuseNeutralCloseoutEvidencePath(filePath: string): boolean {
    return normalizePath(filePath) === 'TASK.md';
}
