/** Browser-side dashboard script fragment (instructions). */
export const UI_DASHBOARD_CLIENT_INSTRUCTIONS = `function renderInstructions(report) {
  const entries = report.instructions_tab.entries || [];
  instructionsNode.innerHTML = entries.length === 0
    ? '<p class="empty">' + safe(t('noInstructions')) + '</p>'
    : '<div class="instruction-table"><table><thead><tr><th>' + safe(t('instructionAreaColumn')) + '</th><th>' + safe(t('instructionDescriptionColumn')) + '</th></tr></thead><tbody>' + entries.map(entry => {
      const id = entry.id || entry.title;
      const title = localizedField(instructionTextPacks, id, 'title', entry.title);
      const body = localizedField(instructionTextPacks, id, 'body', entry.body);
      return '<tr><td><strong>' + safe(title) + '</strong></td><td class="description-cell">' + inlineText(body) + instructionLinks(id) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  for (const button of instructionsNode.querySelectorAll('button[data-instruction-tab]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.instructionTab;
      const tabButton = Array.from(document.querySelectorAll('nav button[data-tab]')).find(candidate => candidate.dataset.tab === target);
      if (tabButton) {
        tabButton.click();
      }
    });
  }
}
function instructionLinks(id) {
  const links = [];
  if (id === 'task-inspection' || id === 'task-execution') {
    links.push(['tasks-tab', t('tasksTab')]);
  }
  if (id === 'workflow-configuration' || id === 'review-execution-modes' || id === 'workflow-guards') {
    links.push(['workflow-tab', t('workflowTab')]);
  }
  if (id === 'workspace-actions') {
    links.push(['actions-tab', t('actionsTab')]);
  }
  if (id === 'init-settings') {
    links.push(['init-settings-tab', t('initSettingsTab')]);
  }
  if (id === 'project-memory') {
    links.push(['project-memory-tab', t('projectMemoryTab')]);
  }
  if (links.length === 0) {
    return '';
  }
  return '<div class="instruction-links">' + links.map(([tabId, label]) => '<button type="button" data-instruction-tab="' + safe(tabId) + '">' + safe(label) + '</button>').join('') + '</div>';
}
function artifactList(links) {
  if (!links || links.length === 0) {
    return '<p class="empty">' + safe(t('noArtifacts')) + '</p>';
  }
  const existing = links.filter(link => link.exists).length;
  const missing = links.length - existing;
  return '<p class="empty">' + safe(t('existingArtifacts')) + ': ' + safe(existing) + ' | ' + safe(t('missingArtifacts')) + ': ' + safe(missing) + '</p><ul class="list">' + links.map(link => '<li class="' + (link.exists ? 'artifact-ok' : 'artifact-missing') + '"><code>' + safe(link.kind) + '</code>: ' + safe(link.path) + (link.exists ? '' : ' (' + safe(t('missing')) + ')') + '</li>').join('') + '</ul>';
}
`;
