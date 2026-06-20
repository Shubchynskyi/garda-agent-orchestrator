/** Browser-side dashboard script fragment (session-actions). */
export const UI_DASHBOARD_CLIENT_SESSION_ACTIONS = `async function postSession(path) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({})
  });
  return response.json();
}
function renderSession(session) {
  currentSession = session;
  if (!session || !session.enabled) {
    sessionSummaryNode.innerHTML = safe(t('idleShutdownDisabled'));
    sessionCountdownNode.max = '1';
    sessionCountdownNode.value = '1';
    return;
  }
  const warningSeconds = Number(session.seconds_until_warning || 0);
  const shutdownSeconds = Number(session.seconds_until_shutdown || 0);
  const totalShutdownSeconds = session.state === 'active'
    ? warningSeconds
    : shutdownSeconds;
  sessionCountdownNode.max = String(Math.max(1, Number(session.warning_seconds || 1)));
  sessionCountdownNode.value = String(session.state === 'warning' ? Math.max(0, shutdownSeconds) : Number(session.warning_seconds || 1));
  if (session.state === 'stopping') {
    sessionSummaryNode.innerHTML = '<span class="session-stopping">' + safe(t('stopping')) + '</span>';
    return;
  }
  if (session.state === 'warning') {
    sessionSummaryNode.innerHTML = '<strong class="session-warning">' + safe(t('shutdownIn')) + ':</strong> ' + safe(formatSeconds(totalShutdownSeconds));
    return;
  }
  sessionSummaryNode.innerHTML = '<strong>' + safe(t('shutdownIn')) + ':</strong> ' + safe(formatSeconds(totalShutdownSeconds));
}
async function refreshSession() {
  try {
    const response = await fetch('/api/session');
    renderSession(await response.json());
  } catch (error) {
    sessionSummaryNode.innerHTML = '<span class="session-stopping">' + safe(t('serverUnavailable')) + ' <code>garda ui</code> ' + safe(t('serverUnavailableTail')) + '</span>';
    if (sessionPollTimer) {
      clearInterval(sessionPollTimer);
      sessionPollTimer = null;
    }
  }
}
async function markActivity(force) {
  const now = Date.now();
  if (!force && now - lastActivityPingAt < 10000) {
    return;
  }
  lastActivityPingAt = now;
  try {
    renderSession(await postSession('/api/session/activity'));
  } catch {
    await refreshSession();
  }
}
const SYSTEM_STATE_DIAGNOSTIC_ACTION_IDS = ['status', 'doctor', 'status-why-blocked', 'repair-inspect'];
function focusVisibleActionResult(node) {
  if (!node || !node.innerHTML) {
    return;
  }
  if (typeof node.setAttribute === 'function' && (!node.getAttribute || node.getAttribute('tabindex') === null)) {
    node.setAttribute('tabindex', '-1');
  }
  if (typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (typeof node.focus === 'function') {
    node.focus({ preventScroll: true });
  }
}
function renderActionResult(result) {
  currentActionResult = result;
  const actionId = result.action_id || '';
  const label = localizedField(actionTextPacks, actionId, 'label', actionId || t('action'));
  actionStatusNode.innerHTML = '<section class="command-preview-panel">'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span></div>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
  focusVisibleActionResult(actionStatusNode);
}
function outputBlock(label, value) {
  if (!value) {
    return '';
  }
  return '<details open><summary>' + safe(label) + ' (' + safe(String(value.length)) + ' chars)</summary><pre>' + safe(value) + '</pre></details>';
}
async function runAction(actionId, mode, confirmation) {
  const response = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode, confirmation })
  });
  const result = await response.json();
  renderActionResult(result);
  if (actionId === 'garda-on' || actionId === 'garda-off') {
    await refreshActionsPayload();
  }
}
function actionLabel(action) {
  return localizedField(actionTextPacks, action.id, 'label', action.label);
}
function actionDescription(action) {
  return localizedField(actionTextPacks, action.id, 'description', action.description);
}
function actionCategoryLabel(category) {
  return (actionCategoryTextPacks[currentLanguage] && actionCategoryTextPacks[currentLanguage][category])
    || (actionCategoryTextPacks[fallbackLanguage] && actionCategoryTextPacks[fallbackLanguage][category])
    || category;
}
function actionChangeLabel(action) {
  if (!action.mutates) return t('safeAction');
  if (action.id === 'html-report') return t('htmlReportMutation');
  if (action.id === 'cleanup-apply') return t('cleanupMutation');
  if (action.id === 'garda-on' || action.id === 'garda-off') return t('gardaSwitchMutation');
  return t('mutatingAction');
}
function switchStateText(state) {
  if (state === 'on') return t('gardaSwitchStateOn');
  if (state === 'off') return t('gardaSwitchStateOff');
  return t('gardaSwitchStateUnknown');
}
function wireActionButtons(rootNode, actions) {
  for (const button of rootNode.querySelectorAll('button[data-action-id]')) {
    button.addEventListener('click', () => {
      const action = actions.find(item => item.id === button.dataset.actionId);
      const mode = button.dataset.actionMode;
      const confirmation = mode === 'execute' && action && action.requires_confirmation
        ? window.prompt(t('typeToRunAction') + ' "' + action.confirmation_phrase + '" ' + t('typeToRunActionTail'))
        : null;
      if (mode === 'execute' && action && action.requires_confirmation && confirmation === null) {
        return;
      }
      runAction(button.dataset.actionId, mode, confirmation);
    });
  }
}
function renderGardaSwitch(payload) {
  const state = payload.switch_state || 'unknown';
  const stateClass = state === 'on' ? 'data-full' : state === 'off' ? 'data-compact' : 'data-blockers';
  const actions = payload.actions || [];
  const desiredActionIds = state === 'off' ? ['garda-on'] : state === 'on' ? ['garda-off'] : ['garda-on', 'garda-off'];
  const buttons = !payload.enabled
    ? '<span class="empty">' + safe(t('gardaSwitchActionsDisabled')) + ' <code>garda ui --actions</code></span>'
    : state === 'unknown'
      ? '<span class="empty">' + safe(t('gardaSwitchUnavailable')) + '</span>'
      : desiredActionIds.map(actionId => {
        const action = actions.find(item => item.id === actionId);
        if (!action) return '';
        const label = actionId === 'garda-on' ? t('turnGardaOn') : t('turnGardaOff');
        return '<button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">' + safe(label) + '</button>';
      }).join('');
  const help = state === 'unknown' ? t('gardaSwitchUnknownHelp') : t('gardaSwitchHelp');
  gardaSwitchNode.hidden = false;
  gardaSwitchNode.innerHTML = '<div><strong>' + safe(t('gardaSwitchTitle')) + '</strong><span class="badge ' + stateClass + '">' + safe(t('gardaSwitchState')) + ': ' + safe(switchStateText(state)) + '</span><p>' + safe(help) + '</p></div><div class="switch-buttons">' + buttons + '</div>';
  if (payload.enabled && state !== 'unknown') {
    wireActionButtons(gardaSwitchNode, actions);
  }
}
function configFileStatusClass(status) {
  if (status === 'present') return 'data-full';
  if (status === 'missing' || status === 'invalid') return 'data-blockers';
  return 'data-compact';
}
function configFileStatusLabel(status) {
  if (status === 'present') return t('initStatusPresent');
  if (status === 'missing') return t('initStatusMissing');
  if (status === 'invalid') return t('initStatusInvalid');
  return String(status || '-');
}
function systemHealthClass(status) {
  if (status === 'ok') return 'data-full';
  if (status === 'attention') return 'data-compact';
  if (status === 'error') return 'data-blockers';
  return 'status-TODO';
}
function systemHealthLabel(status, fallback) {
  if (status === 'ok') return 'OK';
  if (status === 'attention') return t('overviewWarnings');
  if (status === 'error') return t('blockers');
  return fallback || t('gardaSwitchStateUnknown');
}
function systemHealthRank(status) {
  if (status === 'error') return 3;
  if (status === 'attention') return 2;
  if (status === 'ok') return 1;
  return 0;
}
function systemWorstHealth(signals) {
  const ranked = (signals || []).reduce((best, signal) => Math.max(best, systemHealthRank(signal && signal.status)), 0);
  if (ranked === 3) return 'error';
  if (ranked === 2) return 'attention';
  if (ranked === 1) return 'ok';
  return 'unknown';
}
function isPrimarySystemHealthSignal(signal) {
  const id = signal && signal.id ? String(signal.id) : '';
  return !id.startsWith('config-file-');
}
function systemOverallSummary(status, fallback) {
  if (status === 'ok') return fallback || 'Core System State signals look healthy.';
  if (status === 'unknown') return fallback || 'System State health is not available.';
  return 'One or more System State signals need attention.';
}
function systemSignalLabel(signal) {
  const id = signal && signal.id;
  if (id === 'garda-switch') return t('gardaSwitchTitle');
  if (id === 'ui-actions') return t('actionsTab');
  if (id === 'task-queue') return t('taskQueueStatus');
  if (id === 'workflow-readiness') return t('workflowTab');
  if (id === 'project-memory') return t('projectMemoryTab');
  if (id === 'protected-manifest') return t('workflowGroupSafety');
  if (id === 'runtime-locks') return t('runtimeDiagnosticsTitle');
  if (id === 'active-task-timelines' || id === 'incomplete-task-timelines') return t('gateTimeline');
  return signal && signal.label ? signal.label : '-';
}
function systemConfigFileLabel(entry) {
  if (entry.id === 'init-answers') return t('initBlockTitle');
  if (entry.id === 'agent-init-state') return t('agentInitBlockTitle');
  if (entry.id === 'ordinary-doc-paths') return t('ordinaryDocsTitle');
  if (entry.id === 'workflow-config') return t('workflowConfigPath');
  return entry.label || '-';
}
function enrichUiActionsSignal(signal) {
  const payload = currentActionsPayload;
  if (!payload || typeof payload.enabled !== 'boolean') {
    return signal;
  }
  return {
    ...(signal || {}),
    id: 'ui-actions',
    status: payload.enabled ? 'ok' : 'attention',
    summary: payload.enabled
      ? 'Guarded UI actions are enabled for this local session.'
      : 'Guarded UI actions are disabled for this local session.',
    remediation: payload.enabled ? null : 'Restart with garda ui --actions to expose allowlisted actions.',
    value: { enabled: payload.enabled }
  };
}
function enrichSystemSignals(signals) {
  return (signals || []).map(signal => signal && signal.id === 'ui-actions' ? enrichUiActionsSignal(signal) : signal).filter(Boolean);
}
function mergeSystemSignals(primarySignals, allSignals) {
  const seen = new Set();
  const merged = [];
  for (const signal of [...(primarySignals || []), ...(allSignals || [])]) {
    if (!signal || !signal.id || seen.has(signal.id)) {
      continue;
    }
    seen.add(signal.id);
    merged.push(signal);
  }
  return merged;
}
function renderSystemSignal(signal) {
  if (!signal) {
    return '';
  }
  return '<div class="system-signal">'
    + '<div><strong>' + safe(systemSignalLabel(signal)) + '</strong><span class="badge ' + safe(systemHealthClass(signal.status)) + '">' + safe(systemHealthLabel(signal.status, signal.status)) + '</span></div>'
    + '<p>' + safe(signal.summary || '-') + '</p>'
    + (signal.remediation ? '<p class="empty">' + inlineText(signal.remediation) + '</p>' : '')
    + (signal.source_path ? '<code>' + safe(signal.source_path) + '</code>' : '')
    + '</div>';
}
function renderSystemConfigurationFiles(entries) {
  if (!entries || entries.length === 0) {
    return '';
  }
  return '<section class="system-config-files"><h3>' + safe(t('workflowStatus')) + '</h3><div class="value-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th><th>' + safe(t('statusColumn')) + '</th></tr></thead><tbody>'
    + entries.map(entry => '<tr><td><strong>' + safe(systemConfigFileLabel(entry)) + '</strong><br><code>' + safe(entry.path) + '</code></td><td><span class="badge ' + safe(configFileStatusClass(entry.status)) + '">' + safe(configFileStatusLabel(entry.status)) + '</span></td></tr>').join('')
    + '</tbody></table></div></section>';
}
function systemDiagnosticActionsHtml(payload) {
  const actions = payload && payload.actions ? payload.actions : [];
  if (!payload || !payload.enabled) {
    return '<section class="system-diagnostic-actions"><h3>' + safe(t('runtimeDiagnosticsTitle')) + '</h3><p class="empty">' + safe(t('actionsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('actionsDisabledTail')) + '</p></section>';
  }
  const buttons = SYSTEM_STATE_DIAGNOSTIC_ACTION_IDS.map(actionId => {
    const action = actions.find(item => item.id === actionId);
    if (!action || !action.enabled) {
      return '';
    }
    return '<button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">' + safe(actionLabel(action)) + '</button>';
  }).join('');
  if (!buttons) {
    return '';
  }
  return '<section class="system-diagnostic-actions"><h3>' + safe(t('runtimeDiagnosticsTitle')) + '</h3><p class="empty">' + safe(t('actionsPreviewHelp')) + '</p><div class="action-buttons">' + buttons + '</div></section>';
}
function renderSystemState(report) {
  const node = document.getElementById('system-state-panel');
  if (!node || !report) {
    return;
  }
  const state = report.system_state;
  if (!state) {
    node.innerHTML = '';
    return;
  }
  const primarySignals = [
    state.garda,
    enrichUiActionsSignal(state.ui_actions),
    state.task_queue,
    state.workflow,
    state.project_memory,
    state.protected_manifest,
    state.runtime && state.runtime.stale_locks,
    state.runtime && state.runtime.incomplete_timeline
  ].filter(Boolean);
  const allSignals = enrichSystemSignals(state.signals && state.signals.length > 0 ? state.signals : primarySignals);
  const signals = mergeSystemSignals(primarySignals, allSignals);
  const renderedOverallStatus = systemWorstHealth(allSignals.filter(isPrimarySystemHealthSignal));
  const renderedOverallLabel = systemHealthLabel(renderedOverallStatus, state.overall.label);
  const renderedOverallSummary = systemOverallSummary(renderedOverallStatus, state.overall.summary);
  const workflowDetails = state.workflow
    ? '<div class="system-inline-details">'
      + '<span>' + safe(t('fullSuiteCommand')) + ': <code>' + safe(state.workflow.full_suite_command || '-') + '</code></span>'
      + '<span>' + safe(t('fullSuiteTimeoutForecast')) + ': ' + safe(state.workflow.full_suite_timeout_forecast_label || '-') + '</span>'
      + '</div>'
    : '';
  node.innerHTML = '<section class="system-health-summary">'
    + '<div><h3>' + safe(t('actionsTab')) + '</h3><p>' + safe(renderedOverallSummary || '-') + '</p><p class="empty">' + safe(state.overall.generated_at_utc || report.generated_at_utc || '-') + '</p></div>'
    + '<span class="badge ' + safe(systemHealthClass(renderedOverallStatus)) + '">' + safe(renderedOverallLabel) + '</span>'
    + '</section>'
    + workflowDetails
    + systemDiagnosticActionsHtml(currentActionsPayload)
    + '<section class="system-signal-grid">' + signals.map(renderSystemSignal).join('') + '</section>'
    + renderSystemConfigurationFiles(state.configuration_files || []);
  if (currentActionsPayload && currentActionsPayload.enabled) {
    wireActionButtons(node, currentActionsPayload.actions || []);
  }
}
function renderActions(payload) {
  currentActionsPayload = payload;
  renderGardaSwitch(payload);
  if (!payload.enabled) {
    actionsNode.innerHTML = '<p class="empty">' + safe(t('actionsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('actionsDisabledTail')) + '</p><p class="empty">' + safe(t('actionsTaskMoved')) + '</p>';
    return;
  }
  if (!currentActionResult) {
    actionStatusNode.innerHTML = '';
  }
  const categories = uniqueSorted(payload.actions.map(action => action.category || 'Workspace'));
  actionsNode.innerHTML = categories.map(category => {
    const actions = payload.actions.filter(action => (action.category || 'Workspace') === category);
    return '<section class="action-section"><h3>' + safe(actionCategoryLabel(category)) + '</h3><div class="action-table"><table><thead><tr><th>' + safe(t('action')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('actionEffectColumn')) + '</th><th>' + safe(t('commandColumn')) + '</th><th>' + safe(t('actionRunColumn')) + '</th></tr></thead><tbody>'
      + actions.map(action => '<tr><td><strong>' + safe(actionLabel(action)) + '</strong></td><td class="description-cell">' + inlineText(actionDescription(action)) + '</td><td><span class="action-kind' + (action.mutates ? ' mutates' : '') + '">' + safe(actionChangeLabel(action)) + '</span></td><td class="command-cell"><code>' + safe(action.command) + '</code></td><td><div class="action-buttons"><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">' + safe(t('run')) + '</button></div></td></tr>').join('')
      + '</tbody></table></div></section>';
  }).join('');
  wireActionButtons(actionsNode, payload.actions);
  if (currentReport) {
    renderSystemState(currentReport);
    renderBackups(currentReport);
  }
}
async function refreshActionsPayload() {
  const response = await fetch('/api/actions');
  renderActions(await response.json());
}
`;
