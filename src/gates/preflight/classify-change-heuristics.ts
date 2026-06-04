export interface RefactorHeuristicInput {
    runtimeChanged: boolean;
    normalizedFilesCount: number;
    renameCount: number;
    additionsTotal: number;
    deletionsTotal: number;
    runtimeCodeLikeCount: number;
    dbTriggered: boolean;
    securityTriggered: boolean;
}

export function buildRefactorHeuristicReasons(input: RefactorHeuristicInput): string[] {
    const refactorHeuristicReasons: string[] = [];
    if (!input.runtimeChanged || input.normalizedFilesCount <= 0) {
        return refactorHeuristicReasons;
    }

    const renameRatio = Math.round((input.renameCount / input.normalizedFilesCount) * 10000) / 10000;
    if (input.normalizedFilesCount >= 2 && renameRatio >= 0.4) {
        refactorHeuristicReasons.push('rename_ratio_high');
    }

    const totalChurn = input.additionsTotal + input.deletionsTotal;
    const deltaBalanceThreshold = Math.max(20, Math.floor(totalChurn * 0.15));
    const balancedChurn = Math.abs(input.additionsTotal - input.deletionsTotal) <= deltaBalanceThreshold;
    if (input.runtimeCodeLikeCount >= 3 && totalChurn >= 80 && balancedChurn && !input.dbTriggered && !input.securityTriggered) {
        refactorHeuristicReasons.push('balanced_structural_churn');
    }

    return refactorHeuristicReasons;
}

export interface PerformanceHeuristicInput {
    performancePathTriggered: boolean;
    apiTriggered: boolean;
    dbTriggered: boolean;
    runtimeCodeChanged: boolean;
    onlySqlOrMigration: boolean;
    changedLinesTotal: number;
    performanceHeuristicMinLines: number;
}

export function isPerformanceHeuristicTriggered(input: PerformanceHeuristicInput): boolean {
    return (
        !input.performancePathTriggered
        && (input.apiTriggered || (input.dbTriggered && input.runtimeCodeChanged))
        && !input.onlySqlOrMigration
        && input.changedLinesTotal >= input.performanceHeuristicMinLines
    );
}
