import type { ProtectedControlPlaneManifestEvidence } from '../gates/helpers';
import type { SourceBundleParityResult } from './workspace-layout';

export type ProtectedManifestAssessmentCode =
    | 'HEALTHY'
    | 'INFO_SOURCE_CHECKOUT'
    | 'INFO_TASK_CONTEXT_ALLOWED_DRIFT'
    | 'REPAIR_REQUIRED';

export interface ProtectedManifestAssessment {
    code: ProtectedManifestAssessmentCode;
    severity: 'pass' | 'warn' | 'fail';
    blocks: boolean;
    requires_refresh: boolean;
}

interface ProtectedManifestAssessmentOptions {
    evidence: ProtectedControlPlaneManifestEvidence | null;
    parityResult?: Pick<SourceBundleParityResult, 'isSourceCheckout'> | null;
    baselineAllowanceStatus?: string | null;
    orchestratorWork?: boolean;
    allowSourceCheckoutInfo?: boolean;
}

function isSourceCheckoutDrift(
    evidence: ProtectedControlPlaneManifestEvidence,
    parityResult?: Pick<SourceBundleParityResult, 'isSourceCheckout'> | null
): boolean {
    return evidence.status === 'DRIFT'
        && evidence.manifest?.is_source_checkout === true
        && parityResult?.isSourceCheckout === true;
}

export function assessProtectedManifest(
    options: ProtectedManifestAssessmentOptions
): ProtectedManifestAssessment | null {
    const evidence = options.evidence;
    if (!evidence) {
        return null;
    }

    if (evidence.status === 'MATCH' || evidence.status === 'MISSING') {
        return {
            code: 'HEALTHY',
            severity: 'pass',
            blocks: false,
            requires_refresh: false
        };
    }

    if (evidence.status === 'INVALID') {
        return {
            code: 'REPAIR_REQUIRED',
            severity: 'fail',
            blocks: true,
            requires_refresh: true
        };
    }

    const baselineAllowanceStatus = String(options.baselineAllowanceStatus || '').trim().toUpperCase();
    if (options.orchestratorWork === true || baselineAllowanceStatus === 'INHERITED_BASELINE_ONLY') {
        return {
            code: 'INFO_TASK_CONTEXT_ALLOWED_DRIFT',
            severity: 'warn',
            blocks: false,
            requires_refresh: false
        };
    }

    if (options.allowSourceCheckoutInfo === true && isSourceCheckoutDrift(evidence, options.parityResult)) {
        return {
            code: 'INFO_SOURCE_CHECKOUT',
            severity: 'warn',
            blocks: false,
            requires_refresh: false
        };
    }

    return {
        code: 'REPAIR_REQUIRED',
        severity: 'fail',
        blocks: true,
        requires_refresh: true
    };
}
