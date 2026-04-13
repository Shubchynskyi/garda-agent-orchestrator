#!/usr/bin/env node
/**
 * CI-friendly config validation script.
 *
 * Usage:
 *   node scripts/validate-config.cjs [--bundle-root <path>]
 *
 * Exits 0 on success, 1 on validation failure.
 * Designed for use in GitHub Actions or local pre-commit hooks.
 */

'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let bundleRoot = path.resolve(repoRoot, 'garda-agent-orchestrator');

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle-root' && args[i + 1]) {
        bundleRoot = path.resolve(args[i + 1]);
        i++;
    }
}

const cliPath = path.join(repoRoot, 'bin', 'garda.js');
const executionCwd = fs.existsSync(bundleRoot) && fs.statSync(bundleRoot).isDirectory()
    ? bundleRoot
    : repoRoot;

try {
    const output = execSync(
        `node ${JSON.stringify(cliPath)} gate validate-config --bundle-root ${JSON.stringify(bundleRoot)} --compact`,
        { cwd: executionCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    process.stdout.write(output);
    process.exit(0);
} catch (err) {
    if (err.stdout) {
        process.stdout.write(err.stdout);
    }
    if (err.stderr) {
        process.stderr.write(err.stderr);
    }
    process.exit(1);
}
