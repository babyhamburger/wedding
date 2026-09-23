'use strict';
// 极简 .env 加载（避免多引一个 dotenv 依赖）
const fs = require('fs');
const path = require('path');

function load() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

load();

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  STORAGE: (process.env.STORAGE || 'local').toLowerCase(),
  WEDDING_TITLE: process.env.WEDDING_TITLE || '婚礼现场照片墙',
  WEDDING_DATE: process.env.WEDDING_DATE || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'change-me-please',
  // 超管总控台口令（多场次管理）；未配置时回退用 ADMIN_TOKEN
  SUPER_TOKEN: process.env.SUPER_TOKEN || process.env.ADMIN_TOKEN || 'change-me-please',
  MAX_UPLOAD_BYTES: 15 * 1024 * 1024,
  MAX_VIDEO_BYTES: 500 * 1024 * 1024,
  ALLOWED_MIME: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
  ALLOWED_VIDEO_MIME: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
  OSS: {
    region: process.env.OSS_REGION || '',
    bucket: process.env.OSS_BUCKET || '',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    publicBase: (process.env.OSS_PUBLIC_BASE || '').replace(/\/+$/, ''),
    prefix: process.env.OSS_PREFIX || 'wedding'
  }
};
