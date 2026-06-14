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
function renderValueTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">' + safe(t('noInitSettings')) + '</p>';
  }
  return '<div class="value-table"><table><thead><tr><th>' + safe(t('fieldColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('valueColumn')) + '</th></tr></thead><tbody>'
    + rows.map(row => {
      const localized = localizedValueRow(row);
      return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(row.id) + '</code></td><td class="description-cell">' + inlineText(localized.description) + '</td><td><code class="current-value">' + safe(renderJsonValue(row.value)) + '</code></td></tr>';
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
    + '<section class="workflow-group"><h3>' + safe(t('initCommandsTitle')) + '</h3><div class="action-table"><table><thead><tr><th>' + safe(t('action')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('commandColumn')) + '</th></tr></thead><tbody>'
    + commands.map(command => '<tr><td><strong>' + safe(localizedField(initSettingTextPacks, command.id, 'title', command.title)) + '</strong></td><td class="description-cell">' + inlineText(localizedField(initSettingTextPacks, command.id, 'description', command.description)) + '</td><td class="command-cell"><code>' + safe(command.command) + '</code></td></tr>').join('')
    + '</tbody></table></div></section>';
}
`;
