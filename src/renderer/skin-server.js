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
      <canvas id="skin-preview-canvas" width="180" height="260" aria-label="Трёхмерное отображение скина"></canvas>
      <div class="skin-preview-empty" id="skin-preview-empty">Скин ещё не загружен</div>
    </div>
    <input id="skin-file-input" type="file" accept="image/png,.png" hidden>
    <button id="skin-upload-button" class="secondary-button skin-upload-button" type="button">Загрузить скин на сервер</button>
    <p class="skin-message" id="skin-message">Введите ник, затем выберите PNG 64×64 или 64×32.</p>
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

  let currentName = '';
  let currentExists = false;
  let statusTimer = null;
  let refreshSequence = 0;

  function selectedPlayerName() {
    if (microsoftMode?.classList.contains('active')) {
      const value = String(microsoftName?.textContent || '').trim();
      return playerNamePattern.test(value) ? value : '';
    }
    const value = String(offlineInput?.value || '').trim();
    return playerNamePattern.test(value) ? value : '';
  }

  function setSkinMessage(text, kind = '') {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  function clearPreview() {
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.classList.add('hidden');
    emptyPreview.classList.remove('hidden');
  }

  function imageFromBase64(base64) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Не удалось прочитать изображение скина.'));
      image.src = `data:image/png;base64,${base64}`;
    });
  }

  function drawPixelFace(context, image, source, destination, shade = 1) {
    context.save();
    context.imageSmoothingEnabled = false;
    context.globalAlpha = shade;
    context.drawImage(image, source.x, source.y, source.w, source.h,
      destination.x, destination.y, destination.w, destination.h);
    context.restore();
  }

  function drawPart(context, image, x, y, front, side, top, width, height, depth, scale) {
    const frontRect = { x, y: y + depth * scale, w: width * scale, h: height * scale };
    const sideRect = { x: x + width * scale, y, w: depth * scale, h: height * scale };
    const topRect = { x, y, w: width * scale, h: depth * scale };
    drawPixelFace(context, image, top, topRect, 0.92);
    drawPixelFace(context, image, side, sideRect, 0.72);
    drawPixelFace(context, image, front, frontRect, 1);
    context.strokeStyle = 'rgba(0,0,0,.18)';
    context.lineWidth = 1;
    context.strokeRect(frontRect.x + 0.5, frontRect.y + 0.5, frontRect.w - 1, frontRect.h - 1);
  }

  function drawSkinModel(image) {
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.save();
    context.translate(13, 2);

    const s = 3.05;
    drawPart(context, image, 53, 5,
      { x: 8, y: 8, w: 8, h: 8 }, { x: 0, y: 8, w: 8, h: 8 }, { x: 8, y: 0, w: 8, h: 8 },
      8, 8, 4, s);
    drawPart(context, image, 53, 42,
      { x: 20, y: 20, w: 8, h: 12 }, { x: 16, y: 20, w: 4, h: 12 }, { x: 20, y: 16, w: 8, h: 4 },
      8, 12, 3.2, s);
    drawPart(context, image, 37, 42,
      { x: 44, y: 20, w: 4, h: 12 }, { x: 40, y: 20, w: 4, h: 12 }, { x: 44, y: 16, w: 4, h: 4 },
      4, 12, 2.5, s);
    const leftArmFront = image.height >= 64 ? { x: 36, y: 52, w: 4, h: 12 } : { x: 44, y: 20, w: 4, h: 12 };
    const leftArmSide = image.height >= 64 ? { x: 32, y: 52, w: 4, h: 12 } : { x: 40, y: 20, w: 4, h: 12 };
    const leftArmTop = image.height >= 64 ? { x: 36, y: 48, w: 4, h: 4 } : { x: 44, y: 16, w: 4, h: 4 };
    drawPart(context, image, 87, 42, leftArmFront, leftArmSide, leftArmTop, 4, 12, 2.5, s);
    drawPart(context, image, 53, 88,
      { x: 4, y: 20, w: 4, h: 12 }, { x: 0, y: 20, w: 4, h: 12 }, { x: 4, y: 16, w: 4, h: 4 },
      4, 12, 2.5, s);
    const leftLegFront = image.height >= 64 ? { x: 20, y: 52, w: 4, h: 12 } : { x: 4, y: 20, w: 4, h: 12 };
    const leftLegSide = image.height >= 64 ? { x: 16, y: 52, w: 4, h: 12 } : { x: 0, y: 20, w: 4, h: 12 };
    const leftLegTop = image.height >= 64 ? { x: 20, y: 48, w: 4, h: 4 } : { x: 4, y: 16, w: 4, h: 4 };
    drawPart(context, image, 68, 88, leftLegFront, leftLegSide, leftLegTop, 4, 12, 2.5, s);

    context.restore();
    canvas.classList.remove('hidden');
    emptyPreview.classList.add('hidden');
  }

  async function refreshSkinState() {
    const sequence = ++refreshSequence;
    const name = selectedPlayerName();
    currentName = name;
    currentExists = false;
    title.classList.add('hidden');
    uploadButton.textContent = 'Загрузить скин на сервер';
    stateDot.className = 'skin-state-dot';
    clearPreview();

    if (!name) {
      uploadButton.disabled = true;
      setSkinMessage('Введите корректный ник игрока.', 'muted');
      return;
    }

    uploadButton.disabled = true;
    stateDot.classList.add('checking');
    setSkinMessage('Проверяю скин на сервере…', 'muted');
    try {
      const status = await api.status(name);
      if (sequence !== refreshSequence || name !== selectedPlayerName()) return;
      currentExists = Boolean(status.exists);
      if (!currentExists) {
        stateDot.className = 'skin-state-dot';
        uploadButton.textContent = 'Загрузить скин на сервер';
        setSkinMessage('PNG 64×64 или 64×32, не более 2 МБ.', 'muted');
        return;
      }

      title.classList.remove('hidden');
      uploadButton.textContent = 'Обновить скин на сервере';
      stateDot.className = 'skin-state-dot online';
      setSkinMessage('В лаунчере отображается исходный загруженный скин.', 'success');
      const skin = await api.getSkin(name, 'uploaded');
      if (sequence !== refreshSequence || !skin.exists) return;
      const image = await imageFromBase64(skin.data);
      if (sequence !== refreshSequence) return;
      drawSkinModel(image);
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
      setSkinMessage('Сначала введи корректный ник.', 'error');
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
    setSkinMessage('Проверяю и загружаю скин…', 'muted');
    try {
      await validateSkinFile(file);
      const bytes = await file.arrayBuffer();
      await api.upload(name, bytes);
      setSkinMessage('Скин успешно загружен на сервер.', 'success');
      await refreshSkinState();
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

  refreshSkinState();
  refreshPlayers();
  setInterval(refreshPlayers, 10_000);
})();
