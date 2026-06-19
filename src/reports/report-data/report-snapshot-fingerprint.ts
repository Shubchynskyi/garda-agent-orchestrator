import * as path from 'node:path';
import { getBackupSnapshotsRoot } from '../../lifecycle/backups';
import { statFingerprint } from './shared';

export function buildReportSnapshotFingerprint(repoRoot: string): string {
    const resolvedRoot = path.resolve(repoRoot);
    return [
        statFingerprint(path.join(resolvedRoot, 'TASK.md')),
        statFingerprint(path.join(resolvedRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json')),
        statFingerprint(path.join(resolvedRoot, 'garda-agent-orchestrator', 'runtime', 'workflow-config-audit.jsonl')),
        statFingerprint(path.join(resolvedRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json')),
        statFingerprint(path.join(resolvedRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json')),
        statFingerprint(path.join(resolvedRoot, 'garda-agent-orchestrator', 'runtime', 'agent-init-state.json')),
        statFingerprint(getBackupSnapshotsRoot(resolvedRoot))
    ].join('|');
}
