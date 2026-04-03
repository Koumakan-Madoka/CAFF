// @ts-check

const RESERVED_FILE_PATHS = new Set(['SKILL.md', 'agents/openai.yaml']);

const state = {
  skills: [],
  selectedSkillId: null,
  selectedFileOriginalPath: '',
  activeTab: 'skills',
  modes: [],
  selectedModeId: null,
};

const shared = window.CaffShared || {};
const fetchJson = shared.fetchJson;

const dom = {
  refreshButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh-button')),
  newSkillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('new-skill-button')),
  skillList: /** @type {HTMLDivElement | null} */ (document.getElementById('skill-list')),
  editorTitle: /** @type {HTMLElement | null} */ (document.getElementById('editor-title')),
  skillForm: /** @type {HTMLFormElement | null} */ (document.getElementById('skill-form')),
  skillId: /** @type {HTMLInputElement | null} */ (document.getElementById('skill-id')),
  skillName: /** @type {HTMLInputElement | null} */ (document.getElementById('skill-name')),
  skillDescription: /** @type {HTMLInputElement | null} */ (document.getElementById('skill-description')),
  skillFolderPath: /** @type {HTMLInputElement | null} */ (document.getElementById('skill-folder-path')),
  skillBody: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('skill-body')),
  skillOpenAiYaml: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('skill-openai-yaml')),
  skillFileList: /** @type {HTMLElement | null} */ (document.getElementById('skill-file-list')),
  skillExtraFileList: /** @type {HTMLElement | null} */ (document.getElementById('skill-extra-file-list')),
  newSkillFileButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('new-skill-file-button')),
  skillExtraFilePath: /** @type {HTMLInputElement | null} */ (document.getElementById('skill-extra-file-path')),
  skillExtraFileContent: /** @type {HTMLTextAreaElement | null} */ (document.getElementById('skill-extra-file-content')),
  saveSkillFileButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-skill-file-button')),
  deleteSkillFileButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-skill-file-button')),
  saveSkillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-skill-button')),
  deleteSkillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-skill-button')),
  toast: /** @type {HTMLElement | null} */ (document.getElementById('toast')),

  // Tab elements
  tabSkills: /** @type {HTMLButtonElement | null} */ (document.getElementById('tab-skills')),
  tabModes: /** @type {HTMLButtonElement | null} */ (document.getElementById('tab-modes')),
  newModeButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('new-mode-button')),
  skillPanel: /** @type {HTMLElement | null} */ (document.getElementById('skill-panel')),
  modePanel: /** @type {HTMLElement | null} */ (document.getElementById('mode-panel')),
  modeList: /** @type {HTMLDivElement | null} */ (document.getElementById('mode-list')),

  // Mode form elements
  modeForm: /** @type {HTMLFormElement | null} */ (document.getElementById('mode-form')),
  modeId: /** @type {HTMLInputElement | null} */ (document.getElementById('mode-id')),
  modeName: /** @type {HTMLInputElement | null} */ (document.getElementById('mode-name')),
  modeDescription: /** @type {HTMLInputElement | null} */ (document.getElementById('mode-description')),
  modeLoadingStrategy: /** @type {HTMLSelectElement | null} */ (document.getElementById('mode-loading-strategy')),
  modeSkillCheckboxes: /** @type {HTMLElement | null} */ (document.getElementById('mode-skill-checkboxes')),
  modeEditorTitle: /** @type {HTMLElement | null} */ (document.getElementById('mode-editor-title')),
  saveModeButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('save-mode-button')),
  deleteModeButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-mode-button')),
};

const toast = typeof shared.createToastController === 'function' ? shared.createToastController(dom.toast) : { show() {} };

function showToast(message) {
  toast.show(message);
}

function setMainSkillFormReadOnly(isReadOnly) {
  const readOnly = Boolean(isReadOnly);

  dom.skillName.readOnly = readOnly;
  dom.skillDescription.readOnly = readOnly;
  dom.skillBody.readOnly = readOnly;
  dom.skillOpenAiYaml.readOnly = readOnly;

  if (dom.saveSkillButton) {
    dom.saveSkillButton.disabled = readOnly;
  }
}

