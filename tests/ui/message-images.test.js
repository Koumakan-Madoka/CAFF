const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(ROOT, 'public', relativePath), 'utf8');
}

function bootImages() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  dom.window.CaffChat = {};
  dom.window.eval(readPublic('chat/message-images.js'));
  return { dom, window: dom.window, document: dom.window.document, images: dom.window.CaffChat.messageImages };
}

function message(blocks, overrides = {}) {
  return {
    id: 'message-1',
    role: 'user',
    content: 'caption',
    metadata: { contentBlocks: blocks },
    ...overrides,
  };
}

test('message image blocks come only from metadata contentBlocks and preserve order', () => {
  const { images } = bootImages();
  const blocks = images.messageImageBlocks(message([
    { type: 'text', text: 'caption' },
    { type: 'image', imageId: 'i-1', url: '/uploads/a.png' },
    { type: 'image', imageId: 'i-2', url: '/uploads/b.png', alt: 'B' },
  ]));

  assert.deepEqual(JSON.parse(JSON.stringify(blocks)), [
    { type: 'image', imageId: 'i-1', url: '/uploads/a.png' },
    { type: 'image', imageId: 'i-2', url: '/uploads/b.png', alt: 'B' },
  ]);
  assert.deepEqual(Array.from(images.messageImageBlocks({ contentBlocks: [{ type: 'image', url: '/wrong-place.png' }] })), []);
});

test('single and multiple galleries use safe new-tab links and visible fallbacks', () => {
  const { window, document, images } = bootImages();
  const container = document.createElement('div');
  images.syncMessageImages(container, message([
    { type: 'image', imageId: 'i-1', url: '/uploads/a.png', alt: 'first' },
  ]));

  assert.equal(container.classList.contains('single'), true);
  assert.equal(container.hidden, false);
  const link = container.querySelector('a');
  const image = container.querySelector('img');
  const fallback = container.querySelector('.message-image-fallback');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel'), /noopener/u);
  assert.equal(image.getAttribute('alt'), 'first');
  assert.equal(fallback.hidden, true);

  image.dispatchEvent(new window.Event('error'));
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);
  assert.match(fallback.textContent, /无法|失败|缺失/u);
  const retryButton = fallback.querySelector('button');
  const openLink = fallback.querySelector('a');
  assert.match(retryButton.textContent, /重试/u);
  assert.equal(openLink.getAttribute('target'), '_blank');
  assert.equal(openLink.getAttribute('href'), '/uploads/a.png');
  retryButton.click();
  assert.equal(image.hidden, false);
  assert.equal(fallback.hidden, true);
  assert.equal(image.getAttribute('src'), '/uploads/a.png');

  images.syncMessageImages(container, message([
    { type: 'image', imageId: 'i-1', url: '/uploads/a.png' },
    { type: 'image', imageId: 'i-2', url: '/uploads/b.png' },
  ]));
  assert.equal(container.classList.contains('multiple'), true);
  assert.equal(container.querySelectorAll('.message-image-tile').length, 2);
});

test('invalid or missing URLs render a placeholder instead of a blank image', () => {
  const { document, images } = bootImages();
  const container = document.createElement('div');
  images.syncMessageImages(container, message([
    { type: 'image', imageId: 'missing', url: '' },
    { type: 'image', imageId: 'unsafe', url: 'javascript:alert(1)' },
  ]));

  assert.equal(container.querySelectorAll('img').length, 0);
  assert.equal(container.querySelectorAll('.message-image-fallback:not([hidden])').length, 2);
  assert.equal(container.querySelectorAll('a[href^="javascript:"]').length, 0);
});

test('timeline places the shared image gallery before text and updates it without duplicates', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="timeline"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const { document } = window;
  window.CaffShared = {
    conversationDigest: {
      digestsForConversation: () => [],
      digestKindLabel: () => '',
      digestKindHelp: () => '',
      createDigestSourceLocator: () => ({ focusSourceMessage() {} }),
    },
  };
  window.CaffChat = {
    crossConversationUi: {
      receiptModel: () => null,
      provenanceModel: () => null,
      birthModel: () => null,
    },
  };
  window.eval(readPublic('chat/message-images.js'));
  window.eval(readPublic('chat/message-timeline.js'));

  const conversation = {
    id: 'conversation-1',
    agents: [],
    messages: [message([
      { type: 'text', text: 'caption' },
      { type: 'image', imageId: 'i-1', url: '/uploads/a.png' },
    ])],
  };
  const renderer = window.CaffChat.createMessageTimelineRenderer({
    dom: { messageTimeline: document.getElementById('timeline') },
    helpers: {
      agentById: () => null,
      buildAgentAvatarElement: () => document.createElement('span'),
      canInspectToolTrace: () => false,
      conversationSummaries: () => [],
      crossConversationBundleForMessage: () => null,
      displayedMessageBody: (item) => item.content,
      digestStatusForConversation: () => null,
      formatDateTime: () => 'now',
      isPrivateTimelineMessage: () => false,
      liveStageForMessage: () => null,
      liveStageLabel: () => '',
      messageSessionInfo: () => ({ sessionPath: '', sessionName: '', canExport: false }),
      privateRecipientNames: () => [],
      renderMessageBody: (container, text) => { container.textContent = text; },
      timelineMessagesForConversation: (item) => item.messages,
      toolTraceSignatureForMessage: () => '',
      toolTraceStateForMessage: () => null,
    },
    showToast() {},
  });

  renderer.render(conversation, null, []);
  const card = document.querySelector('.message-card');
  const gallery = card.querySelector('.message-images');
  const body = card.querySelector('.message-body');
  assert.ok(gallery.compareDocumentPosition(body) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(gallery.querySelectorAll('.message-image-tile').length, 1);

  conversation.messages[0].metadata.contentBlocks.push({ type: 'image', imageId: 'i-2', url: '/uploads/b.png' });
  renderer.render(conversation, null, []);
  assert.equal(document.querySelectorAll('.message-images').length, 1);
  assert.equal(document.querySelectorAll('.message-image-tile').length, 2);
});
