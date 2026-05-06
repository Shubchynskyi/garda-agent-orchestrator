#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();
const canonicalPath = path.join(repoRoot, 'template', 'entrypoints', 'canonical-rule-index.md');
const legacyClaudePath = path.join(repoRoot, 'template', 'CLAUDE.md');

function buildLegacyClaudeContent() {
  if (!fs.existsSync(canonicalPath)) {
    throw new Error(`Canonical rule-index template not found: ${canonicalPath}`);
  }
  return fs.readFileSync(canonicalPath, 'utf8').replace(/^# .+$/m, '# CLAUDE.md');
}

function createLegacyClaudeTemplate() {
  const content = buildLegacyClaudeContent();
  fs.mkdirSync(path.dirname(legacyClaudePath), { recursive: true });
  if (fs.existsSync(legacyClaudePath)) {
    const existing = fs.readFileSync(legacyClaudePath, 'utf8');
    if (existing !== content) {
      throw new Error(`Refusing to overwrite unexpected legacy template: ${legacyClaudePath}`);
    }
  }
  fs.writeFileSync(legacyClaudePath, content, 'utf8');
  console.log(`Generated legacy package compatibility template: ${path.relative(repoRoot, legacyClaudePath)}`);
}

function removeLegacyClaudeTemplate() {
  if (!fs.existsSync(legacyClaudePath)) {
    return;
  }
  const expected = buildLegacyClaudeContent();
  const existing = fs.readFileSync(legacyClaudePath, 'utf8');
  if (existing !== expected) {
    console.warn(`Leaving unexpected legacy template in place: ${legacyClaudePath}`);
    return;
  }
  fs.rmSync(legacyClaudePath);
  console.log(`Removed legacy package compatibility template: ${path.relative(repoRoot, legacyClaudePath)}`);
}

const action = process.argv[2] || '';
if (action === 'create') {
  createLegacyClaudeTemplate();
} else if (action === 'remove') {
  removeLegacyClaudeTemplate();
} else {
  console.error('Usage: node scripts/package-legacy-entrypoint-compat.cjs <create|remove>');
  process.exit(2);
}
