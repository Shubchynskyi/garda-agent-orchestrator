import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringSha256, normalizePath, joinOrchestratorPath } from './helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';

/**
 * Detect the compile command profile (kind/strategy/label/failure/success profiles).
 * Matches Python get_compile_command_profile exactly.
 */
export function getCompileCommandProfile(command: string) {
    const normalized = (command || '').trim().toLowerCase();
    let kind = 'compile';
    let strategy = 'generic';
    let label = 'compile';

    const testPatterns = [
        /(^|\s)(pytest|nosetests|tox)(\s|$)/,
        /(^|\s)(jest|vitest|ava|mocha)(\s|$)/,
        /(^|\s)(playwright\s+test|cypress\s+run)(\s|$)/,
        /(^|\s)(go\s+test|cargo\s+test|dotnet\s+test)(\s|$)/,
        /(^|\s)(\.\/)?mvnw(\.cmd)?(\s+.*)?\s+test(\s|$)/,
        /(^|\s)mvn(\s+.*)?\s+test(\s|$)/,
        /(^|\s)(\.\/)?gradlew(\.bat)?(\s+.*)?\s+test(\s|$)/,
        /(^|\s)gradle(\s+.*)?\s+test(\s|$)/,
        /(^|\s)(npm|pnpm|yarn|bun)(\s+run)?\s+(test|test:ci|test:unit|test:integration)(\s|$)/
    ];
    const lintPatterns = [
        /(^|\s)(eslint|stylelint|ruff(\s+check)?|flake8|mypy|pyright|shellcheck|hadolint|ktlint|golangci-lint|phpstan|psalm)(\s|$)/,
        /(^|\s)(npm|pnpm|yarn|bun)(\s+run)?\s+(lint|typecheck|check)(\s|$)/,
        /(^|\s)(cargo\s+clippy|dotnet\s+format|tsc(\s|$).*(--noemit|--no-emit))/
    ];

    if (testPatterns.some(p => p.test(normalized))) {
        kind = 'test'; strategy = 'test'; label = 'test';
    } else if (lintPatterns.some(p => p.test(normalized))) {
        kind = 'lint'; strategy = 'lint'; label = 'lint';
    } else if (/(^|\s)(\.\/)?mvnw(\.cmd)?(\s|$)/.test(normalized) || /(^|\s)mvn(\s|$)/.test(normalized)) {
        strategy = 'maven'; label = 'maven';
    } else if (/(^|\s)(\.\/)?gradlew(\.bat)?(\s|$)/.test(normalized) || /(^|\s)gradle(\s|$)/.test(normalized)) {
        strategy = 'gradle'; label = 'gradle';
    } else if (/(^|\s)(npm|pnpm|yarn|bun|npx|vite|webpack|turbo|nx)(\s|$)/.test(normalized)) {
        strategy = 'node'; label = 'node-build';
    } else if (/(^|\s)cargo(\s|$)/.test(normalized)) {
        strategy = 'cargo'; label = 'cargo';
    } else if (/(^|\s)dotnet(\s|$)/.test(normalized)) {
        strategy = 'dotnet'; label = 'dotnet';
    } else if (/(^|\s)go(\s|$)/.test(normalized)) {
        strategy = 'go'; label = 'go';
    }

    let failureProfile, successProfile;
    if (kind === 'test') {
        failureProfile = 'test_failure_console';
        successProfile = 'test_success_console';
    } else if (kind === 'lint') {
        failureProfile = 'lint_failure_console';
        successProfile = 'lint_success_console';
    } else {
        failureProfile = `compile_failure_console_${strategy}`;
        successProfile = 'compile_success_console';
    }

    return { kind, strategy, label, failure_profile: failureProfile, success_profile: successProfile };
}

/**
 * Extract compile commands from a markdown rules file.
 * Matches Python get_compile_commands.
 */
export function getCompileCommands(rulePath: string): string[] {
    const content = fs.readFileSync(rulePath, 'utf8');
    const lines = content.split('\n');
    if (!lines.length) throw new Error(`Commands file is empty: ${rulePath}`);

    let sectionIndex = -1;
    for (let idx = 0; idx < lines.length; idx++) {
        if (lines[idx].trim() === '### Compile Gate (Mandatory)') {
            sectionIndex = idx;
            break;
        }
    }
    if (sectionIndex < 0) throw new Error(`Section '### Compile Gate (Mandatory)' not found in ${rulePath}`);

    let fenceStart = -1;
    for (let idx = sectionIndex + 1; idx < lines.length; idx++) {
        const stripped = lines[idx].trim();
        if (stripped.startsWith('```')) { fenceStart = idx; break; }
        if (stripped.startsWith('### ')) break;
    }
    if (fenceStart < 0) {
        throw new Error(`Code fence with compile command not found under '### Compile Gate (Mandatory)' in ${rulePath}`);
    }

    const commands = [];
    for (let idx = fenceStart + 1; idx < lines.length; idx++) {
        const stripped = lines[idx].trim();
        if (stripped.startsWith('```')) break;
        if (!stripped || stripped.startsWith('#')) continue;
        commands.push(stripped);
    }

    if (!commands.length) {
        throw new Error(`Compile command is missing under '### Compile Gate (Mandatory)' in ${rulePath}`);
    }

    for (const command of commands) {
        if (/^\s*<[^>]+>\s*$/.test(command)) {
            throw new Error(`Compile command placeholder is unresolved in ${rulePath}: ${command}`);
        }
        if (/\borg\.apache\.maven\.wrapper\.mavenwrappermain\b/i.test(command)) {
            throw new Error(
                `Compile command anti-pattern detected in ${rulePath}: ` +
                "use wrapper entrypoint script (for example './mvnw' or '.\\mvnw.cmd') instead of MavenWrapperMain class invocation."
            );
        }
    }

    return commands;
}