function normalizeFilePath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function skillById(skillId) {
  return state.skills.find((skill) => skill.id === skillId) || null;
}

function ensureSelectedSkill() {
  if (state.selectedSkillId && skillById(state.selectedSkillId)) {
    return;
  }

  state.selectedSkillId = state.skills[0] ? state.skills[0].id : null;
}

function mergeSkillDetail(skill) {
  if (!skill || !skill.id) {
    return;
  }

  const index = state.skills.findIndex((item) => item.id === skill.id);

  if (index === -1) {
    state.skills.push(skill);
    return;
  }

  state.skills[index] = {
    ...state.skills[index],
    ...skill,
  };
}

function extraFilesForSkill(skill) {
  return Array.isArray(skill && skill.files) ? skill.files.filter((filePath) => !RESERVED_FILE_PATHS.has(filePath)) : [];
}

function renderFileSummary(files) {
  dom.skillFileList.innerHTML = '';

  if (!Array.isArray(files) || files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Save the skill to see files in this folder.';
    dom.skillFileList.appendChild(empty);
    return;
  }

  files.forEach((file) => {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    chip.textContent = file;
    dom.skillFileList.appendChild(chip);
  });
}

function updateFileEditorActions() {
  const currentSkill = skillById(state.selectedSkillId);
  const currentPath = normalizeFilePath(dom.skillExtraFilePath.value);
  const usingReservedPath = RESERVED_FILE_PATHS.has(currentPath);
  const isReadOnly = Boolean(currentSkill && currentSkill.readOnly);
  const canEdit = Boolean(currentSkill && currentPath && !usingReservedPath && !isReadOnly);
  const isLoadedFile = Boolean(state.selectedFileOriginalPath) && currentPath === state.selectedFileOriginalPath;

  dom.newSkillFileButton.disabled = !currentSkill || isReadOnly;
  dom.skillExtraFilePath.disabled = !currentSkill;
  dom.skillExtraFileContent.disabled = !currentSkill || isReadOnly;
  dom.saveSkillFileButton.disabled = !canEdit;
  dom.deleteSkillFileButton.disabled = !currentSkill || !isLoadedFile || isReadOnly;
}

function clearFileEditor(draftPath = '') {
  state.selectedFileOriginalPath = '';
  dom.skillExtraFilePath.value = draftPath;
  dom.skillExtraFileContent.value = '';
  updateFileEditorActions();
}

function fillFileEditor(file) {
  state.selectedFileOriginalPath = file.path || '';
  dom.skillExtraFilePath.value = file.path || '';
  dom.skillExtraFileContent.value = file.content || '';
  updateFileEditorActions();
}

function renderExtraFileList(skill) {
  dom.skillExtraFileList.innerHTML = '';

  if (!skill) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = 'Save a skill first, then you can manage extra files here.';
    dom.skillExtraFileList.appendChild(empty);
    return;
  }

  const files = extraFilesForSkill(skill);

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact-empty-state';
    empty.textContent = 'No extra files yet. Create one for references or scripts.';
    dom.skillExtraFileList.appendChild(empty);
    return;
  }

  files.forEach((filePath) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'skill-file-item';
    item.dataset.path = filePath;

    if (filePath === state.selectedFileOriginalPath) {
      item.classList.add('active');
    }

    const fileName = document.createElement('strong');
    fileName.textContent = filePath.split('/').pop() || filePath;

    const pathLine = document.createElement('div');
    pathLine.className = 'muted skill-file-item-path';
    pathLine.textContent = filePath;

    item.append(fileName, pathLine);
    dom.skillExtraFileList.appendChild(item);
  });
}

