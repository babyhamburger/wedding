'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('title'), subtitle: $('subtitle'),
    btnCamera: $('btn-camera'), btnAlbum: $('btn-album'),
    inCamera: $('in-camera'), inAlbum: $('in-album'),
    btnVideo: $('btn-video'), inVideo: $('in-video'),
    done: $('done'), btnAgain: $('btn-again'),
    queueList: $('queue-list'), queueEmpty: $('queue-empty'),
    queueTitle: $('queue-title'), btnRetryAll: $('btn-retry-all'),
    offlineBanner: $('offline-banner')
  };

  let config = { title: '', storage: 'local', maxBytes: 15 * 1024 * 1024, maxVideoBytes: 500 * 1024 * 1024 };
  let processing = false;
  const progressMap = new Map(); // cid -> 0..1
  const thumbCache = new Map();  // cid -> objectURL

  fetch(window.Event.api('/config')).then((r) => r.json()).then((c) => {
    config = c;
    if (c.title) els.title.textContent = c.title;
  }).catch(() => {});

  // ---------- 选图/选视频入口 ----------
  els.btnCamera.addEventListener('click', () => els.inCamera.click());
  els.btnAlbum.addEventListener('click', () => els.inAlbum.click());
  els.inCamera.addEventListener('change', (e) => onFiles(e.target.files, e.target));
  els.inAlbum.addEventListener('change', (e) => onFiles(e.target.files, e.target));
  if (els.btnVideo) els.btnVideo.addEventListener('click', () => els.inVideo.click());
  if (els.inVideo) els.inVideo.addEventListener('change', (e) => onFiles(e.target.files, e.target));

  const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

  async function onFiles(fileList, input) {
    const files = Array.from(fileList || []);
    input.value = '';
    for (const f of files) {
      const isVideo = f.type.startsWith('video/');
      if (!isVideo && !f.type.startsWith('image/')) continue;
      const limit = isVideo ? config.maxVideoBytes : config.maxBytes;
      if (f.size > limit) {
        alert(`「${f.name}」超过 ${Math.round(limit / 1024 / 1024)}MB，已跳过`);
        continue;
      }
      if (isVideo) {
        if (!VIDEO_MIME.has(f.type)) {
          alert(`「${f.name}」视频格式暂不支持（请用 MP4/MOV/WebM），已跳过`);
          continue;
        }
        const dims = await probeVideo(f);
        await window.Queue.add({
          blob: f, fileName: f.name, mime: f.type,
          size: f.size, width: dims.width, height: dims.height, mediaType: 'video'
        });
        continue;
      }
      let out;
      try {
        out = await window.compressImage(f);
      } catch {
        out = { blob: f, width: 0, height: 0, mime: f.type || 'image/jpeg' };
      }
      if (out.blob.size > config.maxBytes) {
        alert(`「${f.name}」压缩后仍超过大小限制，已跳过`);
        continue;
      }
      await window.Queue.add({
        blob: out.blob, fileName: f.name, mime: out.mime,
        size: out.blob.size, width: out.width, height: out.height, mediaType: 'image'
      });
    }
    render();
    pump();
  }

  // 读取视频时长/尺寸（用于占位与 confirm），失败返回 0
  function probeVideo(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      const done = (w, h) => { URL.revokeObjectURL(url); resolve({ width: w || 0, height: h || 0 }); };
      v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight);
      v.onerror = () => done(0, 0);
      setTimeout(() => done(v.videoWidth, v.videoHeight), 4000);
      v.src = url;
    });
  }

  // ---------- 上传 worker（串行） ----------
  let retryTimer = null;
  async function pump() {
    if (processing) return;
    processing = true;
    try {
      while (true) {
        if (!navigator.onLine) break;
        const ready = await window.Queue.ready();
        if (!ready.length) break;
        await processOne(ready[0]);
        render();
      }
    } finally {
      processing = false;
      render();
      scheduleRetry();
    }
  }

  // 有退避中的任务时，安排最早时间点的唤醒
  async function scheduleRetry() {
    clearTimeout(retryTimer);
    const items = await window.Queue.all();
    const now = Date.now();
    const waiting = items.filter((i) => i.status === 'queued' && i.nextAt > now);
    if (!waiting.length) return;
    const soonest = Math.min(...waiting.map((i) => i.nextAt));
    retryTimer = setTimeout(pump, Math.max(1000, soonest - now));
  }

  async function processOne(item) {
    await window.Queue.update(item.cid, { status: 'uploading', lastError: '' });
    try {
      // 1. init
      const initRes = await fetch(window.Event.api('/uploads/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: item.fileName, mimeType: item.mime, size: item.size })
      });
      if (!initRes.ok) throw new Error('init_' + initRes.status);
      const cred = await initRes.json();

      // 2. PUT 直传（带进度）
      await putWithProgress(cred, item);

      // 3. confirm
      const confRes = await fetch(window.Event.api(`/uploads/${cred.id}/confirm`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ width: item.width, height: item.height })
      });
      if (!confRes.ok) throw new Error('confirm_' + confRes.status);

      await window.Queue.remove(item.cid);
      releaseThumb(item.cid);
      showDone();
    } catch (err) {
      const attempts = (item.attempts || 0) + 1;
      const status = attempts >= 8 ? 'failed' : 'queued';
      const delay = Math.min(Math.pow(2, attempts) * 2000, 60000);
      await window.Queue.update(item.cid, {
        status, attempts, lastError: String(err && err.message || err),
        nextAt: Date.now() + delay
      });
    } finally {
      progressMap.delete(item.cid);
    }
  }

  function putWithProgress(cred, item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(cred.method || 'PUT', cred.uploadUrl, true);
      for (const [k, v] of Object.entries(cred.headers || {})) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) { progressMap.set(item.cid, e.loaded / e.total); render(); }
      };
      xhr.timeout = item.mediaType === 'video' ? 600000 : 120000;
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.onerror = () => reject(new Error('network'));
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('put_' + xhr.status)));
      xhr.send(item.blob);
    });
  }

  // ---------- UI ----------
  let doneTimer = null;
  function showDone() {
    els.done.classList.remove('hidden');
    clearTimeout(doneTimer);
    doneTimer = setTimeout(() => els.done.classList.add('hidden'), 2600);
  }
  els.btnAgain.addEventListener('click', () => {
    els.done.classList.add('hidden');
    els.inAlbum.click();
  });

  function thumbFor(item) {
    if (!thumbCache.has(item.cid)) {
      thumbCache.set(item.cid, URL.createObjectURL(item.blob));
    }
    return thumbCache.get(item.cid);
  }
  function imgThumb(item) {
    const img = document.createElement('img');
    img.className = 'q-thumb';
    img.src = thumbFor(item);
    img.alt = '';
    return img;
  }
  function videoThumb(item) {
    const box = document.createElement('div');
    box.className = 'q-thumb q-thumb-video';
    box.textContent = '🎬';
    return box;
  }
  function releaseThumb(cid) {
    const u = thumbCache.get(cid);
    if (u) { URL.revokeObjectURL(u); thumbCache.delete(cid); }
  }

  const STATUS_TEXT = { queued: '排队中', uploading: '上传中', failed: '已暂停' };

  async function render() {
    const items = await window.Queue.all();
    els.queueEmpty.classList.toggle('hidden', items.length > 0);
    els.queueTitle.textContent = items.length ? `待上传 ${items.length} 张` : '待上传';
    els.btnRetryAll.classList.toggle('hidden', !items.some((i) => i.status === 'failed'));

    els.queueList.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'q-item q-' + it.status;

      const thumb = it.mediaType === 'video' ? videoThumb(it) : imgThumb(it);

      const info = document.createElement('div');
      info.className = 'q-info';
      const line1 = document.createElement('div');
      line1.className = 'q-line';
      const prefix = it.mediaType === 'video' ? '视频·' : '';
      let text;
      if (it.status === 'uploading') {
        const p = progressMap.get(it.cid);
        text = prefix + (p != null ? `上传中 ${Math.round(p * 100)}%` : '上传中');
      } else if (it.status === 'failed') {
        text = prefix + '上传失败';
      } else if (it.attempts > 0 && it.status === 'queued') {
        text = prefix + `排队中（第 ${it.attempts + 1} 次尝试）`;
      } else {
        text = prefix + (STATUS_TEXT[it.status] || it.status);
      }
      line1.textContent = text;
      info.appendChild(line1);

      if (it.lastError) {
        const line2 = document.createElement('div');
        line2.className = 'q-err';
        line2.textContent = it.lastError;
        info.appendChild(line2);
      }

      if (it.status === 'uploading') {
        const bar = document.createElement('div');
        bar.className = 'q-bar';
        const fill = document.createElement('div');
        fill.className = 'q-bar-fill';
        fill.style.width = Math.round((progressMap.get(it.cid) || 0) * 100) + '%';
        bar.appendChild(fill);
        info.appendChild(bar);
      }

      li.appendChild(thumb);
      li.appendChild(info);

      const ops = document.createElement('div');
      ops.className = 'q-ops';
      if (it.status === 'failed') {
        const retry = document.createElement('button');
        retry.className = 'link';
        retry.textContent = '重试';
        retry.addEventListener('click', async () => {
          await window.Queue.update(it.cid, { status: 'queued', attempts: 0, nextAt: 0, lastError: '' });
          render(); pump();
        });
        ops.appendChild(retry);
      }
      const del = document.createElement('button');
      del.className = 'link danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await window.Queue.remove(it.cid);
        releaseThumb(it.cid);
        render();
      });
      ops.appendChild(del);
      li.appendChild(ops);

      els.queueList.appendChild(li);
    }
  }

  els.btnRetryAll.addEventListener('click', async () => {
    for (const it of await window.Queue.all()) {
      if (it.status === 'failed') await window.Queue.update(it.cid, { status: 'queued', attempts: 0, nextAt: 0, lastError: '' });
    }
    render(); pump();
  });

  // ---------- 网络状态与自动续传 ----------
  function syncOnline() {
    els.offlineBanner.classList.toggle('hidden', navigator.onLine);
    if (navigator.onLine) pump();
  }
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncOnline(); render(); } });
  setInterval(() => { syncOnline(); render(); }, 15000);

  // 启动：恢复未完成队列
  (async () => {
    render();
    syncOnline();
    const items = await window.Queue.all();
    for (const it of items) {
      if (it.status === 'uploading') await window.Queue.update(it.cid, { status: 'queued' });
    }
    pump();
  })();
})();
