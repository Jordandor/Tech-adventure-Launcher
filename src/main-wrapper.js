'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const electron = require('electron');

const { app, ipcMain, screen } = electron;
const OriginalBrowserWindow = electron.BrowserWindow;
const SKIN_SERVICE_HOST = '45.152.160.143';
const SKIN_SERVICE_PORT = 25888;
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const WINDOW_STATE_FILE = 'main-window-state.json';

function windowStatePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function readWindowState() {
  try {
    const value = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
    return value;
  } catch {
    return null;
  }
}

function normalizeWindowState(state) {
  const fallback = { width: 1360, height: 850 };
  if (!state) return fallback;
  const width = Math.max(1100, Math.round(state.width));
  const height = Math.max(720, Math.round(state.height));
  const candidate = {
    width,
    height,
    ...(Number.isFinite(state.x) ? { x: Math.round(state.x) } : {}),
    ...(Number.isFinite(state.y) ? { y: Math.round(state.y) } : {})
  };
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some((display) => {
      const area = display.workArea;
      const x = candidate.x ?? area.x;
      const y = candidate.y ?? area.y;
      return x < area.x + area.width - 80 && x + width > area.x + 80
        && y < area.y + area.height - 80 && y + height > area.y + 80;
    });
    if (!visible) return fallback;
  } catch {
    return candidate;
  }
  return candidate;
}

function saveWindowState(window) {
  if (!window || window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
  try {
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(window.getBounds()), 'utf8');
  } catch {
    // Сохранение размера не должно мешать работе лаунчера.
  }
}

function injectSkinUi(window) {
  const cssPath = path.join(__dirname, 'renderer', 'skin-server.css');
  const scriptPath = path.join(__dirname, 'renderer', 'skin-server.js');
  try {
    const css = fs.readFileSync(cssPath, 'utf8');
    window.webContents.insertCSS(css).catch(() => {});
  } catch {}
  try {
    const script = fs.readFileSync(scriptPath, 'utf8');
    window.webContents.executeJavaScript(script, true).catch((error) => {
      console.error('[launcher:skins] Не удалось добавить интерфейс скинов:', error);
    });
  } catch (error) {
    console.error('[launcher:skins] Не удалось прочитать интерфейс скинов:', error);
  }
}

class TechAdventureBrowserWindow extends OriginalBrowserWindow {
  constructor(options = {}) {
    const isMainWindow = options.width === 1180 && options.height === 760;
    let nextOptions = options;
    if (isMainWindow) {
      const bounds = normalizeWindowState(readWindowState());
      nextOptions = {
        ...options,
        ...bounds,
        minWidth: 1100,
        minHeight: 720,
        webPreferences: {
          ...(options.webPreferences || {}),
          preload: path.join(__dirname, 'preload-wrapper.js')
        }
      };
    }
    super(nextOptions);
    if (!isMainWindow) return;

    let saveTimer = null;
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveWindowState(this), 250);
    };
    this.on('resize', scheduleSave);
    this.on('move', scheduleSave);
    this.on('close', () => saveWindowState(this));
    this.webContents.on('did-finish-load', () => injectSkinUi(this));
  }
}

function requestSkinService({ method = 'GET', requestPath = '/', body = null, headers = {}, timeoutMs = 7000 }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: SKIN_SERVICE_HOST,
      port: SKIN_SERVICE_PORT,
      method,
      path: requestPath,
      headers,
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.once('timeout', () => request.destroy(new Error('Сервис скинов не ответил вовремя.')));
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function checkedName(value) {
  const name = String(value || '').trim();
  if (!PLAYER_NAME.test(name)) throw new Error('Введите корректный ник игрока.');
  return name;
}

function serverError(response, fallback) {
  try {
    const parsed = JSON.parse(response.body.toString('utf8'));
    return new Error(parsed.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

ipcMain.handle('skins:status', async (_event, payload) => {
  const name = checkedName(payload?.name);
  const response = await requestSkinService({
    method: 'HEAD',
    requestPath: `/skins/uploaded/${encodeURIComponent(name)}.png`
  });
  if (response.status === 404) return { exists: false };
  if (response.status !== 200) throw serverError(response, 'Не удалось проверить скин на сервере.');
  return { exists: true };
});

ipcMain.handle('skins:get', async (_event, payload) => {
  const name = checkedName(payload?.name);
  const kind = payload?.kind === 'game' ? 'game' : 'uploaded';
  const response = await requestSkinService({
    requestPath: `/skins/${kind}/${encodeURIComponent(name)}.png?ts=${Date.now()}`
  });
  if (response.status === 404) return { exists: false, data: '' };
  if (response.status !== 200) throw serverError(response, 'Не удалось загрузить изображение скина.');
  return { exists: true, data: response.body.toString('base64') };
});

ipcMain.handle('skins:upload', async (_event, payload) => {
  const name = checkedName(payload?.name);
  const bytes = Buffer.from(payload?.bytes || []);
  if (!bytes.length) throw new Error('Файл скина пуст.');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Файл скина слишком большой.');
  const response = await requestSkinService({
    method: 'POST',
    requestPath: `/api/skin/upload?name=${encodeURIComponent(name)}`,
    body: bytes,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-cache'
    },
    timeoutMs: 12000
  });
  if (response.status !== 200) throw serverError(response, 'Не удалось загрузить скин на сервер.');
  return JSON.parse(response.body.toString('utf8'));
});

ipcMain.handle('skins:players', async () => {
  const response = await requestSkinService({ requestPath: `/api/players?ts=${Date.now()}` });
  if (response.status !== 200) throw serverError(response, 'Не удалось получить список игроков.');
  return JSON.parse(response.body.toString('utf8'));
});

const originalLoad = Module._load;
Module._load = function patchedElectronLoad(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request === 'electron' && parent?.filename === path.join(__dirname, 'main.js')) {
    const patched = Object.create(loaded);
    Object.defineProperty(patched, 'BrowserWindow', { value: TechAdventureBrowserWindow, enumerable: true });
    return patched;
  }
  return loaded;
};

require('./main.js');
