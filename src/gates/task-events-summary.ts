import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId, inspectTaskEventFile, forEachJsonlLine } from '../gate-runtime/task-events';
import { coerceIntLike } from '../gate-runtime/token-telemetry';
import { resolvePathInsideRepo, toPosix } from './helpers';

const REVIEW_CONTEXT_LABELS = Object.freeze({
    code: 'code review context',
    db: 'DB review context',
    security: 'security review context',
    refactor: 'refactor review context',
    api: 'API review context',
    test: 'test review context',
    performance: 'performance review context',
    infra: 'infra review context',
    dependency: 'dependency review context'
});

/**
 * Parse an ISO 8601 timestamp to a Date, matching Python parse_timestamp.
 */
export function parseTimestamp(value: unknown): Date {
    if (value == null) return new Date(0);
    const text = String(value).trim();
    if (!text) return new Date(0);
    const candidate = text.replace('Z', '+00:00');
    try {
        const parsed = new Date(candidate);
        if (isNaN(parsed.getTime())) return new Date(0);
        return parsed;
    } catch {
        return new Date(0);
    }
}

/**
 * Format a timestamp to ISO 8601 UTC string.
 */
export function formatTimestamp(value: unknown): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
        if (isNaN(value.getTime())) return null;
        return value.toISOString();
    }
    const text = String(value).trim();
    if (!text) return null;
    try {
        const parsed = new Date(text.replace('Z', '+00:00'));
        if (isNaN(parsed.getTime())) return text;
        return parsed.toISOString();
    } catch {
        return text;
    }
}

export interface AuditCommandOptions {
    mode?: string;
    justification?: string;
    suppressWarningsWithJustification?: boolean;
}

export interface CommandCompactnessAudit {
    command: string;
    mode: string;
    justification: string;
    warnings: string[];
    warning_count: number;
    /** Category tag for the matched noisy pattern, if any. */
    matched_categories: string[];
}

interface NoisyPattern {
    pattern: RegExp;
    warning: string;
    category: string;
}

/**
 * Noisy-command patterns derived from the Compact Command Policy in 40-commands.md.
 * Each entry matches a command that should use a compact equivalent first.
 */
