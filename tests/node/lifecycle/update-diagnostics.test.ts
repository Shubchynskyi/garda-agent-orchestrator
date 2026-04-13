import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyGitDiagnostic,
    classifyNpmDiagnostic,
    createLifecycleDiagnosticError,
    normalizeDiagnosticText
} from '../../../src/lifecycle/update-diagnostics';

describe('classifyGitDiagnostic', () => {
    it('classifies missing refs', () => {
        assert.equal(
            classifyGitDiagnostic("fatal: couldn't find remote ref missing-branch"),
            'GIT_REF_NOT_FOUND'
        );
    });

    it('classifies auth failures', () => {
        assert.equal(
            classifyGitDiagnostic('fatal: Authentication failed for https://example.com/repo.git'),
            'GIT_AUTH_FAILURE'
        );
    });

    it('classifies repository-not-found failures', () => {
        assert.equal(
            classifyGitDiagnostic('remote: Repository not found. fatal: repository not found'),
            'GIT_REPOSITORY_NOT_FOUND'
        );
    });

    it('classifies network failures', () => {
        assert.equal(
            classifyGitDiagnostic('fatal: unable to access https://example.com/repo.git: Could not resolve host: example.com'),
            'GIT_NETWORK_FAILURE'
        );
    });
});

describe('classifyNpmDiagnostic', () => {
    it('classifies package-not-found failures', () => {
        assert.equal(
            classifyNpmDiagnostic('npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/missing-package'),
            'NPM_PACKAGE_NOT_FOUND'
        );
    });

    it('classifies auth failures', () => {
        assert.equal(
            classifyNpmDiagnostic('npm ERR! code E401\nnpm ERR! Unable to authenticate, need: Bearer authorization'),
            'NPM_AUTH_FAILURE'
        );
    });

    it('classifies network failures', () => {
        assert.equal(
            classifyNpmDiagnostic('npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org failed'),
            'NPM_NETWORK_FAILURE'
        );
    });
});

describe('createLifecycleDiagnosticError', () => {
    it('formats deterministic diagnostic fields and stream blocks', () => {
        const error = createLifecycleDiagnosticError({
            message: 'Failed to clone git update source.',
            tool: 'git',
            code: 'GIT_REF_NOT_FOUND',
            sourceReference: 'https://example.com/repo.git#missing',
            stderr: 'fatal: could not find remote branch missing',
            stdout: ''
        });

        assert.match((error as Error).message, /DiagnosticTool: git/);
        assert.match((error as Error).message, /DiagnosticCode: GIT_REF_NOT_FOUND/);
        assert.match((error as Error).message, /DiagnosticSource: https:\/\/example\.com\/repo\.git#missing/);
        assert.match((error as Error).message, /DiagnosticHint:/);
        assert.match((error as Error).message, /DiagnosticStderr:/);
        assert.equal(error.diagnosticCode, 'GIT_REF_NOT_FOUND');
    });

    it('truncates oversized diagnostic text deterministically', () => {
        const largeText = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join('\n');
        const normalized = normalizeDiagnosticText(largeText);
        assert.match(normalized, /\.\.\.\[truncated\]$/);
        assert.ok(normalized.split('\n').length <= 41);
    });
});
