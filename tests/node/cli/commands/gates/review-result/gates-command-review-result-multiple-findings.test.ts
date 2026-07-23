import {
    describe,
    it,
    assert,
    fs,
    path,
    createTempRepo,
    runCliWithCapturedOutput,
    seedPromptBoundReviewFixture,
    attestReviewerInvocationForTest,
    buildFailedJsonReviewReport
} from './gates-command-review-result-fixtures';

describe('gates command review result - multiple findings', () => {
    it('record-review-result preserves multiple verdict-free JSON findings through validation, disposition, and receipt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-43-multiple-findings';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });

        try {
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const report = buildFailedJsonReviewReport(fixture.reviewContextPath, taskId);
            const context = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
                coverage_contract: { obligations: Array<{ id: string }> };
                task_scope: { changed_files: string[] };
            };
            const ledger = report.coverage_ledger as { entries: Array<{ finding_ids: string[] }> };
            const findings = report.findings as { medium: Array<Record<string, unknown>> };
            ledger.entries[0].finding_ids = ['F-001', 'F-002'];
            findings.medium = [{
                id: 'F-002',
                title: 'Second active finding',
                description: 'The second finding must survive findings-only ingestion.',
                evidence: [{
                    location: `${context.task_scope.changed_files[0]}:1`,
                    observation: 'The medium finding is bound to the authenticated changed file.'
                }],
                coverage_obligation_ids: [context.coverage_contract.obligations[0].id]
            }];
            const outputPath = path.join(
                repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'review-output.md'
            );
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
                '--preflight-path', fixture.preflightPath, '--review-output-path', outputPath,
                '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const readArtifact = (suffix: string) => JSON.parse(fs.readFileSync(
                path.join(fixture.reviewsRoot, `${taskId}-code-${suffix}.json`), 'utf8'
            ));
            const receipt = JSON.parse(fs.readFileSync(
                path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'
            ));
            const validation = readArtifact('findings-validation');
            const disposition = readArtifact('findings-disposition');
            assert.equal(validation.validation_result.normalized_inventory.finding_count, 2);
            assert.deepEqual(disposition.items.map((item: { id: string }) => item.id), ['F-001', 'F-002']);
            assert.deepEqual(receipt.review_findings_report.findings.high.map((item: { id: string }) => item.id), ['F-001']);
            assert.deepEqual(receipt.review_findings_report.findings.medium.map((item: { id: string }) => item.id), ['F-002']);
            assert.deepEqual(receipt.review_findings_summary.finding_ids_by_severity.high, ['F-001']);
            assert.deepEqual(receipt.review_findings_summary.finding_ids_by_severity.medium, ['F-002']);
            assert.equal(receipt.review_findings_summary.active_finding_count, 2);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
