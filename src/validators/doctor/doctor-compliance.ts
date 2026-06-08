import {
    scanProviderCompliance,
    type ProviderComplianceResult
} from '../provider-compliance';
import {
    detectNestedBundleDuplication,
    type NestedBundleDuplicationResult
} from '../workspace-layout';

export interface ComplianceEvidence {
    providerComplianceResult: ProviderComplianceResult | null;
    nestedBundleDuplication: NestedBundleDuplicationResult;
}

export function collectComplianceEvidence(
    targetRoot: string,
    activeAgentFiles: readonly string[]
): ComplianceEvidence {
    let providerComplianceResult: ProviderComplianceResult | null = null;
    if (activeAgentFiles.length > 0) {
        try {
            providerComplianceResult = scanProviderCompliance(targetRoot, activeAgentFiles);
        } catch {
            // compliance scan failure is non-fatal; will show as null in output
        }
    }

    const nestedBundleDuplication = detectNestedBundleDuplication(targetRoot);

    return { providerComplianceResult, nestedBundleDuplication };
}
