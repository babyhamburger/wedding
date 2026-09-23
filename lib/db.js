'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const env = require('./env');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hunli.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  file_key      TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT,
  size          INTEGER,
  width         INTEGER,
  height        INTEGER,
  uploader_ip   TEXT,
  status        TEXT NOT NULL DEFAULT 'init',
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_photos_wall ON photos(status, confirmed_at);

CREATE TABLE IF NOT EXISTS events (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL DEFAULT '',
  admin_token TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at  INTEGER NOT NULL
);
`);

// 迁移：为旧库补充 media_type 列（image | video）
const cols = db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
if (!cols.includes('media_type')) {
  db.exec(`ALTER TABLE photos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'`);
}
// 迁移：视频封面帧的对象 key
if (!cols.includes('poster_key')) {
  db.exec(`ALTER TABLE photos ADD COLUMN poster_key TEXT`);
}
// 迁移：多租户——照片归属场次（旧数据全部归入 default）
if (!cols.includes('event_slug')) {
  db.exec(`ALTER TABLE photos ADD COLUMN event_slug TEXT NOT NULL DEFAULT 'default'`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_photos_event ON photos(event_slug, status, confirmed_at)`);

// 默认场次：沿用 .env 的标题/日期/口令，保证旧 URL 与已打印二维码继续可用
(function ensureDefaultEvent() {
  const exists = db.prepare('SELECT slug FROM events WHERE slug = ?').get('default');
  if (!exists) {
    db.prepare(`INSERT INTO events (slug, title, date, admin_token, status, created_at)
                VALUES ('default', ?, ?, ?, 'active', ?)`)
      .run(env.WEDDING_TITLE, env.WEDDING_DATE, env.ADMIN_TOKEN, Date.now());
  }
})();

const stmts = {
  insert: db.prepare(`INSERT INTO photos (id, file_key, original_name, mime, size, uploader_ip, status, created_at, media_type, event_slug)
                      VALUES (@id, @file_key, @original_name, @mime, @size, @uploader_ip, 'init', @created_at, @media_type, @event_slug)`),
  getById: db.prepare('SELECT * FROM photos WHERE id = ?'),
  confirm: db.prepare(`UPDATE photos SET status = 'confirmed', confirmed_at = ?, width = ?, height = ?, size = ?, mime = ?
                       WHERE id = ? AND status = 'init'`),
  setPoster: db.prepare(`UPDATE photos SET poster_key = ? WHERE id = ?`),
  setStatus: db.prepare('UPDATE photos SET status = ? WHERE id = ?'),
  deleteById: db.prepare('DELETE FROM photos WHERE id = ?'),
  listConfirmed: db.prepare(`SELECT * FROM photos WHERE event_slug = ? AND status = 'confirmed' AND confirmed_at > ?
                             ORDER BY confirmed_at ASC LIMIT ?`),
  listAdmin: db.prepare('SELECT * FROM photos WHERE event_slug = ? ORDER BY created_at DESC LIMIT ?'),
  countConfirmed: db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE event_slug = ? AND status = 'confirmed'`),
  staleInits: db.prepare(`SELECT id, file_key FROM photos WHERE status = 'init' AND created_at < ?`),
  videosWithoutPoster: db.prepare(`SELECT * FROM photos WHERE media_type = 'video' AND status = 'confirmed' AND poster_key IS NULL ORDER BY confirmed_at ASC LIMIT 50`),
  deleteInit: db.prepare(`DELETE FROM photos WHERE id = ? AND status = 'init'`),

  // ---------- events ----------
  eventInsert: db.prepare(`INSERT INTO events (slug, title, date, admin_token, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`),
  eventGet: db.prepare(`SELECT * FROM events WHERE slug = ?`),
  eventList: db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM photos p WHERE p.event_slug = e.slug AND p.status = 'confirmed') AS photo_count
    FROM events e ORDER BY e.created_at DESC`),
  eventSetStatus: db.prepare(`UPDATE events SET status = ? WHERE slug = ?`),
  eventUpdate: db.prepare(`UPDATE events SET title = ?, date = ? WHERE slug = ?`)
};

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function toDto(row) {
  return {
    id: row.id,
    url: row.url || null, // 由路由层填充 publicUrl
    mediaType: row.media_type || 'image',
    posterUrl: row.posterUrl || null, // 由路由层填充（视频封面帧）
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    status: row.status,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    eventSlug: row.event_slug || 'default'
  };
}

module.exports = { db, stmts, toDto, newToken };
