// @ts-check

(function registerClipboardHelper() {
  const shared = window.CaffShared || (window.CaffShared = {});

  /** @param {string} text @param {{isCurrent?: () => boolean, onFallback?: (active: boolean) => void}} [options] */
  shared.copyTextToClipboard = async function copyTextToClipboard(text, options = {}) {
    const value = String(text || '');
    const ensureCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error('复制已取消'); };
    ensureCurrent();

    if (!value.trim()) {
      throw new Error('暂无内容可复制');
    }

    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {}
    }

    // A denied browser Promise may settle after a room/focus/connection change.
    // Never create/select a fallback textarea for an obsolete request.
    ensureCurrent();
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    try {
      options.onFallback?.(true);
      textarea.select();
      const copied = typeof document.execCommand === 'function' && document.execCommand('copy');

      if (!copied) {
        throw new Error('复制失败');
      }
    } finally {
      document.body.removeChild(textarea);
      options.onFallback?.(false);
    }
  };
})();
