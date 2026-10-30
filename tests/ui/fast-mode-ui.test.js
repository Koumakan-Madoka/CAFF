const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const readPublic = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

// Actual production modules/styles, synthetic data only; no server, credentials,
// database or outbound requests. Screenshots are fixture evidence, not W6 E2E.
test('Fast role editor and room profile selection', async (t) => {
  const browser = await chromium.launch({
    ...(process.env.CAFF_UI_BROWSER_PATH ? { executablePath: process.env.CAFF_UI_BROWSER_PATH } : { channel: 'msedge' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  page.setDefaultTimeout(5000);
  await page.route('**/*', (route) => route.abort());
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setContent('<!doctype html><html lang="zh-CN"><body class="management-app" data-page="personas"><main class="management-pane management-detail"><div id="editor"></div><section id="room"></section></main></body></html>');
  await page.addStyleTag({ content: readPublic('styles.css') });
  for (const script of ['shared/icons.js', 'shared/model-options.js', 'personas/management-utils.js', 'personas/role-editor.js', 'chat/conversation-settings.js']) {
    await page.addScriptTag({ content: readPublic(script) });
  }
  await page.evaluate(() => {
    const option = (provider, model, extra = {}) => ({
      key: `${provider}\u001f${model}`, provider, model, family: 'gpt', runtimeResolvable: true,
      api: 'openai-codex-responses', supportedThinkingLevels: ['off', 'low', 'high'], supportsFast: false, ...extra,
    });
    const modelOptions = [
      option('openai-codex', 'gpt-6.1-sol', { supportsFast: true }),
      option('openai-codex', 'gpt-5.4-mini'),
      option('relay', 'gpt-6.1-sol', { api: 'openai-responses' }),
      // Defensive UI gate even if an older projection labels this supported.
      option('custom-codex', 'gpt-6.1-sol', { supportsFast: true }),
      option('deepseek', 'deepseek-v3', { family: 'deepseek', api: 'openai-completions' }),
    ];
    window.fastUi = {
      modelOptions, saved: null, changes: [],
      role: {
        id: 'role-family-gpt', name: 'GPT', roleKind: 'model_family', modelFamily: 'gpt',
        provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'high', fast: false,
        modelProfiles: [
          { id: 'fast-profile', name: '快速配置', description: '适合交互', provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low', fast: true },
          { id: 'normal-profile', name: '常规配置', provider: 'openai-codex', model: 'gpt-6.1-sol', fast: false },
        ],
      },
    };
    window.fastUi.editor = window.CaffPersonas.createRoleEditor({
      root: document.getElementById('editor'), getModelOptions: () => modelOptions, getSkills: () => [],
      avatarUtils: { renderAvatarPreview() {} }, showToast() {}, onManageProviders() {}, onDelete() {},
      onSave(draft, payload) { window.fastUi.saved = { draft, payload }; },
      onDraftChange(draft) { window.fastUi.changes.push(structuredClone(draft)); },
    });
    window.fastUi.editor.show(window.fastUi.role);
  });

  const screenshot = async (name) => {
    const dir = process.env.CAFF_FAST_UI_EVIDENCE_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    // The management pane scrolls internally. Expand the fixture viewport so
    // evidence includes the default config as well as every profile, not only
    // whichever element the preceding interaction scrolled into view.
    const viewport = page.viewportSize();
    const height = await page.evaluate(() => document.querySelector('main').scrollHeight);
    await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height + 40) });
    await page.evaluate(() => {
      document.querySelector('main').scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
    await page.setViewportSize(viewport);
  };
  const profileToggle = '[data-profile-index="0"] [data-fast-toggle]';
  await t.test('family default and profiles have independent accessible toggles and usage warning', async () => {
    assert.equal(await page.locator('#role-default-fast').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator(profileToggle).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-profile-index="1"] [data-fast-toggle]').getAttribute('aria-pressed'), 'false');
    const descriptionId = await page.locator('#role-default-fast').getAttribute('aria-describedby');
    assert.match(await page.locator(`#${descriptionId}`).textContent(), /约 1\.5 倍.*套餐用量消耗更快/u);
    await page.locator('#role-default-fast').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#role-default-fast').getAttribute('aria-pressed'), 'true');
    await page.locator(profileToggle).click();
    assert.equal(await page.locator(profileToggle).getAttribute('aria-pressed'), 'false');
    await page.locator('#save-role').click();
    const payload = await page.evaluate(() => window.fastUi.saved.payload);
    assert.equal(payload.fast, true);
    assert.equal(payload.modelProfiles[0].fast, false);
    assert.equal(payload.modelProfiles[1].fast, false);
    assert.ok(payload.modelProfiles.every((profile) => typeof profile.fast === 'boolean'));
    // Reopening saved data must retain both the default and opposite profile value.
    await page.evaluate(() => window.fastUi.editor.show({ ...window.fastUi.role, ...window.fastUi.saved.payload }));
    assert.equal(await page.locator('#role-default-fast').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator(profileToggle).getAttribute('aria-pressed'), 'false');
    await screenshot('family-editor');
    for (const width of [375, 1100]) {
      await page.setViewportSize({ width, height: 1500 });
      const geometry = await page.locator('#role-default-fast').evaluate((button) => {
        const box = button.getBoundingClientRect();
        const parent = button.closest('.management-card').getBoundingClientRect();
        return { width: box.width, inside: box.left >= parent.left && box.right <= parent.right };
      });
      assert.equal(geometry.width, 48);
      assert.equal(geometry.inside, true);
      if (width === 375) await screenshot('family-editor-mobile');
    }
  });

  await t.test('model changes hide and reset Fast independently, without latent re-enabling', async () => {
    await page.selectOption('#role-default-model', 'openai-codex\u001fgpt-5.4-mini');
    assert.equal(await page.locator('#role-default-fast').count(), 0);
    await page.locator('#save-role').click();
    assert.equal(await page.evaluate(() => window.fastUi.saved.payload.fast), false);
    await page.selectOption('#role-default-model', 'openai-codex\u001fgpt-6.1-sol');
    assert.equal(await page.locator('#role-default-fast').getAttribute('aria-pressed'), 'false');
    await page.locator(profileToggle).click();
    await page.selectOption('[data-profile-index="0"] [data-field="model"]', 'relay\u001fgpt-6.1-sol');
    assert.equal(await page.locator(profileToggle).count(), 0);
    await page.locator('#save-role').click();
    assert.equal(await page.evaluate(() => window.fastUi.saved.payload.modelProfiles[0].fast), false);
    await page.selectOption('[data-profile-index="0"] [data-field="model"]', 'openai-codex\u001fgpt-6.1-sol');
    assert.equal(await page.locator(profileToggle).getAttribute('aria-pressed'), 'false');
    await page.selectOption('#role-default-model', 'custom-codex\u001fgpt-6.1-sol');
    assert.equal(await page.locator('#role-default-fast').count(), 0);
  });

  await t.test('custom roles, new profiles and legacy missing fields default off', async () => {
    await page.evaluate(() => {
      const role = { ...window.fastUi.role, id: 'custom-gpt', roleKind: 'custom', modelFamily: null };
      delete role.fast;
      role.modelProfiles = [];
      window.fastUi.editor.show(role);
    });
    assert.equal(await page.locator('#role-default-fast').getAttribute('aria-pressed'), 'false');
    await page.locator('#role-default-fast').click();
    await page.locator('#add-runtime-profile').click();
    assert.equal(await page.locator(profileToggle).getAttribute('aria-pressed'), 'false');
    await page.locator(profileToggle).focus();
    await page.keyboard.press('Enter');
    await page.locator('#save-role').click();
    const payload = await page.evaluate(() => window.fastUi.saved.payload);
    assert.equal(payload.fast, true);
    assert.equal(payload.modelProfiles[0].fast, true);
    await screenshot('custom-editor');
    await page.selectOption('#role-default-model', 'deepseek\u001fdeepseek-v3');
    assert.equal(await page.locator('#role-default-fast').count(), 0);
    assert.equal(await page.locator(profileToggle).getAttribute('aria-pressed'), 'true');
  });

  await t.test('room selector marks Fast configuration even with a custom description; other rooms stay independent', async () => {
    await page.evaluate(() => {
      document.getElementById('editor').innerHTML = '';
      document.body.className = 'chat-app';
      document.querySelector('main').className = '';
      const agent = { ...window.fastUi.role, fast: true };
      const state = {
        currentConversation: { id: 'room-fast', agents: [{ ...agent, selectedModelProfileId: 'fast-profile' }] },
        agents: [agent], skills: [],
      };
      const dom = { conversationAgentOptions: document.getElementById('room') };
      const controller = window.CaffChat.createConversationSettingsController({
        state, dom, showToast() {}, helpers: {
          normalizedSkillIds: (ids) => Array.isArray(ids) ? ids : [],
          buildAgentAvatarElement: () => document.createElement('span'),
        },
      });
      window.fastUi.room = { controller, state };
      controller.bindEvents();
      controller.render();
    });
    const meta = '.profile-dropdown-trigger-meta';
    assert.match(await page.locator(meta).textContent(), /适合交互.*Fast.*用量/u);
    const normal = page.locator('[data-profile-id="normal-profile"] .profile-choice-meta');
    assert.doesNotMatch(await normal.textContent(), /Fast/u);
    assert.match(await page.locator('[data-profile-id=""] .profile-choice-meta').textContent(), /Fast/u);
    assert.match(await page.locator('[data-profile-id="fast-profile"]').getAttribute('title'), /Fast/u);
    await page.locator('.profile-dropdown-trigger').click();
    assert.equal(await page.locator('.profile-dropdown-menu').isVisible(), true);
    await screenshot('room-profile-menu');
    await page.locator('[data-profile-id="normal-profile"]').click();
    assert.doesNotMatch(await page.locator(meta).textContent(), /Fast/u);
    assert.deepEqual(await page.evaluate(() => window.fastUi.room.controller.selectedParticipants()), [
      { agentId: 'role-family-gpt', modelProfileId: 'normal-profile', conversationSkillIds: [] },
    ]);
    // A draft selection must not mutate the persisted/global role or other rooms.
    assert.equal(await page.evaluate(() => window.fastUi.room.state.agents[0].modelProfiles[0].fast), true);
    await page.evaluate(() => {
      const { controller, state } = window.fastUi.room;
      state.currentConversation = { id: 'room-normal', agents: [{ ...state.agents[0], selectedModelProfileId: 'normal-profile' }] };
      controller.render();
    });
    assert.doesNotMatch(await page.locator(meta).textContent(), /Fast/u);
    assert.equal(await page.locator('[data-role="profile-value"]').inputValue(), 'normal-profile');
  });
  assert.deepEqual(errors, []);
});
