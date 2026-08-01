'use strict';

const byId = (id) => document.getElementById(id);
const elements = {
  pageTitle: byId('page-title'),
  search: byId('search-input'),
  list: byId('mods-list'),
  loading: byId('loading-state'),
  empty: byId('empty-state'),
  totalCount: byId('total-count'),
  enabledCount: byId('enabled-count'),
  disabledCount: byId('disabled-count'),
  footerStatus: byId('footer-status'),
  toast: byId('toast')
};

let snapshot = { mods: [], enabledCount: 0, disabledCount: 0, totalCount: 0, locked: false };
let filter = 'all';
let toastTimer = null;

function friendlyError(error) {
  return String(error?.message || error || 'Неизвестная ошибка')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '');
}

function showToast(message, type = 'normal', duration = 5200) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type === 'normal' ? '' : type}`.trim();
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), duration);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} МБ`;
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';
}

function matches(mod) {
  if (filter === 'enabled' && !mod.enabled) return false;
  if (filter === 'disabled' && mod.enabled) return false;
  const query = elements.search.value.trim().toLocaleLowerCase('ru');
  if (!query) return true;
  return [mod.name, mod.modId, mod.fileName, mod.description, mod.loader]
    .some((value) => String(value || '').toLocaleLowerCase('ru').includes(query));
}

function createModRow(mod) {
  const row = document.createElement('article');
  row.className = `mod-row${mod.enabled ? '' : ' disabled'}`;
  row.dataset.fileName = mod.fileName;

  const identity = document.createElement('div');
  identity.className = 'mod-identity';
  const icon = document.createElement('div');
  icon.className = 'mod-icon';
  if (mod.iconDataUrl) {
    const image = document.createElement('img');
    image.src = mod.iconDataUrl;
    image.alt = '';
    icon.append(image);
  } else {
    icon.textContent = initials(mod.name);
  }
  const copy = document.createElement('div');
  copy.className = 'mod-copy';
  const name = document.createElement('strong');
  name.textContent = mod.name || mod.activeFileName;
  name.title = mod.description || mod.fileName;
  const file = document.createElement('span');
  file.textContent = `${mod.activeFileName} · ${formatBytes(mod.size)}`;
  const badge = document.createElement('small');
  badge.textContent = mod.managed ? 'Управляется сборкой' : 'Пользовательский мод';
  copy.append(name, file, badge);
  identity.append(icon, copy);

  const version = document.createElement('div');
  version.className = 'mod-version';
  version.textContent = mod.version || '—';
  version.title = mod.version || '';

  const loader = document.createElement('div');
  loader.className = 'mod-loader';
  loader.textContent = mod.loader || 'Неизвестно';

  const state = document.createElement('div');
  state.className = 'mod-state';
  const stateLabel = document.createElement('span');
  stateLabel.className = 'mod-state-label';
  stateLabel.textContent = mod.enabled ? 'Включён' : 'Выключен';
  const toggle = document.createElement('button');
  toggle.className = `toggle${mod.enabled ? ' on' : ''}`;
  toggle.type = 'button';
  toggle.role = 'switch';
  toggle.ariaChecked = String(mod.enabled);
  toggle.ariaLabel = `${mod.enabled ? 'Выключить' : 'Включить'} ${mod.name}`;
  toggle.disabled = snapshot.locked;
  toggle.addEventListener('click', async () => {
    const nextEnabled = !mod.enabled;
    toggle.disabled = true;
    try {
      const response = await window.launcher.toggleMod(mod.fileName, nextEnabled);
      mod.enabled = nextEnabled;
      mod.fileName = response.result.fileName;
      snapshot.enabledCount = response.summary.enabledCount;
      snapshot.disabledCount = response.summary.disabledCount;
      snapshot.totalCount = response.summary.totalCount;
      render();
      showToast(`${mod.name}: ${nextEnabled ? 'включён' : 'выключен'}. Изменение применится при следующем запуске.`);
    } catch (error) {
      toggle.disabled = false;
      showToast(friendlyError(error), 'error', 7500);
    }
  });
  state.append(stateLabel, toggle);
  row.append(identity, version, loader, state);
  return row;
}

function updateCounts() {
  elements.totalCount.textContent = snapshot.totalCount;
  elements.enabledCount.textContent = snapshot.enabledCount;
  elements.disabledCount.textContent = snapshot.disabledCount;
  elements.footerStatus.textContent = snapshot.locked
    ? 'Minecraft или проверка файлов сейчас работают — переключатели временно заблокированы.'
    : `Включено ${snapshot.enabledCount} из ${snapshot.totalCount} модов.`;
}

function render() {
  const visible = snapshot.mods.filter(matches);
  elements.list.replaceChildren(...visible.map(createModRow));
  elements.list.classList.toggle('hidden', visible.length === 0);
  elements.empty.classList.toggle('hidden', visible.length !== 0);
  elements.loading.classList.add('hidden');
  updateCounts();
}

async function loadMods() {
  try {
    snapshot = await window.launcher.listMods();
    elements.pageTitle.textContent = `Моды ${snapshot.packName || 'сборки'}`;
    render();
  } catch (error) {
    elements.loading.classList.add('hidden');
    elements.empty.classList.remove('hidden');
    elements.empty.querySelector('strong').textContent = 'Не удалось прочитать моды';
    elements.empty.querySelector('p').textContent = friendlyError(error);
    showToast(friendlyError(error), 'error', 8000);
  }
}

document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
    render();
  });
});
elements.search.addEventListener('input', render);
byId('open-folder').addEventListener('click', () => window.launcher.openModsFolder());
byId('minimize-button').addEventListener('click', () => window.launcher.minimize());
byId('close-button').addEventListener('click', () => window.launcher.close());
window.launcher.onModsChanged((summary) => {
  snapshot = { ...snapshot, ...summary };
  updateCounts();
});
window.launcher.onModsLock(({ locked }) => {
  snapshot.locked = Boolean(locked);
  render();
});

loadMods();