const NOISY_COMMAND_PATTERNS: ReadonlyArray<NoisyPattern> = [
    // Version control — git
    {
        pattern: /\bgit\s+diff\b(?!.*--stat)(?!.*--name-only)(?!.*--numstat)(?!.*--\s+\S)/i,
        warning: 'Use `git diff --stat` or a path-scoped `git diff -- <path>` before full `git diff`.',
        category: 'git'
    },
    {
        pattern: /\bgit\s+log\b(?!.*--oneline)(?!.*-n[\s=]?\d)(?!.*-\d)/i,
        warning: 'Use `git log --oneline -n 20` before unbounded `git log`.',
        category: 'git'
    },
    {
        pattern: /\bgit\s+log\b(?=.*\s--all\b)(?!.*--oneline)(?!.*-n[\s=]?\d)(?!.*-\d)/i,
        warning: 'Use `git log --oneline --graph -n 30` before `git log --all`.',
        category: 'git'
    },
    {
        pattern: /\bgit\s+status\b(?!.*--short)(?!.*-s\b)/i,
        warning: 'Use `git status --short --branch` for quick state.',
        category: 'git'
    },
    {
        pattern: /\bgit\s+show\b(?!.*--stat)(?!.*--\s+\S)/i,
        warning: 'Use `git show --stat <sha>` for commit overview before full `git show`.',
        category: 'git'
    },
    {
        pattern: /\bgit\s+stash\s+list\b(?!.*--oneline)/i,
        warning: 'Use `git stash list --oneline` for stash summary.',
        category: 'git'
    },
    // Containers / infrastructure
    {
        pattern: /\bdocker\s+logs\b(?!.*--tail)(?!.*--since)/i,
        warning: 'Use `docker logs --tail 50` before full container logs.',
        category: 'container'
    },
    {
        pattern: /\bkubectl\s+logs\b(?!.*--tail)/i,
        warning: 'Use `kubectl logs --tail=50` before full pod logs.',
        category: 'container'
    },
    // Testing
    {
        pattern: /\bpytest\b(?!.*-q)(?!.*--tb=short)(?!.*--tb=line)(?!.*--tb=no)/i,
        warning: 'Use `pytest -q --tb=short` first; reserve verbose traceback for localized failures.',
        category: 'test'
    },
    {
        pattern: /\b(jest|vitest)\b(?!.*--silent)(?!.*--verbose=false)/i,
        warning: 'Use `--silent` or `--verbose=false` for jest/vitest; default reporters are noisy.',
        category: 'test'
    },
    {
        pattern: /\bgo\s+test\b.*\s-v\b/i,
        warning: 'Use `go test -count=1 -short` first; add `-v` only for specific test debug.',
        category: 'test'
    },
    // Search / file inspection
    {
        pattern: /\b(rg|grep)\b(?!.*-l\b)(?!.*--files-with-matches)(?!.*--max-count)(?!.*-c\b)(?!.*--count)/i,
        warning: 'Use `rg -l --max-count=5` or `grep -rl --max-count=5` with path scope before unbounded search.',
        category: 'search'
    },
    {
        pattern: /\bcat\s+\S+/i,
        warning: 'Use `head -n 60` or `tail -n 60` instead of `cat` for large files.',
        category: 'search'
    },
    // Package managers
    {
        pattern: /\bnpm\s+install\b(?!.*--prefer-offline)(?!.*--no-fund)(?!.*--no-audit)/i,
        warning: 'Use `npm install --prefer-offline --no-fund --no-audit` to suppress advisory noise.',
        category: 'package_manager'
    },
    {
        pattern: /\bnpm\s+ls\b(?!.*--depth)(?!.*--json)/i,
        warning: 'Use `npm ls --depth=0` or `npm ls --json --depth=0` for top-level deps only.',
        category: 'package_manager'
    },
    {
        pattern: /\bpip\s+install\b(?!.*-q\b)(?!.*--quiet)/i,
        warning: 'Use `pip install -q` to suppress progress and advisory noise.',
        category: 'package_manager'
    },
    {
        pattern: /\byarn\s+install\b(?!.*--silent)(?!.*--json)/i,
        warning: 'Use `yarn install --silent` to suppress noisy fetch output.',
        category: 'package_manager'
    },
    {
        pattern: /\bpnpm\s+install\b(?!.*--silent)(?!.*--reporter[\s=]+silent)/i,
        warning: 'Use `pnpm install --silent` or `pnpm install --reporter silent` to reduce output.',
        category: 'package_manager'
    },
    // Build tools — verbose modes
    {
        pattern: /\b(\.\/)?mvn(w)?(\.cmd)?\b(?=.*\s-X\b)/i,
        warning: 'Avoid `mvn -X` (debug); use `mvn -q` or default verbosity first.',
        category: 'build'
    },
    {
        pattern: /\b(\.\/)?gradlew?(\.bat)?\s.*--info\b/i,
        warning: 'Avoid `gradle --info`; use `gradle -q` or default verbosity first.',
        category: 'build'
    },
    {
        pattern: /\b(\.\/)?gradlew?(\.bat)?\s.*--debug\b/i,
        warning: 'Avoid `gradle --debug`; use `gradle -q` or default verbosity first.',
        category: 'build'
    },
    {
        pattern: /\bcargo\s+build\b(?=.*\s-v\b)/i,
        warning: 'Use `cargo build` without `-v`; add verbose only for specific build issues.',
        category: 'build'
    },
    {
        pattern: /\bcargo\s+test\b(?=.*\s-v\b)/i,
        warning: 'Use `cargo test` without `-v`; add verbose only for specific test debug.',
        category: 'build'
    },
    {
        pattern: /\bdotnet\s+(build|test)\b(?=.*\s-v\s+(d|detailed|diag|diagnostic)\b)/i,
        warning: 'Use `dotnet build` without detailed/diagnostic verbosity; add `-v d` only for specific issues.',
        category: 'build'
    },
    // Network — verbose fetches
    {
        pattern: /\bcurl\b(?!.*-\w*s)(?!.*--silent)(?!.*-\w*o\b)(?!.*--output)(?!.*-\w*f)(?!.*--fail)/i,
        warning: 'Use `curl -sf` or `curl --silent --fail` to suppress progress and noise.',
        category: 'network'
    },
    {
        pattern: /\bwget\b(?!.*-\w*q)(?!.*--quiet)/i,
        warning: 'Use `wget -q` or `wget --quiet` to suppress progress output.',
        category: 'network'
    },
    // File listing / tree
    {
        pattern: /\bfind\s+\S+(?!.*-maxdepth)(?!.*-name\b.*-quit\b)/i,
        warning: 'Use `find <path> -maxdepth 3` to bound directory traversal depth.',
        category: 'file_listing'
    },
    {
        pattern: /\btree\b(?!.*-L\s*\d)(?!.*--filelimit)/i,
        warning: 'Use `tree -L 3` to limit directory listing depth.',
        category: 'file_listing'
    },
    {
        pattern: /\bls\s+-\w*R/i,
        warning: 'Avoid `ls -R`; use `find -maxdepth 2` or `tree -L 2` for bounded listings.',
        category: 'file_listing'
    },
    // System environment dumps
    {
        pattern: /\b(printenv|env)\s*$/im,
        warning: 'Filter environment output: `env | grep PATTERN` or `printenv VAR_NAME`.',
        category: 'system'
    },
    // Interactive pagers
    {
        pattern: /\b(less|more)\s+\S+/i,
        warning: 'Use `head -n 60` or `tail -n 60` instead of interactive pagers.',
        category: 'pager'
    },
    // Docker — verbose listings
    {
        pattern: /\bdocker\s+ps\b(?!.*--format)(?!.*-q\b)(?!.*--quiet)/i,
        warning: 'Use `docker ps --format "table {{.ID}}\\t{{.Names}}\\t{{.Status}}"` for compact output.',
        category: 'container'
    },
    {
        pattern: /\bdocker\s+images\b(?!.*--format)(?!.*-q\b)(?!.*--quiet)/i,
        warning: 'Use `docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}"` for compact output.',
        category: 'container'
    },
    // Kubernetes — verbose describe and get
    {
        pattern: /\bkubectl\s+describe\b(?!.*-l\b)(?!.*--selector)/i,
        warning: 'Prefer `kubectl get -o yaml <resource>` for structured output; `describe` is very verbose.',
        category: 'container'
    },
    {
        pattern: /\bkubectl\s+get\b(?!.*-o\b)(?!.*--output)/i,
        warning: 'Use `kubectl get -o wide` or `-o json` for structured, parseable output.',
        category: 'container'
    },
    // Terraform / IaC
    {
        pattern: /\bterraform\s+plan\b(?!.*-compact-warnings)(?!.*-json)/i,
        warning: 'Use `terraform plan -compact-warnings` or `terraform plan -json` for compact output.',
        category: 'infra'
    }
];

