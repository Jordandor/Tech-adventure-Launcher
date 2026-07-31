'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Authflow, Titles } = require('prismarine-auth');

function cacheFileName(username, cacheName) {
  const digest = crypto.createHash('sha256').update(`${username}:${cacheName}`).digest('hex');
  return `${digest}.authcache`;
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
        userType: 'mojang'
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
  friendlyAuthError
};
