/** Static dashboard body markup; placeholders are filled at render time. */
export const UI_DASHBOARD_MARKUP = `<header>
<div class="header-row">
<div>
<h1 data-i18n="appTitle">\${text.appTitle}</h1>
<div class="meta" id="meta" data-i18n="loadingWorkspaceReport">\${text.loadingWorkspaceReport}</div>
</div>
<div class="top-controls" id="top-controls">
<label class="language-compact"><span class="language-icon" aria-hidden="true">&#127760;</span><span class="visually-hidden" data-i18n="languageTitle">\${text.languageTitle}</span><select id="language-select" data-i18n-aria-label="languageTitle"></select></label>
</div>
</div>
</header>
<nav>
<div class="tab-buttons">
<button type="button" class="active" data-tab="tasks-tab" data-i18n="tasksTab">\${text.tasksTab}</button>
<button type="button" data-tab="workflow-tab" data-i18n="workflowTab">\${text.workflowTab}</button>
<button type="button" data-tab="init-settings-tab" data-i18n="initSettingsTab">\${text.initSettingsTab}</button>
<button type="button" data-tab="project-memory-tab" data-i18n="projectMemoryTab">\${text.projectMemoryTab}</button>
<button type="button" data-tab="backups-tab" data-i18n="backupsTab">\${text.backupsTab}</button>
<button type="button" data-tab="cleanup-settings-tab" data-i18n="cleanupSettingsTab">\${text.cleanupSettingsTab}</button>
<button type="button" data-tab="instructions-tab" data-i18n="instructionsTab">\${text.instructionsTab}</button>
</div>
<div class="session-compact" id="server-status-panel">
<div class="session-status-line" id="session-summary" data-i18n="loadingServerSession">\${text.loadingServerSession}</div>
<input id="session-countdown" type="range" min="0" max="60" value="60" disabled hidden>
<div class="session-action-row">
<button type="button" id="session-activity" data-i18n="iAmHere">\${text.iAmHere}</button>
<button type="button" id="session-shutdown" data-i18n="stopServer">\${text.stopServer}</button>
</div>
</div>
</nav>
<main>
<section class="notice" id="ui-notice">\${actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled}</section>
<section class="warnings" id="warnings" hidden></section>
<section class="switch-strip" id="garda-switch-panel" hidden></section>
<section class="action-status empty" id="action-status"></section>
<div id="actions" hidden></div>
<section class="tab" id="tasks-tab">
<div class="overview" id="overview"></div>
<div class="tasks-layout">
<section class="panel task-list-panel">
<div class="panel-head"><h2 data-i18n="tasksTab">\${text.tasksTab}</h2></div>
<div class="panel-head">
<div class="toolbar">
<input id="task-search" type="search" placeholder="\${text.searchTasks}" data-i18n-placeholder="searchTasks">
<select id="status-filter"><option value="">\${text.allStatuses}</option></select>
<select id="priority-filter"><option value="">\${text.allPriorities}</option></select>
</div>
</div>
<div class="table-wrap">
<table>
<thead><tr><th data-i18n="idColumn">\${text.idColumn}</th><th data-i18n="statusColumn">\${text.statusColumn}</th><th data-i18n="priorityColumn">\${text.priorityColumn}</th><th data-i18n="areaColumn">\${text.areaColumn}</th><th data-i18n="titleColumn">\${text.titleColumn}</th><th data-i18n="dataColumn">\${text.dataColumn}</th><th data-i18n="actionColumn">\${text.actionColumn}</th></tr></thead>
<tbody id="tasks"><tr><td colspan="7" class="empty" data-i18n="loading">\${text.loading}</td></tr></tbody>
</table>
</div>
</section>
<section class="panel task-detail-panel" id="task-detail-panel">
<div class="panel-head"><h2 data-i18n="taskDetailTitle">\${text.taskDetailTitle}</h2></div>
<div class="detail" id="detail"><p class="empty" data-i18n="chooseTask">\${text.chooseTask}</p></div>
</section>
</div>
</section>
<section class="panel tab" id="workflow-tab" hidden>
<div class="panel-head workflow-head"><h2 data-i18n="workflowTab">\${text.workflowTab}</h2><span class="config-path" id="workflow-config-path"></span></div>
<div class="workflow-top-grid">
<div class="detail" id="workflow"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
<div class="detail setting-status" id="setting-status"></div>
</div>
<div class="detail" id="settings-editor"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
<section class="panel tab" id="init-settings-tab" hidden>
<div class="panel-head"><h2 data-i18n="initSettingsTab">\${text.initSettingsTab}</h2></div>
<div class="detail" id="init-settings"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
<section class="panel tab" id="project-memory-tab" hidden>
<div class="panel-head"><h2 data-i18n="projectMemoryTab">\${text.projectMemoryTab}</h2></div>
<div class="detail" id="project-memory"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
<section class="panel tab" id="backups-tab" hidden>
<div class="panel-head"><h2 data-i18n="backupsTab">\${text.backupsTab}</h2></div>
<div class="detail backups-detail">
<p class="empty" data-i18n="backupsTabIntro">\${text.backupsTabIntro}</p>
<div id="backup-action-status" class="action-status empty"></div>
<section id="backups-settings" class="backups-settings"></section>
<section id="backups-table" class="backups-table"></section>
</div>
</section>
<section class="panel tab" id="cleanup-settings-tab" hidden>
<div class="panel-head"><h2 data-i18n="cleanupSettingsTab">\${text.cleanupSettingsTab}</h2></div>
<div class="detail cleanup-detail">
<p class="empty" data-i18n="cleanupSettingsIntro">\${text.cleanupSettingsIntro}</p>
<div id="cleanup-status" class="action-status empty"></div>
<section id="cleanup-settings" class="cleanup-settings"><p class="empty" data-i18n="loading">\${text.loading}</p></section>
</div>
</section>
<section class="panel tab" id="instructions-tab" hidden>
<div class="panel-head"><h2 data-i18n="instructionsTab">\${text.instructionsTab}</h2></div>
<div class="detail" id="instructions"><p class="empty" data-i18n="loading">\${text.loading}</p></div>
</section>
</main>`;
