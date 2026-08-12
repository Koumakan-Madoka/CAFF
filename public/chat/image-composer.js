// @ts-check

(function registerImageComposerModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createImageComposerController = function createImageComposerController({ dom, helpers, showToast }) {
    const requiredDom = ['composerInput', 'sendButton', 'attachButton', 'fileInput', 'strip', 'status'];
    for (const key of requiredDom) {
      if (!dom || !dom[key]) {
        throw new Error(`Image composer requires dom.${key}`);
      }
    }

    const requiredHelpers = [
      'createClientRequestId',
      'getConversationId',
      'fetchConfig',
      'uploadBatch',
      'createObjectURL',
      'revokeObjectURL',
    ];
    for (const key of requiredHelpers) {
      if (!helpers || typeof helpers[key] !== 'function') {
        throw new Error(`Image composer requires helpers.${key}`);
      }
    }

    let uploadConfig = null;
    let configState = 'idle';
    let configError = '';
    let baseComposerEnabled = false;
    let currentConversationId = String(helpers.getConversationId() || '').trim();
    let uploadRequestId = '';
    let revision = 0;
    let itemSequence = 0;
    let items = [];
    let lastOperation = Promise.resolve();
    let imageMessageSending = false;
    let activeMessageSendToken = null;
    let pendingMessageSubmission = null;
    const confirmedMessageSendTokens = new WeakSet();

    function normalizedContent(value) {
      return String(value || '').trim();
    }

    function hasPayload(content) {
      return normalizedContent(content).length > 0 || items.length > 0;
    }

    function everyItemReady() {
      return items.every((item) => item.status === 'ready');
    }

    function canSend(content) {
      return baseComposerEnabled && !imageMessageSending && hasPayload(content) && everyItemReady();
    }

    function cloneItem(item) {
      return {
        id: item.id,
        name: item.file.name,
        type: item.file.type,
        size: item.file.size,
        previewUrl: item.previewUrl,
        status: item.status,
        error: item.error,
        imageId: item.imageId,
        retryable: Boolean(item.retryable),
      };
    }

    function snapshot() {
      return {
        configState,
        configError,
        uploadRequestId,
        conversationId: currentConversationId,
        imageMessageSending,
        items: items.map(cloneItem),
      };
    }

    function statusLabel(item) {
      if (item.status === 'ready') {
        return '已就绪';
      }
      if (item.status === 'rejected') {
        return '需要处理';
      }
      return '正在校验并上传';
    }

    function renderStrip() {
      const fragment = document.createDocumentFragment();

      for (const item of items) {
        const card = document.createElement('article');
        const preview = document.createElement('div');
        const copy = document.createElement('div');
        const name = document.createElement('strong');
        const state = document.createElement('span');
        const actions = document.createElement('div');
        const removeButton = document.createElement('button');

        card.className = `composer-attachment ${item.status}`;
        card.dataset.attachmentId = item.id;
        preview.className = 'composer-attachment-preview';
        copy.className = 'composer-attachment-copy';
        name.className = 'composer-attachment-name';
        state.className = 'composer-attachment-state';
        actions.className = 'composer-attachment-actions';
        removeButton.type = 'button';
        removeButton.className = 'icon-btn composer-attachment-remove';
        removeButton.disabled = imageMessageSending;
        removeButton.setAttribute('aria-label', `移除图片 ${item.file.name}`);
        removeButton.textContent = '×';
        removeButton.addEventListener('click', () => {
          void removeItem(item.id);
        });

        if (String(item.file.type || '').startsWith('image/') && item.previewUrl) {
          const image = document.createElement('img');
          image.src = item.previewUrl;
          image.alt = '';
          preview.appendChild(image);
        } else {
          preview.textContent = 'IMG';
        }

        name.textContent = item.file.name || '未命名图片';
        state.textContent = item.error || statusLabel(item);
        copy.append(name, state);

        if (item.status === 'rejected' && !item.localError && item.retryable) {
          const retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'ghost-button composer-attachment-retry';
          retryButton.disabled = imageMessageSending;
          retryButton.textContent = '重试整批';
          retryButton.addEventListener('click', () => {
            void retryUpload();
          });
          actions.appendChild(retryButton);
        }

        actions.appendChild(removeButton);
        card.append(preview, copy, actions);
        fragment.appendChild(card);
      }

      dom.strip.replaceChildren(fragment);
      dom.strip.classList.toggle('hidden', items.length === 0);
    }

    function renderStatus() {
      if (configState === 'loading') {
        dom.status.textContent = '正在读取图片限制…';
        return;
      }
      if (configState === 'failed') {
        dom.status.textContent = `图片入口不可用：${configError}`;
        return;
      }
      if (imageMessageSending) {
        dom.status.textContent = '图片消息正在发送…';
        return;
      }
      if (items.some((item) => item.status === 'pending_validation')) {
        dom.status.textContent = `正在处理 ${items.length} 张图片…`;
        return;
      }
      if (items.some((item) => item.status === 'rejected')) {
        dom.status.textContent = items.some((item) => item.retryable)
          ? '图片尚未就绪，请移除问题项或重试整批。'
          : '图片批次已被拒绝，请移除或重新选择图片后再试。';
        return;
      }
      if (items.length > 0) {
        dom.status.textContent = `${items.length} 张图片已就绪。`;
        return;
      }
      dom.status.textContent = configState === 'ready' ? '可选择或粘贴图片。' : '';
    }

    function renderAvailability() {
      const attachmentEntryEnabled = configState === 'ready' && baseComposerEnabled && !imageMessageSending;
      if (imageMessageSending) {
        dom.composerInput.disabled = true;
      }
      dom.attachButton.disabled = !attachmentEntryEnabled;
      dom.fileInput.disabled = !attachmentEntryEnabled;
      dom.sendButton.disabled = !canSend(dom.composerInput.value);
    }

    function render() {
      renderStrip();
      renderStatus();
      renderAvailability();
    }

    function track(promise) {
      lastOperation = Promise.resolve(promise).catch((error) => {
        if (typeof showToast === 'function') {
          showToast(error && error.message ? error.message : String(error));
        }
      });
      return lastOperation;
    }

    function invalidatePendingMessageSubmission() {
      pendingMessageSubmission = null;
    }

    function clearItems() {
      const composerInputWasDisabled = activeMessageSendToken
        ? Boolean(activeMessageSendToken.composerInputWasDisabled)
        : dom.composerInput.disabled;
      for (const item of items) {
        if (item.previewUrl) {
          helpers.revokeObjectURL(item.previewUrl);
        }
      }
      items = [];
      uploadRequestId = '';
      imageMessageSending = false;
      activeMessageSendToken = null;
      invalidatePendingMessageSubmission();
      dom.composerInput.disabled = composerInputWasDisabled;
      revision += 1;
      dom.fileInput.value = '';
      render();
    }

    function validateFile(file, prospectiveCount) {
      if (!uploadConfig) {
        return '图片配置尚未加载。';
      }
      if (prospectiveCount > Number(uploadConfig.maxImagesPerUpload || uploadConfig.maxImagesPerMessage || 0)) {
        return `每次最多选择 ${uploadConfig.maxImagesPerUpload || uploadConfig.maxImagesPerMessage} 张图片。`;
      }
      const allowedTypes = Array.isArray(uploadConfig.allowedMimeTypes) ? uploadConfig.allowedMimeTypes : [];
      if (!allowedTypes.includes(String(file && file.type || '').trim())) {
        return '图片类型不受支持。';
      }
      if (Number(file && file.size || 0) > Number(uploadConfig.maxImageBytes || 0)) {
        return `图片 ${file.name || ''} 超过大小限制。`;
      }
      return '';
    }

    function uploadErrorDetails(error) {
      const payloadError = error && error.payload && error.payload.error;
      const code = payloadError && typeof payloadError === 'object'
        ? String(payloadError.code || '').trim()
        : String(error && error.code || '').trim();
      const message = payloadError && typeof payloadError === 'object'
        ? String(payloadError.message || error.message || '').trim()
        : String(error && error.message || payloadError || '图片上传失败').trim();
      const status = Number(error && error.status || 0);
      if (code === 'UPLOAD_IN_PROGRESS') {
        return {
          code,
          message: '同一批图片仍在服务端处理中，请稍后重试。',
          retryable: true,
        };
      }
      if (code === 'UPLOAD_IDEMPOTENCY_CONFLICT') {
        return {
          code,
          message: '图片批次内容已经变化，请移除或重新选择后再试。',
          retryable: false,
        };
      }
      return {
        code,
        message: message || '图片上传失败。',
        retryable:
          code !== 'UPLOAD_RESPONSE_MISMATCH'
          && (status === 0 || status === 408 || status === 429 || status >= 500),
      };
    }

    function uploadResultError(result) {
      const structuredError = result && result.error && typeof result.error === 'object' ? result.error : null;
      const code = String(structuredError && structuredError.code || '').trim();
      if (!code) {
        return null;
      }
      /** @type {Error & { status?: number; code?: string; payload?: any }} */
      const error = new Error(String(structuredError.message || '图片上传失败').trim());
      error.status = code === 'UPLOAD_IN_PROGRESS' ? 202 : 200;
      error.code = code;
      error.payload = result;
      return error;
    }

    function responseMismatchError() {
      /** @type {Error & { status?: number; code?: string }} */
      const error = new Error('服务端返回的图片数量与当前批次不一致。');
      error.code = 'UPLOAD_RESPONSE_MISMATCH';
      error.status = 422;
      return error;
    }

    async function uploadCurrentBatch() {
      if (items.length === 0 || items.some((item) => item.localError)) {
        render();
        return false;
      }

      const conversationId = String(helpers.getConversationId() || currentConversationId || '').trim();
      if (!conversationId) {
        items.forEach((item) => {
          item.status = 'rejected';
          item.error = '请先选择一个房间。';
        });
        render();
        return false;
      }

      currentConversationId = conversationId;
      const operationRevision = revision;
      const operationRequestId = uploadRequestId;
      const operationItems = items.slice();
      operationItems.forEach((item) => {
        item.status = 'pending_validation';
        item.error = '';
        item.imageId = '';
        item.retryable = false;
      });
      render();

      try {
        const result = await helpers.uploadBatch({
          conversationId,
          clientRequestId: operationRequestId,
          files: operationItems.map((item) => item.file),
        });
        if (revision !== operationRevision || uploadRequestId !== operationRequestId) {
          return false;
        }
        const structuredResultError = uploadResultError(result);
        if (structuredResultError) {
          throw structuredResultError;
        }
        const images = result && Array.isArray(result.images) ? result.images : [];
        if (
          images.length !== operationItems.length
          || images.some((image) => !String(image && image.imageId || '').trim())
        ) {
          throw responseMismatchError();
        }
        operationItems.forEach((item, index) => {
          item.status = 'ready';
          item.error = '';
          item.imageId = String(images[index].imageId).trim();
          item.retryable = false;
        });
        render();
        return true;
      } catch (error) {
        if (revision !== operationRevision || uploadRequestId !== operationRequestId) {
          return false;
        }
        const details = uploadErrorDetails(error);
        operationItems.forEach((item) => {
          item.status = 'rejected';
          item.error = details.message;
          item.imageId = '';
          item.retryable = details.retryable;
        });
        render();
        return false;
      }
    }

    async function addFilesInternal(files) {
      if (imageMessageSending) {
        if (typeof showToast === 'function') {
          showToast('图片消息正在发送，请等待完成后再添加图片。');
        }
        return false;
      }
      const incoming = Array.from(files || []).filter(Boolean);
      if (incoming.length === 0) {
        return false;
      }
      if (configState !== 'ready' || !uploadConfig) {
        const message = configError || '图片配置尚未加载。';
        if (typeof showToast === 'function') {
          showToast(message);
        }
        return false;
      }

      const prospectiveCount = items.length + incoming.length;
      invalidatePendingMessageSubmission();
      for (const file of incoming) {
        const localError = validateFile(file, prospectiveCount);
        items.push({
          id: `attachment-${++itemSequence}`,
          file,
          previewUrl: helpers.createObjectURL(file),
          status: localError ? 'rejected' : 'pending_validation',
          localError,
          error: localError,
          imageId: '',
          retryable: false,
        });
      }
      revision += 1;
      items.forEach((item) => {
        if (!item.localError) {
          item.status = 'pending_validation';
          item.error = '';
          item.imageId = '';
          item.retryable = false;
        }
      });
      uploadRequestId = items.some((item) => item.localError) ? '' : String(helpers.createClientRequestId() || '').trim();
      render();
      return uploadCurrentBatch();
    }

    function addFiles(files) {
      return track(addFilesInternal(files));
    }

    async function removeItemInternal(itemId) {
      if (imageMessageSending) {
        return false;
      }
      const index = items.findIndex((item) => item.id === itemId);
      if (index < 0) {
        return false;
      }
      const [removed] = items.splice(index, 1);
      invalidatePendingMessageSubmission();
      if (removed.previewUrl) {
        helpers.revokeObjectURL(removed.previewUrl);
      }
      revision += 1;
      dom.fileInput.value = '';

      if (items.length === 0) {
        uploadRequestId = '';
        render();
        return true;
      }

      items.forEach((item) => {
        if (!item.localError) {
          item.status = 'pending_validation';
          item.error = '';
          item.imageId = '';
          item.retryable = false;
        }
      });
      uploadRequestId = items.some((item) => item.localError) ? '' : String(helpers.createClientRequestId() || '').trim();
      render();
      await uploadCurrentBatch();
      return true;
    }

    function removeItem(itemId) {
      return track(removeItemInternal(itemId));
    }

    async function retryUploadInternal() {
      if (
        imageMessageSending
        || !uploadRequestId
        || items.length === 0
        || items.some((item) => item.localError || item.status !== 'rejected' || !item.retryable)
      ) {
        return false;
      }
      return uploadCurrentBatch();
    }

    function retryUpload() {
      return track(retryUploadInternal());
    }

    async function loadConfig() {
      configState = 'loading';
      configError = '';
      render();
      try {
        const result = await helpers.fetchConfig();
        if (
          !result
          || !Array.isArray(result.allowedMimeTypes)
          || !Number.isFinite(Number(result.maxImageBytes))
          || !Number.isFinite(Number(result.maxImagesPerUpload || result.maxImagesPerMessage))
        ) {
          throw new Error('图片配置响应不完整');
        }
        uploadConfig = result;
        configState = 'ready';
        configError = '';
        dom.fileInput.accept = result.allowedMimeTypes.join(',');
        render();
        return true;
      } catch (error) {
        uploadConfig = null;
        configState = 'failed';
        configError = String(error && error.message || '无法读取图片配置').trim();
        render();
        return false;
      }
    }

    function syncBaseAvailability(value) {
      baseComposerEnabled = Boolean(value);
      if (imageMessageSending) {
        dom.composerInput.disabled = true;
      }
      renderAvailability();
    }

    function syncConversation(conversationId) {
      const normalized = String(conversationId || '').trim();
      if (normalized === currentConversationId) {
        renderAvailability();
        return;
      }
      clearItems();
      currentConversationId = normalized;
      renderAvailability();
    }

    function readyImageIds() {
      return everyItemReady() ? items.map((item) => item.imageId).filter(Boolean) : [];
    }

    function optimisticContentBlocks(content) {
      const blocks = [];
      const text = String(content || '');
      if (text.trim()) {
        blocks.push({ type: 'text', text });
      }
      if (!everyItemReady()) {
        return blocks;
      }
      items.forEach((item) => {
        blocks.push({
          type: 'image',
          imageId: item.imageId,
          url: item.previewUrl,
          alt: item.file.name || '待发送图片',
        });
      });
      return blocks;
    }

    function handleMessageSuccess(sendToken) {
      if (!sendToken || sendToken !== activeMessageSendToken) {
        return false;
      }
      clearItems();
      return true;
    }

    function handleMessageFailure(sendToken) {
      if (!sendToken || sendToken !== activeMessageSendToken) {
        return false;
      }
      imageMessageSending = false;
      activeMessageSendToken = null;
      dom.composerInput.disabled = Boolean(sendToken.composerInputWasDisabled);
      dom.composerInput.value = String(sendToken.content || '');
      render();
      return true;
    }

    function messagePayloadSignature(content) {
      return JSON.stringify([
        currentConversationId,
        String(content || ''),
        readyImageIds(),
      ]);
    }

    function beginMessageSend(content) {
      if (imageMessageSending || items.length === 0 || !everyItemReady()) {
        return null;
      }
      const signature = messagePayloadSignature(content);
      if (!pendingMessageSubmission || pendingMessageSubmission.signature !== signature) {
        const clientRequestId = String(helpers.createClientRequestId() || '').trim();
        if (!clientRequestId) {
          return null;
        }
        pendingMessageSubmission = { signature, clientRequestId };
      }
      activeMessageSendToken = Object.freeze({
        conversationId: currentConversationId,
        revision,
        uploadRequestId,
        content: String(content || ''),
        clientRequestId: pendingMessageSubmission.clientRequestId,
        composerInputWasDisabled: dom.composerInput.disabled,
      });
      imageMessageSending = true;
      dom.composerInput.disabled = true;
      render();
      return activeMessageSendToken;
    }

    function confirmMessage(conversationId, clientRequestId) {
      const normalizedConversationId = String(conversationId || '').trim();
      const normalizedClientRequestId = String(clientRequestId || '').trim();
      if (
        !pendingMessageSubmission
        || normalizedConversationId !== currentConversationId
        || normalizedClientRequestId !== pendingMessageSubmission.clientRequestId
      ) {
        return false;
      }
      if (activeMessageSendToken && activeMessageSendToken.clientRequestId === normalizedClientRequestId) {
        confirmedMessageSendTokens.add(activeMessageSendToken);
      }
      clearItems();
      return true;
    }

    function wasMessageConfirmed(sendToken) {
      return Boolean(sendToken && confirmedMessageSendTokens.has(sendToken));
    }

    function bindEvents() {
      dom.attachButton.addEventListener('click', () => {
        if (!dom.attachButton.disabled) {
          dom.fileInput.click();
        }
      });
      dom.fileInput.addEventListener('change', () => {
        const selected = Array.from(dom.fileInput.files || []);
        dom.fileInput.value = '';
        void addFiles(selected);
      });
      dom.composerInput.addEventListener('paste', (event) => {
        const clipboardFiles = event.clipboardData ? Array.from(event.clipboardData.files || []) : [];
        const imageFiles = clipboardFiles.filter((file) => String(file.type || '').startsWith('image/'));
        if (imageFiles.length === 0) {
          return;
        }
        event.preventDefault();
        void addFiles(imageFiles);
      });
      dom.composerInput.addEventListener('input', renderAvailability);
      render();
    }

    return {
      addFiles,
      beginMessageSend,
      bindEvents,
      canSend,
      confirmMessage,
      handleMessageFailure,
      handleMessageSuccess,
      hasPayload,
      loadConfig,
      optimisticContentBlocks,
      readyImageIds,
      removeItem,
      retryUpload,
      snapshot,
      syncBaseAvailability,
      syncConversation,
      wasMessageConfirmed,
      whenIdle() {
        return lastOperation;
      },
    };
  };
})();
