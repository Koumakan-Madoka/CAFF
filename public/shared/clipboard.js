// @ts-check

(function registerClipboardHelper() {
  const shared = window.CaffShared || (window.CaffShared = {});

  shared.copyTextToClipboard = async function copyTextToClipboard(text) {
    const value = String(text || '');

    if (!value.trim()) {
      throw new Error('暂无内容可复制');
    }

    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      const copied = document.execCommand('copy');

      if (!copied) {
        throw new Error('复制失败');
      }
    } finally {
      document.body.removeChild(textarea);
    }
  };
})();