/**
 * Get output stats (warning and error line counts).
 */
export function getOutputStats(lines: string[]) {
    let warningLines = 0;
    let errorLines = 0;
    for (const line of lines) {
        if (/\bwarning\b/i.test(line)) warningLines++;
        if (/\berror\b/i.test(line)) errorLines++;
    }
    return { warningLines, errorLines };
}

/**
 * Extract the "new" file path from a numstat path-spec column.
 * Handles rename syntax: "old => new" and "{old => new}/suffix".
 */
export function extractNewPathFromNumstat(pathSpec: string): string {
    if (!pathSpec.includes(' => ')) return pathSpec;

    // Brace-style: "prefix/{old => new}/suffix" or "{old => new}"
    const braceMatch = pathSpec.match(/^(.*?)\{[^}]* => ([^}]*)\}(.*)$/);
    if (braceMatch) {
        return braceMatch[1] + braceMatch[2] + braceMatch[3];
    }

    // Simple style: "old => new"
    const arrowIndex = pathSpec.indexOf(' => ');
    return pathSpec.substring(arrowIndex + 4);
}

/**
 * Get workspace snapshot for scope validation.
 * Matches Python get_workspace_snapshot.
 */
export function getWorkspaceSnapshot(repoRoot: string, detectionSource: string, includeUntracked: boolean, explicitChangedFiles: string[]) {
    const source = (detectionSource || 'git_auto').trim().toLowerCase();
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source);
    if (source === 'git_staged_only') includeUntracked = false;
    const snapshotCacheRelativePath = normalizePath(
        path.relative(repoRoot, joinOrchestratorPath(repoRoot, path.join('runtime', 'cache', 'workspace-snapshot.json')))
    );
    function isInternalSnapshotCachePath(relativePath: string): boolean {
        const normalized = normalizePath(relativePath);
        return !!normalized && normalized === snapshotCacheRelativePath;
    }

    function gitLines(args: string[], failMsg: string): string[] {
        const result = spawnSyncWithTimeout('git', ['-C', String(repoRoot), ...args], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 50 * 1024 * 1024
        });
        if (result.timedOut) {
            throw new Error(`${failMsg} git timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.`);
        }
        if (result.error) {
            throw new Error(`${failMsg} ${result.error.message || result.error}`);
        }
        if (result.status !== 0) {
            const errText = String(result.stderr || '').trim();
            throw new Error(`${failMsg} git exited with code ${result.status}. ${errText}`);
        }
        return (String(result.stdout || '')).split('\n').filter(l => l.trim());
    }

    const normalizedExplicit = [...new Set(
        (explicitChangedFiles || []).map((f: string) => normalizePath(f)).filter(Boolean)
    )]
        .filter((item: string) => !isInternalSnapshotCachePath(item))
        .sort();

    if (source === 'explicit_changed_files') {
        const numstatRows: Record<string, { additions: string; deletions: string }> = {};
        if (normalizedExplicit.length > 0) {
            try {
                for (const line of gitLines(['diff', '--numstat', '--diff-filter=ACMRTUXB', 'HEAD', '--', ...normalizedExplicit], 'Failed numstat')) {
                    const parts = line.split('\t');
                    if (parts.length >= 3) {
                        const key = normalizePath(parts[2]);
                        if (key) numstatRows[key] = { additions: parts[0], deletions: parts[1] };
                    }
                }
            } catch { /* best effort */ }
        }

        let additionsTotal = 0, deletionsTotal = 0;
        for (const item of normalizedExplicit) {
            if (numstatRows[item]) {
                const row = numstatRows[item];
                if (/^\d+$/.test(row.additions)) additionsTotal += parseInt(row.additions, 10);
                if (/^\d+$/.test(row.deletions)) deletionsTotal += parseInt(row.deletions, 10);
                continue;
            }
            const candidate = path.join(repoRoot, item);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                additionsTotal += countFileLines(candidate);
            }
        }
        const changedLinesTotal = additionsTotal + deletionsTotal;
        const filesFingerprint = stringSha256(normalizedExplicit.join('\n'));
        const scopeFingerprint = stringSha256(
            `${source}|false|${includeUntracked}|${normalizedExplicit.length}|${changedLinesTotal}|${filesFingerprint}`
        );

        return {
            detection_source: source, use_staged: false, include_untracked: !!includeUntracked,
            changed_files: normalizedExplicit, changed_files_count: normalizedExplicit.length,
            additions_total: additionsTotal, deletions_total: deletionsTotal,
            changed_lines_total: changedLinesTotal,
            changed_files_sha256: filesFingerprint, scope_sha256: scopeFingerprint
        };
    }

    const diffArgs = ['diff', '--numstat', '--diff-filter=ACMRTUXB'];
    diffArgs.push(useStaged ? '--cached' : 'HEAD');
    const numstatOutput = gitLines(diffArgs, 'Failed to collect changed files snapshot.');

    // Extract both file names and line counts from the single numstat call
    const changedFromDiff: string[] = [];
    let additionsTotal = 0, deletionsTotal = 0;
    for (const row of numstatOutput) {
        const parts = row.split('\t');
        if (parts.length < 3) continue;
        const filePath = extractNewPathFromNumstat(parts.slice(2).join('\t'));
        if (filePath) changedFromDiff.push(filePath);
        if (/^\d+$/.test(parts[0])) additionsTotal += parseInt(parts[0], 10);
        if (/^\d+$/.test(parts[1])) deletionsTotal += parseInt(parts[1], 10);
    }

    let untracked: string[] = [];
    if (includeUntracked) {
        untracked = gitLines(['ls-files', '--others', '--exclude-standard'], 'Failed to collect untracked files snapshot.')
            .map((item: string) => normalizePath(item))
            .filter((item: string) => !!item && !isInternalSnapshotCachePath(item));
    }

    const normalizedChanged = [...new Set(
        [...changedFromDiff, ...untracked]
            .map((item: string) => normalizePath(item))
            .filter((item: string) => !!item && !isInternalSnapshotCachePath(item))
    )].sort();

    if (includeUntracked) {
        for (const item of untracked) {
            additionsTotal += countFileLines(path.join(repoRoot, item));
        }
    }

    const changedLinesTotal = additionsTotal + deletionsTotal;
    const filesFingerprint = stringSha256(normalizedChanged.join('\n'));
    const scopeFingerprint = stringSha256(
        `${source}|${useStaged}|${includeUntracked}|${normalizedChanged.length}|${changedLinesTotal}|${filesFingerprint}`
    );

    return {
        detection_source: source, use_staged: useStaged, include_untracked: !!includeUntracked,
        changed_files: normalizedChanged, changed_files_count: normalizedChanged.length,
        additions_total: additionsTotal, deletions_total: deletionsTotal,
        changed_lines_total: changedLinesTotal,
        changed_files_sha256: filesFingerprint, scope_sha256: scopeFingerprint
    };
}