/**
 * Audit command compactness against the compact-command protocol from 40-commands.md.
 * Returns structured audit with matched categories for enforcement telemetry.
 */
export function auditCommandCompactness(commandText: string, options: AuditCommandOptions = {}): CommandCompactnessAudit {
    const mode = options.mode || 'scan';
    const justification = options.justification || '';
    const suppressWarningsWithJustification = options.suppressWarningsWithJustification !== false;
    const warnings: string[] = [];
    const matchedCategories: string[] = [];

    if (!commandText || !commandText.trim()) {
        return { command: commandText, mode, justification, warnings, warning_count: 0, matched_categories: [] };
    }

    for (const { pattern, warning, category } of NOISY_COMMAND_PATTERNS) {
        if (pattern.test(commandText)) {
            if (suppressWarningsWithJustification && justification && justification.trim().length >= 10) continue;
            warnings.push(warning);
            if (!matchedCategories.includes(category)) {
                matchedCategories.push(category);
            }
        }
    }

    return {
        command: commandText,
        mode,
        justification: justification || '',
        warnings,
        warning_count: warnings.length,
        matched_categories: matchedCategories
    };
}

/**
 * Audit a compile/build command for compact-protocol compliance.
 * Gate-executed commands are lifecycle-required, so this applies
 * informational auditing only (warnings, not blocking).
 */
export function auditGateCommand(commandText: string, gateLabel: string): CommandCompactnessAudit {
    const result = auditCommandCompactness(commandText, {
        mode: 'gate',
        justification: `Lifecycle-required gate command (${gateLabel})`,
        suppressWarningsWithJustification: false
    });
    return result;
}

/**
 * Extract command audit from event details, matching Python get_command_audit_from_details.
 */