function resetSkillForm() {
  dom.editorTitle.textContent = '新建 Skill';
  dom.skillId.value = '';
  dom.skillName.value = '';
  dom.skillDescription.value = '';
  dom.skillFolderPath.value = '';
  dom.skillBody.value = '';
  dom.skillOpenAiYaml.value = '';
  setMainSkillFormReadOnly(false);
  renderFileSummary([]);
  renderExtraFileList(null);
  clearFileEditor();
  dom.deleteSkillButton.disabled = true;
}

function fillSkillForm(skill) {
  dom.editorTitle.textContent = `${skill && skill.readOnly ? '查看 Skill' : '编辑 Skill'} · ${skill.name}`;
  dom.skillId.value = skill.id;
  dom.skillName.value = skill.name || '';
  dom.skillDescription.value = skill.description || '';
  dom.skillFolderPath.value = skill.path || '';
  dom.skillBody.value = skill.body || '';
  dom.skillOpenAiYaml.value = skill.openaiYaml || '';
  setMainSkillFormReadOnly(Boolean(skill && skill.readOnly));
  renderFileSummary(skill.files || []);
  renderExtraFileList(skill);
  dom.deleteSkillButton.disabled = Boolean(skill && skill.readOnly);

  if (!state.selectedFileOriginalPath || !extraFilesForSkill(skill).includes(state.selectedFileOriginalPath)) {
    clearFileEditor();
  } else {
    updateFileEditorActions();
  }
}

function renderSkillList() {
  ensureSelectedSkill();
  dom.skillList.innerHTML = '';

  if (state.skills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No skills yet. Create one first.';
    dom.skillList.appendChild(empty);
    return;
  }

  state.skills.forEach((skill) => {
    const item = document.createElement('div');
    item.className = 'agent-list-item';
    item.dataset.id = skill.id;

    if (skill.id === state.selectedSkillId) {
      item.classList.add('active');
    }

    const content = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = skill.name;

    const description = document.createElement('div');
    description.className = 'muted';
    description.textContent = `${skill.description || 'No description'} | ${skill.id}`;

    content.append(name, description);
    item.appendChild(content);
    dom.skillList.appendChild(item);
  });
}

function renderAll() {
  renderSkillList();

  const selectedSkill = skillById(state.selectedSkillId);

  if (selectedSkill) {
    fillSkillForm(selectedSkill);
  } else {
    resetSkillForm();
  }

  updateFileEditorActions();
}

async function refreshSkills(preferredSkillId) {
  const data = await fetchJson('/api/skills');
  state.skills = Array.isArray(data.skills) ? data.skills : [];
  state.selectedSkillId =
    preferredSkillId && state.skills.some((skill) => skill.id === preferredSkillId) ? preferredSkillId : state.selectedSkillId;
  ensureSelectedSkill();
  renderAll();
}

async function loadSkill(skillId) {
  if (!skillId) {
    state.selectedSkillId = null;
    state.selectedFileOriginalPath = '';
    renderAll();
    return;
  }

  const data = await fetchJson(`/api/skills/${encodeURIComponent(skillId)}`);
  mergeSkillDetail(data.skill);
  state.selectedSkillId = data.skill.id;
  renderAll();
}

async function loadSkillFile(skillId, filePath) {
  const data = await fetchJson(`/api/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(filePath)}`);
  fillFileEditor(data.file);
  renderExtraFileList(skillById(skillId));
}

function serializeSkillForm() {
  return {
    id: dom.skillId.value.trim(),
    name: dom.skillName.value.trim(),
    description: dom.skillDescription.value.trim(),
    body: dom.skillBody.value.trim(),
    openaiYaml: dom.skillOpenAiYaml.value.trim(),
  };
}

