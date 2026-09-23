'use strict';
const express = require('express');
const { stmts } = require('../db');
const { photoDto } = require('../dto');
const { resolveEvent } = require('../events');

// deps: { storage }
function photosRouter(deps) {
  const { storage } = deps;
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => {
    const slug = req.params.slug || 'default';
    const r = resolveEvent(slug);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    req.event = r.event;
    next();
  });

  // 大屏初始加载 + 轮询降级：GET /api/photos?since=<confirmedAt>&limit=200
  router.get('/', (req, res) => {
    const since = Number(req.query.since) || 0;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const rows = stmts.listConfirmed.all(req.event.slug, since, limit);
    res.json({
      photos: rows.map((r) => photoDto(r, storage, req)),
      count: stmts.countConfirmed.get(req.event.slug).n
    });
  });

  return router;
}

module.exports = photosRouter;