export function getCommandAuditFromDetails(details: Record<string, unknown> | null | undefined) {
    if (!details || typeof details !== 'object') return null;

    const existing = details.command_policy_audit;
    if (existing && typeof existing === 'object') return existing as Record<string, unknown>;

    let commandText = '';
    for (const key of ['command', 'command_text', 'shell_command']) {
        const value = details[key];
        if (typeof value === 'string' && value.trim()) {
            commandText = value.trim();
            break;
        }
    }
    if (!commandText) return null;

    const mode = String(details.command_mode || details.mode || 'scan');
    const justification = String(details.command_justification || details.justification || '');
    return auditCommandCompactness(commandText, { mode, justification });
}

function resolveArtifactPathForRead(pathValue: unknown, repoRoot: string | null): string | null {
    if (pathValue == null) {
        return null;
    }
    const text = String(pathValue).trim();
    if (!text) {
        return null;
    }
    if (repoRoot) {
        try {
            return resolvePathInsideRepo(text, repoRoot, { allowMissing: true });
        } catch {
            return null;
        }
    }
    if (path.isAbsolute(text)) {
        return path.resolve(text);
    }
    return null;
}

function readJsonArtifactForSummary(pathValue: unknown, repoRoot: string | null): { path: string; payload: Record<string, unknown> } | null {
    const resolvedPath = resolveArtifactPathForRead(pathValue, repoRoot);
    if (!resolvedPath) {
        return null;
    }
    try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            return null;
        }
        return {
            path: toPosix(resolvedPath),
            payload: JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
        };
    } catch {
        return null;
    }
}

export function getOutputTelemetryFromPayload(payload: Record<string, unknown> | null | undefined) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const candidate = (payload.output_telemetry && typeof payload.output_telemetry === 'object'
        ? payload.output_telemetry
        : payload) as Record<string, unknown>;
    const savedTokens = coerceIntLike(candidate.estimated_saved_tokens);
    if (savedTokens == null || savedTokens <= 0) {
        return null;
    }
    const rawTokenEstimate = coerceIntLike(candidate.raw_token_count_estimate);
    const outputTokenEstimate = coerceIntLike(candidate.filtered_token_count_estimate);
    return {
        raw_token_count_estimate: rawTokenEstimate != null && rawTokenEstimate > 0 ? rawTokenEstimate : 0,
        output_token_count_estimate: outputTokenEstimate != null && outputTokenEstimate >= 0 ? outputTokenEstimate : null,
        estimated_saved_tokens: savedTokens,
        baseline_known: rawTokenEstimate != null && rawTokenEstimate > 0
    };
}

function getReviewContextSummary(payload: Record<string, unknown> | null | undefined) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const ruleContext = payload.rule_context as Record<string, unknown> | null | undefined;
    if (!ruleContext || typeof ruleContext !== 'object') {
        return null;
    }
    const summary = ruleContext.summary as Record<string, unknown> | null | undefined;
    if (!summary || typeof summary !== 'object') {
        return null;
    }
    const savedTokens = coerceIntLike(summary.estimated_saved_tokens);
    if (savedTokens == null || savedTokens <= 0) {
        return null;
    }
    const rawTokenEstimate = coerceIntLike(summary.original_token_count_estimate);
    const outputTokenEstimate = coerceIntLike(summary.output_token_count_estimate);
    return {
        raw_token_count_estimate: rawTokenEstimate != null && rawTokenEstimate > 0 ? rawTokenEstimate : 0,
        output_token_count_estimate: outputTokenEstimate != null && outputTokenEstimate >= 0 ? outputTokenEstimate : null,
        estimated_saved_tokens: savedTokens,
        baseline_known: rawTokenEstimate != null && rawTokenEstimate > 0
    };
}

function getReviewContextLabel(reviewType: string): string {
    const normalized = String(reviewType || '').trim().toLowerCase();
    return (REVIEW_CONTEXT_LABELS as Record<string, string>)[normalized] || 'review context';
}

function getCommandOutputLabel(eventType: string): string {
    const normalized = String(eventType || '').trim().toUpperCase();
    if (normalized.startsWith('COMPILE_GATE_')) {
        return 'compile gate output';
    }
    if (normalized.startsWith('REVIEW_GATE_')) {
        return 'review gate output';
    }
    return 'gate output';
}

interface TokenContributionEntry {
    label: string;
    estimated_saved_tokens: number;
    raw_token_count_estimate: number;
    output_token_count_estimate: number | null;
    source_kind: string;
    source_key: string;
    source_path?: string | null;
    source_event_type?: string | null;
    source_index?: number | null;
}

