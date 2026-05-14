export const REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION =
    'Spawn a new clean-context delegated reviewer for this review context using the provider-native/internal agent or subagent tool, not a shell command or hand-written artifact; do not reuse an existing reviewer session. Codex/Claude should use fork_context=false when available, and other providers must use provider-equivalent isolated sub-agent or task launch. If the current provider session cannot launch a fresh delegated reviewer, stop and report that blocker instead of fabricating routing, launch, review, receipt, or telemetry evidence.';

export const REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION =
    'Treat review context as an opaque handoff artifact. Do not open or summarize the generated review-context markdown, JSON, or scoped diff after a successful context build; pass the artifact path to the fresh delegated reviewer and inspect only gate status, paths, hashes, and reviewer output.';

export const REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION =
    'Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence; reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.';

export const REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION =
    'After the review receipt is persisted, close or release the reviewer sub-agent session.';
