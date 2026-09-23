'use strict';
const express = require('express');
const crypto = require('crypto');
const { ZipArchive } = require('archiver');
const env = require('../env');
const { stmts } = require('../db');
const { photoDto } = require('../dto');
const { rateLimit, clientIp } = require('../ratelimit');
const { resolveEvent } = require('../events');

// deps: { storage, ws }
function adminRouter(deps) {
  const { storage, ws } = deps;
  const router = express.Router({ mergeParams: true });
  router.use(express.json({ limit: '32kb' }));

  // 场次解析 + 鉴权（口令来自该场次记录）
  router.use((req, res, next) => {
    const slug = req.params.slug || 'default';
    const r = resolveEvent(slug);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    req.event = r.event;
    const token = req.headers['x-admin-token'];
    if (!token || token !== req.event.admin_token || !rateLimit('admin:' + req.event.slug + ':' + clientIp(req), 60, 60000)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  router.get('/photos', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const rows = stmts.listAdmin.all(req.event.slug, limit);
    res.json({
      photos: rows.map((r) => photoDto(r, storage, req))
    });
  });

  // 撤回/恢复：status = hidden | confirmed
  router.post('/photos/:id/status', (req, res) => {
    const { status } = req.body || {};
    if (!['hidden', 'confirmed'].includes(status)) {
      return res.status(400).json({ error: 'bad_status' });
    }
    const row = stmts.getById.get(req.params.id);
    if (!row || row.event_slug !== req.event.slug) return res.status(404).json({ error: 'not_found' });
    stmts.setStatus.run(status, row.id);
    if (status === 'hidden') {
      ws.broadcast(row.event_slug, { type: 'photo.removed', id: row.id });
    } else {
      ws.broadcast(row.event_slug, { type: 'photo.added', photo: photoDto({ ...row, status }, storage, req) });
    }
    res.json({ ok: true });
  });

  // 彻底删除（含文件与封面）
  router.delete('/photos/:id', async (req, res) => {
    const row = stmts.getById.get(req.params.id);
    if (!row || row.event_slug !== req.event.slug) return res.status(404).json({ error: 'not_found' });
    try { await storage.delete(row.file_key); } catch { /* ignore */ }
    if (row.poster_key) { try { await storage.delete(row.poster_key); } catch { /* ignore */ } }
    stmts.deleteById.run(row.id);
    ws.broadcast(row.event_slug, { type: 'photo.removed', id: row.id });
    res.json({ ok: true });
  });

  // ---------- 批量打包下载 ----------
  // 一次性票据：浏览器 <a> 下载无法带自定义 header，故先鉴权换短期 token
  const tickets = new Map(); // token -> { ids, slug, exp }
  const TICKET_TTL = 5 * 60 * 1000;

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
  }, 60 * 1000).unref();

  function safeName(name, id, mime) {
    const base = (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 80);
    const ext = require('../storage/ext').extFor(mime);
    if (!base) return id + ext;
    // 保留原扩展名，否则补上
    return /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : base + ext;
  }

  router.post('/download/ticket', (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const uniq = Array.from(new Set(ids.filter((x) => typeof x === 'string' && /^[0-9a-f]{8,32}$/.test(x))));
    if (!uniq.length) return res.status(400).json({ error: 'no_ids' });
    if (uniq.length > 500) return res.status(400).json({ error: 'too_many' });
    const token = crypto.randomBytes(16).toString('hex');
    tickets.set(token, { ids: uniq, slug: req.event.slug, exp: Date.now() + TICKET_TTL });
    res.json({ token, count: uniq.length });
  });

  router.get('/download/zip/:token', async (req, res) => {
    const t = tickets.get(req.params.token);
    if (!t || t.exp < Date.now()) return res.status(403).json({ error: 'bad_ticket' });
    tickets.delete(req.params.token); // 一次性
    if (t.slug !== req.event.slug) return res.status(403).json({ error: 'bad_ticket' });

    const rows = t.ids.map((id) => stmts.getById.get(id)).filter((r) => r && r.event_slug === t.slug);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const zipName = `wedding-${t.slug === 'default' ? '' : t.slug + '-'}${stamp}.zip`;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Cache-Control': 'no-store'
    });

    const archive = new ZipArchive({ zlib: { level: 0 } }); // 照片/视频已压缩，store 模式省 CPU
    archive.on('error', (err) => {
      console.error('[zip] archive error:', err.message);
      try { res.destroy(); } catch { /* ignore */ }
    });
    archive.pipe(res);

    const used = new Set();
    for (const row of rows) {
      let entry = safeName(row.original_name, row.id, row.mime);
      let n = 1;
      while (used.has(entry)) {
        const dot = entry.lastIndexOf('.');
        entry = dot > 0 ? `${entry.slice(0, dot)}(${n++})${entry.slice(dot)}` : `${entry}(${n++})`;
      }
      used.add(entry);
      try {
        const stream = await storage.getStream(row.file_key);
        archive.append(stream, { name: entry });
      } catch (e) {
        console.error(`[zip] skip ${row.id}:`, e.message);
      }
    }
    archive.finalize();
  });

  return router;
}

module.exports = adminRouter;
