'use strict';
const express = require('express');
const crypto = require('crypto');
const env = require('../env');
const { stmts } = require('../db');
const { photoDto } = require('../dto');
const { makePoster } = require('../poster');
const { rateLimit, clientIp } = require('../ratelimit');
const { resolveEvent } = require('../events');

// deps: { storage, ws }
function uploadsRouter(deps) {
  const { storage, ws } = deps;
  const router = express.Router({ mergeParams: true });

  // 场次解析：/api/e/:slug/... 带 slug；挂载在 /api/uploads 时归入 default
  router.use((req, res, next) => {
    const slug = req.params.slug || 'default';
    const r = resolveEvent(slug);
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    req.event = r.event;
    next();
  });

  // 1) init：校验 + 签发上传凭证 + 落 init 记录
  router.post('/init', express.json({ limit: '16kb' }), (req, res) => {
    if (req.event.status === 'archived') {
      return res.status(403).json({ error: 'event_archived' });
    }
    const ip = clientIp(req);
    if (!rateLimit('init:' + ip, 30, 60000)) {
      return res.status(429).json({ error: 'too_many_requests' });
    }
    const { fileName, mimeType, size } = req.body || {};
    const isVideo = env.ALLOWED_VIDEO_MIME.has(mimeType);
    if (!mimeType || (!env.ALLOWED_MIME.has(mimeType) && !isVideo)) {
      return res.status(400).json({ error: 'unsupported_type' });
    }
    const maxBytes = isVideo ? env.MAX_VIDEO_BYTES : env.MAX_UPLOAD_BYTES;
    if (!Number.isFinite(size) || size <= 0 || size > maxBytes) {
      return res.status(400).json({ error: 'invalid_size' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const slug = req.event.slug;
    const fileKey = storage.keyFor(id, mimeType, slug);
    let cred;
    try {
      cred = storage.createUpload(id, mimeType, slug, req);
    } catch (e) {
      return res.status(500).json({ error: 'sign_failed', detail: String(e.message || e) });
    }
    stmts.insert.run({
      id, file_key: cred.key || fileKey, original_name: (fileName || '').slice(0, 200),
      mime: mimeType, size, uploader_ip: ip, created_at: Date.now(),
      media_type: isVideo ? 'video' : 'image', event_slug: slug
    });
    res.json({
      id,
      uploadUrl: cred.uploadUrl,
      method: cred.method,
      headers: cred.headers,
      expires: cred.expires
    });
  });

  // 2) 仅 local 模式：流式接收 PUT 落盘
  if (storage.type === 'local') {
    router.put('/raw/:id', (req, res) => {
      const row = stmts.getById.get(req.params.id);
      if (!row || row.status !== 'init' || row.event_slug !== req.event.slug) return res.status(404).json({ error: 'not_found' });
      const maxBytes = row.media_type === 'video' ? env.MAX_VIDEO_BYTES : env.MAX_UPLOAD_BYTES;
      const stream = storage.writeStream(row.file_key);
      let received = 0;
      let aborted = false;
      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          aborted = true;
          stream.destroy();
          req.destroy();
          res.status(413).json({ error: 'too_large' });
        }
      });
      req.pipe(stream);
      stream.on('finish', () => { if (!aborted) res.json({ ok: true }); });
      stream.on('error', () => { if (!aborted) res.status(500).json({ error: 'write_failed' }); });
    });
  }

  // 3) confirm：校验文件存在 -> confirmed -> 广播
  router.post('/:id/confirm', express.json({ limit: '4kb' }), async (req, res) => {
    const row = stmts.getById.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status === 'confirmed') {
      return res.json({ photo: photoDto(row, storage, req) });
    }
    if (row.status !== 'init') return res.status(409).json({ error: 'bad_state' });

    const ok = await storage.exists(row.file_key);
    if (!ok) return res.status(404).json({ error: 'file_missing' });

    const realSize = (await storage.size(row.file_key)) || row.size;
    const { width, height } = req.body || {};
    const confirmedAt = Date.now();
    stmts.confirm.run(confirmedAt, Number(width) || null, Number(height) || null, realSize, row.mime, row.id);

    const updated = stmts.getById.get(row.id);
    const photo = photoDto(updated, storage, req);
    ws.broadcast(updated.event_slug, { type: 'photo.added', photo });
    res.json({ photo });

    // 视频：后台异步截取封面帧，完成后广播 photo.poster（不阻塞上传响应）
    if (updated.media_type === 'video') {
      setImmediate(() => { makePoster(updated, storage, ws).catch(() => {}); });
    }
  });

  return router;
}

module.exports = uploadsRouter;
