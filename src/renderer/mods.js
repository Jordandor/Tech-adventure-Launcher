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
  clientCount: byId('client-count'),
  sort: byId('sort-select'),
  footerStatus: byId('footer-status'),
  toast: byId('toast'),
  enableAll: byId('enable-all'),
  disableAll: byId('disable-all'),
  modal: byId('decision-modal'),
  modalKicker: byId('decision-kicker'),
  modalTitle: byId('decision-title'),
  modalMessage: byId('decision-message'),
  modalList: byId('decision-list'),
  modalCancel: byId('decision-cancel'),
  modalPrimary: byId('decision-primary'),
  modalSecondary: byId('decision-secondary'),
  descriptionTooltip: byId('mod-description-tooltip'),
  descriptionTitle: byId('mod-description-title'),
  descriptionText: byId('mod-description-text')
};

let snapshot = { mods: [], enabledCount: 0, disabledCount: 0, clientCount: 0, totalCount: 0, locked: false };
let filter = 'all';
let sortMode = localStorage.getItem('mods-sort-mode') || 'name';
if (!['name', 'client-first'].includes(sortMode)) sortMode = 'name';
let toastTimer = null;
let decisionResolve = null;
let descriptionTimer = null;

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

function compareByName(left, right) {
  return String(left.name || left.activeFileName || '').localeCompare(
    String(right.name || right.activeFileName || ''),
    'ru',
    { sensitivity: 'base' }
  ) || String(left.fileName || '').localeCompare(String(right.fileName || ''), 'en');
}

function sortMods(mods) {
  return mods.slice().sort((left, right) => {
    if (sortMode === 'client-first' && Boolean(left.clientSide) !== Boolean(right.clientSide)) {
      return left.clientSide ? -1 : 1;
    }
    return compareByName(left, right);
  });
}

function matches(mod) {
  if (filter === 'enabled' && !mod.enabled) return false;
  if (filter === 'disabled' && mod.enabled) return false;
  if (filter === 'client' && !mod.clientSide) return false;
  const query = elements.search.value.trim().toLocaleLowerCase('ru');
  if (!query) return true;
  return [mod.name, mod.modId, mod.fileName, mod.description, mod.loader]
    .some((value) => String(value || '').toLocaleLowerCase('ru').includes(query));
}

function hideDescriptionTooltip() {
  clearTimeout(descriptionTimer);
  descriptionTimer = null;
  elements.descriptionTooltip.classList.add('hidden');
}

function showDescriptionTooltip(row, mod) {
  elements.descriptionTitle.textContent = mod.name || mod.activeFileName;
  elements.descriptionText.textContent = mod.description || 'Автор мода не добавил описание в метаданные.';
  elements.descriptionTooltip.classList.remove('hidden');

  const rowRect = row.getBoundingClientRect();
  const tooltipRect = elements.descriptionTooltip.getBoundingClientRect();
  const margin = 12;
  const left = Math.min(
    Math.max(margin, rowRect.left + 54),
    window.innerWidth - tooltipRect.width - margin
  );
  let top = rowRect.bottom + 7;
  if (top + tooltipRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rowRect.top - tooltipRect.height - 7);
  }
  elements.descriptionTooltip.style.left = `${left}px`;
  elements.descriptionTooltip.style.top = `${top}px`;
}

function closeDecision(choice = 'cancel') {
  elements.modal.classList.add('hidden');
  const resolve = decisionResolve;
  decisionResolve = null;
  resolve?.(choice);
}

function openDecision({ kicker, title, message, items = [], primary, secondary = null }) {
  if (decisionResolve) closeDecision('cancel');
  elements.modalKicker.textContent = kicker || 'ПОДТВЕРЖДЕНИЕ';
  elements.modalTitle.textContent = title;
  elements.modalMessage.textContent = message;
  elements.modalList.replaceChildren();
  elements.modalList.classList.toggle('hidden', items.length === 0);

  const visibleItems = items.slice(0, 12);
  for (const item of visibleItems) {
    const row = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = item.name || item.activeFileName || item.fileName;
    const details = document.createElement('span');
    details.textContent = item.modId ? `${item.modId}${item.dependencyDepth ? ` · уровень зависимости ${item.dependencyDepth}` : ''}` : item.activeFileName || '';
    row.append(name, details);
    elements.modalList.append(row);
  }
  if (items.length > visibleItems.length) {
    const more = document.createElement('div');
    more.className = 'decision-more';
    more.textContent = `И ещё ${items.length - visibleItems.length}`;
    elements.modalList.append(more);
  }

  elements.modalPrimary.textContent = primary.label;
  elements.modalPrimary.dataset.choice = primary.choice;
  elements.modalPrimary.className = `decision-button ${primary.kind || 'primary'}`;

  if (secondary) {
    elements.modalSecondary.textContent = secondary.label;
    elements.modalSecondary.dataset.choice = secondary.choice;
    elements.modalSecondary.className = `decision-button ${secondary.kind || 'secondary'}`;
    elements.modalSecondary.classList.remove('hidden');
  } else {
    elements.modalSecondary.classList.add('hidden');
  }

  elements.modal.classList.remove('hidden');
  elements.modalPrimary.focus();
  return new Promise((resolve) => { decisionResolve = resolve; });
}

