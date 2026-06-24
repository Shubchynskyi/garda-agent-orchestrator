import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    auditCommandCompactness,
    auditGateCommand,
    getCommandAuditFromDetails
} from '../../../../src/gates/task-events-summary';

describe('gates/task-events-summary', () => {
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

});
