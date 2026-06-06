import { createHash } from 'node:crypto';

import { formatJson } from '../core/json';
import type { SkillsHeadlinesPayload } from './skill-headlines-types';

export function computeSha256FromText(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function computePayloadSha256(payload: SkillsHeadlinesPayload): string {
    return computeSha256FromText(formatJson(payload));
}

export function computeSkillsHeadlinesSelectionSurfaceSha256(payload: Pick<
    SkillsHeadlinesPayload,
    'installed_pack_ids' | 'baseline_skill_ids' | 'installed_optional_skill_ids' | 'custom_skill_ids' | 'skills' | 'optional_packs'
>): string {
    return computeSha256FromText(formatJson({
        installed_pack_ids: payload.installed_pack_ids,
        baseline_skill_ids: payload.baseline_skill_ids,
        installed_optional_skill_ids: payload.installed_optional_skill_ids,
        custom_skill_ids: payload.custom_skill_ids,
        skills: payload.skills,
        optional_packs: payload.optional_packs
    }));
}
