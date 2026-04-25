export const REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION =
    'Spawn a new clean-context delegated reviewer for this review context; do not reuse an existing reviewer session. Codex/Claude should use fork_context=false when available, and other providers must use provider-equivalent isolated sub-agent or task launch.';

export const REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION =
    'Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence; reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.';

export const REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION =
    'After the review receipt is persisted, close or release the reviewer sub-agent session.';
