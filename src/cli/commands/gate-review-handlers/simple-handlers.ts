import {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from '../gates';
import {
    parseOptions
} from '../cli-helpers';

export async function handleRequiredReviewsCheck(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--code-review-verdict': { key: 'codeReviewVerdict', type: 'string' },
        '--db-review-verdict': { key: 'dbReviewVerdict', type: 'string' },
        '--security-review-verdict': { key: 'securityReviewVerdict', type: 'string' },
        '--refactor-review-verdict': { key: 'refactorReviewVerdict', type: 'string' },
        '--api-review-verdict': { key: 'apiReviewVerdict', type: 'string' },
        '--test-review-verdict': { key: 'testReviewVerdict', type: 'string' },
        '--performance-review-verdict': { key: 'performanceReviewVerdict', type: 'string' },
        '--infra-review-verdict': { key: 'infraReviewVerdict', type: 'string' },
        '--dependency-review-verdict': { key: 'dependencyReviewVerdict', type: 'string' },
        '--skip-reviews': { key: 'skipReviews', type: 'string' },
        '--skip-reason': { key: 'skipReason', type: 'string' },
        '--override-artifact-path': { key: 'overrideArtifactPath', type: 'string' },
        '--compile-evidence-path': { key: 'compileEvidencePath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--review-evidence-path': { key: 'reviewEvidencePath', type: 'string' },
        '--no-op-artifact-path': { key: 'noOpArtifactPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runRequiredReviewsCheckCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleDocImpactGate(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--behavior-changed': { key: 'behaviorChanged', type: 'boolean' },
        '--docs-updated': { key: 'docsUpdated', type: 'string[]' },
        '--changelog-updated': { key: 'changelogUpdated', type: 'boolean' },
        '--internal-changelog-updated': { key: 'internalChangelogUpdated', type: 'boolean' },
        '--project-memory-updated': { key: 'projectMemoryUpdated', type: 'boolean' },
        '--sensitive-scope-reviewed': { key: 'sensitiveScopeReviewed', type: 'boolean' },
        '--sensitive-reviewed': { key: 'sensitiveReviewed', type: 'boolean' },
        '--rationale': { key: 'rationale', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runDocImpactGateCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}
