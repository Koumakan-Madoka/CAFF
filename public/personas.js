// @ts-check

const shared = window.CaffShared || {};
const personas = window.CaffPersonas || {};
const fetchJson = shared.fetchJson;
const avatarUtils = shared.avatar;
const toast = shared.createToastController(document.getElementById('toast'));

if (!fetchJson
  || !avatarUtils
  || !personas.createRoleManagement
  || !personas.createProviderManagement
  || !personas.createRecoveryScribeManagement) {
  throw new Error('Role, provider, and system service management modules failed to load');
}

const adminState = {
  providers: { enabled: false, csrfToken: '' },
  systemServices: { enabled: false, csrfToken: '' },
};
const roleView = document.getElementById('role-management-view');
const providerView = document.getElementById('provider-management-view');
const systemServicesView = document.getElementById('system-services-view');
const roleTab = document.getElementById('show-role-management');
const providerTab = document.getElementById('show-provider-management');
const systemServicesTab = document.getElementById('show-system-services');
const providerBanner = document.getElementById('provider-local-admin-banner');
const systemServiceBanner = document.getElementById('system-service-local-admin-banner');

function showToast(message) {
  toast.show(message);
}

function showView(view, updateHash = true) {
  const roles = view === 'roles';
  const providers = view === 'providers';
  const systemServices = view === 'system-services';
  roleView.classList.toggle('hidden', !roles);
  providerView.classList.toggle('hidden', !providers);
  systemServicesView.classList.toggle('hidden', !systemServices);
  roleTab.classList.toggle('ghost-button', !roles);
  providerTab.classList.toggle('ghost-button', !providers);
  systemServicesTab.classList.toggle('ghost-button', !systemServices);
  roleTab.setAttribute('aria-selected', String(roles));
  providerTab.setAttribute('aria-selected', String(providers));
  systemServicesTab.setAttribute('aria-selected', String(systemServices));
  if (updateHash) history.replaceState(null, '', `#${view}`);
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
  isEnabled: () => adminState.providers.enabled,
  getCsrfToken: () => adminState.providers.csrfToken,
  onProvidersChanged: async () => {
    await roleManagement.refresh();
    await recoveryScribeManagement.refresh();
  },
});

const recoveryScribeManagement = personas.createRecoveryScribeManagement({
  root: document.getElementById('recovery-scribe-detail'),
  fetchJson,
  showToast,
  isEnabled: () => adminState.systemServices.enabled,
  getCsrfToken: () => adminState.systemServices.csrfToken,
});

roleTab.addEventListener('click', () => showView('roles'));
providerTab.addEventListener('click', () => showView('providers'));
systemServicesTab.addEventListener('click', () => showView('system-services'));
document.getElementById('refresh-roles').addEventListener('click', async () => {
  try { await roleManagement.refresh(); showToast('角色目录已刷新'); } catch (error) { showToast(error.message); }
});
document.getElementById('refresh-providers').addEventListener('click', async () => {
  try { await providerManagement.refresh(); showToast('供应商状态已刷新'); } catch (error) { showToast(error.message); }
});
document.getElementById('refresh-system-services').addEventListener('click', async () => {
  try { await recoveryScribeManagement.refresh(); showToast('系统服务状态已刷新'); } catch (error) { showToast(error.message); }
});
document.getElementById('refresh-button').addEventListener('click', async () => {
  try {
    await roleManagement.refresh();
    await providerManagement.refresh();
    await recoveryScribeManagement.refresh();
    showToast('已刷新');
  } catch (error) { showToast(error.message); }
});

async function init() {
  try {
    const bootstrap = await fetchJson('/api/bootstrap');
    const providerAdmin = bootstrap.localAdmin && bootstrap.localAdmin.modelProviders || {};
    const systemServicesAdmin = bootstrap.localAdmin && bootstrap.localAdmin.systemServices || {};
    adminState.providers.enabled = Boolean(providerAdmin.enabled);
    adminState.providers.csrfToken = String(providerAdmin.csrfToken || '');
    adminState.systemServices.enabled = Boolean(systemServicesAdmin.enabled);
    adminState.systemServices.csrfToken = String(systemServicesAdmin.csrfToken || '');
    providerBanner.classList.toggle('hidden', adminState.providers.enabled);
    systemServiceBanner.classList.toggle('hidden', adminState.systemServices.enabled);
    /** @type {HTMLButtonElement} */ (document.getElementById('add-provider')).disabled = !adminState.providers.enabled;
    /** @type {HTMLButtonElement} */ (document.getElementById('import-from-catalog')).disabled = !adminState.providers.enabled;
    /** @type {HTMLButtonElement} */ (document.getElementById('refresh-providers')).disabled = !adminState.providers.enabled;
    /** @type {HTMLButtonElement} */ (document.getElementById('refresh-system-services')).disabled = !adminState.systemServices.enabled;
    roleManagement.setDirectory(bootstrap);
    await providerManagement.refresh();
    await recoveryScribeManagement.refresh();
    const initialView = location.hash === '#providers'
      ? 'providers'
      : location.hash === '#system-services'
        ? 'system-services'
        : 'roles';
    showView(initialView, false);
    document.body.dataset.managementReady = 'true';
  } catch (error) {
    document.body.dataset.managementReady = 'error';
    showToast(error.message || '管理页面加载失败');
  }
}

init();
