// @ts-check

(function registerRoleEditor() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});

  namespace.createRoleEditor = function createRoleEditor(options) {
    const root = options.root;
    const utils = namespace.managementUtils;
    let draft = null;

    function isFamily() {
      return draft && draft.roleKind === 'model_family';
    }

    function modelOptions() {
      return utils.roleModelOptions(draft, options.getModelOptions());
    }

    function updateModel(target, key) {
      const option = options.getModelOptions().find((item) => item.key === key) || null;
      target.provider = option ? option.provider : '';
      target.model = option ? option.model : '';
      const levels = utils.supportedThinkingLevels(options.getModelOptions(), target.provider, target.model);
      if (target.thinking && !levels.includes(target.thinking)) {
        target.thinking = '';
        return true;
      }
      return false;
    }

    function profileMarkup(profile, index) {
      return `
        <article class="runtime-profile" data-runtime-profile data-profile-index="${index}">
          <div class="runtime-profile-head">
            <strong>运行 Profile ${index + 1}</strong>
            <button class="ghost-button" type="button" data-remove-runtime-profile="${index}">移除</button>
          </div>
          <div class="field-grid">
            <label><span>名称</span><input data-field="name" value="${utils.escapeHtml(profile.name || '')}" placeholder="例如：深度推理" /></label>
            <label><span>说明</span><input data-field="description" value="${utils.escapeHtml(profile.description || '')}" placeholder="适用任务" /></label>
          </div>
          <div class="field-grid">
            <label><span>模型</span><select data-field="model"></select></label>
            <label><span>思考强度</span><select data-field="thinking"></select></label>
          </div>
          ${isFamily() ? '' : `<label><span>Profile Persona Prompt</span><textarea data-field="personaPrompt" data-profile-persona rows="4">${utils.escapeHtml(profile.personaPrompt || '')}</textarea></label>`}
        </article>`;
    }

    function avatarUploadMarkup() {
      return `
        <div class="avatar-upload-row">
          <div id="role-avatar-preview" class="agent-avatar large avatar-preview">AI</div>
          <div class="avatar-upload-actions">
            <input id="role-avatar-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
            <input id="role-avatar-data" type="hidden" value="${utils.escapeHtml(draft.avatarDataUrl || '')}" />
            <button id="clear-role-avatar" class="ghost-button" type="button">移除头像</button>
          </div>
        </div>`;
    }

    function identityMarkup() {
      if (isFamily()) {
        return `
          <section class="management-card">
            <div class="management-card-title"><div><h3>系统身份</h3><p>展示身份与模型族边界由 CAFF 维护；头像可自定义。</p></div><span class="status-badge system">系统维护</span></div>
            <div class="field-grid">
              <label><span>名称</span><input value="${utils.escapeHtml(draft.name)}" readonly /></label>
              <label><span>稳定 ID</span><input value="${utils.escapeHtml(draft.id)}" readonly /></label>
              <label><span>角色类型</span><input value="model_family" readonly /></label>
              <label><span>模型族</span><input value="${utils.escapeHtml(draft.modelFamily)}" readonly /></label>
            </div>
            <div class="role-identity-extras">
              ${avatarUploadMarkup()}
            </div>
            <p class="management-note">名称、颜色、稳定 ID、角色类型和族归属不可通过普通保存覆盖。</p>
          </section>`;
      }
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>角色身份</h3><p>自定义角色继续保留现有身份与工作目录能力。</p></div></div>
          <div class="field-grid">
            <label><span>名称</span><input id="role-name" value="${utils.escapeHtml(draft.name || '')}" maxlength="40" /></label>
            <label><span>稳定 ID</span><input value="${utils.escapeHtml(draft.id || '保存时生成')}" readonly /></label>
            <label><span>角色说明</span><input id="role-description" value="${utils.escapeHtml(draft.description || '')}" maxlength="120" /></label>
            <label><span>工作目录名</span><input id="role-sandbox-name" value="${utils.escapeHtml(draft.sandboxName || '')}" maxlength="80" /></label>
          </div>
          <div class="role-identity-extras">
            ${avatarUploadMarkup()}
            <label><span>主色</span><input id="role-accent-color" type="color" value="${utils.escapeHtml(draft.accentColor || '#3d405b')}" /></label>
          </div>
        </section>`;
    }

    function customPersonaMarkup() {
      if (isFamily()) return '';
      const selected = new Set(Array.isArray(draft.skillIds || draft.skills) ? draft.skillIds || draft.skills : []);
      const skillOptions = options.getSkills().map((skill) => `
        <label class="skill-option"><input name="role-skill" type="checkbox" value="${utils.escapeHtml(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''} />
          <span><strong>${utils.escapeHtml(skill.name || skill.id)}</strong><small>${utils.escapeHtml(skill.description || skill.id)}</small></span>
        </label>`).join('');
      return `
        <section class="management-card">
          <div class="management-card-title"><div><h3>Persona 与 Skills</h3><p>Persona 能力只属于自定义角色。</p></div></div>
          <label><span>默认 Persona Prompt</span><textarea id="role-persona-prompt" rows="6">${utils.escapeHtml(draft.personaPrompt || '')}</textarea></label>
          <div class="skill-options">${skillOptions || '<div class="empty-state">还没有可选 Skill。</div>'}</div>
        </section>`;
    }

    function render() {
      if (!draft) {
        root.innerHTML = '<div class="empty-state">选择一个角色查看详情。</div>';
        return;
      }
      const availability = draft.availability || { status: 'available' };
      const available = availability.status === 'available';
      const optionsForRole = modelOptions();
      const canConfigureRuntime = !isFamily() || optionsForRole.length > 0;
      const profiles = Array.isArray(draft.modelProfiles) ? draft.modelProfiles : [];
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">${isFamily() ? 'System Model Family' : 'Custom Role'}</p><h2>${utils.escapeHtml(draft.name || '新建自定义角色')}</h2><p>${utils.escapeHtml(draft.description || '尚未填写角色说明')}</p></div>
          <div class="detail-badges"><span class="status-badge ${isFamily() ? 'system' : 'neutral'}">${isFamily() ? '系统模型族' : '自定义角色'}</span><span class="status-badge ${available ? '' : 'warning'}">${utils.availabilityCopy(availability)}</span></div>
        </div>
        <div class="provider-source-note"><p><strong>模型来自聚合目录</strong><br />${isFamily() ? '这里只显示 catalog 归类为本模型族的条目。' : '自定义角色可以选择 catalog 中任意模型。'}</p><button id="manage-providers-from-role" class="ghost-button" type="button">管理模型供应商</button></div>
        ${available ? '' : `<div class="management-warning"><strong>当前不可用于聊天</strong><p>${utils.availabilityCopy(availability)}。修复配置后会自动恢复；系统身份不会消失。</p></div>`}
        ${identityMarkup()}
        <section class="management-card">
          <div class="management-card-title"><div><h3>默认运行配置</h3><p>${isFamily() ? '模型限定同族，思考强度来自 modelOptions.supportedThinkingLevels。' : 'Provider 由模型选项自动带出；可留空继承 runtime 默认。'}</p></div></div>
          <div class="field-grid">
            <label><span>默认模型</span><select id="role-default-model" ${canConfigureRuntime ? '' : 'disabled'}></select></label>
            <label><span>默认思考强度</span><select id="role-default-thinking" ${canConfigureRuntime ? '' : 'disabled'}></select></label>
          </div>
          <p class="management-note">不支持的旧值不会被就近夹取；切换模型时会明确重置为“跟随运行时默认”。</p>
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>运行 Profiles</h3><p>${isFamily() ? '同族模型与思考强度，不携带 Persona。' : '可跨族覆盖模型、思考强度和 Persona。'}</p></div><button id="add-runtime-profile" class="ghost-button" type="button" ${canConfigureRuntime ? '' : 'disabled'}>添加 Profile</button></div>
          <div class="runtime-profiles">${profiles.length ? profiles.map(profileMarkup).join('') : '<div class="empty-state">还没有运行 Profile。</div>'}</div>
        </section>
        ${customPersonaMarkup()}
        <section class="management-card"><div class="toggle-row"><div><h3>新建普通聊天时默认预选</h3><p>只影响未来打开的新建聊天表单，不追写已有会话。</p></div><button id="default-toggle" class="toggle" type="button" aria-label="新建普通聊天时默认预选 ${utils.escapeHtml(draft.name || '当前角色')}" aria-pressed="${Boolean(draft.isDefaultChatRole)}" ${available ? '' : 'disabled'}></button></div></section>
        <div class="management-actions"><button id="save-role" type="button">${draft.id ? '保存角色' : '创建自定义角色'}</button>${!isFamily() && draft.id ? '<button id="delete-role" class="ghost-button danger" type="button">删除角色</button>' : ''}</div>
        <p id="role-error" class="management-error hidden" role="alert"></p>`;

      utils.fillModelSelect(document.getElementById('role-default-model'), optionsForRole, draft.provider, draft.model, { allowEmpty: !isFamily() });
      utils.fillThinkingSelect(document.getElementById('role-default-thinking'), options.getModelOptions(), draft.provider, draft.model, draft.thinking || '');
      profiles.forEach((profile, index) => {
        const card = root.querySelector(`[data-profile-index="${index}"]`);
        utils.fillModelSelect(card.querySelector('[data-field="model"]'), optionsForRole, profile.provider, profile.model, { allowEmpty: false });
        utils.fillThinkingSelect(card.querySelector('[data-field="thinking"]'), options.getModelOptions(), profile.provider, profile.model, profile.thinking || '');
      });
      bindEvents();
      options.avatarUtils.renderAvatarPreview(document.getElementById('role-avatar-preview'), draft.avatarDataUrl || '', draft.name || '', draft.accentColor || '#3d405b');
    }

    function bindEvents() {
      document.getElementById('manage-providers-from-role').addEventListener('click', options.onManageProviders);
      document.getElementById('role-default-model').addEventListener('change', (event) => {
        const reset = updateModel(draft, /** @type {HTMLSelectElement} */ (event.target).value);
        render();
        document.getElementById('role-default-model').focus();
        if (reset) options.showToast('原思考强度不受新模型支持，已改为跟随运行时默认');
      });
      document.getElementById('role-default-thinking').addEventListener('change', (event) => { draft.thinking = /** @type {HTMLSelectElement} */ (event.target).value; });
      document.getElementById('add-runtime-profile').addEventListener('click', () => {
        const choices = modelOptions();
        const first = utils.findModelOption(options.getModelOptions(), draft.provider, draft.model) || choices[0] || null;
        const index = (draft.modelProfiles || []).length;
        draft.modelProfiles = Array.isArray(draft.modelProfiles) ? draft.modelProfiles : [];
        draft.modelProfiles.push({ id: utils.nextProfileId(draft.modelProfiles), name: '', description: '', provider: first ? first.provider : '', model: first ? first.model : '', thinking: '', personaPrompt: '' });
        render();
        root.querySelector(`[data-profile-index="${index}"] [data-field="name"]`).focus();
      });
      root.querySelectorAll('[data-remove-runtime-profile]').forEach((button) => button.addEventListener('click', () => {
        draft.modelProfiles.splice(Number(button.dataset.removeRuntimeProfile), 1);
        render();
        document.getElementById('add-runtime-profile').focus();
      }));
      root.querySelectorAll('[data-runtime-profile]').forEach((card) => {
        const index = Number(card.dataset.profileIndex);
        card.addEventListener('input', (event) => {
          const target = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (event.target);
          const field = target.dataset.field;
          if (field && field !== 'model' && field !== 'thinking') draft.modelProfiles[index][field] = target.value;
        });
        card.querySelector('[data-field="model"]').addEventListener('change', (event) => {
          const reset = updateModel(draft.modelProfiles[index], event.target.value);
          render();
          root.querySelector(`[data-profile-index="${index}"] [data-field="model"]`).focus();
          if (reset) options.showToast('Profile 原思考强度不受新模型支持，已改为跟随运行时默认');
        });
        card.querySelector('[data-field="thinking"]').addEventListener('change', (event) => { draft.modelProfiles[index].thinking = /** @type {HTMLSelectElement} */ (event.target).value; });
      });
      document.getElementById('default-toggle').addEventListener('click', () => { draft.isDefaultChatRole = !draft.isDefaultChatRole; render(); options.onDraftChange(draft); });
      document.getElementById('save-role').addEventListener('click', async () => {
        try { await options.onSave(draft, utils.buildRolePayload(draft, options.getModelOptions())); } catch (error) { const target = document.getElementById('role-error'); target.textContent = utils.requestIssueMessage(error, '角色保存失败'); target.classList.remove('hidden'); }
      });
      const deleteButton = document.getElementById('delete-role');
      if (deleteButton) deleteButton.addEventListener('click', () => options.onDelete(draft));
      bindAvatarEvents();
      if (!isFamily()) bindCustomEvents();
    }

    function bindAvatarEvents() {
      document.getElementById('role-avatar-file').addEventListener('change', async (event) => {
        const target = /** @type {HTMLInputElement} */ (event.target);
        const file = target.files && target.files[0];
        try { draft.avatarDataUrl = await options.avatarUtils.readAvatarFileAsDataUrl(file); render(); } catch (error) { options.showToast(error.message); }
      });
      document.getElementById('clear-role-avatar').addEventListener('click', () => { draft.avatarDataUrl = ''; render(); });
    }

    function bindCustomEvents() {
      for (const [id, field] of [['role-name', 'name'], ['role-description', 'description'], ['role-sandbox-name', 'sandboxName'], ['role-persona-prompt', 'personaPrompt'], ['role-accent-color', 'accentColor']]) {
        document.getElementById(id).addEventListener('input', (event) => { draft[field] = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (event.target).value; });
      }
      root.querySelectorAll('input[name="role-skill"]').forEach((input) => input.addEventListener('change', () => {
        draft.skillIds = Array.from(root.querySelectorAll('input[name="role-skill"]:checked')).map((item) => item.value);
      }));
    }

    return {
      show(role) { draft = utils.clone(role); render(); },
      currentId() { return draft && draft.id || ''; },
    };
  };
})();