function addTokenEconomyContribution(breakdown: TokenContributionEntry[], seenKeys: Set<string>, contribution: Partial<TokenContributionEntry> & { estimated_saved_tokens: number; source_key?: string; label?: string }): void {
    if (!contribution || contribution.estimated_saved_tokens <= 0) {
        return;
    }
    const sourceKey = String(contribution.source_key || '').trim();
    if (!sourceKey || seenKeys.has(sourceKey)) {
        return;
    }
    seenKeys.add(sourceKey);
    breakdown.push({
        label: contribution.label || '',
        estimated_saved_tokens: contribution.estimated_saved_tokens,
        raw_token_count_estimate: contribution.raw_token_count_estimate || 0,
        output_token_count_estimate: contribution.output_token_count_estimate ?? null,
        source_kind: contribution.source_kind || '',
        source_key: sourceKey,
        source_path: contribution.source_path || null,
        source_event_type: contribution.source_event_type || null,
        source_index: contribution.source_index || null
    });
}

function collectReviewContextContributions(container: Record<string, unknown>, repoRoot: string | null, breakdown: TokenContributionEntry[], seenKeys: Set<string>): void {
    if (!container || typeof container !== 'object') {
        return;
    }
    const artifactEvidence = container.artifact_evidence as Record<string, unknown> | null | undefined;
    const checked = artifactEvidence && Array.isArray((artifactEvidence as Record<string, unknown>).checked)
        ? (artifactEvidence as Record<string, unknown>).checked as Record<string, unknown>[]
        : [];
    for (const entry of checked) {
        if (!entry || typeof entry !== 'object' || !entry.review_context_path) {
            continue;
        }
        const reviewContextArtifact = readJsonArtifactForSummary(entry.review_context_path, repoRoot);
        if (!reviewContextArtifact) {
            continue;
        }
        const summary = getReviewContextSummary(reviewContextArtifact.payload);
        if (!summary) {
            continue;
        }
        addTokenEconomyContribution(breakdown, seenKeys, {
            label: getReviewContextLabel(String(reviewContextArtifact.payload.review_type || entry.review || '')),
            estimated_saved_tokens: summary.estimated_saved_tokens,
            raw_token_count_estimate: summary.raw_token_count_estimate,
            output_token_count_estimate: summary.output_token_count_estimate,
            source_kind: 'review_context',
            source_key: `review-context:${reviewContextArtifact.path}`,
            source_path: reviewContextArtifact.path
        });
    }
}

function buildTokenEconomySummary(events: Record<string, unknown>[], repoRoot: string | null) {
    const breakdown: TokenContributionEntry[] = [];
    const seenKeys = new Set<string>();

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const rawDetails = event && typeof event === 'object' ? event.details : null;
        if (!rawDetails || typeof rawDetails !== 'object') {
            continue;
        }
        const details = rawDetails as Record<string, unknown>;

        const eventType = String(event.event_type || 'UNKNOWN');
        let reviewEvidencePayload: Record<string, unknown> | null = null;

        if (typeof details.review_evidence_path === 'string' && details.review_evidence_path.trim()) {
            const reviewEvidence = readJsonArtifactForSummary(details.review_evidence_path, repoRoot);
            if (reviewEvidence) {
                reviewEvidencePayload = reviewEvidence.payload;
                const reviewTelemetry = getOutputTelemetryFromPayload(reviewEvidence.payload);
                if (reviewTelemetry) {
                    addTokenEconomyContribution(breakdown, seenKeys, {
                        label: getCommandOutputLabel(eventType),
                        estimated_saved_tokens: reviewTelemetry.estimated_saved_tokens,
                        raw_token_count_estimate: reviewTelemetry.raw_token_count_estimate,
                        output_token_count_estimate: reviewTelemetry.output_token_count_estimate,
                        source_kind: 'command_output',
                        source_key: `command-output:${reviewEvidence.path}`,
                        source_path: reviewEvidence.path,
                        source_event_type: eventType,
                        source_index: index + 1
                    });
                }
                collectReviewContextContributions(reviewEvidence.payload, repoRoot, breakdown, seenKeys);
            }
        }

        if (!reviewEvidencePayload) {
            const directTelemetry = getOutputTelemetryFromPayload(details);
            if (directTelemetry) {
                addTokenEconomyContribution(breakdown, seenKeys, {
                    label: getCommandOutputLabel(eventType),
                    estimated_saved_tokens: directTelemetry.estimated_saved_tokens,
                    raw_token_count_estimate: directTelemetry.raw_token_count_estimate,
                    output_token_count_estimate: directTelemetry.output_token_count_estimate,
                    source_kind: 'command_output',
                    source_key: `command-output:event:${index + 1}:${eventType}`,
                    source_event_type: eventType,
                    source_index: index + 1
                });
            }
            collectReviewContextContributions(details, repoRoot, breakdown, seenKeys);
        }
    }

    const totalSavedTokens = breakdown.reduce(function (total, item) {
        return total + item.estimated_saved_tokens;
    }, 0);
    const totalRawTokens = breakdown.reduce(function (total, item) {
        return total + (item.raw_token_count_estimate || 0);
    }, 0);
    const totalOutputTokens = breakdown.reduce(function (total, item) {
        return total + (item.output_token_count_estimate != null ? item.output_token_count_estimate : 0);
    }, 0);
    const baselineKnown = breakdown.length > 0 && breakdown.every(function (item) {
        return (item.raw_token_count_estimate || 0) > 0;
    });

    let visibleSummaryLine = null;
    if (totalSavedTokens > 0 && breakdown.length > 0) {
        const parts = breakdown.map(function (item) {
            return `${item.estimated_saved_tokens} ${item.label}`;
        }).join(' + ');
        if (baselineKnown && totalRawTokens > 0) {
            const savedPercent = Math.round((totalSavedTokens * 100.0) / totalRawTokens);
            visibleSummaryLine = `Saved tokens: ~${totalSavedTokens} (~${savedPercent}%) (${parts}).`;
        } else {
            visibleSummaryLine = `Saved tokens: ~${totalSavedTokens} (${parts}).`;
        }
    }

    return {
        total_estimated_saved_tokens: totalSavedTokens,
        total_raw_token_count_estimate: totalRawTokens,
        total_output_token_count_estimate: totalOutputTokens,
        baseline_known: baselineKnown,
        measurable_part_count: breakdown.length,
        breakdown,
        visible_summary_line: visibleSummaryLine
    };
}