function countFileLines(filePath: string): number {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0;
        let count = 0;
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
            if (line.trimEnd() !== '') count++;
        }
        return count;
    } catch { return 0; }
}

/**
 * Get preflight context for scope validation.
 */
export function getPreflightContext(preflightPath: string, taskId: string) {
    if (!preflightPath || !fs.existsSync(preflightPath)) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }
    let preflightObject;
    try {
        preflightObject = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const preflightTaskId = String(preflightObject.task_id || '').trim();
    if (preflightTaskId && preflightTaskId !== taskId) {
        throw new Error(`TaskId '${taskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!('changed_files' in preflightObject)) throw new Error('Preflight field `changed_files` is required.');
    if (!preflightObject.metrics || typeof preflightObject.metrics !== 'object') {
        throw new Error('Preflight field `metrics` is required.');
    }
    if (!preflightObject.required_reviews || typeof preflightObject.required_reviews !== 'object') {
        throw new Error('Preflight field `required_reviews` is required.');
    }

    const preflightChangedFiles = [...new Set(
        (preflightObject.changed_files || []).map((f: string) => normalizePath(String(f).replace(/\\/g, '/'))).filter(Boolean)
    )].sort();

    const changedLinesTotal = preflightObject.metrics.changed_lines_total;
    if (typeof changedLinesTotal !== 'number' || changedLinesTotal < 0) {
        throw new Error('Preflight field `metrics.changed_lines_total` is required and must be non-negative.');
    }

    const detectionSource = String(preflightObject.detection_source || 'git_auto').trim() || 'git_auto';
    const includeUntracked = detectionSource.toLowerCase() !== 'git_staged_only';

    return {
        preflight: preflightObject,
        task_id: taskId,
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        changed_files: preflightChangedFiles,
        changed_files_count: preflightChangedFiles.length,
        changed_lines_total: changedLinesTotal,
        changed_files_sha256: stringSha256(preflightChangedFiles.join('\n')),
        budget_forecast: preflightObject.budget_forecast ?? null
    };
}
