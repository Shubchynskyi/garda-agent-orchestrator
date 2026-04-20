// ---------------------------------------------------------------------------
// Stable CLI exit codes – T-016
//
// Every non-zero exit code used by the Garda CLI must be defined here.
// Automation and CI scripts depend on these values being stable across
// releases.  Do not renumber existing codes.
// ---------------------------------------------------------------------------

/** Successful execution. */
export const EXIT_SUCCESS = 0;

/** General / unclassified failure (legacy catch-all). */
export const EXIT_GENERAL_FAILURE = 1;

/** Usage error: unknown command, bad flag, missing required arg. */
export const EXIT_USAGE_ERROR = 2;

/** A gate check did not pass (compile-gate, review-gate, etc.). */
export const EXIT_GATE_FAILURE = 3;

/** Validation failure (doctor, verify, manifest, workspace checks). */
export const EXIT_VALIDATION_FAILURE = 4;

/** Lock contention – another operation holds a lifecycle or file lock. */
export const EXIT_LOCK_CONTENTION = 5;

/** Precondition not met (missing build output, missing artifact, stale bundle). */
export const EXIT_PRECONDITION_FAILURE = 6;

/** Offline mode blocked a network-sensitive command. */
export const EXIT_OFFLINE_BLOCKED = 7;

/** Signal-interrupted (128 + SIGINT=2). Already used by signal-handler. */
export const EXIT_SIGNAL_INTERRUPT = 130;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const USAGE_PATTERNS: ReadonlyArray<string | RegExp> = [
    'Unsupported command:',
    'Unknown gate:',
    /must be one of:/i,
    /is required(?! but was not found)/i,
    /is invalid\b/i,
    /Expected one of\b/i,
    'Provide git commit arguments',
    'must not be empty',
    /unknown option/i,
    /Unrecognised option/i,
    'Stage must be one of:',
    /^Usage:/
];

const LOCK_CONTENTION_PATTERNS: ReadonlyArray<string | RegExp> = [
    'Another lifecycle operation is already running',
    'Timed out acquiring file lock:'
];

const PRECONDITION_PATTERNS: ReadonlyArray<string | RegExp> = [
    'Deployed bundle not found:',
    'Garda runtime build output not found',
    'Source Parity Violation:',
    /not found in PATH\b/
];

const OFFLINE_BLOCKED_PATTERNS: ReadonlyArray<string | RegExp> = [
    'offline mode is active'
];

const VALIDATION_PATTERNS: ReadonlyArray<string | RegExp> = [
    'Workspace doctor detected validation failures',
    /manifest.*DRIFT/i,
    /manifest.*INVALID/i
];

function matchesAny(message: string, patterns: ReadonlyArray<string | RegExp>): boolean {
    for (const pattern of patterns) {
        if (typeof pattern === 'string') {
            if (message.includes(pattern)) return true;
        } else {
            if (pattern.test(message)) return true;
        }
    }
    return false;
}

/**
 * Classify an error into the appropriate exit code.
 * The classification is conservative: if no specific pattern matches,
 * EXIT_GENERAL_FAILURE (1) is returned so behaviour stays fail-closed.
 */
export function classifyErrorExitCode(error: unknown): number {
    if (error instanceof Error && error.name === 'GateFailureError') {
        return EXIT_GATE_FAILURE;
    }
    const message = error instanceof Error ? error.message : String(error ?? '');

    if (matchesAny(message, LOCK_CONTENTION_PATTERNS)) return EXIT_LOCK_CONTENTION;
    if (matchesAny(message, OFFLINE_BLOCKED_PATTERNS))  return EXIT_OFFLINE_BLOCKED;
    if (matchesAny(message, USAGE_PATTERNS))            return EXIT_USAGE_ERROR;
    if (matchesAny(message, PRECONDITION_PATTERNS))     return EXIT_PRECONDITION_FAILURE;
    if (matchesAny(message, VALIDATION_PATTERNS))       return EXIT_VALIDATION_FAILURE;

    return EXIT_GENERAL_FAILURE;
}

/**
 * Map from code to a short human label – useful for diagnostics output.
 */
export function exitCodeLabel(code: number): string {
    switch (code) {
        case EXIT_SUCCESS:              return 'SUCCESS';
        case EXIT_GENERAL_FAILURE:      return 'GENERAL_FAILURE';
        case EXIT_USAGE_ERROR:          return 'USAGE_ERROR';
        case EXIT_GATE_FAILURE:         return 'GATE_FAILURE';
        case EXIT_VALIDATION_FAILURE:   return 'VALIDATION_FAILURE';
        case EXIT_LOCK_CONTENTION:      return 'LOCK_CONTENTION';
        case EXIT_PRECONDITION_FAILURE: return 'PRECONDITION_FAILURE';
        case EXIT_OFFLINE_BLOCKED:      return 'OFFLINE_BLOCKED';
        case EXIT_SIGNAL_INTERRUPT:     return 'SIGNAL_INTERRUPT';
        default:                        return `EXIT_${code}`;
    }
}
