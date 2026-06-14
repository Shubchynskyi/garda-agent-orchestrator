/** Browser-side dashboard script fragment (project-memory). */
export const UI_DASHBOARD_CLIENT_PROJECT_MEMORY = `function localizedMemoryFile(file) {
  return {
    label: localizedField(projectMemoryTextPacks, file.path, 'label', file.path),
    description: localizedField(projectMemoryTextPacks, file.path, 'description', file.purpose)
  };
}
function renderProjectMemory(report) {
  const tab = report.project_memory_tab || {};
  const files = tab.files || [];
  projectMemoryNode.innerHTML = '<section class="memory-section"><h3>' + safe(t('projectMemoryStatusTitle')) + '</h3>' + renderValueTable(tab.status || []) + '</section>'
    + '<section class="memory-section"><h3>' + safe(t('projectMemoryFilesTitle')) + '</h3>'
    + (files.length === 0 ? '<p class="empty">' + safe(t('noProjectMemoryFiles')) + '</p>' : '<div class="memory-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th><th>' + safe(t('purposeColumn')) + '</th><th>' + safe(t('sizeColumn')) + '</th><th>' + safe(t('openColumn')) + '</th></tr></thead><tbody>'
      + files.map(file => {
        const localized = localizedMemoryFile(file);
        return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(file.path) + '</code></td><td class="description-cell">' + safe(localized.description) + '</td><td><code>' + safe(file.size_bytes === null ? '-' : file.size_bytes) + '</code></td><td>' + (file.exists ? '<a href="#memory-' + safe(file.id) + '">' + safe(t('openMemoryFile')) + '</a>' : '<span class="empty">' + safe(t('missing')) + '</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>')
    + '</section><section class="memory-file-content">'
    + files.filter(file => file.exists).map(file => '<h3 id="memory-' + safe(file.id) + '">' + safe(file.path) + '</h3><pre>' + safe(file.content || '') + '</pre>').join('')
    + '</section>';
}
`;
