// @ts-check

const shared = window.CaffShared || {};
const personas = window.CaffPersonas || {};
const fetchJson = shared.fetchJson;
const avatarUtils = shared.avatar;
const toast = shared.createToastController(document.getElementById('toast'));

if (!fetchJson || !avatarUtils || !personas.createRoleManagement || !personas.createProviderManagement) {
  throw new Error('Role and provider management modules failed to load');
}

const adminState = { enabled: false, csrfToken: '' };
const roleView = document.getElementById('role-management-view');
const providerView = document.getElementById('provider-management-view');
const roleTab = document.getElementById('show-role-management');
const providerTab = document.getElementById('show-provider-management');
const providerBanner = document.getElementById('provider-local-admin-banner');

function showToast(message) {
  toast.show(message);
}

function showView(view, updateHash = true) {
  const providers = view === 'providers';
  roleView.classList.toggle('hidden', providers);
  providerView.classList.toggle('hidden', !providers);
  roleTab.classList.toggle('ghost-button', providers);
  providerTab.classList.toggle('ghost-button', !providers);
  roleTab.setAttribute('aria-selected', String(!providers));
  providerTab.setAttribute('aria-selected', String(providers));
  if (updateHash) history.replaceState(null, '', providers ? '#providers' : '#roles');
}

const roleManagement = personas.createRoleManagement({
  familyList: document.getElementById('family-role-list'),
  customList: document.getElementById('custom-role-list'),
  detail: document.getElementById('role-detail'),
  familyCount: document.getElementById('family-role-count'),
  customCount: document.getElementById('custom-role-count'),
  newRoleButton: document.getElementById('new-custom-role'),
  avatarUtils,
  fetchJson,
  showToast,
  onManageProviders: () => showView('providers'),
});

const providerManagement = personas.createProviderManagement({
  list: document.getElementById('provider-list'),
  detail: document.getElementById('provider-detail'),
  count: document.getElementById('provider-count'),
  addButton: document.getElementById('add-provider'),
  importButton: document.getElementById('import-from-catalog'),
  refreshButton: document.getElementById('refresh-providers'),
  fetchJson,
  showToast,
  isEnabled: () => adminState.enabled,
  getCsrfToken: () => adminState.csrfToken,
  onProvidersChanged: () => roleManagement.refresh(),
});

roleTab.addEventListener('click', () => showView('roles'));
providerTab.addEventListener('click', () => showView('providers'));
document.getElementById('refresh-roles').addEventListener('click', async () => {
  try { await roleManagement.refresh(); showToast('角色目录已刷新'); } catch (error) { showToast(error.message); }
});
document.getElementById('refresh-providers').addEventListener('click', async () => {
  try { await providerManagement.refresh(); showToast('供应商状态已刷新'); } catch (error) { showToast(error.message); }
});
document.getElementById('refresh-button').addEventListener('click', async () => {
  try {
    await roleManagement.refresh();
    await providerManagement.refresh();
    showToast('已刷新');
  } catch (error) { showToast(error.message); }
});

async function init() {
  try {
    const bootstrap = await fetchJson('/api/bootstrap');
    const localAdmin = bootstrap.localAdmin && bootstrap.localAdmin.modelProviders || {};
    adminState.enabled = Boolean(localAdmin.enabled);
    adminState.csrfToken = String(localAdmin.csrfToken || '');
    providerBanner.classList.toggle('hidden', adminState.enabled);
    /** @type {HTMLButtonElement} */ (document.getElementById('add-provider')).disabled = !adminState.enabled;
    /** @type {HTMLButtonElement} */ (document.getElementById('import-from-catalog')).disabled = !adminState.enabled;
    /** @type {HTMLButtonElement} */ (document.getElementById('refresh-providers')).disabled = !adminState.enabled;
    roleManagement.setDirectory(bootstrap);
    await providerManagement.refresh();
    showView(location.hash === '#providers' ? 'providers' : 'roles', false);
    document.body.dataset.managementReady = 'true';
  } catch (error) {
    document.body.dataset.managementReady = 'error';
    showToast(error.message || '管理页面加载失败');
  }
}

init();
