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

const NODE_BUILD_DIRECT_CONSUMER_PATTERN = /\bnode(?:\.exe)?\b(?=.*\s--test\b)(?=.*\.node-build[\\/])/i;

function appendValidationChainWarnings(
    commandText: string,
    mode: string,
    _justification: string,
    _suppressWarningsWithJustification: boolean,
    warnings: string[],
    matchedCategories: string[]
): void {
    const normalizedMode = String(mode || '').trim().toLowerCase();
    if (normalizedMode === 'gate') {
        return;
    }

    if (NODE_BUILD_DIRECT_CONSUMER_PATTERN.test(commandText)) {
        warnings.push(
            'Direct `.node-build` test consumer detected: refresh `.node-build` first with ' +
            '`npm run build:node-foundation` or `npm test`, and never fan out producer and consumer as raw shell sidecars.'
        );
        if (!matchedCategories.includes('validation_chain')) {
            matchedCategories.push('validation_chain');
        }
    }
}

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

    appendValidationChainWarnings(
        commandText,
        mode,
        justification,
        suppressWarningsWithJustification,
        warnings,
        matchedCategories
    );

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