async function saveSelectedSkillFile() {
  const skill = skillById(state.selectedSkillId);

  if (!skill) {
    showToast('Save the skill first.');
    return;
  }

  const filePath = normalizeFilePath(dom.skillExtraFilePath.value);

  if (!filePath) {
    showToast('File path is required.');
    return;
  }

  if (RESERVED_FILE_PATHS.has(filePath)) {
    showToast('Edit SKILL.md and agents/openai.yaml in the form above.');
    return;
  }

  const result = await fetchJson(`/api/skills/${encodeURIComponent(skill.id)}/files?path=${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    body: {
      content: dom.skillExtraFileContent.value,
    },
  });

  state.skills = Array.isArray(result.skills) ? result.skills : state.skills;
  state.selectedSkillId = result.skill.id;
  renderAll();
  fillFileEditor(result.file);
  renderExtraFileList(skillById(result.skill.id));
  showToast('Skill file saved.');
}

async function deleteSelectedSkillFile() {
  const skill = skillById(state.selectedSkillId);
  const filePath = normalizeFilePath(dom.skillExtraFilePath.value);

  if (!skill || !filePath || !state.selectedFileOriginalPath || filePath !== state.selectedFileOriginalPath) {
    return;
  }

  if (!window.confirm(`Delete file "${filePath}"?`)) {
    return;
  }

  const result = await fetchJson(`/api/skills/${encodeURIComponent(skill.id)}/files?path=${encodeURIComponent(filePath)}`, {
    method: 'DELETE',
  });

  state.skills = Array.isArray(result.skills) ? result.skills : state.skills;
  state.selectedSkillId = result.skill.id;
  state.selectedFileOriginalPath = '';
  renderAll();
  showToast('Skill file deleted.');
}

function switchTab(tab) {
  state.activeTab = tab;
  const isSkills = tab === 'skills';

  dom.tabSkills.classList.toggle('active', isSkills);
  dom.tabModes.classList.toggle('active', !isSkills);
  dom.skillList.style.display = isSkills ? '' : 'none';
  dom.modeList.style.display = isSkills ? 'none' : '';
  dom.newSkillButton.style.display = isSkills ? '' : 'none';
  dom.newModeButton.style.display = isSkills ? 'none' : '';
  dom.skillPanel.style.display = isSkills ? '' : 'none';
  dom.modePanel.style.display = isSkills ? 'none' : '';

  if (!isSkills) {
    refreshModes();
  }
}

function modeById(modeId) {
  return state.modes.find((mode) => mode.id === modeId) || null;
}

function resetModeForm() {
  dom.modeEditorTitle.textContent = '新建模式';
  dom.modeId.value = '';
  dom.modeName.value = '';
  dom.modeName.readOnly = false;
  dom.modeDescription.value = '';
  dom.modeLoadingStrategy.value = 'dynamic';
  dom.deleteModeButton.disabled = true;
  renderModeSkillCheckboxes([]);
}

function fillModeForm(mode) {
  dom.modeEditorTitle.textContent = `${mode.builtin ? '编辑内置模式' : '编辑模式'} · ${mode.name}`;
  dom.modeId.value = mode.id;
  dom.modeName.value = mode.name || '';
  dom.modeDescription.value = mode.description || '';
  dom.modeLoadingStrategy.value = mode.loadingStrategy || 'dynamic';
  dom.modeName.readOnly = mode.builtin;
  dom.deleteModeButton.disabled = mode.builtin;
  renderModeSkillCheckboxes(mode.skillIds || []);
}

function renderModeSkillCheckboxes(selectedSkillIds) {
  dom.modeSkillCheckboxes.innerHTML = '';

  if (state.skills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = '暂无可用 Skill，请先在 Skill 仓库创建。';
    dom.modeSkillCheckboxes.appendChild(empty);
    return;
  }

  const selectedSet = new Set(selectedSkillIds || []);

  state.skills.forEach((skill) => {
    const label = document.createElement('label');
    label.className = `skill-checkbox-item${selectedSet.has(skill.id) ? ' checked' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = skill.id;
    checkbox.checked = selectedSet.has(skill.id);

    const text = document.createElement('span');
    text.textContent = skill.name;

    label.append(checkbox, text);
    dom.modeSkillCheckboxes.appendChild(label);

    checkbox.addEventListener('change', () => {
      label.classList.toggle('checked', checkbox.checked);
    });
  });
}

