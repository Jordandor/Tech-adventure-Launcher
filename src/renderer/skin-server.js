(() => {
  'use strict';
  if (window.__techAdventureSkinUiInstalled) return;
  window.__techAdventureSkinUiInstalled = true;

  const api = window.techAdventureSkins;
  if (!api) return;

  const playerNamePattern = /^[A-Za-z0-9_]{1,16}$/;
  const authPanel = document.querySelector('.auth-panel');
  const serverPanel = document.querySelector('.server-panel');
  if (!authPanel || !serverPanel) return;

  const skinPanel = document.createElement('section');
  skinPanel.className = 'panel skin-panel';
  skinPanel.innerHTML = `
    <div class="skin-panel-heading">
      <div>
        <span class="section-kicker">СКИН ИГРОКА</span>
        <h2 id="skin-server-title" class="hidden">Скин на сервере:</h2>
      </div>
      <span class="skin-state-dot" id="skin-state-dot"></span>
    </div>
    <div class="skin-preview-shell" id="skin-preview-shell">
      <canvas id="skin-preview-canvas" aria-label="Трёхмерное отображение скина"></canvas>
      <div class="skin-preview-empty" id="skin-preview-empty">Скин ещё не загружен</div>
      <div class="skin-inline-message hidden" id="skin-message" aria-live="polite"></div>
    </div>
    <input id="skin-file-input" type="file" accept="image/png,.png" hidden>
    <button id="skin-upload-button" class="secondary-button skin-upload-button" type="button">Загрузить скин на сервер</button>
  `;
  serverPanel.parentElement.insertBefore(skinPanel, serverPanel);

  const oldTitle = serverPanel.querySelector('#server-status-title');
  const oldDetail = serverPanel.querySelector('#server-status-detail');
  oldTitle?.classList.add('skin-ui-hidden');
  oldDetail?.classList.add('skin-ui-hidden');

  const onlineList = document.createElement('div');
  onlineList.className = 'online-player-list';
  onlineList.id = 'online-player-list';
  serverPanel.appendChild(onlineList);

  const title = document.getElementById('skin-server-title');
  const stateDot = document.getElementById('skin-state-dot');
  const previewShell = document.getElementById('skin-preview-shell');
  const canvas = document.getElementById('skin-preview-canvas');
  const emptyPreview = document.getElementById('skin-preview-empty');
  const uploadButton = document.getElementById('skin-upload-button');
  const fileInput = document.getElementById('skin-file-input');
  const message = document.getElementById('skin-message');
  const offlineInput = document.getElementById('offline-username');
  const offlineMode = document.getElementById('offline-mode');
  const microsoftMode = document.getElementById('microsoft-mode');
  const microsoftName = document.getElementById('microsoft-name');
  const playerCount = document.getElementById('server-player-count');
  const playerLimit = document.getElementById('server-player-limit');

  let currentExists = false;
  let statusTimer = null;
  let messageTimer = null;
  let refreshSequence = 0;
  let skinViewer = null;

  function selectedPlayerName() {
    if (microsoftMode?.classList.contains('active')) {
      const value = String(microsoftName?.textContent || '').trim();
      return playerNamePattern.test(value) ? value : '';
    }
    const value = String(offlineInput?.value || '').trim();
    return playerNamePattern.test(value) ? value : '';
  }

  function setSkinMessage(text = '', kind = '', hideAfterMs = 0) {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.dataset.kind = kind;
    message.classList.toggle('hidden', !text);
    if (text && hideAfterMs > 0) {
      messageTimer = setTimeout(() => {
        message.textContent = '';
        message.classList.add('hidden');
      }, hideAfterMs);
    }
  }

  function ensureSkinViewer() {
    if (skinViewer) return skinViewer;
    if (!window.skinview3d?.SkinViewer) {
      throw new Error('Модуль трёхмерного отображения скина не загрузился.');
    }

    skinViewer = new window.skinview3d.SkinViewer({
      canvas,
      width: Math.max(220, Math.floor(previewShell.clientWidth)),
      height: Math.max(255, Math.floor(previewShell.clientHeight)),
      fov: 35,
      zoom: 0.92,
      enableControls: true,
      pixelRatio: 'match-device'
    });
    skinViewer.background = null;
    skinViewer.autoRotate = false;
    skinViewer.controls.enablePan = false;
    skinViewer.controls.enableZoom = false;
    skinViewer.controls.enableRotate = true;
    skinViewer.controls.minPolarAngle = Math.PI * 0.36;
    skinViewer.controls.maxPolarAngle = Math.PI * 0.64;
    skinViewer.globalLight.intensity = 3.1;
    skinViewer.cameraLight.intensity = 0.72;
    return skinViewer;
  }

  function resizeSkinViewer() {
    if (!skinViewer) return;
    const width = Math.max(220, Math.floor(previewShell.clientWidth));
    const height = Math.max(255, Math.floor(previewShell.clientHeight));
    skinViewer.width = width;
    skinViewer.height = height;
  }

  function applyPreviewPose(viewer) {
    const skin = viewer.playerObject.skin;
    skin.resetJoints();
    viewer.playerWrapper.rotation.y = -0.58;
    skin.head.rotation.y = -0.06;
    skin.rightArm.rotation.x = 0.16;
    skin.rightArm.rotation.z = 0.035;
    skin.leftArm.rotation.x = -0.13;
    skin.leftArm.rotation.z = -0.025;
    skin.rightLeg.rotation.x = -0.09;
    skin.leftLeg.rotation.x = 0.09;
  }

  function clearPreview() {
    canvas.classList.add('hidden');
    emptyPreview.classList.remove('hidden');
  }

  async function showSkinModel(base64) {
    const viewer = ensureSkinViewer();
    resizeSkinViewer();
    await viewer.loadSkin(`data:image/png;base64,${base64}`, { model: 'auto-detect' });
    applyPreviewPose(viewer);
    canvas.classList.remove('hidden');
    emptyPreview.classList.add('hidden');
  }

  function imageFromBase64(base64) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Не удалось прочитать изображение скина.'));
      image.src = `data:image/png;base64,${base64}`;
    });
  }

  async function refreshSkinState() {
    const sequence = ++refreshSequence;
    const name = selectedPlayerName();
    currentExists = false;
    title.classList.add('hidden');
    uploadButton.textContent = 'Загрузить скин на сервер';
    stateDot.className = 'skin-state-dot';
    clearPreview();
    setSkinMessage();

    if (!name) {
      uploadButton.disabled = true;
      return;
    }

    uploadButton.disabled = true;
    stateDot.classList.add('checking');
    try {
      const status = await api.status(name);
      if (sequence !== refreshSequence || name !== selectedPlayerName()) return;
      currentExists = Boolean(status.exists);
      if (!currentExists) {
        stateDot.className = 'skin-state-dot';
        uploadButton.textContent = 'Загрузить скин на сервер';
        return;
      }

      title.classList.remove('hidden');
      uploadButton.textContent = 'Обновить скин на сервере';
      stateDot.className = 'skin-state-dot online';
      const skin = await api.getSkin(name, 'uploaded');
      if (sequence !== refreshSequence || !skin.exists) return;
      await showSkinModel(skin.data);
    } catch (error) {
      if (sequence !== refreshSequence) return;
      stateDot.className = 'skin-state-dot error';
      setSkinMessage(error?.message || 'Сервис скинов недоступен.', 'error');
    } finally {
      if (sequence === refreshSequence) uploadButton.disabled = !selectedPlayerName();
    }
  }

  function scheduleSkinRefresh() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshSkinState, 250);
  }

  async function validateSkinFile(file) {
    if (!file || file.type !== 'image/png') throw new Error('Выбери файл формата PNG.');
    if (file.size > 2 * 1024 * 1024) throw new Error('Размер файла не должен превышать 2 МБ.');
    const image = await createImageBitmap(file);
    const valid = image.width === 64 && (image.height === 64 || image.height === 32);
    const result = { width: image.width, height: image.height };
    image.close();
    if (!valid) throw new Error(`Получен размер ${result.width}×${result.height}. Нужен 64×64 или 64×32.`);
  }

  uploadButton.addEventListener('click', () => {
    if (!selectedPlayerName()) {
      setSkinMessage('Сначала введи корректный ник.', 'error', 3500);
      return;
    }
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    const name = selectedPlayerName();
    if (!file || !name) return;
    uploadButton.disabled = true;
    uploadButton.classList.add('loading');
    setSkinMessage('Загрузка скина…', 'muted');
    try {
      await validateSkinFile(file);
      const bytes = await file.arrayBuffer();
      await api.upload(name, bytes);
      await refreshSkinState();
      setSkinMessage('Скин обновлён.', 'success', 2500);
    } catch (error) {
      setSkinMessage(error?.message || 'Не удалось загрузить скин.', 'error');
    } finally {
      uploadButton.classList.remove('loading');
      uploadButton.disabled = !selectedPlayerName();
    }
  });

  function drawFallbackHead(context) {
    context.fillStyle = '#7b5b43';
    context.fillRect(0, 0, 32, 32);
    context.fillStyle = '#c78f68';
    context.fillRect(5, 7, 22, 20);
    context.fillStyle = '#e8e5dc';
    context.fillRect(8, 14, 5, 4);
    context.fillRect(19, 14, 5, 4);
    context.fillStyle = '#38291f';
    context.fillRect(10, 15, 2, 2);
    context.fillRect(21, 15, 2, 2);
  }

  async function fillPlayerHead(canvasElement, name) {
    const context = canvasElement.getContext('2d');
    context.imageSmoothingEnabled = false;
    drawFallbackHead(context);
    try {
      const skin = await api.getSkin(name, 'game');
      if (!skin.exists) return;
      const image = await imageFromBase64(skin.data);
      context.clearRect(0, 0, 32, 32);
      context.drawImage(image, 8, 8, 8, 8, 0, 0, 32, 32);
      if (image.height >= 64) context.drawImage(image, 40, 8, 8, 8, 0, 0, 32, 32);
    } catch {}
  }

  function renderPlayers(data) {
    const players = Array.isArray(data?.players) ? data.players : [];
    const online = Number.isFinite(Number(data?.online)) ? Number(data.online) : players.length;
    const max = Number.isFinite(Number(data?.max)) ? Number(data.max) : 20;
    if (playerCount) playerCount.textContent = String(online);
    if (playerLimit) playerLimit.textContent = `из ${max}`;
    onlineList.replaceChildren();

    if (!players.length) {
      const empty = document.createElement('div');
      empty.className = 'online-list-empty';
      empty.textContent = 'Сейчас никто не играет';
      onlineList.appendChild(empty);
      return;
    }

    for (const player of players) {
      const name = String(player?.name || '');
      if (!playerNamePattern.test(name)) continue;
      const row = document.createElement('div');
      row.className = 'online-player-row';
      const head = document.createElement('canvas');
      head.width = 32;
      head.height = 32;
      head.className = 'online-player-head';
      const label = document.createElement('span');
      label.textContent = name;
      row.append(head, label);
      onlineList.appendChild(row);
      fillPlayerHead(head, name);
    }
  }

  async function refreshPlayers() {
    try {
      renderPlayers(await api.players());
    } catch {
      onlineList.replaceChildren();
      const unavailable = document.createElement('div');
      unavailable.className = 'online-list-empty error';
      unavailable.textContent = 'Список игроков временно недоступен';
      onlineList.appendChild(unavailable);
    }
  }

  offlineInput?.addEventListener('input', scheduleSkinRefresh);
  offlineMode?.addEventListener('click', scheduleSkinRefresh);
  microsoftMode?.addEventListener('click', scheduleSkinRefresh);
  new MutationObserver(scheduleSkinRefresh).observe(microsoftName || document.body, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(resizeSkinViewer).observe(previewShell);

  refreshSkinState();
  refreshPlayers();
  setInterval(refreshPlayers, 10_000);
})();
