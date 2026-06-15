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
    renderBackups(currentReport);
  }
}
async function refreshActionsPayload() {
  const response = await fetch('/api/actions');
  renderActions(await response.json());
}
`;
