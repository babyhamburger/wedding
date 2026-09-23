'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');

const env = require('./lib/env');
const { stmts } = require('./lib/db');
const { createStorage } = require('./lib/storage');
const ws = require('./lib/ws');
const uploadsRouter = require('./lib/routes/uploads');
const photosRouter = require('./lib/routes/photos');
const adminRouter = require('./lib/routes/admin');
const superRouter = require('./lib/routes/super');
const { backfillPosters } = require('./lib/poster');
const { resolveEvent } = require('./lib/events');

const storage = createStorage();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function baseOf(req) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// 公共配置（按场次）：前端注入标题等
function configHandler(req, res) {
  const slug = req.params.slug || 'default';
  const r = resolveEvent(slug);
  if (!r.ok) return res.status(r.code).json({ error: r.error });
  const ev = r.event;
  res.json({
    title: ev.title,
    date: ev.date,
    slug: ev.slug,
    storage: storage.type,
    maxBytes: env.MAX_UPLOAD_BYTES,
    maxVideoBytes: env.MAX_VIDEO_BYTES
  });
}
app.get('/api/config', configHandler);
app.get('/api/e/:slug/config', configHandler);

// 二维码：内容为该场次上传页绝对 URL
function qrHandler(req, res) {
  const slug = req.params.slug || 'default';
  const r = resolveEvent(slug);
  if (!r.ok) return res.status(r.code).send('bad event');
  const url = slug === 'default' ? `${baseOf(req)}/upload` : `${baseOf(req)}/e/${slug}/upload`;
  QRCode.toBuffer(url, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
    .then((buf) => {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(buf);
    })
    .catch(() => res.status(500).send('qr_failed'));
}
app.get('/qr.png', qrHandler);
app.get('/e/:slug/qr.png', qrHandler);

// ---------- API：按场次挂载 + 旧路径兼容（default） ----------
app.use('/api/uploads', uploadsRouter({ storage, ws }));
app.use('/api/photos', photosRouter({ storage }));
app.use('/api/admin', adminRouter({ storage, ws }));
app.use('/api/e/:slug/uploads', uploadsRouter({ storage, ws }));
app.use('/api/e/:slug/photos', photosRouter({ storage }));
app.use('/api/e/:slug/admin', adminRouter({ storage, ws }));
app.use('/api/super', superRouter());

// local 模式：静态提供已上传图片
if (storage.type === 'local') {
  app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h', immutable: false }));
}

// ---------- 页面路由 ----------
app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/', (req, res) => res.redirect('/upload'));
app.get('/upload', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'upload.html')));
app.get('/wall', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wall.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/super', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'super.html')));
app.get('/e/:slug/upload', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'upload.html')));
app.get('/e/:slug/wall', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wall.html')));
app.get('/e/:slug/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.get('/healthz', (req, res) => res.json({ ok: true, storage: storage.type, wsClients: ws.clientCount() }));

// 孤儿 init 记录清理（>24h）
setInterval(async () => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const row of stmts.staleInits.all(cutoff)) {
    try { await storage.delete(row.file_key); } catch { /* ignore */ }
    stmts.deleteInit.run(row.id);
  }
}, 3600 * 1000).unref();

const server = app.listen(env.PORT, () => {
  console.log(`[wedding] http://localhost:${env.PORT}  storage=${storage.type}`);
  console.log(`[wedding] 上传页 /upload   大屏 /wall   管理 /admin   超管 /super   二维码 /qr.png`);
});
ws.attach(server);

// 启动后补生成历史缺失的视频封面（异步，不阻塞监听）
setTimeout(() => { backfillPosters(storage, ws).catch(() => {}); }, 3000).unref();
