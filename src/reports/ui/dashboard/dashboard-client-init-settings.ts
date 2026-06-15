/** Browser-side dashboard script fragment (init-settings). */
export const UI_DASHBOARD_CLIENT_INIT_SETTINGS = `function localizedValueRow(row) {
  return {
    label: localizedField(initSettingTextPacks, row.id, 'label', row.label),
    description: localizedField(initSettingTextPacks, row.id, 'description', row.description)
  };
}
function renderJsonValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '-' : value.join(', ');
  }
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
function fileViewerHref(pathValue) {
  return '/files?path=' + encodeURIComponent(pathValue) + '&action_token=' + encodeURIComponent(actionToken);
}
function renderValueTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">' + safe(t('noInitSettings')) + '</p>';
  }
  return '<div class="value-table"><table><thead><tr><th>' + safe(t('fieldColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('valueColumn')) + '</th></tr></thead><tbody>'
    + rows.map(row => {
      const localized = localizedValueRow(row);
      const openLink = row.file_path ? '<br><a href="' + fileViewerHref(row.file_path) + '" target="_blank" rel="noopener">' + safe(t('openMemoryFile')) + '</a>' : '';
      return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(row.id) + '</code></td><td class="description-cell">' + inlineText(localized.description) + '</td><td><code class="current-value">' + safe(renderJsonValue(row.value)) + '</code>' + openLink + '</td></tr>';
    }).join('')
    + '</tbody></table></div>';
}
function initStatusText(status) {
  if (status === 'present') return t('initStatusPresent');
  if (status === 'missing') return t('initStatusMissing');
  if (status === 'invalid') return t('initStatusInvalid');
  return String(status || 'unknown');
}
function renderInitSettings(report) {
  const tab = report.init_settings_tab || {};
  const commands = tab.commands || [];
  initSettingsNode.innerHTML = '<section class="workflow-group"><h3>' + safe(t('initBlockTitle')) + ' <span class="config-path">(' + safe(tab.init_answers_path || '-') + ')</span></h3>'
    + '<p class="workflow-state">' + safe(initStatusText(tab.init_answers_status)) + '</p>' + renderValueTable(tab.init_answers || []) + '</section>'
    + '<section class="workflow-group"><h3>' + safe(t('agentInitBlockTitle')) + ' <span class="config-path">(' + safe(tab.agent_init_state_path || '-') + ')</span></h3>'
    + '<p class="workflow-state">' + safe(initStatusText(tab.agent_init_state_status)) + '</p>' + renderValueTable(tab.agent_init_state || []) + '</section>'
    + renderOrdinaryDocs(tab.ordinary_docs || { paths: [], config_path: '-', status: 'missing' })
    + '<section class="workflow-group"><h3>' + safe(t('initCommandsTitle')) + '</h3><div class="action-table"><table><thead><tr><th>' + safe(t('action')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('commandColumn')) + '</th></tr></thead><tbody>'
    + commands.map(command => '<tr><td><strong>' + safe(localizedField(initSettingTextPacks, command.id, 'title', command.title)) + '</strong></td><td class="description-cell">' + inlineText(localizedField(initSettingTextPacks, command.id, 'description', command.description)) + '</td><td class="command-cell"><code>' + safe(command.command) + '</code></td></tr>').join('')
    + '</tbody></table></div></section>';
  wireOrdinaryDocsControls(tab.ordinary_docs || { paths: [] });
}
function renderOrdinaryDocs(info) {
  const rows = (info.paths || []).map(pathValue => '<tr><td><code>' + safe(pathValue) + '</code></td><td><div class="setting-buttons"><button type="button" data-ordinary-doc-path="' + safe(pathValue) + '" data-ordinary-doc-operation="remove" data-ordinary-doc-mode="preview"' + (!actionsEnabled ? ' disabled' : '') + '>' + safe(t('previewCommand')) + '</button><button type="button" data-ordinary-doc-path="' + safe(pathValue) + '" data-ordinary-doc-operation="remove" data-ordinary-doc-mode="execute"' + (!actionsEnabled ? ' disabled' : '') + '>' + safe(t('removeOrdinaryDoc')) + '</button></div></td></tr>').join('');
  const table = rows
    ? '<div class="value-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th><th>' + safe(t('actionColumn')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<p class="empty">' + safe(t('ordinaryDocsEmpty')) + '</p>';
  const disabledText = !actionsEnabled ? '<p class="empty">' + safe(t('ordinaryDocsActionsDisabled')) + ' <code>garda ui --actions</code></p>' : '';
  return '<section class="workflow-group ordinary-docs"><h3>' + safe(t('ordinaryDocsTitle')) + ' <span class="config-path">(' + safe(info.config_path || '-') + ')</span></h3>'
    + '<p class="empty">' + safe(t('ordinaryDocsHelp')) + '</p>'
    + table
    + '<div id="ordinary-docs-status" class="action-status empty"></div>'
    + '<div class="ordinary-doc-form"><label><span>' + safe(t('ordinaryDocsPath')) + '</span><input id="ordinary-doc-path" type="text" placeholder="docs/plan.md"' + (!actionsEnabled ? ' disabled' : '') + '></label><div class="setting-buttons"><button type="button" data-ordinary-doc-operation="add" data-ordinary-doc-mode="preview"' + (!actionsEnabled ? ' disabled' : '') + '>' + safe(t('previewCommand')) + '</button><button type="button" data-ordinary-doc-operation="add" data-ordinary-doc-mode="execute"' + (!actionsEnabled ? ' disabled' : '') + '>' + safe(t('addOrdinaryDoc')) + '</button></div></div>'
    + disabledText
    + '</section>';
}
function renderOrdinaryDocsResult(result) {
  const node = document.getElementById('ordinary-docs-status');
  if (!node) return;
  node.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3>'
    + '<div class="command-preview-main"><strong>' + safe(result.operation || '-') + '</strong><br><code>' + safe(result.command || '-') + '</code></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span><span>' + safe(t('fileColumn')) + '<code>' + safe(result.path || '-') + '</code></span></div>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + '</section>';
}
async function submitOrdinaryDocs(operation, mode, pathValue, confirmation) {
  const response = await fetch('/api/ordinary-docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ operation, mode, path: pathValue, confirmation })
  });
  const result = await response.json();
  renderOrdinaryDocsResult(result);
  if (result && result.status === 'executed') {
    const reportResponse = await fetch('/api/report');
    currentReport = await reportResponse.json();
    renderInitSettings(currentReport);
  }
}
function wireOrdinaryDocsControls(info) {
  for (const button of initSettingsNode.querySelectorAll('button[data-ordinary-doc-operation]')) {
    button.addEventListener('click', async () => {
      const operation = button.dataset.ordinaryDocOperation;
      const mode = button.dataset.ordinaryDocMode;
      const input = document.getElementById('ordinary-doc-path');
      const pathValue = operation === 'add' ? (input ? input.value : '') : button.dataset.ordinaryDocPath;
      const confirmation = mode === 'execute'
        ? window.prompt(t('typeToApplySetting') + ' "APPLY ORDINARY DOCS" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      await submitOrdinaryDocs(operation, mode, pathValue, confirmation);
    });
  }
}
`;
