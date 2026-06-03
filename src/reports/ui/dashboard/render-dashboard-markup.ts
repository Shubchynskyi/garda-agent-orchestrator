import { UI_DASHBOARD_MARKUP } from './dashboard-markup';
import type { LocalUiTextKey } from '../ui-i18n';

const NOTICE_PLACEHOLDER = '${actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled}';

function applyTextPlaceholders(markup: string, text: Readonly<Record<LocalUiTextKey, string>>): string {
    return markup.replace(/\$\{text\.([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
        const value = text[key as LocalUiTextKey];
        return value === undefined || value === null ? '' : String(value);
    });
}

/** Static dashboard body markup with initial i18n strings applied. */
export function renderDashboardBodyMarkup(text: Readonly<Record<LocalUiTextKey, string>>, actionsEnabled: boolean): string {
    const notice = actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled;
    const withNotice = UI_DASHBOARD_MARKUP.replace(NOTICE_PLACEHOLDER, notice);
    return applyTextPlaceholders(withNotice, text);
}

/** Task plan modal shell with initial i18n strings applied. */
export function renderDashboardPlanModalMarkup(text: Readonly<Record<LocalUiTextKey, string>>): string {
    return `<div class="modal-backdrop" id="plan-modal" hidden>
<section class="modal" role="dialog" aria-modal="true" aria-labelledby="plan-modal-title">
<div class="modal-head"><h2 id="plan-modal-title" data-i18n="taskPlanTitle">${text.taskPlanTitle}</h2><button type="button" id="plan-modal-close" data-i18n="close">${text.close}</button></div>
<div class="modal-body" id="plan-modal-body"></div>
</section>
</div>`;
}