function getSelectedModeSkillIds() {
  if (!dom.modeSkillCheckboxes) return [];
  const checkboxes = /** @type {NodeListOf<HTMLInputElement>} */ (
    dom.modeSkillCheckboxes.querySelectorAll('input[type="checkbox"]:checked')
  );
  return Array.from(checkboxes).map((cb) => cb.value);
}

function renderModeList() {
  dom.modeList.innerHTML = '';

  if (state.modes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无模式，点击「新建模式」创建。';
    dom.modeList.appendChild(empty);
    return;
  }

  state.modes.forEach((mode) => {
    const item = document.createElement('div');
    item.className = 'agent-list-item';
    item.dataset.id = mode.id;

    if (mode.id === state.selectedModeId) {
      item.classList.add('active');
    }

    const content = document.createElement('div');

    const header = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = mode.name;

    const builtinBadge = document.createElement('span');
    builtinBadge.className = `mode-badge ${mode.builtin ? 'builtin' : 'custom'}`;
    builtinBadge.textContent = mode.builtin ? '内置' : '自定义';

    const strategyBadge = document.createElement('span');
    strategyBadge.className = `strategy-badge ${mode.loadingStrategy}`;
    strategyBadge.textContent = mode.loadingStrategy === 'full' ? '全量' : '渐进';

    header.append(name, builtinBadge, strategyBadge);

    const description = document.createElement('div');
    description.className = 'muted';
    description.textContent = `${mode.description || '无描述'} · ${mode.skillIds.length} 个绑定 Skill`;

    content.append(header, description);
    item.appendChild(content);
    dom.modeList.appendChild(item);
  });
}

async function refreshModes(preferredModeId) {
  const data = await fetchJson('/api/modes');
  state.modes = Array.isArray(data.modes) ? data.modes : [];
  state.selectedModeId =
    preferredModeId && state.modes.some((mode) => mode.id === preferredModeId) ? preferredModeId : state.selectedModeId;

  if (state.selectedModeId && !modeById(state.selectedModeId)) {
    state.selectedModeId = state.modes[0] ? state.modes[0].id : null;
  }

  renderModeList();

  const selectedMode = modeById(state.selectedModeId);
  if (selectedMode) {
    fillModeForm(selectedMode);
  } else {
    resetModeForm();
  }
}

function bindModeEvents() {
  dom.tabSkills.addEventListener('click', () => switchTab('skills'));
  dom.tabModes.addEventListener('click', () => switchTab('modes'));

  dom.newModeButton.addEventListener('click', () => {
    state.selectedModeId = null;
    resetModeForm();
    renderModeList();
    dom.modeName.focus();
  });

  dom.modeList.addEventListener('click', (event) => {
    const item =
      event.target instanceof Element ? /** @type {HTMLElement | null} */ (event.target.closest('.agent-list-item')) : null;

    if (!item || !item.dataset.id) {
      return;
    }

    state.selectedModeId = item.dataset.id;
    const mode = modeById(state.selectedModeId);
    if (mode) {
      fillModeForm(mode);
    }
    renderModeList();
  });

  dom.modeForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      id: dom.modeId.value.trim(),
      name: dom.modeName.value.trim(),
      description: dom.modeDescription.value.trim(),
      loadingStrategy: dom.modeLoadingStrategy.value,
      skillIds: getSelectedModeSkillIds(),
    };

    if (!payload.name) {
      showToast('模式名称是必填项');
      return;
    }

    try {
      const result = await fetchJson(payload.id ? `/api/modes/${encodeURIComponent(payload.id)}` : '/api/modes', {
        method: payload.id ? 'PUT' : 'POST',
        body: payload,
      });

      state.modes = Array.isArray(result.modes) ? result.modes : state.modes;
      state.selectedModeId = result.mode.id;
      renderModeList();
      fillModeForm(result.mode);
      showToast(payload.id ? '模式已更新' : '模式已创建');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.deleteModeButton.addEventListener('click', async () => {
    const modeId = dom.modeId.value.trim();
    const mode = modeById(modeId);

    if (!mode || mode.builtin) {
      return;
    }

    if (!window.confirm(`确认删除模式「${mode.name}」？`)) {
      return;
    }

    try {
      const result = await fetchJson(`/api/modes/${encodeURIComponent(modeId)}`, {
        method: 'DELETE',
      });
      state.modes = Array.isArray(result.modes) ? result.modes : [];
      state.selectedModeId = null;
      renderModeList();
      resetModeForm();
      showToast('模式已删除');
    } catch (error) {
      showToast(error.message);
    }
  });
}

