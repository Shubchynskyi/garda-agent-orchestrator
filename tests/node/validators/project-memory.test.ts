import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { validateProjectMemoryBootstrap } from '../../../src/validators/project-memory';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../src/core/project-memory';

function findRepoRoot() {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

describe('validateProjectMemoryBootstrap', () => {
    it('detects missing required project-memory files with clear diagnostics', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-validator-missing-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'README.md'), '# Project Memory\n', 'utf8');

            const result = validateProjectMemoryBootstrap(pmDir, { mode: 'strict' });

            assert.equal(result.passed, false);
            assert.ok(result.missingFiles.includes('compact.md'));
            assert.ok(result.issues.some((issue) =>
                issue.code === 'required_file_missing'
                && issue.severity === 'error'
                && issue.message.includes('docs/project-memory/compact.md')
            ));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('warns on compact.md overflow in check mode and fails in strict mode', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-validator-overflow-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
                const body = fileName === 'compact.md'
                    ? `# Compact\n\n## Notes\n${'x'.repeat(200)}\n`
                    : `# ${fileName}\n\n## Notes\n- Durable fact.\n`;
                fs.writeFileSync(path.join(pmDir, fileName), body, 'utf8');
            }

            const checkResult = validateProjectMemoryBootstrap(pmDir, {
                mode: 'check',
                maxCompactSummaryChars: 80
            });
            assert.equal(checkResult.passed, true);
            assert.ok(checkResult.issues.some((issue) =>
                issue.code === 'compact_overflow'
                && issue.severity === 'warning'
            ));

            const strictResult = validateProjectMemoryBootstrap(pmDir, {
                mode: 'strict',
                maxCompactSummaryChars: 80
            });
            assert.equal(strictResult.passed, false);
            assert.ok(strictResult.issues.some((issue) =>
                issue.code === 'compact_overflow'
                && issue.severity === 'error'
            ));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('reports placeholder-heavy seeded memory without blocking check mode', () => {
        const repoRoot = findRepoRoot();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-validator-seed-'));
        try {
            const templateDir = path.join(repoRoot, 'template', 'docs', 'project-memory');
            const pmDir = path.join(tmpDir, 'project-memory');
            copyDirRecursive(templateDir, pmDir);

            const result = validateProjectMemoryBootstrap(pmDir, {
                mode: 'check',
                templateProjectMemoryDir: templateDir
            });

            assert.equal(result.passed, true);
            assert.equal(result.templateSeedFiles.length, PROJECT_MEMORY_REQUIRED_FILE_NAMES.length);
            assert.ok(result.issues.some((issue) =>
                issue.code === 'project_memory_placeholder_heavy'
                && issue.severity === 'warning'
            ));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
