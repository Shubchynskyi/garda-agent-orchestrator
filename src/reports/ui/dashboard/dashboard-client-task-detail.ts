/** Browser-side dashboard script fragment (task-detail). */
export const UI_DASHBOARD_CLIENT_TASK_DETAIL = `function reviewSummary(audit) {
  const summary = audit && audit.review_attempt_summary && (audit.review_attempt_summary.by_type || audit.review_attempt_summary.review_types);
  if (!summary || summary.length === 0) {
    return '<p class="empty">' + safe(t('noReviewAttempts')) + '</p>';
  }
  return '<ul class="list">' + summary.map(item => '<li><code>' + safe(item.review_type) + '</code>: pass=' + safe(item.pass_count) + ', fail=' + safe(item.fail_count) + ', reused=' + safe(item.reused_count) + '</li>').join('') + '</ul>';
}
function isTaskResetEnabled() {
  const readiness = taskResetReadiness();
  if (readiness) {
    return readiness.ready === true;
  }
  const settings = currentReport && currentReport.workflow_config_tab && currentReport.workflow_config_tab.settings
    ? currentReport.workflow_config_tab.settings
    : [];
  const setting = settings.find(item => item && item.key === 'task_reset.enabled');
  return setting && setting.value === true;
}
function taskResetReadiness() {
  const settings = currentReport && currentReport.workflow_config_tab && currentReport.workflow_config_tab.settings
    ? currentReport.workflow_config_tab.settings
    : [];
  const setting = settings.find(item => item && item.key === 'task_reset.enabled');
  return setting && setting.readiness ? setting.readiness : null;
}
function taskResetUnavailableText() {
  const readiness = taskResetReadiness();
  if (!readiness) {
    return t('taskResetUnavailable');
  }
  if (readiness.configured_enabled === true && readiness.audited_enablement !== true) {
    return t('taskResetAuditUnavailable') + ' ' + (readiness.disabled_reason || '');
  }
  return t('taskResetUnavailable') + ' ' + (readiness.disabled_reason || '');
}
function taskCommandList(taskId) {
  const resetReadiness = taskResetReadiness();
  const resetReady = isTaskResetEnabled();
  const resetRemediationCommand = resetReadiness && resetReadiness.remediation_command
    ? resetReadiness.remediation_command
    : 'garda workflow set --target-root "." --task-reset-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"';
  const commands = [
    { id: 'task-next-step', label: t('taskCommandNextStep'), description: t('taskCommandNextStepDescription'), command: 'garda next-step "' + taskId + '" --repo-root "."', mutates: true, disabled: false, unavailable: '' },
    { id: 'task-reset-reopen', label: t('taskCommandReset'), description: t('taskCommandResetDescription'), command: 'garda gate task-reset --task-id "' + taskId + '" --reopen --confirm --repo-root "."', mutates: true, disabled: !resetReady, unavailable: taskResetUnavailableText() },
    { id: 'task-reset-discard', label: t('taskCommandDiscard'), description: t('taskCommandDiscardDescription'), command: 'garda gate task-reset --task-id "' + taskId + '" --discard --confirm --repo-root "."', mutates: true, disabled: !resetReady, unavailable: taskResetUnavailableText() },
    { id: 'task-reset-enable-audited', label: t('taskCommandEnableReset'), description: resetReadiness && resetReadiness.configured_enabled === true ? t('taskCommandEnableResetAuditDescription') : t('taskCommandEnableResetDescription'), command: resetRemediationCommand, mutates: true, disabled: resetReady, unavailable: t('taskResetAlreadyReady') },
    { id: 'task-stats', label: t('taskCommandStats'), description: t('taskCommandStatsDescription'), command: 'garda task "' + taskId + '" stats --target-root "."', mutates: false, disabled: false, unavailable: '' },
    { id: 'task-events', label: t('taskCommandEvents'), description: t('taskCommandEventsDescription'), command: 'garda task "' + taskId + '" events --target-root "."', mutates: false, disabled: false, unavailable: '' }
  ];
  return '<div class="task-command-list">' + commands.map(action => '<section class="task-command-card"><strong>' + safe(action.label) + '</strong><p>' + safe(action.description) + '</p><code>' + safe(action.command) + '</code>'
    + (actionsEnabled
      ? '<div class="task-command-buttons"><button type="button" data-task-action-id="' + safe(action.id) + '" data-task-action-mode="execute"' + (action.disabled ? ' disabled' : '') + '>' + safe(action.disabled ? t('actionUnavailable') : t('run')) + '</button>' + (action.mutates ? '<span class="action-kind mutates">' + safe(t('mutatingAction')) + '</span>' : '<span class="action-kind">' + safe(t('safeAction')) + '</span>') + '</div>' + (action.disabled ? '<p class="task-action-unavailable">' + safe(action.unavailable) + '</p>' : '')
      : '<p class="empty">' + inlineText(t('taskCommandUnavailable')) + '</p>')
    + '</section>').join('') + '</div>';
}
function blockerText(item) {
  if (typeof item === 'string') {
    return item;
  }
  if (item && typeof item === 'object') {
    const gate = item.gate ? String(item.gate) : '';
    const reason = item.reason ? String(item.reason) : JSON.stringify(item);
    return gate ? gate + ': ' + reason : reason;
  }
  return String(item ?? '');
}
function auditDiagnosticsList(blockers) {
  if (!blockers || blockers.length === 0) {
    return '<p class="empty">' + safe(t('noRuntimeDiagnostics')) + '</p>';
  }
  return '<ul class="list">' + blockers.map(item => '<li>' + safe(blockerText(item)) + '</li>').join('') + '</ul>';
}
function wireTaskActionButtons(taskId) {
  for (const button of detailNode.querySelectorAll('button[data-task-action-id]')) {
    button.addEventListener('click', async () => {
      const actionId = button.dataset.taskActionId;
      const mode = button.dataset.taskActionMode;
      const confirmationPhrase = taskActionConfirmationPhrase(actionId);
      const confirmation = mode === 'execute' && confirmationPhrase
        ? window.prompt(t('typeToRunAction') + ' "' + confirmationPhrase + '" ' + t('typeToRunActionTail'))
        : null;
      if (mode === 'execute' && confirmationPhrase && confirmation === null) {
        return;
      }
      await runTaskAction(taskId, actionId, mode, confirmation);
    });
  }
}
function taskActionConfirmationPhrase(actionId) {
  if (actionId === 'task-next-step') return 'RUN TASK NEXT STEP';
  if (actionId === 'task-reset-reopen') return 'RESET TASK';
  if (actionId === 'task-reset-discard') return 'DISCARD TASK';
  if (actionId === 'task-reset-enable-audited') return 'ENABLE TASK RESET';
  return null;
}
async function runTaskAction(taskId, actionId, mode, confirmation) {
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode, confirmation })
  });
  const result = await response.json();
  const node = document.getElementById('task-action-status');
  if (!node) {
    return;
  }
  node.innerHTML = '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(result.task_id || taskId) + '</strong></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span></div>'
    + (result.unavailable_reason ? '<p class="task-action-unavailable">' + safe(result.unavailable_reason) + '</p>' : '')
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
  focusVisibleActionResult(node);
  const exitCode = Number.isFinite(Number(result.exit_code)) ? Number(result.exit_code) : null;
  if (response.ok && result.status === 'executed' && (exitCode === null || exitCode === 0) && actionId === 'task-reset-enable-audited') {
    try {
      const reportResponse = await fetch('/api/report');
      currentReport = await reportResponse.json();
      await loadDetail(taskId);
    } catch {
      // Keep the command result visible if refresh fails.
    }
  }
}
function planButton(detail) {
  return detail.plan && detail.plan.available
    ? '<button type="button" id="show-task-plan">' + safe(t('showTaskPlan')) + '</button>'
    : '';
}
function renderTaskPlanModal(detail) {
  const plan = detail.plan || {};
  const task = findReportTask(detail.task_id);
  planModalBodyNode.innerHTML = '<div class="plan-meta">'
    + '<div><span>' + safe(t('idColumn')) + '</span><strong>' + safe(detail.task_id) + '</strong></div>'
    + '<div><span>' + safe(t('titleColumn')) + '</span><strong>' + safe(plan.task_title || (task && task.title) || '-') + '</strong></div>'
    + '<div><span>' + safe(t('taskQueueStatus')) + '</span><strong>' + safe(plan.task_status || (task && (task.status_token || task.status)) || '-') + '</strong></div>'
    + '</div>'
    + (plan.summary ? '<p class="empty">' + safe(plan.summary) + '</p>' : '')
    + (plan.markdown_path ? '<p><strong>' + safe(t('planPath')) + ':</strong> <code>' + safe(plan.markdown_path) + '</code></p>' : '')
    + '<pre class="plan-content">' + safe(plan.markdown || t('planMetadataOnly')) + '</pre>';
  planModalNode.hidden = false;
}
function closeTaskPlanModal() {
  planModalNode.hidden = true;
  planModalBodyNode.innerHTML = '';
}
async function loadDetail(taskId) {
  selectedTaskId = taskId;
  detailNode.innerHTML = '<p class="empty">' + safe(t('loadingTaskPrefix')) + ' ' + safe(taskId) + '...</p>';
  renderTaskRows();
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/detail');
  if (!response.ok) {
    detailNode.innerHTML = '<p class="error">' + safe(t('unableToLoadDetails')) + ' ' + response.status + '</p>';
    return;
  }
  const detail = await response.json();
  currentTaskDetail = detail;
  loadedTaskDetails[detail.task_id] = detail;
  renderTaskDetail(detail);
  renderTaskRows();
}
function renderTaskDetail(detail) {
  const task = findReportTask(detail.task_id);
  const stats = detail.stats || {};
  const audit = detail.audit || {};
  const fullSuite = detail.full_suite_validation || {};
  const blockers = audit.blockers || [];
  const queueStatus = task ? (task.status_token || task.status) : '';
  const queueBlocked = queueStatus === 'BLOCKED';
  const dataState = queueBlocked ? t('blockerDetailState') : t('fullDetailState');
  detailNode.innerHTML = '<h2>' + safe(detail.task_id) + (task ? ' - ' + safe(task.title) : '') + '</h2>'
    + '<p class="empty">' + safe(dataState) + '</p>'
    + (queueBlocked ? '<div class="blocker-alert">' + safe(t('blockerDetailState')) + '</div>' : '')
    + '<div class="metrics">'
    + metric(t('taskQueueStatus'), queueStatus || '-')
    + metric(t('events'), stats.events_count)
    + metric(t('gatePass'), stats.gate_pass_count)
    + metric(t('gateFail'), stats.gate_fail_count)
    + metric(t('fullSuiteState'), fullSuite.state)
    + metric(t('fullSuiteDuration'), fullSuite.duration_human)
    + metric(t('changedLines'), stats.changed_lines_total)
    + metric(t('dataColumn'), t('dataFull'))
    + '</div>'
    + '<h3 class="task-section-title">' + safe(t('taskActionsTitle')) + '</h3><p class="empty">' + safe(t('taskActionsHelp')) + '</p><div class="task-command-buttons">' + planButton(detail) + '</div><div id="task-action-status" class="task-action-status"></div>' + taskCommandList(detail.task_id)
    + '<h3 class="task-section-title">' + safe(t('fullSuiteTitle')) + '</h3>' + fullSuiteSummary(fullSuite)
    + '<h3 class="task-section-title">' + safe(t('gateTimeline')) + '</h3><p class="empty">' + safe(t('gateTimelineHelp')) + '</p><pre>' + safe(JSON.stringify(detail.latest_cycle_events || {}, null, 2)) + '</pre>'
    + (blockers.length > 0 ? '<h3 class="task-section-title">' + safe(t('runtimeDiagnosticsTitle')) + '</h3>' + auditDiagnosticsList(blockers) : '')
    + '<h3 class="task-section-title">' + safe(t('reviews')) + '</h3>' + reviewSummary(audit)
    + '<h3 class="task-section-title">' + safe(t('artifacts')) + '</h3>' + artifactList(detail.artifact_links);
  wireTaskActionButtons(detail.task_id);
  const showPlanButton = document.getElementById('show-task-plan');
  if (showPlanButton) {
    showPlanButton.addEventListener('click', () => renderTaskPlanModal(detail));
  }
}
`;
