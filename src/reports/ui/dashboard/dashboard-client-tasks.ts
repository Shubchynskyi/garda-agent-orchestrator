/** Browser-side dashboard script fragment (tasks). */
export const UI_DASHBOARD_CLIENT_TASKS = `function renderOverview(report) {
  const rows = report.tasks_tab.rows;
  const active = rows.filter(task => !['DONE', 'BLOCKED', 'DECOMPOSED'].includes(task.status_token || '')).length;
  const done = rows.filter(task => (task.status_token || '') === 'DONE').length;
  const blocked = rows.filter(task => (task.status_token || '') === 'BLOCKED').length;
  overviewNode.innerHTML = metric(t('overviewTasks'), rows.length)
    + metric(t('overviewActive'), active)
    + metric(t('overviewDone'), done)
    + metric(t('overviewBlocked'), blocked)
    + metric(t('overviewWarnings'), report.unavailable.length);
}
function matchesFilters(task) {
  const query = String(searchNode.value || '').trim().toLowerCase();
  const status = statusFilterNode.value;
  const priority = priorityFilterNode.value;
  const haystack = [task.task_id, task.status, task.priority, task.area, task.title, task.owner, task.notes].join(' ').toLowerCase();
  return (!query || haystack.includes(query))
    && (!status || (task.status_token || task.status) === status)
    && (!priority || task.priority === priority);
}
function findReportTask(taskId) {
  return currentReport ? currentReport.tasks_tab.rows.find(task => task.task_id === taskId) || null : null;
}
function isTerminalTask(task) {
  return ['DONE', 'DECOMPOSED'].includes(task && (task.status_token || task.status));
}
function taskDataBadge(task) {
  const detail = loadedTaskDetails[task.task_id];
  if (detail || task.detail.detail_status === 'loaded') {
    return badge(t('dataFull'), 'data', 'data-full');
  }
  return isTerminalTask(task)
    ? badge(t('dataCompact'), 'data', 'data-compact')
    : badge(t('dataOnDemand'), 'data', 'data-compact');
}
function renderTasks(report) {
  currentReport = report;
  setPanelConfigPath(tasksConfigPathNode, report.tasks_tab && report.tasks_tab.source_path);
  metaNode.textContent = t('metaRepo') + ': ' + report.repo_root + ' | ' + t('metaTasks') + ': ' + report.tasks_tab.rows.length + ' | ' + t('metaWarnings') + ': ' + report.unavailable.length;
  if (report.unavailable.length > 0) {
    warningsNode.hidden = false;
    warningsNode.innerHTML = '<strong>' + safe(t('warningsTitle')) + '</strong><ul>' + report.unavailable.map(item => '<li><code>' + safe(item.scope) + '</code>: ' + safe(item.reason) + '</li>').join('') + '</ul>';
  } else {
    warningsNode.hidden = true;
    warningsNode.innerHTML = '';
  }
  renderOverview(report);
  setOptions(statusFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.status_token || task.status)), t('allStatuses'));
  setOptions(priorityFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.priority)), t('allPriorities'));
  renderTaskRows();
  renderWorkflow(report);
  renderInitSettings(report);
  renderProjectMemory(report);
  renderBackups(report);
  renderInstructions(report);
  renderSystemState(report);
  if (currentSettingsPayload) {
    renderSettingsEditor(currentSettingsPayload);
  }
}
function renderTaskRows() {
  const rows = currentReport ? currentReport.tasks_tab.rows.filter(matchesFilters) : [];
  if (rows.length === 0) {
    tasksNode.innerHTML = '<tr><td colspan="7" class="empty">' + safe(t('noMatchingTasks')) + '</td></tr>';
    return;
  }
  tasksNode.innerHTML = rows.map(task => {
    const selected = task.task_id === selectedTaskId ? ' class="selected"' : '';
    return '<tr data-task-id="' + safe(task.task_id) + '"' + selected + '><td><span class="task-id">' + safe(task.task_id) + '</span></td><td>' + badge(task.status_token || task.status, 'status') + '</td><td>' + badge(task.priority, 'priority') + '</td><td>' + safe(task.area) + '</td><td>' + safe(task.title) + '</td><td>' + taskDataBadge(task) + '</td><td><button type="button" data-task-id="' + safe(task.task_id) + '">' + safe(t('loadDetails')) + '</button></td></tr>';
  }).join('');
  for (const button of tasksNode.querySelectorAll('button[data-task-id]')) {
    button.addEventListener('click', () => loadDetail(button.dataset.taskId));
  }
}
`;
