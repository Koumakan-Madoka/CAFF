const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const readPublic = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

// Real layout, no CAFF server, provider, database, network, or production fixtures.
// A missing browser is a failure, not a silently skipped layout gate.
test('message actions remain inside the card through failed-status updates', async (t) => {
  const browser = await chromium.launch({
    ...(process.env.CAFF_UI_BROWSER_PATH
      ? { executablePath: process.env.CAFF_UI_BROWSER_PATH }
      : { channel: 'msedge' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setContent('<!doctype html><html><body class="chat-app"><main id="timeline"></main></body></html>');
  await page.addStyleTag({ content: readPublic('styles.css') });
  await page.addStyleTag({ content: '#timeline { display: grid; gap: 16px; margin: 24px auto; }' });
  for (const script of ['shared/icons.js', 'shared/avatar.js', 'shared/conversation-digest.js', 'chat/cross-conversation-ui.js', 'chat/message-images.js', 'chat/message-timeline.js']) {
    await page.addScriptTag({ content: readPublic(script) });
  }
  // Use the actual app helpers without booting app.js / opening SSE connections.
  const app = readPublic('app.js');
  await page.addScriptTag({ content:
    app.slice(app.indexOf('function formatDateTime('), app.indexOf('function conversationById('))
    + app.slice(app.indexOf('function messageSessionInfo('), app.indexOf('function messageSessionExportUrl(')),
  });
  await page.evaluate(() => {
    const agent = { id: 'layout-agent', name: 'GPT', accentColor: '#336699' };
    const conversation = { id: 'layout-room', agents: [agent], messages: [] };
    const renderer = window.CaffChat.createMessageTimelineRenderer({
      dom: { messageTimeline: document.getElementById('timeline') },
      helpers: {
        agentById: (id) => id === agent.id ? agent : null,
        buildAgentAvatarElement: () => {
          const avatar = document.createElement('span');
          avatar.className = 'agent-avatar tiny';
          avatar.textContent = 'G';
          return avatar;
        },
        canInspectToolTrace: () => false,
        conversationSummaries: () => [],
        crossConversationBundleForMessage: () => null,
        displayedMessageBody: (message) => message.content,
        digestStatusForConversation: () => null,
        formatDateTime: window.formatDateTime,
        isConversationMessageDeletionBlocked: () => false,
        isPrivateTimelineMessage: () => false,
        liveStageForMessage: () => null,
        liveStageLabel: () => '',
        messageSessionInfo: window.messageSessionInfo,
        privateRecipientNames: () => [],
        renderMessageBody: (container, text) => { container.textContent = text; },
        timelineMessagesForConversation: (item) => item.messages,
        toolTraceSignatureForMessage: () => '',
        toolTraceStateForMessage: () => null,
      },
      showToast() {},
    });
    window.layoutFixture = { conversation, renderer, clicks: [] };
    document.getElementById('timeline').addEventListener('click', (event) => {
      const button = event.target.closest('.message-export-button, .message-context-button');
      if (button) window.layoutFixture.clicks.push(button.className);
    });
  });

  const dimensions = [
    { viewport: 1440, column: 1080 },
    { viewport: 1440, column: 800 },
    { viewport: 1440, column: 600 },
    { viewport: 820, column: 400 },
    { viewport: 375, column: 343 },
  ];
  for (const dimension of dimensions) {
    await page.setViewportSize({ width: dimension.viewport, height: 1200 });
    await page.locator('#timeline').evaluate((element, width) => { element.style.width = `${width}px`; }, dimension.column);
    for (const usage of [false, true]) {
      for (const available of [true, false]) {
        await t.test(`${dimension.viewport}/${dimension.column}px usage=${usage} available=${available}`, async () => {
          // Same message/card transitions, not just three freshly created DOM trees.
          for (const status of ['streaming', 'failed', 'completed']) {
            await page.evaluate(({ status, usage, available }) => {
              const { conversation, renderer } = window.layoutFixture;
              conversation.messages = [{
                id: 'layout-message', agentId: 'layout-agent', role: 'assistant', senderName: 'GPT',
                content: 'Synthetic partial reply', status, createdAt: '2026-09-27T07:26:42.909Z',
                errorMessage: status === 'failed' ? 'Synthetic failure' : '',
                deletionEligibility: { eligible: status !== 'streaming' },
                metadata: {
                  ...(available ? { sessionName: 'synthetic-session', agentContextSnapshot: { snapshotId: 'synthetic-snapshot' } } : {}),
                  ...(usage ? {
                    tokenUsage: { inputTokens: 960000, outputTokens: 18000, totalTokens: 978000, cacheReadTokens: 908000, totalCostUsd: 1.7842 },
                    modelUsage: { modelCallCount: 20 },
                  } : {}),
                },
              }];
              renderer.render(conversation, null, []);
              window.layoutFixture.clicks = [];
            }, { status, usage, available });
            const geometry = await page.evaluate(() => {
              const card = document.querySelector('.message-card');
              const rect = card.getBoundingClientRect();
              return {
                cardOverflow: getComputedStyle(card).overflow,
                buttons: [...card.querySelectorAll('.message-export-button, .message-context-button')].map((button) => {
                  const box = button.getBoundingClientRect();
                  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                  return {
                    name: button.textContent, disabled: button.disabled,
                    width: box.width, height: box.height,
                    inside: box.left >= rect.left && box.right <= rect.right && box.top >= rect.top && box.bottom <= rect.bottom,
                    hit: hit === button || button.contains(hit),
                    visibleWidth: Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left)),
                  };
                }),
              };
            });
            assert.equal(geometry.cardOverflow, 'hidden', 'fix the layout, do not disable card clipping');
            assert.equal(geometry.buttons.length, 2);
            for (const button of geometry.buttons) {
              assert.equal(button.disabled, !available, `${status}: capability state unchanged`);
              assert.ok(button.inside && button.hit && button.width > 0 && button.height > 0,
                `${status}: action clipped or covered: ${JSON.stringify(button)}`);
            }
            if (available) {
              await page.locator('.message-export-button').click();
              await page.locator('.message-context-button').focus();
              await page.keyboard.press('Enter');
              assert.equal(await page.evaluate(() => window.layoutFixture.clicks.length), 2, `${status}: mouse + keyboard actions reachable`);
            }
          }
        });
      }
    }
  }
  assert.deepEqual(errors, []);
});
