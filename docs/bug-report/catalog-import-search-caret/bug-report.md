---
feature_ids: [F004]
topics: [bug, ui, catalog-import, search, caret, focus]
doc_kind: bug-report
created: 2026-08-07
---

# Catalog import search caret jumps to the line start

## Reported by

Operator observed that each character typed into the provider search field moved the caret to the beginning of the input, reversing or scrambling continued typing.

## Reproduction

1. Start the F004 acceptance app and open `personas.html`.
2. Open “模型供应商” → “从目录导入”.
3. Type into `#catalog-import-search` with the caret in the middle or at the end.
4. Observe that the next character is inserted at the beginning instead of at the prior caret.

Expected: filtering may rerender provider rows, but the input value, selection start, selection end, and focus position remain stable.

## Root cause analysis

The search `input` handler called `render()`. `render()` replaces `root.innerHTML`, which destroys and recreates `#catalog-import-search`. The handler then called `focus()` on the replacement element without restoring its selection range; browsers therefore used the new input’s default caret position (the line start).

## Fix

Capture `selectionStart`, `selectionEnd`, and `selectionDirection` before the render; focus the replacement input and restore the clamped range afterward. This keeps the existing full-list render behavior and avoids a second search-specific DOM update path.

## Verification

- RED: the new regression test failed with `selectionStart 0 !== 3`.
- GREEN: `node tests/runtime/catalog-import-ui.test.js` passes 6/6.
- Browser preview target `http://127.0.0.1:3110/personas.html` responds 200 from the AC-1 worktree.
- Final `npm run test:fast` passed with exit 0 after the fix.

[砚砚/gpt-5.6-sol🐾]
