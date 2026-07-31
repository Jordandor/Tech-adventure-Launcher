'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Authflow, Titles } = require('prismarine-auth');

const MINECRAFT_XSTS_RELYING_PARTY = 'rp://api.minecraftservices.com/';
const MINECRAFT_CLIENT_ID_FILE = 'minecraft-client-id.txt';

function cacheFileName(username, cacheName) {
  const digest = crypto.createHash('sha256').update(`${username}:${cacheName}`).digest('hex');
  return `${digest}.authcache`;
}


function createMinecraftClientId() {
  return Buffer.from(crypto.randomUUID(), 'utf8').toString('base64');
}

function isValidMinecraftClientId(value) {
  try {
    const decoded = Buffer.from(String(value || '').trim(), 'base64').toString('utf8');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded);
  } catch {
    return false;
  }
}

async function getOrCreateMinecraftClientId(cacheDirectory) {
  const file = path.join(cacheDirectory, MINECRAFT_CLIENT_ID_FILE);
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (isValidMinecraftClientId(existing)) return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const clientId = createMinecraftClientId();
  await fs.mkdir(cacheDirectory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${clientId}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
  return clientId;
}

class EncryptedFileCache {
  constructor(file, safeStorage) {
    this.file = file;
    this.safeStorage = safeStorage;
  }

  async reset() {
    await fs.rm(this.file, { force: true });
  }

  async getCached() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (envelope.encrypted) {
        if (!this.safeStorage.isEncryptionAvailable()) return {};
        const clearText = this.safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
        return JSON.parse(clearText);
      }
      return envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      return {};
    }
  }

  async setCached(value) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const clearText = JSON.stringify(value ?? {});
    const encrypted = this.safeStorage.isEncryptionAvailable();
    const envelope = encrypted
      ? { version: 1, encrypted: true, payload: this.safeStorage.encryptString(clearText).toString('base64') }
      : { version: 1, encrypted: false, payload: value ?? {} };
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  async setCachedPartial(value) {
    const current = await this.getCached();
    await this.setCached({ ...current, ...value });
  }
}

function friendlyAuthError(error) {
  const message = String(error?.message || error || 'Неизвестная ошибка авторизации');
  if (/Not Found|profile/i.test(message)) {
    return new Error('У этого аккаунта не найден профиль Minecraft: Java Edition.');
  }
  if (/2148916233/.test(message)) {
    return new Error('У аккаунта ещё не создан профиль Xbox. Создай его на xbox.com и повтори вход.');
  }
  if (/2148916238|family|guardian/i.test(message)) {
    return new Error('Для этого аккаунта требуются разрешения семейной группы Microsoft.');
  }
  if (/fetch|network|ENOTFOUND|ECONN/i.test(message)) {
    return new Error('Не удалось связаться с Microsoft. Проверь интернет и повтори вход.');
  }
  return new Error(message);
}

class MicrosoftAuthManager {
  constructor({ cacheDirectory, safeStorage }) {
    this.cacheDirectory = cacheDirectory;
    this.safeStorage = safeStorage;
    this.session = null;
    this.activeLogin = null;
  }

  cacheFactory = ({ username, cacheName }) => new EncryptedFileCache(
    path.join(this.cacheDirectory, cacheFileName(username, cacheName)),
    this.safeStorage
  );

  async login(onDeviceCode) {
    if (this.activeLogin) return this.activeLogin;
    this.activeLogin = this.#login(onDeviceCode).finally(() => {
      this.activeLogin = null;
    });
    return this.activeLogin;
  }

  async #login(onDeviceCode) {
    try {
      const flow = new Authflow(
        'primary-account',
        this.cacheFactory,
        { authTitle: Titles.MinecraftJava, deviceType: 'Win32', flow: 'sisu' },
        (code) => {
          onDeviceCode?.({
            userCode: code.user_code || code.userCode || '',
            verificationUri: code.verification_uri || code.verificationUri || 'https://www.microsoft.com/link',
            expiresIn: code.expires_in || code.expiresIn || 900,
            message: code.message || ''
          });
        }
      );
      const response = await flow.getMinecraftJavaToken({
        fetchEntitlements: true,
        fetchProfile: true
      });
      if (!response?.profile?.id || !response?.profile?.name || !response?.token) {
        throw new Error('Microsoft вернул неполные данные профиля Minecraft.');
      }

      const xbox = await flow.getXboxToken(MINECRAFT_XSTS_RELYING_PARTY);
      const xuid = String(xbox?.userXUID || '').trim();
      if (!/^\d+$/.test(xuid)) {
        throw new Error('Microsoft не вернул Xbox User ID, необходимый для лицензионного запуска Minecraft.');
      }
      const clientId = await getOrCreateMinecraftClientId(this.cacheDirectory);
      const skins = Array.isArray(response.profile.skins) ? response.profile.skins : [];
      const activeSkin = skins.find((skin) => skin?.state === 'ACTIVE') || skins[0] || null;
      this.session = {
        mode: 'microsoft',
        profile: {
          id: response.profile.id.replaceAll('-', ''),
          name: response.profile.name,
          skinUrl: String(activeSkin?.url || ''),
          skins,
          capes: response.profile.capes || []
        },
        accessToken: response.token,
        userType: 'msa',
        xuid,
        clientId
      };
      return this.publicState();
    } catch (error) {
      throw friendlyAuthError(error);
    }
  }

  getSession() {
    return this.session;
  }

  publicState() {
    return this.session
      ? { authenticated: true, profile: structuredClone(this.session.profile) }
      : { authenticated: false, profile: null };
  }

  async logout() {
    this.session = null;
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    const files = await fs.readdir(this.cacheDirectory).catch(() => []);
    await Promise.all(files
      .filter((file) => file.endsWith('.authcache'))
      .map((file) => fs.rm(path.join(this.cacheDirectory, file), { force: true })));
    return this.publicState();
  }
}

module.exports = {
  MicrosoftAuthManager,
  EncryptedFileCache,
  cacheFileName,
  createMinecraftClientId,
  isValidMinecraftClientId,
  getOrCreateMinecraftClientId,
  friendlyAuthError,
  MINECRAFT_XSTS_RELYING_PARTY,
  MINECRAFT_CLIENT_ID_FILE
};
