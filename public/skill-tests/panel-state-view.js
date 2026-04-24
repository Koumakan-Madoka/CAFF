// @ts-check

(function registerSkillTestPanelStateView() {
  const skillTests = window.CaffSkillTests || (window.CaffSkillTests = {});

  skillTests.createPanelStateViewHelpers = function createPanelStateViewHelpers(deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '');

    function buildCompactEmptyStateHtml(message, options = {}) {
      const text = String(message || '').trim();
      const actionsHtml = String(options.actionsHtml || '').trim();
      const extraClassName = String(options.extraClassName || '').trim();
      const rootClassName = ['empty-state', 'compact-empty-state', extraClassName].filter(Boolean).join(' ');
      return `
        <div class="${rootClassName}">
          <p class="section-hint">${escapeHtml(text)}</p>
          ${actionsHtml}
        </div>
      `;
    }

    function buildInlineBannerHtml(options = {}) {
      const tone = String(options.tone || 'pending').trim().toLowerCase();
      const text = String(options.message || '').trim();
      const actionsHtml = String(options.actionsHtml || '').trim();
      const extraClassName = String(options.extraClassName || '').trim();
      const toneClassName = tone === 'error'
        ? 'skill-test-inline-banner-error'
        : (tone === 'success'
          ? 'skill-test-inline-banner-success'
          : 'skill-test-inline-banner-pending');
      const rootClassName = ['skill-test-inline-banner', toneClassName, extraClassName].filter(Boolean).join(' ');
      return `
        <div class="${rootClassName}">
          <p class="section-hint">${escapeHtml(text)}</p>
          ${actionsHtml}
        </div>
      `;
    }

    function renderLoadingState(container, message) {
      if (!container) return;
      container.innerHTML = `<p class="section-hint">${escapeHtml(String(message || '').trim())}</p>`;
    }

    function renderRetryState(container, message, onRetry, options = {}) {
      if (!container) return;
      const buttonLabel = String(options.buttonLabel || '重试').trim();
      const buttonClassName = String(options.buttonClassName || 'ghost-button').trim();
      const actionsHtml = `
        <div class="panel-actions skill-test-empty-actions">
          <button type="button" class="${escapeHtml(buttonClassName)}" data-panel-state-action="retry">${escapeHtml(buttonLabel)}</button>
        </div>
      `;
      container.innerHTML = buildCompactEmptyStateHtml(message, { actionsHtml });
      const retryButton = container.querySelector('[data-panel-state-action="retry"]');
      if (retryButton) {
        retryButton.addEventListener('click', () => {
          if (typeof onRetry === 'function') {
            onRetry();
          }
        });
      }
    }

    return {
      buildCompactEmptyStateHtml,
      buildInlineBannerHtml,
      renderLoadingState,
      renderRetryState,
    };
  };
})();
