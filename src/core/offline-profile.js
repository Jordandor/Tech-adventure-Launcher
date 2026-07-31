'use strict';

const crypto = require('node:crypto');

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

function validateOfflineUsername(username) {
  const normalized = String(username ?? '').trim();
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error('Ник должен содержать от 3 до 16 латинских букв, цифр или символов _.');
  }
  return normalized;
}

function offlineUuid(username) {
  const validName = validateOfflineUsername(username);
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${validName}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createOfflineSession(username) {
  const name = validateOfflineUsername(username);
  return {
    mode: 'offline',
    profile: {
      name,
      id: offlineUuid(name).replaceAll('-', '')
    },
    accessToken: '0',
    userType: 'legacy'
  };
}

module.exports = {
  USERNAME_PATTERN,
  validateOfflineUsername,
  offlineUuid,
  createOfflineSession
};
