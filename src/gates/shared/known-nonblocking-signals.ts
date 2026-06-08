export interface KnownNonBlockingSignal {
    id: string;
    source: 'project-memory' | 'reviewer-launch';
    action_required: false;
    summary: string;
}

export interface KnownNonBlockingProjectMemoryInput {
    evidence_status?: string | null;
    status?: string | null;
    update_needed?: boolean | null;
    compact_status?: string | null;
    compact_refreshed?: boolean | null;
}

export interface KnownNonBlockingCommandInput {
    command: string;
}

function normalizeToken(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

export function collectKnownNonBlockingSignals(input: {
    projectMemory?: KnownNonBlockingProjectMemoryInput | null;
    nextGate?: string | null;
    reason?: string | null;
    commands?: readonly KnownNonBlockingCommandInput[];
}): KnownNonBlockingSignal[] {
    const signals: KnownNonBlockingSignal[] = [];
    const projectMemory = input.projectMemory || null;
    const compactStatus = normalizeToken(projectMemory?.compact_status);
    const evidenceStatus = normalizeToken(projectMemory?.evidence_status);
    const impactStatus = normalizeToken(projectMemory?.status);
    if (
        compactStatus === 'UPDATED_OVERFLOW_NOT_REFRESHED'
        && evidenceStatus === 'CURRENT'
        && impactStatus === 'UPDATED'
    ) {
        signals.push({
            id: 'project_memory_updated_compact_overflow_accepted',
            source: 'project-memory',
            action_required: false,
            summary:
                'Project memory compact overflow is accepted because current update evidence is valid; ' +
                'this is advisory and not a new orchestrator defect.'
        });
    } else if (
        compactStatus === 'OVERFLOW_NON_BLOCKING_NO_UPDATE'
        && evidenceStatus === 'CURRENT'
        && impactStatus === 'NO_UPDATE_NEEDED'
    ) {
        signals.push({
            id: 'project_memory_no_update_compact_overflow_accepted',
            source: 'project-memory',
            action_required: false,
            summary:
                'Project memory compact overflow is non-blocking because this task does not require a memory update.'
        });
    } else if (
        compactStatus === 'REFRESHED_OVERFLOW_ACKNOWLEDGED'
        && evidenceStatus === 'CURRENT'
        && impactStatus === 'UPDATED'
    ) {
        signals.push({
            id: 'project_memory_refreshed_compact_overflow_acknowledged',
            source: 'project-memory',
            action_required: false,
            summary:
                'Project memory compact overflow remains after a valid refresh and is acknowledged by current evidence.'
        });
    }

    const reason = String(input.reason || '');
    if (/standby completion before launch input delivery/iu.test(reason)) {
        signals.push({
            id: 'reviewer_standby_resume_provider_handshake',
            source: 'reviewer-launch',
            action_required: false,
            summary:
                'Delegated reviewer standby completion before launch input delivery is normal provider handshake noise; ' +
                'resume the same session and do not report it as review evidence or a defect.'
        });
    }

    const commandText = (input.commands || []).map((entry) => entry.command).join('\n');
    if (/<provider-owned (?:invocation id|attestation source) from delegated reviewer launch result>/iu.test(commandText)) {
        signals.push({
            id: 'reviewer_provider_owned_placeholder_values',
            source: 'reviewer-launch',
            action_required: false,
            summary:
                'Provider-owned reviewer launch placeholders are external values to replace from the subagent launch result; ' +
                'the printed command is intentionally not allowed to invent them.'
        });
    }

    const seen = new Set<string>();
    return signals.filter((signal) => {
        if (seen.has(signal.id)) {
            return false;
        }
        seen.add(signal.id);
        return true;
    });
}

export function formatKnownNonBlockingSignals(signals: readonly KnownNonBlockingSignal[]): string | null {
    if (signals.length === 0) {
        return null;
    }
    const entries = signals
        .map((signal) => `${signal.id}(action_required=${signal.action_required})`)
        .join('; ');
    return `KnownNonBlockingSignals: ${entries}`;
}
