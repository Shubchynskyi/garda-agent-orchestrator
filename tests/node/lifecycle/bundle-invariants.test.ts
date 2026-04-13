import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    BUNDLE_RUNTIME_INVENTORY_PATHS,
    detectSourceBundleParity,
    validateBundleInvariants
} from '../../../src/validators/workspace-layout';
import { runUpdate } from '../../../src/lifecycle/update';
import { runReinit } from '../../../src/materialization/reinit';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json')) && 
            fs.existsSync(path.join(dir, 'VERSION')) && 
            fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    if (fs.existsSync(path.join(process.cwd(), 'VERSION'))) {
        return process.cwd();
    }
    throw new Error('Cannot find repo root');
}

describe('Bundle invariants', () => {
    let repoRoot: string;
    let tmpDir: string;
    let bundle: string;

    before(() => {
        repoRoot = findRepoRoot();
    });

    function setupTestWorkspace() {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-invariants-'));
        bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundle, { recursive: true });

        // Minimal source setup
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.0.0');
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), 'console.log("launcher")');
        fs.writeFileSync(path.join(tmpDir, 'bin', 'garda.js'), 'console.log("launcher")');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {}');

        // Create valid bundle
        fs.writeFileSync(path.join(bundle, 'VERSION'), '1.0.0');
        fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
        fs.copyFileSync(path.join(tmpDir, 'bin', 'garda.js'), path.join(bundle, 'bin', 'garda.js'));
        fs.copyFileSync(path.join(tmpDir, 'bin', 'garda.js'), path.join(bundle, 'bin', 'garda.js'));
        fs.mkdirSync(path.join(bundle, 'dist', 'src'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'dist', 'src', 'index.js'), 'module.exports = {}');
        fs.writeFileSync(path.join(bundle, 'package.json'), '{}');
        
        // Copy template using fs.cpSync (stable since Node 16.7)
        fs.cpSync(path.join(repoRoot, 'template'), path.join(bundle, 'template'), { recursive: true });

        // Create runtime and answers
        fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
        const answers = {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Claude',
            EnforceNoAutoCommit: 'false',
            TokenEconomyEnabled: 'true',
            ClaudeOrchestratorFullAccess: 'false'
        };
        fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify(answers));

        for (const relPath of BUNDLE_RUNTIME_INVENTORY_PATHS) {
            const fullPath = path.join(bundle, relPath);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, '{}');
            }
        }

        // Create .git dir
        fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    }

    function cleanupTestWorkspace() {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    it('detectSourceBundleParity should detect missing critical files', () => {
        setupTestWorkspace();
        try {
            const initialResult = detectSourceBundleParity(tmpDir);
            assert.equal(initialResult.isStale, false, 'Should be valid initially');

            fs.rmSync(path.join(bundle, 'dist', 'src', 'index.js'));
            const missingDistResult = detectSourceBundleParity(tmpDir);
            assert.equal(missingDistResult.isStale, true, 'Should be stale when dist file is missing');
            assert.ok(missingDistResult.violations.some(v => v.includes('dist/src/index.js')), 'Should report missing dist file');

            fs.rmSync(path.join(bundle, 'bin', 'garda.js'));
            const missingBinResult = detectSourceBundleParity(tmpDir);
            assert.equal(missingBinResult.isStale, true, 'Should be stale when bin is missing');
        } finally {
            cleanupTestWorkspace();
        }
    });

    it('runUpdate should fail if invariants are violated after sync', () => {
        setupTestWorkspace();
        try {
            const installRunner = (opts: any) => {
                const targetBundle = path.join(opts.targetRoot, 'garda-agent-orchestrator');
                fs.rmSync(path.join(targetBundle, 'bin'), { recursive: true, force: true });
                fs.rmSync(path.join(targetBundle, 'dist'), { recursive: true, force: true });
                fs.writeFileSync(path.join(targetBundle, 'VERSION'), '2.0.0');
            };

            assert.throws(() => {
                runUpdate({
                    targetRoot: tmpDir,
                    bundleRoot: bundle, 
                    installRunner,
                    skipVerify: true,
                    skipManifestValidation: true
                });
            }, /Bundle invariant violation after update/);
        } finally {
            cleanupTestWorkspace();
        }
    });

    it('validateBundleInvariants should fail on partial runtime inventory', () => {
        setupTestWorkspace();
        try {
            fs.rmSync(path.join(bundle, 'live', 'config', 'paths.json'));
            const result = validateBundleInvariants(bundle);
            assert.equal(result.isValid, false);
            assert.ok(result.violations.some(v => v.includes('live/config/paths.json')));
        } finally {
            cleanupTestWorkspace();
        }
    });

    it('runReinit should fail if invariants are violated', () => {
        setupTestWorkspace();
        try {
            fs.rmSync(path.join(bundle, 'dist'), { recursive: true, force: true });
            assert.throws(() => {
                runReinit({
                    targetRoot: tmpDir,
                    bundleRoot: bundle,
                    skipVerify: true,
                    skipManifestValidation: true
                });
            }, /Bundle invariant violation after reinit/);
        } finally {
            cleanupTestWorkspace();
        }
    });
});
