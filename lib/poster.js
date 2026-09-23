'use strict';
// 视频封面帧提取：从存储拉取视频 -> ffmpeg 截第一帧 -> 写回存储 -> 更新 DB -> 广播
// ffmpeg 缺失或截帧失败时静默降级（保持占位海报），不阻塞上传主流程。
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { stmts } = require('./db');
const { photoDto } = require('./dto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const POSTER_W = 480;
const TMP_DIR = path.join(os.tmpdir(), 'hunli-poster');
fs.mkdirSync(TMP_DIR, { recursive: true });

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: String(e.message || e) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, err }); });
  });
}

async function extractOnce(videoPath, jpgPath, seek) {
  const out = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(seek),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale=${POSTER_W}:-2`,
    '-q:v', '3',
    '-y', jpgPath
  ], 60000);
  let size = 0;
  try { size = (await fsp.stat(jpgPath)).size; } catch { /* ignore */ }
  return { ok: out.ok && size > 0, err: out.err, size };
}

// 对一条已 confirmed 的视频记录生成封面；成功返回 true
async function makePoster(row, storage, ws) {
  if (row.media_type !== 'video' || row.poster_key) return false;
  const srcExt = path.extname(row.file_key) || '.mp4';
  const videoPath = path.join(TMP_DIR, row.id + srcExt);
  const jpgPath = path.join(TMP_DIR, row.id + '.jpg');
  try {
    // 1) 拉取视频到临时文件
    const stream = await storage.getStream(row.file_key);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(videoPath);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
    });
    // 2) 截帧：先试 0.5s（避开黑场），失败/空文件再试 0
    let r = await extractOnce(videoPath, jpgPath, 0.5);
    if (!r.ok) r = await extractOnce(videoPath, jpgPath, 0);
    if (!r.ok) {
      console.error(`[poster] ${row.id} ffmpeg 失败:`, (r.err || 'empty output').slice(0, 300));
      return false;
    }
    // 3) 写回存储（key 与视频同目录，后缀 _poster.jpg）
    const posterKey = row.file_key.replace(/\.[A-Za-z0-9]+$/, '') + '_poster.jpg';
    const buf = await fsp.readFile(jpgPath);
    await storage.putBuffer(posterKey, buf, 'image/jpeg');
    stmts.setPoster.run(posterKey, row.id);
    if (ws) {
      const updated = stmts.getById.get(row.id);
      ws.broadcast(row.event_slug, { type: 'photo.poster', photo: photoDto(updated, storage, null) });
    }
    console.log(`[poster] ${row.id} 封面已生成 (${buf.length}B)`);
    return true;
  } catch (e) {
    console.error(`[poster] ${row.id} 异常:`, e.message);
    return false;
  } finally {
    for (const f of [videoPath, jpgPath]) { try { await fsp.unlink(f); } catch { /* ignore */ } }
  }
}

// 服务启动时补做历史缺封面的视频（串行，避免并发拉大文件）
async function backfillPosters(storage, ws) {
  try {
    const rows = stmts.videosWithoutPoster.all();
    if (!rows.length) return;
    console.log(`[poster] 补生成 ${rows.length} 个视频封面…`);
    for (const row of rows) await makePoster(row, storage, ws);
  } catch (e) {
    console.error('[poster] backfill error:', e.message);
  }
}

module.exports = { makePoster, backfillPosters };
