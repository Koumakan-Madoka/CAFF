// @ts-check

const state = {
  projects: [],
  activeProjectId: '',
  selectedProjectId: null,
};

const shared = window.CaffShared || {};
const fetchJson = shared.fetchJson;

const dom = {
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  projectList: /** @type {HTMLDivElement | null} */ (document.getElementById('project-list')),
  newProjectForm: /** @type {HTMLFormElement | null} */ (document.getElementById('new-project-form')),
  projectName: /** @type {HTMLInputElement | null} */ (document.getElementById('project-name')),
  projectPath: /** @type {HTMLInputElement | null} */ (document.getElementById('project-path')),
  selectedProjectTitle: /** @type {HTMLElement | null} */ (document.getElementById('selected-project-title')),
  selectedProjectMeta: /** @type {HTMLElement | null} */ (document.getElementById('selected-project-meta')),
  setActiveButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('set-active-button')),
  deleteProjectButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-project-button')),
  toast: /** @type {HTMLElement | null} */ (document.getElementById('toast')),
};

const toast =
  typeof shared.createToastController === 'function' ? shared.createToastController(dom.toast) : { show() {} };

function showToast(message) {
  toast.show(message);
}

function projectById(projectId) {
  return state.projects.find((project) => project.id === projectId) || null;
}

function ensureSelectedProject() {
  if (state.selectedProjectId && projectById(state.selectedProjectId)) {
    return;
  }

  state.selectedProjectId = state.projects[0] ? state.projects[0].id : null;
}

async function refreshProjects() {
  const result = await fetchJson('/api/projects');
  state.projects = Array.isArray(result.projects) ? result.projects : [];
  state.activeProjectId = String(result.activeProjectId || '').trim();
  ensureSelectedProject();
}

function renderProjectList() {
  if (!dom.projectList) {
    return;
  }

  dom.projectList.innerHTML = '';

  if (!Array.isArray(state.projects) || state.projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有添加项目。';
    dom.projectList.appendChild(empty);
    return;
  }

  state.projects.forEach((project) => {
    const item = document.createElement('div');
    item.className = `agent-list-item compact${project.id === state.selectedProjectId ? ' active' : ''}`;

    const left = document.createElement('div');
    left.style.display = 'grid';
    left.style.gap = '0.12rem';

    const title = document.createElement('strong');
    title.textContent = project.name || project.id;

    const pathLine = document.createElement('div');
    pathLine.className = 'muted';
    pathLine.textContent = project.path || '';

    left.append(title, pathLine);

    const badge = document.createElement('span');
    badge.className = 'mini-badge';
    badge.textContent = project.id === state.activeProjectId ? 'Active' : 'Idle';

    item.append(left, badge);

    item.addEventListener('click', () => {
      state.selectedProjectId = project.id;
      renderAll();
    });

    dom.projectList.appendChild(item);
  });
}

function renderSelectedProject() {
  const selected = state.selectedProjectId ? projectById(state.selectedProjectId) : null;

  if (dom.selectedProjectTitle) {
    dom.selectedProjectTitle.textContent = selected ? selected.name || selected.id : '未选择项目';
  }

  if (dom.selectedProjectMeta) {
    if (!selected) {
      dom.selectedProjectMeta.textContent = '从左侧选择一个项目';
    } else {
      const activeLabel = selected.id === state.activeProjectId ? '（当前激活）' : '';
      dom.selectedProjectMeta.textContent = `${selected.path || ''} ${activeLabel}`.trim();
    }
  }

  if (dom.setActiveButton) {
    dom.setActiveButton.disabled = !selected || selected.id === state.activeProjectId;
  }

  if (dom.deleteProjectButton) {
    dom.deleteProjectButton.disabled = !selected;
  }
}

function renderAll() {
  renderProjectList();
  renderSelectedProject();
}

async function handleCreateProject(event) {
  event.preventDefault();

  if (!dom.projectPath) {
    return;
  }

  const payload = {
    name: dom.projectName ? dom.projectName.value : '',
    path: dom.projectPath.value,
  };

  try {
    await fetchJson('/api/projects', { method: 'POST', body: payload });
    if (dom.projectName) {
      dom.projectName.value = '';
    }
    dom.projectPath.value = '';
    await refreshProjects();
    renderAll();
    showToast('已添加并激活项目');
  } catch (error) {
    showToast(error && error.message ? error.message : '添加项目失败');
  }
}

async function handleSetActive() {
  const selected = state.selectedProjectId ? projectById(state.selectedProjectId) : null;

  if (!selected) {
    return;
  }

  try {
    await fetchJson('/api/projects/active', { method: 'PUT', body: { projectId: selected.id } });
    await refreshProjects();
    renderAll();
    showToast('已切换激活项目');
  } catch (error) {
    showToast(error && error.message ? error.message : '切换项目失败');
  }
}

async function handleDeleteProject() {
  const selected = state.selectedProjectId ? projectById(state.selectedProjectId) : null;

  if (!selected) {
    return;
  }

  if (!window.confirm(`确定删除项目：${selected.name || selected.id}？`)) {
    return;
  }

  try {
    await fetchJson(`/api/projects/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
    state.selectedProjectId = null;
    await refreshProjects();
    renderAll();
    showToast('已删除项目');
  } catch (error) {
    showToast(error && error.message ? error.message : '删除项目失败');
  }
}

async function bootstrap() {
  try {
    await refreshProjects();
  } catch (error) {
    showToast(error && error.message ? error.message : '加载项目失败');
  }

  renderAll();
}

if (dom.refreshButton) {
  dom.refreshButton.addEventListener('click', () => {
    bootstrap();
  });
}

if (dom.newProjectForm) {
  dom.newProjectForm.addEventListener('submit', handleCreateProject);
}

if (dom.setActiveButton) {
  dom.setActiveButton.addEventListener('click', handleSetActive);
}

if (dom.deleteProjectButton) {
  dom.deleteProjectButton.addEventListener('click', handleDeleteProject);
}

bootstrap();