async function reloadMods({ showLoading = false } = {}) {
  if (showLoading) {
    elements.loading.classList.remove('hidden');
    elements.list.classList.add('hidden');
    elements.empty.classList.add('hidden');
  }
  const previousLocked = snapshot.locked;
  const next = await window.launcher.listMods();
  snapshot = { ...next, locked: Boolean(next.locked || previousLocked) };
  elements.pageTitle.textContent = `Моды ${snapshot.packName || 'сборки'}`;
  render();
}

async function toggleSingleMod(mod, nextEnabled) {
  if (snapshot.locked) return;
  let cascade = false;

  if (!nextEnabled) {
    const analysis = await window.launcher.analyzeModToggle(mod.fileName, false);
    if (analysis.requiresConfirmation) {
      const count = analysis.dependents.length;
      const choice = await openDecision({
        kicker: 'ПРОВЕРКА ЗАВИСИМОСТЕЙ',
        title: `${mod.name} требуется другим модам`,
        message: `От этого мода зависит ${count} ${count === 1 ? 'включённый мод' : 'включённых модов'}. Выключение только выбранного мода может привести к ошибке запуска сборки.`,
        items: analysis.dependents,
        primary: { choice: 'only', label: 'Выключить только этот', kind: 'warning' },
        secondary: { choice: 'cascade', label: 'Выключить также зависимые', kind: 'danger' }
      });
      if (choice === 'cancel') return;
      cascade = choice === 'cascade';
    }
  }

  snapshot.locked = true;
  render();
  try {
    const response = await window.launcher.toggleMod(mod.fileName, nextEnabled, cascade);
    await reloadMods();
    const extra = response.dependentCount
      ? ` Вместе с ним выключено зависимых модов: ${response.dependentCount}.`
      : '';
    showToast(`${mod.name}: ${nextEnabled ? 'включён' : 'выключен'}.${extra} Изменение применится при следующем запуске.`);
  } finally {
    snapshot.locked = false;
    render();
  }
}

function createModRow(mod) {
  const row = document.createElement('article');
  row.className = `mod-row${mod.enabled ? '' : ' disabled'}${mod.clientSide ? ' client-side' : ''}`;
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
    icon.classList.add('placeholder');
    const placeholder = document.createElement('span');
    placeholder.className = 'mod-icon-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    const core = document.createElement('i');
    placeholder.append(core);
    icon.append(placeholder);
  }
  const copy = document.createElement('div');
  copy.className = 'mod-copy';
  const titleLine = document.createElement('div');
  titleLine.className = 'mod-title-line';
  const name = document.createElement('strong');
  name.textContent = mod.name || mod.activeFileName;
  titleLine.append(name);
  if (mod.clientSide) {
    const clientBadge = document.createElement('span');
    clientBadge.className = 'client-mod-badge';
    const sparkle = document.createElement('i');
    sparkle.className = 'client-mod-sparkle';
    sparkle.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = 'Клиентский мод';
    clientBadge.append(sparkle, label);
    titleLine.append(clientBadge);
  }
  const file = document.createElement('span');
  file.textContent = `${mod.activeFileName} · ${formatBytes(mod.size)}`;
  const badges = document.createElement('div');
  badges.className = 'mod-badges';
  const sourceBadge = document.createElement('small');
  sourceBadge.textContent = mod.managed ? 'Управляется сборкой' : 'Пользовательский мод';
  badges.append(sourceBadge);
  if (Array.isArray(mod.dependencies) && mod.dependencies.length) {
    const dependencyBadge = document.createElement('small');
    dependencyBadge.textContent = `Зависимостей: ${mod.dependencies.length}`;
    dependencyBadge.title = mod.dependencies.join(', ');
    badges.append(dependencyBadge);
  }
  copy.append(titleLine, file, badges);
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
    toggle.disabled = true;
    try {
      await toggleSingleMod(mod, !mod.enabled);
    } catch (error) {
      showToast(friendlyError(error), 'error', 8000);
    } finally {
      toggle.disabled = snapshot.locked;
    }
  });
  state.append(stateLabel, toggle);
  row.append(identity, version, loader, state);
  row.addEventListener('mouseenter', () => {
    clearTimeout(descriptionTimer);
    descriptionTimer = setTimeout(() => showDescriptionTooltip(row, mod), 320);
  });
  row.addEventListener('mouseleave', hideDescriptionTooltip);
  row.addEventListener('focusin', () => showDescriptionTooltip(row, mod));
  row.addEventListener('focusout', hideDescriptionTooltip);
  return row;
}

