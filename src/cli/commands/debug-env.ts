import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { redactPath, redactHostname, redactEnvObject } from '../../core/redaction';

const TRIAGE_ENV_KEYS: readonly string[] = Object.freeze([
    'NODE_ENV',
    'CI',
    'GITHUB_ACTIONS',
    'TERM',
    'SHELL',
    'COMSPEC',
    'NO_COLOR',
    'FORCE_COLOR',
    'LANG',
    'LC_ALL',
    'TERM_PROGRAM',
    'EDITOR',
]);

export interface DebugEnvSnapshot {
    cli_version: string;
    node_version: string;
    platform: string;
    arch: string;
    os_release: string;
    hostname: string | null;
    cpus: number;
    total_memory_mb: number;
    shell: string | null;
    cwd: string;
    bundle_present: boolean;
    bundle_path: string;
    live_version: string | null;
    env: Record<string, string>;
}

// Paths and hostnames are redacted through the central redaction module.
export function collectDebugEnvSnapshot(
    targetRoot: string,
    cliVersion: string
): DebugEnvSnapshot {
    const bundlePath = path.join(targetRoot, resolveBundleName());
    const bundlePresent = fs.existsSync(bundlePath) && fs.statSync(bundlePath).isDirectory();

    let liveVersion: string | null = null;
    const versionJsonPath = path.join(bundlePath, 'live', 'version.json');
    if (bundlePresent) {
        try {
            const raw = fs.readFileSync(versionJsonPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.version === 'string') {
                liveVersion = parsed.version;
            }
        } catch {
            // version.json missing or unreadable — surface as null
        }
    }

    const repoRoot = path.resolve(targetRoot);

    const relevantEnv: Record<string, string | undefined> = {};
    for (const key of TRIAGE_ENV_KEYS) {
        if (process.env[key] !== undefined) {
            relevantEnv[key] = process.env[key];
        }
    }
    const secretRedacted = redactEnvObject(relevantEnv);
    // Path-redact shell/editor values that may contain usernames or home directories.
    const pathValueKeys = new Set(['SHELL', 'COMSPEC', 'EDITOR']);
    const redactedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(secretRedacted)) {
        redactedEnv[key] = pathValueKeys.has(key) ? redactPath(value, repoRoot) : value;
    }

    const rawShell = process.env.SHELL || process.env.COMSPEC || null;

    return {
        cli_version: cliVersion,
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        os_release: os.release(),
        hostname: redactHostname(os.hostname()),
        cpus: os.cpus().length,
        total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
        shell: rawShell ? redactPath(rawShell, repoRoot) : null,
        cwd: redactPath(process.cwd(), repoRoot),
        bundle_present: bundlePresent,
        bundle_path: redactPath(bundlePath, repoRoot),
        live_version: liveVersion,
        env: redactedEnv,
    };
}

export function formatDebugEnvText(snapshot: DebugEnvSnapshot): string {
    const lines: string[] = [];
    lines.push('GARDA_DEBUG_ENV');
    lines.push(`CLI version:    ${snapshot.cli_version}`);
    lines.push(`Node version:   ${snapshot.node_version}`);
    lines.push(`Platform:       ${snapshot.platform}`);
    lines.push(`Arch:           ${snapshot.arch}`);
    lines.push(`OS release:     ${snapshot.os_release}`);
    lines.push(`Hostname:       ${snapshot.hostname ?? '(unknown)'}`);
    lines.push(`CPUs:           ${snapshot.cpus}`);
    lines.push(`Total memory:   ${snapshot.total_memory_mb} MB`);
    lines.push(`Shell:          ${snapshot.shell ?? '(none)'}`);
    lines.push(`CWD:            ${snapshot.cwd}`);
    lines.push(`Bundle present: ${snapshot.bundle_present}`);
    lines.push(`Bundle path:    ${snapshot.bundle_path}`);
    lines.push(`Live version:   ${snapshot.live_version ?? '(not found)'}`);

    const envKeys = Object.keys(snapshot.env);
    if (envKeys.length > 0) {
        lines.push('Environment:');
        for (const key of envKeys) {
            lines.push(`  ${key}=${snapshot.env[key]}`);
        }
    } else {
        lines.push('Environment:    (none of the triage keys are set)');
    }

    return lines.join('\n');
}

export function formatDebugEnvJson(snapshot: DebugEnvSnapshot): string {
    return JSON.stringify(snapshot, null, 2);
}
