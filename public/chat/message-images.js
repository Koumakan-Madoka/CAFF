// @ts-check

(function registerMessageImagesModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  function messageImageBlocks(message) {
    const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    const blocks = metadata && Array.isArray(metadata.contentBlocks) ? metadata.contentBlocks : [];
    return blocks.filter((block) => block && block.type === 'image');
  }

  function imageBlockSignature(message) {
    return JSON.stringify(messageImageBlocks(message).map((block) => [
      String(block.imageId || ''),
      String(block.url || ''),
      String(block.alt || ''),
      String(block.integrityStatus || block.integrity_status || ''),
    ]));
  }

  function safeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    if (raw.startsWith('/uploads/') || raw.startsWith('blob:')) {
      return raw;
    }
    try {
      const parsed = new URL(raw, window.location.href);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === window.location.origin) {
        return parsed.href;
      }
    } catch {}
    return '';
  }

  function createFallback(block, index) {
    const fallback = document.createElement('div');
    const label = document.createElement('span');
    fallback.className = 'message-image-fallback';
    label.className = 'message-image-fallback-label';
    label.textContent = block && (block.integrityStatus === 'missing_file' || block.integrity_status === 'missing_file')
      ? '图片文件已缺失'
      : `图片 ${index + 1} 无法显示`;
    fallback.appendChild(label);
    return fallback;
  }

  function appendFallbackActions(fallback, url, retry) {
    const actions = document.createElement('span');
    const retryButton = document.createElement('button');
    const openLink = document.createElement('a');
    actions.className = 'message-image-fallback-actions';
    retryButton.type = 'button';
    retryButton.className = 'ghost-button';
    retryButton.textContent = '重试';
    retryButton.addEventListener('click', retry);
    openLink.href = url;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = '新标签打开';
    actions.append(retryButton, openLink);
    fallback.appendChild(actions);
  }

  function createImageTile(block, index) {
    const tile = document.createElement('figure');
    const fallback = createFallback(block, index);
    const url = safeImageUrl(block && block.url);
    tile.className = 'message-image-tile';

    if (!url || block.integrityStatus === 'missing_file' || block.integrity_status === 'missing_file') {
      fallback.hidden = false;
      tile.appendChild(fallback);
      return tile;
    }

    const link = document.createElement('a');
    const image = document.createElement('img');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'message-image-link';
    link.setAttribute('aria-label', `在新标签页打开图片 ${index + 1}`);
    image.src = url;
    image.alt = String(block.alt || `消息图片 ${index + 1}`);
    image.loading = 'lazy';
    image.decoding = 'async';
    fallback.hidden = true;
    image.addEventListener('load', () => {
      image.hidden = false;
      fallback.hidden = true;
      tile.classList.remove('failed');
    });
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
      tile.classList.add('failed');
    });
    appendFallbackActions(fallback, url, () => {
      image.hidden = false;
      fallback.hidden = true;
      tile.classList.remove('failed');
      image.removeAttribute('src');
      image.src = url;
    });
    link.appendChild(image);
    tile.append(link, fallback);
    return tile;
  }

  function syncMessageImages(container, message) {
    const blocks = messageImageBlocks(message);
    container.className = `message-images${blocks.length === 1 ? ' single' : blocks.length > 1 ? ' multiple' : ''}`;
    container.hidden = blocks.length === 0;
    if (blocks.length === 0) {
      container.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    blocks.forEach((block, index) => {
      fragment.appendChild(createImageTile(block, index));
    });
    container.replaceChildren(fragment);
  }

  chat.messageImages = Object.freeze({
    imageBlockSignature,
    messageImageBlocks,
    syncMessageImages,
  });
})();
