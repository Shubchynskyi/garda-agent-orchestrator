export type CompileInfraRecoveryHintKind =
    | 'docker_daemon_unavailable'
    | 'testcontainers_no_environment'
    | 'container_startup_failure'
    | 'external_service_unavailable';

export interface CompileInfraRecoveryHint {
    kind: CompileInfraRecoveryHintKind;
    title: string;
    hint: string;
}

interface CompileInfraRecoveryHintDefinition {
    kind: CompileInfraRecoveryHintKind;
    title: string;
    hint: string;
    patterns: RegExp[];
    requires?: RegExp[];
}

interface CompileInfraRecoveryHintInput {
    outputLines?: readonly string[];
    errorMessage?: string | null;
}

const HINT_DEFINITIONS: CompileInfraRecoveryHintDefinition[] = [
    {
        kind: 'testcontainers_no_environment',
        title: 'Testcontainers could not find a usable Docker environment.',
        hint:
            'Start Docker Desktop or the Docker daemon, verify "docker info" works in this shell, ' +
            'check DOCKER_HOST/TESTCONTAINERS_* overrides, then rerun next-step before compile-gate.',
        requires: [/\btestcontainers?\b/i],
        patterns: [
            /\bcould not find a valid docker environment\b/i,
            /\bno docker client strategy\b/i,
            /\bdocker environment was not found\b/i,
            /\btestcontainers?[\s\S]{0,240}\bdocker environment\b/i
        ]
    },
    {
        kind: 'docker_daemon_unavailable',
        title: 'Docker daemon is unavailable to the compile command.',
        hint:
            'Start Docker Desktop or the Docker service, verify "docker info" works in this shell, ' +
            'then rerun next-step before compile-gate.',
        patterns: [
            /\bcannot connect to the docker daemon\b/i,
            /\bdocker daemon is not running\b/i,
            /\bis the docker daemon running\b/i,
            /\bdocker desktop service\b/i,
            /\/\/\.\/pipe\/docker/i,
            /\\\\\.\\pipe\\docker/i,
            /\bdockerDesktopLinuxEngine\b/i,
            /\bdocker_engine\b/i
        ]
    },
    {
        kind: 'container_startup_failure',
        title: 'A required container failed to start or become ready.',
        hint:
            'Inspect the container logs, wait strategy, resource limits, and occupied ports, ' +
            'then rerun next-step before compile-gate.',
        patterns: [
            /\btimed out waiting for container\b/i,
            /\bcontainerlaunchexception\b/i,
            /\bstartup check strategy\b/i,
            /\bwait strategy\b[\s\S]{0,160}\btimed out\b/i,
            /\bcould not start container\b/i,
            /\bcontainer startup\b[\s\S]{0,160}\b(?:failed|timeout|timed out)\b/i
        ]
    },
    {
        kind: 'external_service_unavailable',
        title: 'An external service dependency was unreachable.',
        hint:
            'Start the required service or fix the host, port, environment, and credentials visible to the compile command, ' +
            'then rerun next-step before compile-gate.',
        patterns: [
            /\beconnrefused\b/i,
            /\bconnection refused\b/i,
            /\bconnect etimedout\b/i,
            /\betimedout\b/i,
            /\beconnreset\b/i,
            /\bgetaddrinfo enotfound\b/i,
            /\bno route to host\b/i
        ]
    }
];

function textFromInput(input: CompileInfraRecoveryHintInput): string {
    const output = (input.outputLines || [])
        .map((line) => String(line || ''))
        .join('\n');
    return [
        output,
        String(input.errorMessage || '')
    ]
        .filter((part) => part.trim().length > 0)
        .join('\n');
}

function matchesAll(patterns: RegExp[] | undefined, text: string): boolean {
    if (!patterns || patterns.length === 0) {
        return true;
    }
    return patterns.every((pattern) => pattern.test(text));
}

export function classifyCompileInfraRecoveryHint(input: CompileInfraRecoveryHintInput): CompileInfraRecoveryHint | null {
    const text = textFromInput(input);
    if (!text.trim()) {
        return null;
    }
    const definition = HINT_DEFINITIONS.find((candidate) => {
        if (!matchesAll(candidate.requires, text)) {
            return false;
        }
        return candidate.patterns.some((pattern) => pattern.test(text));
    });
    if (!definition) {
        return null;
    }
    return {
        kind: definition.kind,
        title: definition.title,
        hint: definition.hint
    };
}

function coerceCompileInfraRecoveryHint(value: unknown): CompileInfraRecoveryHint | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const kind = String(record.kind || '').trim() as CompileInfraRecoveryHintKind;
    const title = String(record.title || '').trim();
    const hint = String(record.hint || '').trim();
    if (!kind || !title || !hint) {
        return null;
    }
    return { kind, title, hint };
}

export function formatCompileInfraRecoveryHintLine(value: unknown): string | null {
    const hint = coerceCompileInfraRecoveryHint(value);
    if (!hint) {
        return null;
    }
    return `InfraRecoveryHint: ${hint.title} ${hint.hint}`;
}