export interface BuildTaskEventsSummaryOptions {
    taskId: string;
    eventsRoot: string;
    repoRoot?: string | null;
}

/**
 * Build task events summary.
 * Produces the canonical task-events summary output shape.
 */
export function buildTaskEventsSummary(options: BuildTaskEventsSummaryOptions) {
    const taskId = options.taskId;
    const eventsRoot = options.eventsRoot;
    const repoRoot = options.repoRoot ? path.resolve(String(options.repoRoot)) : null;

    const safeTaskId = assertValidTaskId(taskId);
    const taskEventFile = path.join(eventsRoot, `${safeTaskId}.jsonl`);

    if (!fs.existsSync(taskEventFile) || !fs.statSync(taskEventFile).isFile()) {
        throw new Error(`Task events file not found: ${taskEventFile}`);
    }

    const rawLines: string[] = [];
    forEachJsonlLine(taskEventFile, (line: string) => {
        rawLines.push(line);
    });
    const events: Record<string, unknown>[] = [];
    let parseErrors = 0;
    const integrityReport = inspectTaskEventFile(taskEventFile, safeTaskId);

    for (const line of rawLines) {
        try {
            const event = JSON.parse(line);
            if (event != null) events.push(event);
        } catch {
            parseErrors++;
        }
    }

    events.sort(function (a, b) {
        const ta = parseTimestamp(typeof a === 'object' ? a.timestamp_utc : null);
        const tb = parseTimestamp(typeof b === 'object' ? b.timestamp_utc : null);
        return ta.getTime() - tb.getTime();
    });

    interface TimelineEntry {
        index: number;
        timestamp_utc: string | null;
        event_type: string;
        outcome: string;
        actor: string | null;
        message: string;
        details: unknown;
        command_policy_audit: ReturnType<typeof getCommandAuditFromDetails>;
    }

    const summary: {
        task_id: string;
        source_path: string;
        events_count: number;
        parse_errors: number;
        integrity: ReturnType<typeof inspectTaskEventFile>;
        command_policy_warnings: string[];
        command_policy_warning_count: number;
        first_event_utc: string | null;
        last_event_utc: string | null;
        token_economy: ReturnType<typeof buildTokenEconomySummary> | null;
        timeline: TimelineEntry[];
    } = {
        task_id: safeTaskId,
        source_path: toPosix(taskEventFile),
        events_count: events.length,
        parse_errors: parseErrors,
        integrity: integrityReport,
        command_policy_warnings: [],
        command_policy_warning_count: 0,
        first_event_utc: events.length > 0 ? formatTimestamp(events[0].timestamp_utc) : null,
        last_event_utc: events.length > 0 ? formatTimestamp(events[events.length - 1].timestamp_utc) : null,
        token_economy: null,
        timeline: []
    };

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const index = i + 1;
        const details = event.details as Record<string, unknown> | null | undefined;
        const commandPolicyAudit = getCommandAuditFromDetails(details) as Record<string, unknown> | null;
        if (commandPolicyAudit && typeof commandPolicyAudit === 'object' && parseInt(String(commandPolicyAudit.warning_count || 0), 10) > 0) {
            summary.command_policy_warnings.push(...((commandPolicyAudit.warnings as string[]) || []));
        }
        summary.timeline.push({
            index,
            timestamp_utc: formatTimestamp(event.timestamp_utc),
            event_type: String(event.event_type || 'UNKNOWN'),
            outcome: String(event.outcome || 'UNKNOWN'),
            actor: event.actor != null ? String(event.actor) : null,
            message: String(event.message || ''),
            details,
            command_policy_audit: commandPolicyAudit
        });
    }
    summary.command_policy_warning_count = summary.command_policy_warnings.length;
    summary.token_economy = buildTokenEconomySummary(events, repoRoot);

    return summary;
}

