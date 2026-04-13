import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    parseTimestamp,
    formatTimestamp,
    auditCommandCompactness,
    auditGateCommand,
    getCommandAuditFromDetails,
    buildTaskEventsSummary,
    formatTaskEventsSummaryText,
    getOutputTelemetryFromPayload,
    TaskEventsSummaryResult
} from '../../../src/gates/task-events-summary';

describe('gates/task-events-summary', () => {
    describe('parseTimestamp', () => {
        it('parses ISO 8601 timestamp', () => {
            const date = parseTimestamp('2024-01-15T10:30:00Z');
            assert.ok(date instanceof Date);
            assert.ok(date.getTime() > 0);
        });
        it('returns epoch for null', () => {
            const date = parseTimestamp(null);
            assert.equal(date.getTime(), 0);
        });
        it('returns epoch for empty string', () => {
            const date = parseTimestamp('');
            assert.equal(date.getTime(), 0);
        });
    });

    describe('formatTimestamp', () => {
        it('formats Date to ISO string', () => {
            const result = formatTimestamp(new Date('2024-01-15T10:30:00Z'));
            assert.ok(result!.includes('2024-01-15'));
        });
        it('formats string timestamp', () => {
            const result = formatTimestamp('2024-01-15T10:30:00Z');
            assert.ok(result!.includes('2024-01-15'));
        });
        it('returns null for null', () => {
            assert.equal(formatTimestamp(null), null);
        });
    });

    describe('auditCommandCompactness', () => {
        it('warns about unbounded git diff', () => {
            const result = auditCommandCompactness('git diff HEAD');
            assert.ok(result.warning_count > 0);
            assert.ok(result.warnings.some(w => w.includes('git diff')));
            assert.ok(result.matched_categories.includes('git'));
        });
        it('does not warn about bounded git diff', () => {
            const result = auditCommandCompactness('git diff --stat HEAD');
            assert.equal(result.warning_count, 0);
            assert.deepEqual(result.matched_categories, []);
        });
        it('does not warn about path-scoped git diff', () => {
            const result = auditCommandCompactness('git diff -- src/file.ts');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about git diff --name-only', () => {
            const result = auditCommandCompactness('git diff --name-only HEAD');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded git log', () => {
            const result = auditCommandCompactness('git log');
            assert.ok(result.warning_count > 0);
            assert.ok(result.warnings.some(w => w.includes('git log')));
            assert.ok(result.matched_categories.includes('git'));
        });
        it('does not warn about bounded git log', () => {
            const result = auditCommandCompactness('git log --oneline -n 20');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about git log with -n flag', () => {
            const result = auditCommandCompactness('git log -n 10');
            assert.equal(result.warning_count, 0);
        });
        it('warns about git log --all without compact flags', () => {
            const result = auditCommandCompactness('git log --all');
            assert.ok(result.warning_count > 0);
            assert.ok(result.warnings.some(w => w.includes('git log')));
        });
        it('does not warn about git log --all with compact flags (any order)', () => {
            const result = auditCommandCompactness('git log --all --oneline --graph -n 30');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about git log --all --graph --oneline -n20', () => {
            const result = auditCommandCompactness('git log --all --graph --oneline -n20');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded git status', () => {
            const result = auditCommandCompactness('git status');
            assert.ok(result.warning_count > 0);
            assert.ok(result.warnings.some(w => w.includes('git status')));
        });
        it('does not warn about git status --short', () => {
            const result = auditCommandCompactness('git status --short --branch');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about git status -s', () => {
            const result = auditCommandCompactness('git status -s');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded git show', () => {
            const result = auditCommandCompactness('git show abc123');
            assert.ok(result.warning_count > 0);
            assert.ok(result.warnings.some(w => w.includes('git show')));
        });
        it('does not warn about git show --stat', () => {
            const result = auditCommandCompactness('git show --stat abc123');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded git stash list', () => {
            const result = auditCommandCompactness('git stash list');
            assert.ok(result.warning_count > 0);
        });
        it('does not warn about git stash list --oneline', () => {
            const result = auditCommandCompactness('git stash list --oneline');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded docker logs', () => {
            const result = auditCommandCompactness('docker logs container-name');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('container'));
        });
        it('does not warn about bounded docker logs', () => {
            const result = auditCommandCompactness('docker logs --tail 100 container-name');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded kubectl logs', () => {
            const result = auditCommandCompactness('kubectl logs my-pod');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('container'));
        });
        it('does not warn about kubectl logs --tail', () => {
            const result = auditCommandCompactness('kubectl logs --tail=50 my-pod');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded pytest', () => {
            const result = auditCommandCompactness('pytest tests/');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('test'));
        });
        it('does not warn about pytest -q', () => {
            const result = auditCommandCompactness('pytest -q --tb=short tests/');
            assert.equal(result.warning_count, 0);
        });
        it('warns about verbose jest', () => {
            const result = auditCommandCompactness('jest --verbose tests/');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('test'));
        });
        it('warns about plain jest (default reporters are noisy)', () => {
            const result = auditCommandCompactness('jest tests/');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('test'));
        });
        it('warns about plain vitest run', () => {
            const result = auditCommandCompactness('vitest run');
            assert.ok(result.warning_count > 0);
        });
        it('does not warn about jest --silent', () => {
            const result = auditCommandCompactness('jest --silent tests/');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about vitest --verbose=false', () => {
            const result = auditCommandCompactness('vitest --verbose=false');
            assert.equal(result.warning_count, 0);
        });
        it('warns about verbose go test', () => {
            const result = auditCommandCompactness('go test -v ./...');
            assert.ok(result.warning_count > 0);
        });
        it('does not warn about go test without -v', () => {
            const result = auditCommandCompactness('go test -count=1 -short ./...');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded npm install', () => {
            const result = auditCommandCompactness('npm install');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('package_manager'));
        });
        it('does not warn about compact npm install', () => {
            const result = auditCommandCompactness('npm install --prefer-offline --no-fund --no-audit');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded npm ls', () => {
            const result = auditCommandCompactness('npm ls');
            assert.ok(result.warning_count > 0);
        });
        it('does not warn about npm ls --depth=0', () => {
            const result = auditCommandCompactness('npm ls --depth=0');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about npm ls --json', () => {
            const result = auditCommandCompactness('npm ls --json');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded rg without scope or limit', () => {
            const result = auditCommandCompactness('rg pattern');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('search'));
        });
        it('warns about rg -n without compact flags', () => {
            const result = auditCommandCompactness('rg -n pattern');
            assert.ok(result.warning_count > 0);
        });
        it('warns about unbounded grep without scope or limit', () => {
            const result = auditCommandCompactness('grep pattern');
            assert.ok(result.warning_count > 0);
        });
        it('warns about grep -n without compact flags', () => {
            const result = auditCommandCompactness('grep -n pattern');
            assert.ok(result.warning_count > 0);
        });
        it('does not warn about rg -l with max-count', () => {
            const result = auditCommandCompactness('rg -l --max-count=5 pattern src/');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about grep --count', () => {
            const result = auditCommandCompactness('grep --count pattern src/');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about git log -n20 (no space)', () => {
            const result = auditCommandCompactness('git log -n20');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about git log -5', () => {
            const result = auditCommandCompactness('git log -5');
            assert.equal(result.warning_count, 0);
        });
        it('warns about cat on files', () => {
            const result = auditCommandCompactness('cat large-file.log');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('search'));
        });
        it('does not warn about head (compact alternative to cat)', () => {
            const result = auditCommandCompactness('head -n 60 large-file.log');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about tail (compact alternative to cat)', () => {
            const result = auditCommandCompactness('tail -n 60 large-file.log');
            assert.equal(result.warning_count, 0);
        });
        it('skips warning with valid justification', () => {
            const result = auditCommandCompactness('git diff HEAD', { justification: 'localized failure reproduction needed' });
            assert.equal(result.warning_count, 0);
        });
        it('returns zero warnings for safe commands', () => {
            const result = auditCommandCompactness('npm run build');
            assert.equal(result.warning_count, 0);
        });
        it('returns matched_categories as empty array for empty command', () => {
            const result = auditCommandCompactness('');
            assert.deepEqual(result.matched_categories, []);
        });
        it('deduplicates categories when multiple git patterns match', () => {
            const result = auditCommandCompactness('git log --all');
            const gitCount = result.matched_categories.filter(c => c === 'git').length;
            assert.ok(gitCount <= 1);
        });

        // --- Package managers: pip, yarn, pnpm ---
        it('warns about unbounded pip install', () => {
            const result = auditCommandCompactness('pip install requests');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('package_manager'));
        });
        it('does not warn about pip install -q', () => {
            const result = auditCommandCompactness('pip install -q requests');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about pip install --quiet', () => {
            const result = auditCommandCompactness('pip install --quiet requests');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded yarn install', () => {
            const result = auditCommandCompactness('yarn install');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('package_manager'));
        });
        it('does not warn about yarn install --silent', () => {
            const result = auditCommandCompactness('yarn install --silent');
            assert.equal(result.warning_count, 0);
        });
        it('warns about unbounded pnpm install', () => {
            const result = auditCommandCompactness('pnpm install');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('package_manager'));
        });
        it('does not warn about pnpm install --silent', () => {
            const result = auditCommandCompactness('pnpm install --silent');
            assert.equal(result.warning_count, 0);
        });
        it('does not warn about pnpm install --reporter=silent (equals form)', () => {
            const result = auditCommandCompactness('pnpm install --reporter=silent');
            assert.equal(result.warning_count, 0);
        });

        // --- Build tools: maven, gradle, cargo, dotnet ---
        it('warns about mvn -X (debug mode)', () => {
            const result = auditCommandCompactness('mvn -X clean install');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
            const buildWarnings = result.warnings.filter(w => w.includes('mvn'));
            assert.equal(buildWarnings.length, 1, 'should produce exactly one mvn warning, not duplicates');
        });
        it('warns about ./mvnw -X (debug mode)', () => {
            const result = auditCommandCompactness('./mvnw -X package');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('does not warn about mvn without verbose flags', () => {
            const result = auditCommandCompactness('mvn clean install');
            assert.equal(result.matched_categories.filter(c => c === 'build').length, 0);
        });
        it('warns about gradle --info', () => {
            const result = auditCommandCompactness('gradle build --info');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('warns about gradlew --debug', () => {
            const result = auditCommandCompactness('./gradlew build --debug');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('does not warn about gradle without verbose flags', () => {
            const result = auditCommandCompactness('gradle build');
            assert.equal(result.matched_categories.filter(c => c === 'build').length, 0);
        });
        it('warns about verbose cargo build', () => {
            const result = auditCommandCompactness('cargo build -v');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('does not warn about cargo build without -v', () => {
            const result = auditCommandCompactness('cargo build');
            assert.equal(result.matched_categories.filter(c => c === 'build').length, 0);
        });
        it('warns about verbose cargo test', () => {
            const result = auditCommandCompactness('cargo test -v');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('does not warn about cargo test without -v', () => {
            const result = auditCommandCompactness('cargo test');
            assert.equal(result.matched_categories.filter(c => c === 'build').length, 0);
        });
        it('warns about dotnet build with diagnostic verbosity', () => {
            const result = auditCommandCompactness('dotnet build -v detailed');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('warns about dotnet test with diag verbosity', () => {
            const result = auditCommandCompactness('dotnet test -v diag');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('build'));
        });
        it('does not warn about dotnet build without verbose flags', () => {
            const result = auditCommandCompactness('dotnet build');
            assert.equal(result.matched_categories.filter(c => c === 'build').length, 0);
        });

        // --- Network: curl, wget ---
        it('warns about unbounded curl', () => {
            const result = auditCommandCompactness('curl https://example.com/api');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('network'));
        });
        it('does not warn about curl -s', () => {
            const result = auditCommandCompactness('curl -s https://example.com/api');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('does not warn about curl -sf (combined flags)', () => {
            const result = auditCommandCompactness('curl -sf https://example.com/api');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('does not warn about curl --silent', () => {
            const result = auditCommandCompactness('curl --silent https://example.com/api');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('does not warn about curl -o (output to file)', () => {
            const result = auditCommandCompactness('curl -o file.txt https://example.com/api');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('does not warn about curl -f (fail fast)', () => {
            const result = auditCommandCompactness('curl -f https://example.com/api');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('warns about unbounded wget', () => {
            const result = auditCommandCompactness('wget https://example.com/file.tar.gz');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('network'));
        });
        it('does not warn about wget -q', () => {
            const result = auditCommandCompactness('wget -q https://example.com/file.tar.gz');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('does not warn about wget -qO- (combined flags)', () => {
            const result = auditCommandCompactness('wget -qO- https://example.com/file.tar.gz');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });
        it('does not warn about wget --quiet', () => {
            const result = auditCommandCompactness('wget --quiet https://example.com/file.tar.gz');
            assert.equal(result.matched_categories.filter(c => c === 'network').length, 0);
        });

        // --- File listing: find, tree, ls -R ---
        it('warns about unbounded find', () => {
            const result = auditCommandCompactness('find /var/log');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('file_listing'));
        });
        it('does not warn about find with -maxdepth', () => {
            const result = auditCommandCompactness('find /var/log -maxdepth 3 -name "*.log"');
            assert.equal(result.matched_categories.filter(c => c === 'file_listing').length, 0);
        });
        it('warns about unbounded tree', () => {
            const result = auditCommandCompactness('tree src/');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('file_listing'));
        });
        it('does not warn about tree -L', () => {
            const result = auditCommandCompactness('tree -L 3 src/');
            assert.equal(result.matched_categories.filter(c => c === 'file_listing').length, 0);
        });
        it('does not warn about tree -L3 (no space)', () => {
            const result = auditCommandCompactness('tree -L3 src/');
            assert.equal(result.matched_categories.filter(c => c === 'file_listing').length, 0);
        });
        it('warns about ls -R', () => {
            const result = auditCommandCompactness('ls -R src/');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('file_listing'));
        });
        it('warns about ls -lR', () => {
            const result = auditCommandCompactness('ls -lR');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('file_listing'));
        });
        it('does not warn about ls -l (non-recursive)', () => {
            const result = auditCommandCompactness('ls -l src/');
            assert.equal(result.matched_categories.filter(c => c === 'file_listing').length, 0);
        });

        // --- System: env, printenv ---
        it('warns about bare env command', () => {
            const result = auditCommandCompactness('env');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('system'));
        });
        it('warns about bare printenv command', () => {
            const result = auditCommandCompactness('printenv');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('system'));
        });
        it('does not warn about env with pipe/filter (multiline command)', () => {
            const result = auditCommandCompactness('env | grep PATH');
            assert.equal(result.matched_categories.filter(c => c === 'system').length, 0);
        });

        // --- Pager: less, more ---
        it('warns about less on a file', () => {
            const result = auditCommandCompactness('less output.log');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('pager'));
        });
        it('warns about more on a file', () => {
            const result = auditCommandCompactness('more output.log');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('pager'));
        });
        it('does not warn about head (compact alternative to pagers)', () => {
            const result = auditCommandCompactness('head -n 60 output.log');
            assert.equal(result.matched_categories.filter(c => c === 'pager').length, 0);
        });
        it('does not warn about tail (compact alternative to pagers)', () => {
            const result = auditCommandCompactness('tail -n 60 output.log');
            assert.equal(result.matched_categories.filter(c => c === 'pager').length, 0);
        });

        // --- Docker: ps, images ---
        it('warns about unbounded docker ps', () => {
            const result = auditCommandCompactness('docker ps');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('container'));
        });
        it('does not warn about docker ps --format', () => {
            const result = auditCommandCompactness('docker ps --format "table {{.ID}}"');
            const containerWarnings = result.warnings.filter(w => w.includes('docker ps'));
            assert.equal(containerWarnings.length, 0);
        });
        it('does not warn about docker ps -q', () => {
            const result = auditCommandCompactness('docker ps -q');
            const containerWarnings = result.warnings.filter(w => w.includes('docker ps'));
            assert.equal(containerWarnings.length, 0);
        });
        it('warns about unbounded docker images', () => {
            const result = auditCommandCompactness('docker images');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('container'));
        });
        it('does not warn about docker images --format', () => {
            const result = auditCommandCompactness('docker images --format "{{.Repository}}"');
            const imageWarnings = result.warnings.filter(w => w.includes('docker images'));
            assert.equal(imageWarnings.length, 0);
        });

        // --- Kubernetes: describe, get ---
        it('warns about unbounded kubectl describe', () => {
            const result = auditCommandCompactness('kubectl describe pod my-pod');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('container'));
        });
        it('does not warn about kubectl describe -l (label-scoped)', () => {
            const result = auditCommandCompactness('kubectl describe pods -l app=web');
            const describeWarnings = result.warnings.filter(w => w.includes('describe'));
            assert.equal(describeWarnings.length, 0);
        });
        it('warns about kubectl get without output format', () => {
            const result = auditCommandCompactness('kubectl get pods');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('container'));
        });
        it('does not warn about kubectl get -o json', () => {
            const result = auditCommandCompactness('kubectl get pods -o json');
            const getWarnings = result.warnings.filter(w => w.includes('kubectl get'));
            assert.equal(getWarnings.length, 0);
        });
        it('does not warn about kubectl get --output wide', () => {
            const result = auditCommandCompactness('kubectl get pods --output wide');
            const getWarnings = result.warnings.filter(w => w.includes('kubectl get'));
            assert.equal(getWarnings.length, 0);
        });

        // --- Terraform ---
        it('warns about terraform plan without compact flags', () => {
            const result = auditCommandCompactness('terraform plan');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('infra'));
        });
        it('does not warn about terraform plan -compact-warnings', () => {
            const result = auditCommandCompactness('terraform plan -compact-warnings');
            const infraWarnings = result.warnings.filter(w => w.includes('terraform'));
            assert.equal(infraWarnings.length, 0);
        });
        it('does not warn about terraform plan -json', () => {
            const result = auditCommandCompactness('terraform plan -json');
            const infraWarnings = result.warnings.filter(w => w.includes('terraform'));
            assert.equal(infraWarnings.length, 0);
        });

        // --- Cross-category multi-match tests ---
        it('produces multiple warnings for a command matching multiple categories', () => {
            const result = auditCommandCompactness('git diff HEAD && npm install && cat file.log');
            assert.ok(result.warning_count >= 3);
            assert.ok(result.matched_categories.includes('git'));
            assert.ok(result.matched_categories.includes('package_manager'));
            assert.ok(result.matched_categories.includes('search'));
        });
    });

    describe('auditGateCommand', () => {
        it('returns audit with gate mode, lifecycle justification, and warnings for noisy commands', () => {
            const result = auditGateCommand('git diff HEAD', 'compile-gate');
            assert.equal(result.mode, 'gate');
            assert.ok(result.justification.includes('compile-gate'));
            assert.ok(result.warning_count > 0);
            assert.ok(result.warnings.length > 0);
        });
        it('records warnings for noisy gate commands', () => {
            const result = auditGateCommand('git diff HEAD', 'compile-gate');
            assert.ok(result.warning_count > 0, 'gate commands should still be audited');
            assert.ok(result.warnings.length > 0);
        });
    });

    describe('getCommandAuditFromDetails', () => {
        it('extracts command from details.command', () => {
            const result = getCommandAuditFromDetails({ command: 'git diff HEAD' });
            assert.ok(result);
            assert.ok(((result as Record<string, unknown>).warning_count as number) > 0);
        });
        it('returns existing command_policy_audit if present', () => {
            const existing = { warnings: [], warning_count: 0 };
            const result = getCommandAuditFromDetails({ command_policy_audit: existing });
            assert.deepEqual(result, existing);
        });
        it('returns null when no command found', () => {
            assert.equal(getCommandAuditFromDetails({}), null);
            assert.equal(getCommandAuditFromDetails(null), null);
        });
    });

    describe('buildTaskEventsSummary', () => {
        function createTaskEvents(tmpDir: string, taskId: string, events: Array<Record<string, unknown>>) {
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const filePath = path.join(eventsDir, `${taskId}.jsonl`);
            const lines = events.map(e => JSON.stringify(e));
            fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
            return eventsDir;
        }

        it('builds summary from task events', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-001',
                    event_type: 'PREFLIGHT_CLASSIFIED',
                    outcome: 'INFO',
                    actor: 'gate',
                    message: 'Preflight completed.'
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-001',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.'
                }
            ];
            const eventsRoot = createTaskEvents(tmpDir, 'T-001', events);
            const summary = buildTaskEventsSummary({ taskId: 'T-001', eventsRoot });
            assert.equal(summary.task_id, 'T-001');
            assert.equal(summary.events_count, 2);
            assert.equal(summary.parse_errors, 0);
            assert.equal(summary.timeline.length, 2);
            assert.equal(summary.timeline[0].event_type, 'PREFLIGHT_CLASSIFIED');
            assert.equal(summary.timeline[1].event_type, 'COMPILE_GATE_PASSED');
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('handles empty events file', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsRoot = createTaskEvents(tmpDir, 'T-002', []);
            // Remove the file and create an empty one
            const filePath = path.join(eventsRoot, 'T-002.jsonl');
            fs.writeFileSync(filePath, '\n', 'utf8');
            const summary = buildTaskEventsSummary({ taskId: 'T-002', eventsRoot });
            assert.equal(summary.events_count, 0);
            assert.equal(summary.timeline.length, 0);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('throws for missing events file', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            assert.throws(() => buildTaskEventsSummary({ taskId: 'T-999', eventsRoot: eventsDir }), /not found/);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('aggregates measurable token savings from command output and review context artifacts', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'runtime', 'reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const reviewContextPath = path.join(reviewsDir, 'T-003-code-review-context.json');
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const reviewEvidencePath = path.join(reviewsDir, 'T-003-review-gate.json');
            fs.writeFileSync(reviewEvidencePath, JSON.stringify({
                output_telemetry: {
                    raw_token_count_estimate: 18,
                    filtered_token_count_estimate: 6,
                    estimated_saved_tokens: 12
                },
                artifact_evidence: {
                    checked: [{
                        review: 'code',
                        review_context_path: reviewContextPath.replace(/\\/g, '/')
                    }]
                }
            }, null, 2), 'utf8');

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-003',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.',
                    details: {
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-003',
                    event_type: 'REVIEW_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review gate passed.',
                    details: {
                        review_evidence_path: reviewEvidencePath.replace(/\\/g, '/')
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-003.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-003', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 165);
            assert.equal(summary.token_economy!.total_raw_token_count_estimate, 248);
            assert.match(summary.token_economy!.visible_summary_line!, /Saved tokens: ~165/);
            assert.match(summary.token_economy!.visible_summary_line!, /120 code review context/);
            assert.match(summary.token_economy!.visible_summary_line!, /33 compile gate output/);
            assert.match(summary.token_economy!.visible_summary_line!, /12 review gate output/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    describe('formatTaskEventsSummaryText', () => {
        it('formats summary as human-readable text', () => {
            const summary = {
                task_id: 'T-001',
                source_path: '/events/T-001.jsonl',
                events_count: 1,
                parse_errors: 0,
                integrity: {
                    status: 'PASS',
                    integrity_event_count: 1,
                    legacy_event_count: 0,
                    violations: []
                },
                command_policy_warnings: [],
                command_policy_warning_count: 0,
                token_economy: {
                    visible_summary_line: 'Saved tokens: ~33 (~66%) (33 compile gate output).'
                },
                first_event_utc: '2024-01-15T10:00:00.000Z',
                last_event_utc: '2024-01-15T10:00:00.000Z',
                timeline: [{
                    index: 1,
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    event_type: 'PREFLIGHT_CLASSIFIED',
                    outcome: 'INFO',
                    actor: 'gate',
                    message: 'Done.'
                }]
            };
            const text = formatTaskEventsSummaryText(summary as unknown as TaskEventsSummaryResult);
            assert.ok(text.includes('Task: T-001'));
            assert.ok(text.includes('Events: 1'));
            assert.ok(text.includes('IntegrityStatus: PASS'));
            assert.ok(text.includes('Saved tokens: ~33 (~66%) (33 compile gate output).'));
            assert.ok(text.includes('PREFLIGHT_CLASSIFIED'));
            assert.ok(text.includes('Timeline:'));
        });
    });

    describe('getOutputTelemetryFromPayload', () => {
        it('extracts telemetry from nested output_telemetry payloads', () => {
            const result = getOutputTelemetryFromPayload({
                output_telemetry: {
                    raw_token_count_estimate: 20,
                    filtered_token_count_estimate: 10,
                    estimated_saved_tokens: 10
                }
            });

            assert.equal(result!.raw_token_count_estimate, 20);
            assert.equal(result!.output_token_count_estimate, 10);
            assert.equal(result!.estimated_saved_tokens, 10);
            assert.equal(result!.baseline_known, true);
        });
    });
});
