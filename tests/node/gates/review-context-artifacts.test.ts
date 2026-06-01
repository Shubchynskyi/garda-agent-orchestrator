import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildReviewContextHandoffArtifactPaths,
    buildReviewEvidenceManifest,
    resolveReviewHandoffArtifactPath,
    type ReviewSkillBinding
} from '../../../src/gates/review-context-artifacts';
import type { GitDiffSummary } from '../../../src/gates/review-context-diff';

function sha256Text(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function sampleSelectedSkill(): ReviewSkillBinding {
    return {
        skill_id: 'code-review',
        skill_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
        skill_sha256: 'skill-sha',
        skill_directory_path: 'garda-agent-orchestrator/live/skills/code-review',
        skill_entrypoint_exists: true,
        candidate_skill_ids: ['code-review']
    };
}

function sampleGitDiff(): GitDiffSummary {
    return {
        stat: ' src/example.ts | 2 ++',
        diff: 'diff --git a/src/example.ts b/src/example.ts\n+const value = 1;\n',
        diff_truncated: false,
        diff_char_count: 64,
        command_status: 0,
        source: 'git',
        error: null,
        cache_path: 'garda-agent-orchestrator/runtime/reviews/T-001-code-scoped.diff',
        cached: false
    };
}

describe('gates/review-context-artifacts', () => {
    it('derives role, template, and manifest paths from canonical review-context output paths', () => {
        const outputPath = path.join(
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            'T-001-code-review-context.json'
        );

        assert.equal(
            resolveReviewHandoffArtifactPath(outputPath, '-role-prompt.md'),
            path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-role-prompt.md')
        );

        const paths = buildReviewContextHandoffArtifactPaths(outputPath);
        assert.deepEqual(paths, {
            ruleContextArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-review-context.md'),
            rolePromptArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-role-prompt.md'),
            promptTemplateArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-prompt-template.md'),
            outputTemplateArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-output-template.md'),
            evidenceManifestArtifactPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-evidence-manifest.json')
        });
    });

    it('derives handoff paths from non-canonical json output paths without changing the basename prefix', () => {
        const outputPath = path.join('tmp', 'custom-review-context-output.json');

        assert.equal(
            resolveReviewHandoffArtifactPath(outputPath, '-evidence-manifest.json'),
            path.join('tmp', 'custom-review-context-output-evidence-manifest.json')
        );
        assert.equal(
            buildReviewContextHandoffArtifactPaths(outputPath).ruleContextArtifactPath,
            path.join('tmp', 'custom-review-context-output.md')
        );
    });

    it('builds evidence manifest shape with normalized artifact paths and stable sha wiring', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-manifest-'));
        const outputPath = path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-review-context.json');
        const paths = buildReviewContextHandoffArtifactPaths(outputPath);
        const selectedSkill = sampleSelectedSkill();
        const gitDiff = sampleGitDiff();
        const diffCachePath = path.join(tempRoot, 'T-001-scoped-diff-summary.json');
        fs.writeFileSync(diffCachePath, JSON.stringify({ summary: { diff: gitDiff.diff } }, null, 2) + '\n', 'utf8');
        gitDiff.cache_path = diffCachePath;
        const taskEvidence = {
            task_intent: { summary: 'Add focused helper tests' },
            task_row: { id: 'T-001' },
            plan: null
        };

        const result = buildReviewEvidenceManifest({
            taskId: 'T-001',
            reviewType: 'code',
            outputPath,
            paths,
            promptArtifactSha256: 'prompt-sha',
            rolePromptArtifactSha256: 'role-sha',
            promptTemplateArtifactSha256: 'prompt-template-sha',
            outputTemplateArtifactSha256: 'output-template-sha',
            selectedSkill,
            preflightPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-preflight.json'),
            preflightSha256: 'preflight-sha',
            scopedDiffExpected: true,
            scopedDiffMetadataPath: path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-scoped.json'),
            scopedDiffMetadataSha256: 'scoped-sha',
            gitDiff,
            compileGateEvidence: { status: 'PASSED' },
            fullSuiteValidationEvidence: { status: 'PASSED' },
            taskEvidence
        });

        assert.equal(result.evidenceManifest.schema_version, 1);
        assert.equal(result.evidenceManifest.task_id, 'T-001');
        assert.equal(result.evidenceManifest.review_type, 'code');
        assert.equal(result.evidenceManifest.selected_skill, selectedSkill);
        assert.equal(result.evidenceManifest.task_evidence, taskEvidence);

        const artifacts = result.evidenceManifest.artifacts as Record<string, Record<string, unknown>>;
        assert.equal(artifacts.review_context.artifact_path, outputPath.replace(/\\/g, '/'));
        assert.equal(artifacts.reviewer_prompt.artifact_path, paths.ruleContextArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.reviewer_prompt.artifact_sha256, 'prompt-sha');
        assert.equal(artifacts.role_prompt.artifact_path, paths.rolePromptArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.role_prompt.artifact_sha256, 'role-sha');
        assert.equal(artifacts.role_prompt.selected_skill, selectedSkill);
        assert.equal(artifacts.prompt_template.artifact_path, paths.promptTemplateArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.prompt_template.artifact_sha256, 'prompt-template-sha');
        assert.equal(artifacts.output_template.artifact_path, paths.outputTemplateArtifactPath.replace(/\\/g, '/'));
        assert.equal(artifacts.output_template.artifact_sha256, 'output-template-sha');
        assert.equal(artifacts.preflight.artifact_sha256, 'preflight-sha');
        assert.equal(artifacts.scoped_diff.expected, true);
        assert.equal(artifacts.scoped_diff.diff_cache_path, gitDiff.cache_path);
        assert.equal(artifacts.scoped_diff.diff_cache_artifact_sha256, sha256Text(fs.readFileSync(diffCachePath, 'utf8')));
        assert.equal(artifacts.scoped_diff.diff_content_sha256, sha256Text(gitDiff.diff || ''));
        assert.equal(artifacts.scoped_diff.diff_sha256, sha256Text(gitDiff.diff || ''));
        assert.deepEqual(artifacts.compile_gate, { status: 'PASSED' });
        assert.deepEqual(artifacts.full_suite_validation, { status: 'PASSED' });

        assert.ok(result.evidenceManifestText.endsWith('\n'));
        assert.equal(result.evidenceManifestSha256, sha256Text(result.evidenceManifestText));
        assert.deepEqual(JSON.parse(result.evidenceManifestText), result.evidenceManifest);
    });
});
