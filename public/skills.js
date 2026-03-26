// @ts-check

const RESERVED_FILE_PATHS = new Set(['SKILL.md', 'agents/openai.yaml']);

const state = {
  skills: [],
  selectedSkillId: null,
  selectedFileOriginalPath: '',
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
  deleteSkillButton: /** @type {HTMLButtonElement | null} */ (document.getElementById('delete-skill-button')),
  toast: /** @type {HTMLElement | null} */ (document.getElementById('toast')),
};

const toast = typeof shared.createToastController === 'function' ? shared.createToastController(dom.toast) : { show() {} };

function showToast(message) {
  toast.show(message);
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
  const canEdit = Boolean(currentSkill && currentPath && !usingReservedPath);
  const isLoadedFile = Boolean(state.selectedFileOriginalPath) && currentPath === state.selectedFileOriginalPath;

  dom.newSkillFileButton.disabled = !currentSkill;
  dom.skillExtraFilePath.disabled = !currentSkill;
  dom.skillExtraFileContent.disabled = !currentSkill;
  dom.saveSkillFileButton.disabled = !canEdit;
  dom.deleteSkillFileButton.disabled = !currentSkill || !isLoadedFile;
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
  renderFileSummary([]);
  renderExtraFileList(null);
  clearFileEditor();
  dom.deleteSkillButton.disabled = true;
}

function fillSkillForm(skill) {
  dom.editorTitle.textContent = `编辑 Skill · ${skill.name}`;
  dom.skillId.value = skill.id;
  dom.skillName.value = skill.name || '';
  dom.skillDescription.value = skill.description || '';
  dom.skillFolderPath.value = skill.path || '';
  dom.skillBody.value = skill.body || '';
  dom.skillOpenAiYaml.value = skill.openaiYaml || '';
  renderFileSummary(skill.files || []);
  renderExtraFileList(skill);
  dom.deleteSkillButton.disabled = false;

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

  try {
    await refreshSkills();
  } catch (error) {
    showToast(error.message);
  }
}

init();