export interface TaskEventsSummaryResult {
    task_id: string;
    source_path: string;
    events_count: number;
    parse_errors: number;
    integrity: {
        status: string;
        integrity_event_count: number;
        legacy_event_count: number;
        violations: string[];
    };
    command_policy_warnings: string[];
    command_policy_warning_count: number;
    first_event_utc: string | null;
    last_event_utc: string | null;
    token_economy: {
        visible_summary_line: string | null;
    } | null;
    timeline: {
        index: number;
        timestamp_utc: string | null;
        event_type: string;
        outcome: string;
        actor: string | null;
        message: string;
        details: unknown;
    }[];
}

/**
 * Format task events summary as text.
 */
export function formatTaskEventsSummaryText(summary: TaskEventsSummaryResult, includeDetails = false): string {
    const lines: string[] = [
        `Task: ${summary.task_id}`,
        `Source: ${summary.source_path}`,
        `Events: ${summary.events_count}`,
        `IntegrityStatus: ${summary.integrity.status}`
    ];

    if (summary.parse_errors > 0) lines.push(`ParseErrors: ${summary.parse_errors}`);
    if (summary.integrity.integrity_event_count > 0) lines.push(`IntegrityEvents: ${summary.integrity.integrity_event_count}`);
    if (summary.integrity.legacy_event_count > 0) lines.push(`LegacyEvents: ${summary.integrity.legacy_event_count}`);
    if (summary.integrity.violations.length > 0) lines.push(`IntegrityViolations: ${summary.integrity.violations.length}`);
    if (summary.first_event_utc) lines.push(`FirstEventUTC: ${summary.first_event_utc}`);
    if (summary.last_event_utc) lines.push(`LastEventUTC: ${summary.last_event_utc}`);
    if (summary.command_policy_warning_count > 0) lines.push(`CommandPolicyWarnings: ${summary.command_policy_warning_count}`);
    if (summary.token_economy && summary.token_economy.visible_summary_line) lines.push(summary.token_economy.visible_summary_line);

    lines.push('', 'Timeline:');

    for (const item of summary.timeline) {
        const timestamp = item.timestamp_utc || '';
        let line = `[${String(item.index).padStart(2, '0')}] ${timestamp} | ${item.event_type} | ${item.outcome}`;
        if (item.actor && item.actor.trim()) line += ` | actor=${item.actor}`;
        if (item.message && item.message.trim()) line += ` | ${item.message}`;
        lines.push(line);

        if (includeDetails && item.details != null) {
            const detailsJson = JSON.stringify(item.details, null, 0).replace(/\n/g, '');
            lines.push(`       details=${detailsJson}`);
        }
    }

    if (summary.integrity.violations.length > 0) {
        lines.push('', 'IntegrityViolations:');
        for (const violation of summary.integrity.violations) {
            lines.push(`- ${violation}`);
        }
    }
    if (summary.command_policy_warning_count > 0) {
        lines.push('', 'CommandPolicyWarnings:');
        for (const warning of summary.command_policy_warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n');
}
