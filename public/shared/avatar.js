// @ts-check

(function registerAvatarUtils() {
  const shared = window.CaffShared || (window.CaffShared = {});
  const MAX_AVATAR_FILE_SIZE = 1024 * 1024;

  function avatarInitial(name) {
    const value = String(name || '').trim();
    return value ? value.slice(0, 1).toUpperCase() : 'A';
  }

  function buildAgentAvatarElement(agent, className = '') {
    const element = document.createElement('span');
    const classes = ['agent-avatar'];

    if (className) {
      classes.push(...String(className).split(/\s+/).filter(Boolean));
    }

    element.className = classes.join(' ');

    if (agent && agent.accentColor) {
      element.style.setProperty('--agent-color', agent.accentColor);
    }

    if (agent && agent.avatarDataUrl) {
      const image = document.createElement('img');
      image.src = agent.avatarDataUrl;
      image.alt = agent.name ? `${agent.name} avatar` : 'Agent avatar';
      element.appendChild(image);
      return element;
    }

    element.classList.add('avatar-fallback');
    element.textContent = avatarInitial(agent && agent.name ? agent.name : '');
    return element;
  }

  function renderAvatarPreview(container, dataUrl, name, accentColor = '#3d405b') {
    if (!container) {
      return;
    }

    container.className = 'agent-avatar large avatar-preview';
    container.style.setProperty('--agent-color', accentColor || '#3d405b');
    container.textContent = '';

    if (dataUrl) {
      const image = document.createElement('img');
      image.src = dataUrl;
      image.alt = name ? `${name} avatar preview` : 'Avatar preview';
      container.appendChild(image);
      return;
    }

    container.classList.add('avatar-fallback');
    container.textContent = avatarInitial(name);
  }

  function readAvatarFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        resolve('');
        return;
      }

      if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type)) {
        reject(new Error('头像仅支持 PNG、JPEG、WEBP 或 GIF'));
        return;
      }

      if (file.size > MAX_AVATAR_FILE_SIZE) {
        reject(new Error('头像文件不能超过 1MB'));
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        resolve(typeof reader.result === 'string' ? reader.result : '');
      };
      reader.onerror = () => {
        reject(new Error('头像读取失败，请重试'));
      };
      reader.readAsDataURL(file);
    });
  }

  shared.avatar = {
    avatarInitial,
    buildAgentAvatarElement,
    readAvatarFileAsDataUrl,
    renderAvatarPreview,
  };
})();
