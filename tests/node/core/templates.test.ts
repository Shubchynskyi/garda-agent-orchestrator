import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildEffectiveMessageTemplate,
    ensureMessageTemplateUserOverride,
    listTemplateTokens,
    replaceTemplateTokens,
    resetMessageTemplateUserOverride,
    validateEffectiveMessageTemplates
} from '../../../src/core/templates';

test('listTemplateTokens returns unique placeholders in encounter order', () => {
    assert.deepEqual(
        listTemplateTokens('Hello {{NAME}} and {{PLACE}} then {{NAME}} again'),
        ['NAME', 'PLACE']
    );
});

test('replaceTemplateTokens only replaces placeholders that were provided', () => {
    assert.equal(
        replaceTemplateTokens('Hello {{NAME}} from {{PLACE}} / {{UNKNOWN}}', {
            NAME: 'Garda',
            PLACE: 'Node'
        }),
        'Hello Garda from Node / {{UNKNOWN}}'
    );
});

function makeTemplateBundle(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-templates-core-'));
    fs.mkdirSync(path.join(root, 'template', 'templates'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'template', 'templates', 'final-report.md'),
        [
            '# Built in',
            '',
            '<!-- garda:protected-start gate-status -->',
            'Gate status: {{GATE_STATUS}}',
            'Task: {{TASK_ID}}',
            '<!-- garda:protected-end gate-status -->',
            '',
            '<!-- garda:protected-start review-integrity -->',
            'Review integrity: {{REVIEW_INTEGRITY}}',
            '<!-- garda:protected-end review-integrity -->',
            '',
            '<!-- garda:protected-start fake-fallback-review-attestation -->',
            'Fake/fallback/same-agent review artifacts: {{FAKE_FALLBACK_REVIEW_ARTIFACTS}}',
            '<!-- garda:protected-end fake-fallback-review-attestation -->',
            '',
            '<!-- garda:protected-start commit-decision -->',
            'Commit decision: {{COMMIT_DECISION}}',
            '<!-- garda:protected-end commit-decision -->',
            '',
            '<!-- garda:protected-start artifact-references -->',
            'Artifacts: {{ARTIFACT_REFERENCES}}',
            '<!-- garda:protected-end artifact-references -->',
            ''
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(root, 'template', 'templates', 'commit-message.json'),
        JSON.stringify({
            style: 'conventional',
            template: '{{TYPE}}({{SCOPE}}): {{SUMMARY}}',
            protected_required_placeholders: ['TYPE', 'SCOPE', 'SUMMARY'],
            protected_commit_policy: {
                requires_human_confirmation: true,
                auto_commit_allowed: false
            }
        }, null, 2) + '\n',
        'utf8'
    );
    fs.writeFileSync(
        path.join(root, 'template', 'templates', 'reviewer-prompt.md'),
        [
            '# Built in',
            '<!-- garda:protected-start review-context -->',
            '{{REVIEW_TYPE}} {{REVIEW_CONTEXT_PATH}}',
            '<!-- garda:protected-end review-context -->',
            '<!-- garda:protected-start verdict-contract -->',
            '{{PASS_TOKEN}} {{FAIL_TOKEN}}',
            '<!-- garda:protected-end verdict-contract -->',
            '<!-- garda:protected-start review-integrity -->',
            '{{REVIEW_INTEGRITY}}',
            '<!-- garda:protected-end review-integrity -->',
            ''
        ].join('\n'),
        'utf8'
    );
    return root;
}

test('buildEffectiveMessageTemplate merges user wording with protected final-report sections', () => {
    const root = makeTemplateBundle();
    try {
        ensureMessageTemplateUserOverride(root, 'final-report');
        const userPath = path.join(root, 'live', 'templates', 'final-report.user.md');
        fs.writeFileSync(userPath, '# My wording\n\nOptional closeout note with {{TASK_ID}}.\n', 'utf8');

        const template = buildEffectiveMessageTemplate(root, 'final-report');

        assert.equal(template.validation_status, 'PASS');
        assert.equal(template.user_override_exists, true);
        assert.ok(template.effective_content.includes('# My wording'));
        assert.ok(template.effective_content.includes('<!-- garda:protected-start review-integrity -->'));
        assert.ok(template.effective_content.includes('{{FAKE_FALLBACK_REVIEW_ARTIFACTS}}'));
        assert.ok(template.effective_content.includes('{{COMMIT_DECISION}}'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validateEffectiveMessageTemplates fails when commit override removes a required placeholder', () => {
    const root = makeTemplateBundle();
    try {
        ensureMessageTemplateUserOverride(root, 'commit-message');
        fs.writeFileSync(
            path.join(root, 'live', 'templates', 'commit-message.user.json'),
            JSON.stringify({ template: '{{TYPE}}: missing scope and summary' }, null, 2) + '\n',
            'utf8'
        );

        const result = validateEffectiveMessageTemplates(root, 'commit-message');

        assert.equal(result.passed, false);
        assert.ok(result.issues.some((issue) => issue.code === 'required_placeholder_missing'));
        assert.ok(result.issues.some((issue) => issue.message.includes('{{SCOPE}}')));
        assert.ok(result.issues.some((issue) => issue.message.includes('{{SUMMARY}}')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validateEffectiveMessageTemplates rejects commit placeholders moved outside template string', () => {
    const root = makeTemplateBundle();
    try {
        ensureMessageTemplateUserOverride(root, 'commit-message');
        fs.writeFileSync(
            path.join(root, 'live', 'templates', 'commit-message.user.json'),
            JSON.stringify({
                template: 'docs: no machine placeholders here',
                note: '{{TYPE}} {{SCOPE}} {{SUMMARY}}'
            }, null, 2) + '\n',
            'utf8'
        );

        const result = validateEffectiveMessageTemplates(root, 'commit-message');

        assert.equal(result.passed, false);
        assert.ok(result.issues.some((issue) => issue.code === 'commit_message_template_placeholder_missing'));
        assert.ok(result.issues.some((issue) => issue.message.includes('{{TYPE}}')));
        assert.ok(result.issues.some((issue) => issue.message.includes('{{SCOPE}}')));
        assert.ok(result.issues.some((issue) => issue.message.includes('{{SUMMARY}}')));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validateEffectiveMessageTemplates rejects user-owned protected section edits', () => {
    const root = makeTemplateBundle();
    try {
        ensureMessageTemplateUserOverride(root, 'final-report');
        fs.writeFileSync(
            path.join(root, 'live', 'templates', 'final-report.user.md'),
            [
                '# Bad override',
                '<!-- garda:protected-start review-integrity -->',
                'Hidden',
                '<!-- garda:protected-end review-integrity -->',
                ''
            ].join('\n'),
            'utf8'
        );

        const result = validateEffectiveMessageTemplates(root, 'final-report');

        assert.equal(result.passed, false);
        assert.ok(result.issues.some((issue) => issue.code === 'user_override_protected_section'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('validateEffectiveMessageTemplates rejects auto-commit wording in overrides', () => {
    const root = makeTemplateBundle();
    try {
        ensureMessageTemplateUserOverride(root, 'final-report');
        fs.writeFileSync(
            path.join(root, 'live', 'templates', 'final-report.user.md'),
            '# Bad override\n\nRun git commit automatically after this report.\n',
            'utf8'
        );

        const result = validateEffectiveMessageTemplates(root, 'final-report');

        assert.equal(result.passed, false);
        assert.ok(result.issues.some((issue) => issue.code === 'auto_commit_instruction_forbidden'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resetMessageTemplateUserOverride removes only the user override', () => {
    const root = makeTemplateBundle();
    try {
        ensureMessageTemplateUserOverride(root, 'reviewer-prompt');
        const reset = resetMessageTemplateUserOverride(root, 'reviewer-prompt');
        const template = buildEffectiveMessageTemplate(root, 'reviewer-prompt');

        assert.equal(reset.removed, true);
        assert.equal(template.user_override_exists, false);
        assert.equal(template.validation_status, 'PASS');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
