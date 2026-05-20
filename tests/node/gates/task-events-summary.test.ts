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
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    formatTaskEventsSummaryText,
    getOutputTelemetryFromPayload,
    taskCycleScopeBindingsMatch,
    TaskEventsSummaryResult
} from '../../../src/gates/task-events-summary';
import { runTaskEventsSummaryCommand } from '../../../src/cli/commands/gate-flows/task-summary-flow';

describe('gates/task-events-summary', () => {
    describe('taskCycleScopeBindingsMatch', () => {
        it('rejects same-scope evidence that is not bound to a prior compile timestamp', () => {
            const scopeBinding = {
                changed_files_sha256: '1'.repeat(64),
                scope_sha256: '2'.repeat(64),
                scope_content_sha256: '3'.repeat(64)
            };

            assert.equal(taskCycleScopeBindingsMatch({
                preflight_path: 'preflight.json',
                preflight_sha256: 'new-cycle',
                compile_gate_timestamp: '2024-01-15T10:00:00Z',
                scope_binding: scopeBinding
            }, {
                preflight_path: 'preflight.json',
                preflight_sha256: 'old-cycle',
                compile_gate_timestamp: null,
                scope_binding: scopeBinding
            }), false);
        });
    });

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
        it('warns about direct .node-build consumer outside guarded workflow', () => {
            const result = auditCommandCompactness('node --test .node-build/tests/node/materialization/install.test.js');
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('validation_chain'));
            assert.ok(result.warnings.some((warning) => warning.includes('Direct `.node-build` test consumer')));
        });
        it('does not warn about allowed standalone npm test producer path', () => {
            const result = auditCommandCompactness('npm test');
            assert.ok(!result.matched_categories.includes('validation_chain'));
        });
        it('does not suppress validation-chain warnings when a justification is present', () => {
            const result = auditCommandCompactness(
                'node --test .node-build/tests/node/materialization/install.test.js',
                { justification: 'localized reproduction of a generated-artifact chain issue' }
            );
            assert.ok(result.warning_count > 0);
            assert.ok(result.matched_categories.includes('validation_chain'));
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
        it('does not warn about validation-chain producer inside lifecycle-required gate execution', () => {
            const result = auditGateCommand('npm run build:node-foundation', 'compile-gate');
            assert.ok(!result.matched_categories.includes('validation_chain'));
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

        it('surfaces validation-chain warnings through aggregated task summary details', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004',
                    event_type: 'SHELL_COMMAND_EXECUTED',
                    outcome: 'INFO',
                    actor: 'agent',
                    message: 'Direct compiled test consumer launched outside guarded workflow.',
                    details: {
                        command_text: 'node.exe --test .node-build\\tests\\node\\materialization\\install.test.js',
                        command_mode: 'scan'
                    }
                }
            ];
            const eventsRoot = createTaskEvents(tmpDir, 'T-004', events);
            const summary = buildTaskEventsSummary({ taskId: 'T-004', eventsRoot });
            assert.equal(summary.command_policy_warning_count, 1);
            assert.ok(summary.command_policy_warnings.some((warning) => warning.includes('Direct `.node-build` test consumer')));
            assert.ok(summary.timeline[0].command_policy_audit);
            assert.deepEqual(summary.timeline[0].command_policy_audit?.matched_categories, ['validation_chain']);
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
                        original_char_count: 720,
                        output_char_count: 240,
                        estimated_saved_chars: 480,
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const reviewEvidencePath = path.join(reviewsDir, 'T-003-review-gate.json');
            fs.writeFileSync(reviewEvidencePath, JSON.stringify({
                output_telemetry: {
                    raw_char_count: 72,
                    filtered_char_count: 24,
                    estimated_saved_chars: 48,
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
                        raw_char_count: 200,
                        filtered_char_count: 68,
                        estimated_saved_chars: 132,
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
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 660);
            assert.equal(summary.token_economy!.total_raw_char_count, 992);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 165);
            assert.equal(summary.token_economy!.total_raw_token_count_estimate, 248);
            assert.match(summary.token_economy!.visible_summary_line!, /Suppressed output: ~660 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /code review context ~480 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output ~132 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /review gate output ~48 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /Suppressed output estimate: ~165 tokens/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('labels full-suite validation telemetry separately from generic gate output', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 420);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 105);
            assert.match(summary.token_economy!.visible_summary_line!, /full-suite validation output ~420 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('excludes stale full-suite telemetry when the current cycle binding no longer matches', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004B-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: path.join(reviewsDir, 'T-004B-preflight.json'),
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-004B',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        cycle_binding: {
                            preflight_path: path.join(reviewsDir, 'T-004B-preflight.json'),
                            preflight_sha256: 'older-cycle',
                            compile_gate_timestamp: '2024-01-15T09:30:00Z'
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004B', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 0);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 0);
            assert.equal(summary.token_economy!.breakdown.length, 0);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('keeps older full-suite telemetry after a no-scope-change compile recovery', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const preflightPath = path.join(reviewsDir, 'T-004C-preflight.json');
            const changedFilesSha = '1'.repeat(64);
            const scopeSha = '2'.repeat(64);
            const scopeContentSha = '3'.repeat(64);
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004C-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'new-cycle',
                    preflight_changed_files_sha256: changedFilesSha,
                    preflight_scope_sha256: scopeSha,
                    preflight_scope_content_sha256: scopeContentSha
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T09:45:00Z',
                    task_id: 'T-004C',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed before a no-change closeout recovery compile.',
                    details: {
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'old-cycle',
                            compile_gate_timestamp: '2024-01-15T09:30:00Z',
                            scope_binding: {
                                changed_files_sha256: changedFilesSha,
                                scope_sha256: scopeSha,
                                scope_content_sha256: scopeContentSha
                            }
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004C',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile recovery with unchanged tracked scope.',
                    details: {
                        preflight_path: preflightPath,
                        preflight_hash_sha256: 'new-cycle',
                        preflight_changed_files_sha256: changedFilesSha,
                        preflight_scope_sha256: scopeSha,
                        preflight_scope_content_sha256: scopeContentSha
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004C.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004C', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 420);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 105);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('keeps current-cycle compile and full-suite telemetry when the compile artifact is written after the compile event', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const preflightPath = path.join(reviewsDir, 'T-004B-runtime-order-preflight.json');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004B-runtime-order-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00.400Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    task_id: 'T-004B-runtime-order',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the current cycle.',
                    details: {
                        preflight_path: preflightPath,
                        preflight_hash_sha256: 'current-cycle',
                        raw_char_count: 200,
                        filtered_char_count: 68,
                        estimated_saved_chars: 132,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00.000Z',
                    task_id: 'T-004B-runtime-order',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed for the current cycle.',
                    details: {
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'current-cycle',
                            compile_gate_timestamp: '2024-01-15T10:00:00.000Z'
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B-runtime-order.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-004B-runtime-order',
                eventsRoot: eventsDir,
                repoRoot: tmpDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 552);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 138);
            assert.equal(summary.token_economy!.breakdown.length, 2);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output ~132 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /full-suite validation output ~420 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('counts current-cycle review-context telemetry directly from REVIEW_PHASE_STARTED output_path', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const preflightPath = path.join(reviewsDir, 'T-004B-review-phase-preflight.json');
            const reviewContextPath = path.join(reviewsDir, 'T-004B-review-phase-code-review-context.json');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004B-review-phase-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00.400Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_char_count: 720,
                        output_char_count: 240,
                        estimated_saved_chars: 480,
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    task_id: 'T-004B-review-phase',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the current cycle.',
                    details: {
                        preflight_path: preflightPath,
                        preflight_hash_sha256: 'current-cycle'
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00.000Z',
                    task_id: 'T-004B-review-phase',
                    event_type: 'REVIEW_PHASE_STARTED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review phase started for the current cycle.',
                    details: {
                        review_type: 'code',
                        output_path: reviewContextPath
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B-review-phase.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-004B-review-phase',
                eventsRoot: eventsDir,
                repoRoot: tmpDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 480);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 120);
            assert.equal(summary.token_economy!.breakdown.length, 1);
            assert.match(summary.token_economy!.visible_summary_line!, /code review context ~480 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('uses the canonical review-type registry for fallback review-context discovery when no compile cycle exists', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const reviewContextPath = path.join(reviewsDir, 'T-004B-fallback-dependency-review-context.json');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'dependency',
                rule_context: {
                    summary: {
                        original_char_count: 300,
                        output_char_count: 180,
                        estimated_saved_chars: 120,
                        original_token_count_estimate: 75,
                        output_token_count_estimate: 45,
                        estimated_saved_tokens: 30
                    }
                }
            }, null, 2), 'utf8');

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    task_id: 'T-004B-fallback',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Task mode entered before any compile cycle.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B-fallback.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-004B-fallback',
                eventsRoot: eventsDir,
                repoRoot: tmpDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 120);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 30);
            assert.equal(summary.token_economy!.breakdown.length, 1);
            assert.match(summary.token_economy!.visible_summary_line!, /dependency review context ~120 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('excludes stale compile and review-context telemetry after a newer compile cycle starts', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const reviewContextPath = path.join(reviewsDir, 'T-004C-code-review-context.json');
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_char_count: 720,
                        output_char_count: 240,
                        estimated_saved_chars: 480,
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const reviewEvidencePath = path.join(reviewsDir, 'T-004C-review-gate.json');
            fs.writeFileSync(reviewEvidencePath, JSON.stringify({
                output_telemetry: {
                    raw_char_count: 72,
                    filtered_char_count: 24,
                    estimated_saved_chars: 48,
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

            fs.writeFileSync(
                path.join(reviewsDir, 'T-004C-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: path.join(reviewsDir, 'T-004C-preflight.json'),
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004C',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the earlier cycle.',
                    details: {
                        raw_char_count: 200,
                        filtered_char_count: 68,
                        estimated_saved_chars: 132,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-004C',
                    event_type: 'REVIEW_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review gate passed for the earlier cycle.',
                    details: {
                        review_evidence_path: reviewEvidencePath.replace(/\\/g, '/')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:06:00Z',
                    task_id: 'T-004C',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the current cycle.',
                    details: {
                        raw_char_count: 96,
                        filtered_char_count: 34,
                        estimated_saved_chars: 62,
                        raw_token_count_estimate: 24,
                        filtered_token_count_estimate: 8,
                        estimated_saved_tokens: 16
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004C.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004C', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 62);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 16);
            assert.equal(summary.token_economy!.breakdown.length, 1);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output ~62 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('keeps token-only legacy contributions visible inside char-first summaries', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-005',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-005',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.',
                    details: {
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-005.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-005', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.match(summary.token_economy!.visible_summary_line!, /Suppressed output \(char-aware subset\): ~420 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /full-suite validation output ~420 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output suppressed output estimate ~33 tokens/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('uses the provided reviewsRoot and keeps only the latest full-suite attempt per cycle', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'custom-reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const firstArtifactPath = path.join(reviewsDir, 'T-006-full-suite-validation-first.json');
            const secondArtifactPath = path.join(reviewsDir, 'T-006-full-suite-validation-second.json');
            const preflightPath = path.join(reviewsDir, 'T-006-preflight.json');
            fs.writeFileSync(
                path.join(reviewsDir, 'T-006-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-006',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        artifact_path: firstArtifactPath,
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'current-cycle',
                            compile_gate_timestamp: '2024-01-15T10:00:00Z'
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:06:00Z',
                    task_id: 'T-006',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed again.',
                    details: {
                        artifact_path: secondArtifactPath,
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'current-cycle',
                            compile_gate_timestamp: '2024-01-15T10:00:00Z'
                        },
                        output_telemetry: {
                            raw_char_count: 1000,
                            filtered_char_count: 220,
                            estimated_saved_chars: 780,
                            raw_token_count_estimate: 250,
                            filtered_token_count_estimate: 55,
                            estimated_saved_tokens: 195
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-006.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-006',
                eventsRoot: eventsDir,
                repoRoot: tmpDir,
                reviewsRoot: reviewsDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 780);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 195);
            assert.equal(summary.token_economy!.breakdown.length, 1);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('builds a bounded compact latest-cycle contract without full timeline details', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T09:00:00Z',
                    task_id: 'T-007',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Earlier cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T09:01:00Z',
                    task_id: 'T-007',
                    event_type: 'COMPILE_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Earlier compile failed.',
                    details: {
                        artifact_path: path.join(tmpDir, 'old-compile.json')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-007',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.',
                    details: {
                        artifact_path: path.join(tmpDir, 'task-mode.json')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-007',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.',
                    details: {
                        artifact_path: path.join(tmpDir, 'compile.json'),
                        raw_char_count: 200,
                        filtered_char_count: 100,
                        estimated_saved_chars: 100,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 25,
                        estimated_saved_tokens: 25,
                        verbose_payload: 'x'.repeat(1000)
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-007.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const fullSummary = buildTaskEventsSummary({ taskId: 'T-007', eventsRoot: eventsDir, repoRoot: tmpDir });
            const compactSummary = buildCompactLatestCycleTaskEventsSummary(fullSummary);

            assert.equal(compactSummary.schema_version, 2);
            assert.equal(compactSummary.mode, 'compact_latest_cycle');
            assert.equal(compactSummary.event_contract.schema_version, 2);
            assert.equal(compactSummary.event_contract.current_schema_event_count, 0);
            assert.equal(compactSummary.event_contract.legacy_schema_event_count, 4);
            assert.equal(compactSummary.latest_cycle.status, 'IN_PROGRESS');
            assert.equal(compactSummary.latest_cycle.health_state, 'healthy');
            assert.equal(compactSummary.latest_cycle.terminal_outcome, 'none');
            assert.equal(compactSummary.latest_cycle.cycle_event_count, 2);
            assert.equal(compactSummary.latest_cycle.start_index, 3);
            assert.equal(compactSummary.latest_cycle.blocking_reason, null);
            assert.deepEqual(
                compactSummary.latest_cycle.gate_outcomes.map((item) => item.gate),
                ['enter-task-mode', 'compile-gate']
            );
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/compile.json')));
            assert.equal(compactSummary.token_economy?.total_estimated_saved_chars, 100);
            assert.equal(JSON.stringify(compactSummary).includes('verbose_payload'), false);
            assert.equal('timeline' in compactSummary, false);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('tracks mixed legacy, current, and unknown schema event counts in the public contract summary', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-007A',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Legacy event without explicit schema.'
                },
                {
                    schema_version: 2,
                    event_source: 'task-events',
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-007A',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Current public schema event.',
                    public_metadata: {
                        lifecycle_phase: 'validation',
                        status_signal: 'pass',
                        health_state: 'healthy',
                        terminal_outcome: 'none'
                    }
                },
                {
                    schema_version: 7,
                    event_source: 'task-events',
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-007A',
                    event_type: 'COMPLETION_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Unknown future schema event.',
                    public_metadata: {
                        lifecycle_phase: 'terminal',
                        status_signal: 'pass',
                        health_state: 'healthy',
                        terminal_outcome: 'done'
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-007A.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const fullSummary = buildTaskEventsSummary({ taskId: 'T-007A', eventsRoot: eventsDir, repoRoot: tmpDir });
            const compactSummary = buildCompactLatestCycleTaskEventsSummary(fullSummary);

            assert.equal(fullSummary.event_contract.schema_version, 2);
            assert.equal(fullSummary.event_contract.current_schema_event_count, 1);
            assert.equal(fullSummary.event_contract.legacy_schema_event_count, 1);
            assert.equal(fullSummary.event_contract.unknown_schema_version_count, 1);
            assert.equal(compactSummary.event_contract.current_schema_event_count, 1);
            assert.equal(compactSummary.event_contract.legacy_schema_event_count, 1);
            assert.equal(compactSummary.event_contract.unknown_schema_version_count, 1);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('reports the latest-cycle blocker from the latest gate outcome', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008',
                    event_type: 'COMPILE_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Compile gate failed.'
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008',
                    event_type: 'REVIEW_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Review gate failed before compile was retried.'
                },
                {
                    timestamp_utc: '2024-01-15T10:03:00Z',
                    task_id: 'T-008',
                    event_type: 'COMPILE_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Compile gate failed again.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008', eventsRoot: eventsDir, repoRoot: tmpDir })
            );

            assert.equal(compactSummary.latest_cycle.status, 'BLOCKED');
            assert.equal(compactSummary.latest_cycle.health_state, 'failed');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.gate, 'compile-gate');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.event_type, 'COMPILE_GATE_FAILED');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.message, 'Compile gate failed again.');

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('preserves blocked health state when informational events appear after the blocking gate', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008A',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008A',
                    event_type: 'PROJECT_MEMORY_IMPACT_BLOCKED',
                    outcome: 'BLOCKED',
                    actor: 'gate',
                    message: 'Project memory blocked closeout.'
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008A',
                    event_type: 'NO_OP_RECORDED',
                    outcome: 'INFO',
                    actor: 'agent',
                    message: 'Operator left an informational breadcrumb.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008A.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008A', eventsRoot: eventsDir, repoRoot: tmpDir })
            );

            assert.equal(compactSummary.latest_cycle.status, 'BLOCKED');
            assert.equal(compactSummary.latest_cycle.health_state, 'blocked');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.gate, 'project-memory-impact');

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('preserves completion terminal outcome when later non-terminal events are appended', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008D',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008D',
                    event_type: 'COMPLETION_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Completion gate passed.'
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008D',
                    event_type: 'NO_OP_RECORDED',
                    outcome: 'INFO',
                    actor: 'agent',
                    message: 'Final informational note.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008D.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008D', eventsRoot: eventsDir, repoRoot: tmpDir })
            );

            assert.equal(compactSummary.latest_cycle.status, 'PASS');
            assert.equal(compactSummary.latest_cycle.health_state, 'healthy');
            assert.equal(compactSummary.latest_cycle.terminal_outcome, 'done');

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('includes override-approved review gates in compact latest-cycle outcomes', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008B',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008B',
                    event_type: 'REVIEW_GATE_PASSED_WITH_OVERRIDE',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review gate passed with override.',
                    details: {
                        artifact_path: path.join(tmpDir, 'review-gate.json')
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008B.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008B', eventsRoot: eventsDir, repoRoot: tmpDir })
            );
            const reviewGate = compactSummary.latest_cycle.gate_outcomes.find(
                (item) => item.gate === 'required-reviews-check'
            );

            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'PASS');
            assert.equal(reviewGate.event_type, 'REVIEW_GATE_PASSED_WITH_OVERRIDE');
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/review-gate.json')));

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('maps actual doc-impact and project-memory lifecycle events to compact gate outcomes', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008C',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008C',
                    event_type: 'DOC_IMPACT_ASSESSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Doc impact assessed.',
                    details: {
                        artifact_path: path.join(tmpDir, 'doc-impact.json')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008C',
                    event_type: 'PROJECT_MEMORY_IMPACT_BLOCKED',
                    outcome: 'BLOCKED',
                    actor: 'gate',
                    message: 'Project memory impact blocked completion.',
                    details: {
                        artifact_path: path.join(tmpDir, 'project-memory-impact.json')
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008C.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008C', eventsRoot: eventsDir, repoRoot: tmpDir })
            );
            const docImpact = compactSummary.latest_cycle.gate_outcomes.find(
                (item) => item.gate === 'doc-impact-gate'
            );
            const projectMemory = compactSummary.latest_cycle.gate_outcomes.find(
                (item) => item.gate === 'project-memory-impact'
            );

            assert.ok(docImpact);
            assert.equal(docImpact.status, 'PASS');
            assert.equal(docImpact.event_type, 'DOC_IMPACT_ASSESSED');
            assert.ok(projectMemory);
            assert.equal(projectMemory.status, 'FAIL');
            assert.equal(projectMemory.event_type, 'PROJECT_MEMORY_IMPACT_BLOCKED');
            assert.equal(compactSummary.latest_cycle.status, 'BLOCKED');
            assert.equal(compactSummary.latest_cycle.health_state, 'blocked');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.gate, 'project-memory-impact');
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/doc-impact.json')));
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/project-memory-impact.json')));

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('renders compact latest-cycle CLI output as JSON without changing legacy --as-json', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const repoRoot = path.join(tmpDir, 'repo');
            const eventsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(
                path.join(eventsDir, 'T-009.jsonl'),
                [
                    {
                        timestamp_utc: '2024-01-15T10:00:00Z',
                        task_id: 'T-009',
                        event_type: 'TASK_MODE_ENTERED',
                        outcome: 'PASS',
                        actor: 'gate',
                        message: 'Task mode entered.'
                    }
                ].map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const legacy = JSON.parse(runTaskEventsSummaryCommand({
                taskId: 'T-009',
                repoRoot,
                asJson: true
            }).rendered);
            const compact = JSON.parse(runTaskEventsSummaryCommand({
                taskId: 'T-009',
                repoRoot,
                compactLatestCycle: true
            }).rendered);

            assert.ok(Array.isArray(legacy.timeline));
            assert.equal(compact.mode, 'compact_latest_cycle');
            assert.equal(compact.schema_version, 2);
            assert.equal('timeline' in compact, false);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    describe('formatTaskEventsSummaryText', () => {
        it('formats summary as human-readable text', () => {
            const summary = {
                event_contract: {
                    schema_version: 2,
                    legacy_schema_versions: [1],
                    current_schema_event_count: 0,
                    legacy_schema_event_count: 1,
                    unknown_schema_version_count: 0
                },
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
                    visible_summary_line: 'Suppressed output: ~132 chars (~66%) (compile gate output ~132 chars). Suppressed output estimate: ~33 tokens.'
                },
                first_event_utc: '2024-01-15T10:00:00.000Z',
                last_event_utc: '2024-01-15T10:00:00.000Z',
                timeline: [{
                    index: 1,
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    schema_version: 1,
                    event_source: 'task-events',
                    event_type: 'PREFLIGHT_CLASSIFIED',
                    outcome: 'INFO',
                    actor: 'gate',
                    message: 'Done.',
                    lifecycle_phase: 'preflight',
                    health_state: 'neutral',
                    terminal_outcome: 'none',
                    normalized_from_legacy: true,
                    unknown_schema_version: false
                }]
            };
            const text = formatTaskEventsSummaryText(summary as unknown as TaskEventsSummaryResult);
            assert.ok(text.includes('Task: T-001'));
            assert.ok(text.includes('Events: 1'));
            assert.ok(text.includes('IntegrityStatus: PASS'));
            assert.ok(text.includes('Suppressed output: ~132 chars (~66%) (compile gate output ~132 chars). Suppressed output estimate: ~33 tokens.'));
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
