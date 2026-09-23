'use strict';
const express = require('express');
const env = require('../env');
const { stmts, newToken } = require('../db');
const { rateLimit, clientIp } = require('../ratelimit');
const { validSlug } = require('../events');

// 超管总控台：创建/管理场次。鉴权用 SUPER_TOKEN（独立于各场次口令）。
function superRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.use((req, res, next) => {
    const token = req.headers['x-super-token'];
    if (!token || token !== env.SUPER_TOKEN || !rateLimit('super:' + clientIp(req), 60, 60000)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  // 场次列表（含照片数）
  router.get('/events', (req, res) => {
    const rows = stmts.eventList.all().map((e) => ({
      slug: e.slug, title: e.title, date: e.date, status: e.status,
      adminToken: e.admin_token, photoCount: e.photo_count, createdAt: e.created_at
    }));
    res.json({ events: rows });
  });

  // 创建场次
  router.post('/events', (req, res) => {
    let { slug, title, date, adminToken } = req.body || {};
    slug = (slug || '').trim().toLowerCase();
    title = (title || '').trim().slice(0, 60);
    date = (date || '').trim().slice(0, 30);
    if (!validSlug(slug)) return res.status(400).json({ error: 'bad_slug', detail: 'slug 需为 3-32 位小写字母/数字/连字符，不以连字符开头结尾' });
    if (!title) return res.status(400).json({ error: 'title_required' });
    if (stmts.eventGet.get(slug)) return res.status(409).json({ error: 'slug_exists' });
    adminToken = (adminToken || '').trim() || newToken();
    if (adminToken.length < 6) return res.status(400).json({ error: 'token_too_short' });
    stmts.eventInsert.run(slug, title, date, adminToken, Date.now());
    res.json({ event: { slug, title, date, adminToken, status: 'active' } });
  });

  // 修改场次标题/日期
  router.post('/events/:slug', (req, res) => {
    const ev = stmts.eventGet.get(req.params.slug);
    if (!ev) return res.status(404).json({ error: 'event_not_found' });
    const title = req.body.title != null ? String(req.body.title).trim().slice(0, 60) : ev.title;
    const date = req.body.date != null ? String(req.body.date).trim().slice(0, 30) : ev.date;
    if (!title) return res.status(400).json({ error: 'title_required' });
    stmts.eventUpdate.run(title, date, ev.slug);
    res.json({ ok: true });
  });

  // 启用/停用场次
  router.post('/events/:slug/status', (req, res) => {
    const ev = stmts.eventGet.get(req.params.slug);
    if (!ev) return res.status(404).json({ error: 'event_not_found' });
    const status = req.body && req.body.status;
    if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'bad_status' });
    if (ev.slug === 'default') return res.status(400).json({ error: 'cannot_archive_default' });
    stmts.eventSetStatus.run(status, ev.slug);
    res.json({ ok: true });
  });

  return router;
}

module.exports = superRouter;