function bindEvents() {
  dom.refreshButton.addEventListener('click', async () => {
    try {
      await refreshSkills(state.selectedSkillId);
      showToast('Skill list refreshed.');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.newSkillButton.addEventListener('click', () => {
    state.selectedSkillId = null;
    state.selectedFileOriginalPath = '';
    renderAll();
    dom.skillName.focus();
  });

  dom.skillList.addEventListener('click', async (event) => {
    const item =
      event.target instanceof Element ? /** @type {HTMLElement | null} */ (event.target.closest('.agent-list-item')) : null;

    if (!item || !item.dataset.id) {
      return;
    }

    try {
      state.selectedFileOriginalPath = '';
      await loadSkill(item.dataset.id);
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.skillForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = serializeSkillForm();
    const existingSkill = payload.id ? skillById(payload.id) : null;

    if (existingSkill && existingSkill.readOnly) {
      showToast('Skill is read-only.');
      return;
    }

    if (!payload.name) {
      showToast('Skill name is required.');
      return;
    }

    if (!payload.description) {
      showToast('Skill description is required.');
      return;
    }

    if (!payload.body) {
      showToast('SKILL.md body is required.');
      return;
    }

    try {
      const result = await fetchJson(payload.id ? `/api/skills/${payload.id}` : '/api/skills', {
        method: payload.id ? 'PUT' : 'POST',
        body: payload,
      });

      state.skills = Array.isArray(result.skills) ? result.skills : state.skills;
      state.selectedSkillId = result.skill.id;
      state.selectedFileOriginalPath = '';
      await loadSkill(result.skill.id);
      showToast(payload.id ? 'Skill updated.' : 'Skill created.');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.deleteSkillButton.addEventListener('click', async () => {
    const skill = skillById(state.selectedSkillId);

    if (!skill) {
      return;
    }

    if (!window.confirm(`Delete skill "${skill.name}"?`)) {
      return;
    }

    try {
      const result = await fetchJson(`/api/skills/${skill.id}`, {
        method: 'DELETE',
      });
      state.skills = Array.isArray(result.skills) ? result.skills : [];
      state.selectedSkillId = null;
      state.selectedFileOriginalPath = '';
      ensureSelectedSkill();
      renderAll();
      showToast('Skill deleted.');
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.newSkillFileButton.addEventListener('click', () => {
    if (!skillById(state.selectedSkillId)) {
      showToast('Save the skill first.');
      return;
    }

    clearFileEditor('');
    renderExtraFileList(skillById(state.selectedSkillId));
    dom.skillExtraFilePath.focus();
  });

  dom.skillExtraFileList.addEventListener('click', async (event) => {
    const item =
      event.target instanceof Element ? /** @type {HTMLElement | null} */ (event.target.closest('.skill-file-item')) : null;

    if (!item || !item.dataset.path || !state.selectedSkillId) {
      return;
    }

    try {
      await loadSkillFile(state.selectedSkillId, item.dataset.path);
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.skillExtraFilePath.addEventListener('input', () => {
    updateFileEditorActions();
    renderExtraFileList(skillById(state.selectedSkillId));
  });

  dom.saveSkillFileButton.addEventListener('click', async () => {
    try {
      await saveSelectedSkillFile();
    } catch (error) {
      showToast(error.message);
    }
  });

  dom.deleteSkillFileButton.addEventListener('click', async () => {
    try {
      await deleteSelectedSkillFile();
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function init() {
  bindEvents();
  bindModeEvents();

  try {
    await refreshSkills();
  } catch (error) {
    showToast(error.message);
  }
}

init();
