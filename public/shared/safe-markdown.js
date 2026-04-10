// @ts-check

(function registerSafeMarkdownModule() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function defaultAppendText(container, text) {
    if (!text) {
      return;
    }

    container.appendChild(document.createTextNode(text));
  }

  function appendText(container, text, options) {
    const appendTextImpl = options && typeof options.appendText === 'function' ? options.appendText : defaultAppendText;
    appendTextImpl(container, text);
  }

  function normalizeSource(value) {
    return String(value || '').replace(/\r\n?/g, '\n');
  }

  function splitTableRow(line) {
    const normalized = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    return normalized.split('|').map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(String(line || '').trim());
  }

  function isSafeHref(value) {
    const href = String(value || '').trim();

    if (!href) {
      return false;
    }

    if (href.startsWith('#')) {
      return true;
    }

    if (href.startsWith('/')) {
      return !href.startsWith('//');
    }

    return /^(https?:|mailto:)/i.test(href);
  }

  function appendInlineNodes(container, source, options = {}) {
    const text = String(source || '');
    const tokenPattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;
    let lastIndex = 0;
    let match;

    while ((match = tokenPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        appendText(container, text.slice(lastIndex, match.index), options);
      }

      if (match[1]) {
        const code = document.createElement('code');
        code.textContent = match[1];
        container.appendChild(code);
        lastIndex = match.index + match[0].length;
        continue;
      }

      if (match[2] && match[3]) {
        const href = match[3].trim();

        if (isSafeHref(href)) {
          const link = document.createElement('a');
          link.href = href;
          link.rel = 'noopener noreferrer';

          if (/^https?:/i.test(href)) {
            link.target = '_blank';
          }

          appendInlineNodes(link, match[2], options);
          container.appendChild(link);
        } else {
          appendText(container, match[0], options);
        }

        lastIndex = match.index + match[0].length;
        continue;
      }

      if (match[4] || match[5]) {
        const strong = document.createElement('strong');
        appendInlineNodes(strong, match[4] || match[5], options);
        container.appendChild(strong);
        lastIndex = match.index + match[0].length;
        continue;
      }

      if (match[6] || match[7]) {
        const emphasis = document.createElement('em');
        appendInlineNodes(emphasis, match[6] || match[7], options);
        container.appendChild(emphasis);
        lastIndex = match.index + match[0].length;
      }
    }

    if (lastIndex < text.length) {
      appendText(container, text.slice(lastIndex), options);
    }
  }

  function appendInlineTextWithBreaks(container, text, options = {}) {
    const lines = String(text || '').split('\n');

    lines.forEach((line, index) => {
      if (index > 0) {
        container.appendChild(document.createElement('br'));
      }

      appendInlineNodes(container, line, options);
    });
  }

  function buildParagraph(lines, options) {
    const paragraph = document.createElement('p');
    appendInlineTextWithBreaks(paragraph, lines.join('\n'), options);
    return paragraph;
  }

  function buildHeading(line, options) {
    const match = String(line || '').match(/^(#{1,6})\s+(.*)$/);

    if (!match) {
      return null;
    }

    const level = Math.min(match[1].length, 6);
    const heading = document.createElement(`h${level}`);
    appendInlineNodes(heading, match[2], options);
    return heading;
  }

  function buildCodeBlock(lines, language) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');

    if (language) {
      code.dataset.language = language;
    }

    code.textContent = lines.join('\n');
    pre.appendChild(code);
    return pre;
  }

  function buildTable(headerLine, rowLines, options) {
    const wrapper = document.createElement('div');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    const headerCells = splitTableRow(headerLine);
    const headerRow = document.createElement('tr');

    wrapper.className = 'markdown-table-wrap';

    headerCells.forEach((value) => {
      const cell = document.createElement('th');
      appendInlineNodes(cell, value, options);
      headerRow.appendChild(cell);
    });
    thead.appendChild(headerRow);

    rowLines.forEach((line) => {
      const row = document.createElement('tr');
      splitTableRow(line).forEach((value) => {
        const cell = document.createElement('td');
        appendInlineNodes(cell, value, options);
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });

    table.append(thead, tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function buildFlatList(items, ordered, options) {
    const list = document.createElement(ordered ? 'ol' : 'ul');

    items.forEach((itemLines) => {
      const item = document.createElement('li');
      appendInlineTextWithBreaks(item, itemLines.join('\n'), options);
      list.appendChild(item);
    });

    return list;
  }

  function renderBlocks(target, lines, options = {}) {
    let index = 0;

    while (index < lines.length) {
      const rawLine = lines[index] || '';
      const trimmedLine = rawLine.trim();

      if (!trimmedLine) {
        index += 1;
        continue;
      }

      const fenceMatch = rawLine.match(/^(```|~~~)\s*([^\s`]*)\s*$/);

      if (fenceMatch) {
        const fence = fenceMatch[1];
        const language = String(fenceMatch[2] || '').trim();
        const codeLines = [];
        index += 1;

        while (index < lines.length && !lines[index].match(new RegExp(`^${fence}\\s*$`))) {
          codeLines.push(lines[index]);
          index += 1;
        }

        if (index < lines.length) {
          index += 1;
        }

        target.appendChild(buildCodeBlock(codeLines, language));
        continue;
      }

      if (/^#{1,6}\s+/.test(trimmedLine)) {
        const heading = buildHeading(trimmedLine, options);
        if (heading) {
          target.appendChild(heading);
          index += 1;
          continue;
        }
      }

      if (/^>\s?/.test(trimmedLine)) {
        const quoteLines = [];

        while (index < lines.length && /^>\s?/.test(String(lines[index] || '').trim())) {
          quoteLines.push(String(lines[index] || '').replace(/^\s*>\s?/, ''));
          index += 1;
        }

        const blockquote = document.createElement('blockquote');
        renderBlocks(blockquote, quoteLines, options);
        target.appendChild(blockquote);
        continue;
      }

      if (index + 1 < lines.length && trimmedLine.includes('|') && isTableSeparator(lines[index + 1])) {
        const rowLines = [];
        index += 2;

        while (index < lines.length && String(lines[index] || '').trim().includes('|')) {
          rowLines.push(lines[index]);
          index += 1;
        }

        target.appendChild(buildTable(trimmedLine, rowLines, options));
        continue;
      }

      const unorderedMatch = rawLine.match(/^\s*[-*+]\s+(.*)$/);
      const orderedMatch = rawLine.match(/^\s*\d+\.\s+(.*)$/);

      if (unorderedMatch || orderedMatch) {
        const ordered = Boolean(orderedMatch);
        const itemLines = [[(orderedMatch || unorderedMatch || [])[1] || '']];
        index += 1;

        while (index < lines.length) {
          const nextLine = String(lines[index] || '');
          const nextTrimmed = nextLine.trim();
          const nextUnordered = nextLine.match(/^\s*[-*+]\s+(.*)$/);
          const nextOrdered = nextLine.match(/^\s*\d+\.\s+(.*)$/);

          if (!nextTrimmed) {
            break;
          }

          if ((ordered && nextOrdered) || (!ordered && nextUnordered)) {
            itemLines.push([String((nextOrdered || nextUnordered || [])[1] || '')]);
            index += 1;
            continue;
          }

          if (/^\s+/.test(nextLine)) {
            itemLines[itemLines.length - 1].push(nextTrimmed);
            index += 1;
            continue;
          }

          break;
        }

        target.appendChild(buildFlatList(itemLines, ordered, options));
        continue;
      }

      const paragraphLines = [rawLine];
      index += 1;

      while (index < lines.length) {
        const nextLine = String(lines[index] || '');
        const nextTrimmed = nextLine.trim();

        if (!nextTrimmed) {
          break;
        }

        if (
          /^(```|~~~)\s*/.test(nextLine) ||
          /^#{1,6}\s+/.test(nextTrimmed) ||
          /^>\s?/.test(nextTrimmed) ||
          (nextTrimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) ||
          /^\s*[-*+]\s+/.test(nextLine) ||
          /^\s*\d+\.\s+/.test(nextLine)
        ) {
          break;
        }

        paragraphLines.push(nextLine);
        index += 1;
      }

      target.appendChild(buildParagraph(paragraphLines, options));
    }
  }

  shared.safeMarkdown = {
    render(container, source, options = {}) {
      if (!container) {
        return;
      }

      container.textContent = '';
      renderBlocks(container, normalizeSource(source).split('\n'), options);
    },
  };
})();