function updateCounts() {
  elements.totalCount.textContent = snapshot.totalCount;
  elements.enabledCount.textContent = snapshot.enabledCount;
  elements.disabledCount.textContent = snapshot.disabledCount;
  elements.clientCount.textContent = snapshot.clientCount || 0;
  elements.enableAll.disabled = snapshot.locked || snapshot.disabledCount === 0;
  elements.disableAll.disabled = snapshot.locked || snapshot.enabledCount === 0;
  elements.footerStatus.textContent = snapshot.locked
    ? 'Minecraft или операция с файлами сейчас работает — переключатели временно заблокированы.'
    : `Включено ${snapshot.enabledCount} из ${snapshot.totalCount} модов.`;
}

function render() {
  hideDescriptionTooltip();
  const visible = sortMods(snapshot.mods.filter(matches));
  elements.list.replaceChildren(...visible.map(createModRow));
  elements.list.classList.toggle('hidden', visible.length === 0);
  elements.empty.classList.toggle('hidden', visible.length !== 0);
  elements.loading.classList.add('hidden');
  updateCounts();
}

async function setAll(enabled) {
  const count = enabled ? snapshot.disabledCount : snapshot.enabledCount;
  if (!count || snapshot.locked) return;
  const choice = await openDecision({
    kicker: 'МАССОВОЕ ИЗМЕНЕНИЕ',
    title: enabled ? 'Включить все моды?' : 'Выключить все моды?',
    message: enabled
      ? `Будут включены все ${count} выключенных модов. Изменение применится при следующем запуске.`
      : `Будут выключены все ${count} активных модов. Minecraft запустится без модов из этой папки.`,
    primary: {
      choice: 'confirm',
      label: enabled ? 'Включить все' : 'Выключить все',
      kind: enabled ? 'primary' : 'danger'
    }
  });
  if (choice !== 'confirm') return;

  snapshot.locked = true;
  render();
  try {
    const response = await window.launcher.setAllMods(enabled);
    await reloadMods();
    showToast(`${enabled ? 'Включено' : 'Выключено'} модов: ${response.results.length}. Изменение применится при следующем запуске.`);
  } catch (error) {
    showToast(friendlyError(error), 'error', 8500);
  } finally {
    snapshot.locked = false;
    render();
  }
}

async function loadMods() {
  try {
    await reloadMods({ showLoading: true });
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
elements.sort.value = sortMode;
elements.sort.addEventListener('change', () => {
  sortMode = elements.sort.value;
  localStorage.setItem('mods-sort-mode', sortMode);
  render();
});
elements.search.addEventListener('input', render);
elements.list.addEventListener('scroll', hideDescriptionTooltip, { passive: true });
window.addEventListener('resize', hideDescriptionTooltip);
elements.enableAll.addEventListener('click', () => setAll(true));
elements.disableAll.addEventListener('click', () => setAll(false));
byId('open-folder').addEventListener('click', () => window.launcher.openModsFolder());
byId('minimize-button').addEventListener('click', () => window.launcher.minimize());
byId('close-button').addEventListener('click', () => window.launcher.close());
elements.modalCancel.addEventListener('click', () => closeDecision('cancel'));
elements.modalPrimary.addEventListener('click', () => closeDecision(elements.modalPrimary.dataset.choice));
elements.modalSecondary.addEventListener('click', () => closeDecision(elements.modalSecondary.dataset.choice));
elements.modal.addEventListener('click', (event) => {
  if (event.target === elements.modal) closeDecision('cancel');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.modal.classList.contains('hidden')) closeDecision('cancel');
});
window.launcher.onModsChanged((summary) => {
  snapshot = { ...snapshot, ...summary };
  updateCounts();
});
window.launcher.onModsLock(({ locked }) => {
  snapshot.locked = Boolean(locked);
  render();
});

loadMods();
