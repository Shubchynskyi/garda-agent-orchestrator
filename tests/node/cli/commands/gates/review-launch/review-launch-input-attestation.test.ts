import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    buildReviewerLaunchBindingSha256,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    stringSha256
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';

let tempRoots: string[] = [];

afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-launch-input-'));
    tempRoots.push(repoRoot);
    return repoRoot;
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makePreparedLaunchArtifact(repoRoot: string, options: { copyPastePrompt?: string } = {}): {
    launchArtifactPath: string;
    inputArtifactPath: string;
    preparedArtifact: Record<string, unknown>;
    preparedArtifactSha256: string;
    copyPastePromptSha256: string;
} {
    const launchArtifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'tmp',
        'reviews',
        'T-INPUT',
        'code',
        'reviewer-launch.json'
    );
    const inputArtifactPath = resolveReviewerLaunchInputArtifactPath(launchArtifactPath);
    const copyPastePrompt = options.copyPastePrompt || 'Launch this exact delegated reviewer prompt.';
    const copyPastePromptSha256 = stringSha256(copyPastePrompt);
    const preparedArtifact = {
        evidence_type: 'delegated_reviewer_launch_preparation',
        attestation_state: 'prepared',
        task_id: 'T-INPUT',
        review_type: 'code',
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        reviewer_launch_input_artifact_path: inputArtifactPath
    };
    writeJson(launchArtifactPath, preparedArtifact);
    writeJson(inputArtifactPath, preparedArtifact);
    return {
        launchArtifactPath,
        inputArtifactPath,
        preparedArtifact,
        preparedArtifactSha256: fileSha256(launchArtifactPath),
        copyPastePromptSha256
    };
}

describe('review launch input attestation helpers', () => {
    it('builds stable reviewer launch binding hashes from current routing fields', () => {
        const actual = buildReviewerLaunchBindingSha256({
            taskId: 'T-INPUT',
            reviewType: 'code',
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity: 'agent:reviewer',
            reviewContextSha256: 'a'.repeat(64),
            routingEventSha256: 'b'.repeat(64),
            reviewerPromptSha256: 'c'.repeat(64)
        });

        assert.equal(
            actual,
            stringSha256([
                'task_id=T-INPUT',
                'review_type=code',
                'reviewer_execution_mode=delegated_subagent',
                'reviewer_identity=agent:reviewer',
                `review_context_sha256=${'a'.repeat(64)}`,
                `routing_event_sha256=${'b'.repeat(64)}`,
                `reviewer_prompt_sha256=${'c'.repeat(64)}`
            ].join('\n'))
        );
    });

    it('accepts exact copy-paste prompt launch input evidence', () => {
        const repoRoot = makeTempRepo();
        const prepared = makePreparedLaunchArtifact(repoRoot);

        const attestation = resolveReviewerLaunchInputAttestation({
            repoRoot,
            launchArtifactPath: prepared.launchArtifactPath,
            preparedArtifact: prepared.preparedArtifact,
            preparedLaunchArtifactSha256: prepared.preparedArtifactSha256,
            rawMode: 'copy_paste_prompt',
            rawSha256: prepared.copyPastePromptSha256,
            rawArtifactPath: ''
        });

        assert.equal(attestation.mode, 'copy_paste_prompt');
        assert.equal(attestation.sha256, prepared.copyPastePromptSha256);
        assert.equal(attestation.copyPasteReviewerLaunchPromptSha256, prepared.copyPastePromptSha256);
        assert.equal(attestation.artifactPath, null);
    });

    it('accepts immutable reviewer-launch-input artifact path evidence', () => {
        const repoRoot = makeTempRepo();
        const prepared = makePreparedLaunchArtifact(repoRoot);

        const attestation = resolveReviewerLaunchInputAttestation({
            repoRoot,
            launchArtifactPath: prepared.launchArtifactPath,
            preparedArtifact: prepared.preparedArtifact,
            preparedLaunchArtifactSha256: prepared.preparedArtifactSha256,
            rawMode: 'launch_artifact_path',
            rawSha256: prepared.preparedArtifactSha256,
            rawArtifactPath: path.relative(repoRoot, prepared.inputArtifactPath)
        });

        assert.equal(attestation.mode, 'launch_artifact_path');
        assert.equal(attestation.sha256, prepared.preparedArtifactSha256);
        assert.equal(attestation.artifactPath, prepared.inputArtifactPath);
        assert.equal(attestation.artifactSha256, prepared.preparedArtifactSha256);
    });

    it('rejects mismatched launch input hashes before launch completion', () => {
        const repoRoot = makeTempRepo();
        const prepared = makePreparedLaunchArtifact(repoRoot);

        assert.throws(
            () => resolveReviewerLaunchInputAttestation({
                repoRoot,
                launchArtifactPath: prepared.launchArtifactPath,
                preparedArtifact: prepared.preparedArtifact,
                preparedLaunchArtifactSha256: prepared.preparedArtifactSha256,
                rawMode: 'copy_paste_prompt',
                rawSha256: 'd'.repeat(64),
                rawArtifactPath: ''
            }),
            /launch_input_sha256 must match copy_paste_reviewer_launch_prompt_sha256/
        );
    });
});
