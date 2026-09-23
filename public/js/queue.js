'use strict';
// IndexedDB 离线上传队列。核心原则：先入库再上传，成功才删除。
// 记录结构：{ cid, blob, fileName, mime, size, width, height, mediaType, status, attempts, lastError, nextAt, createdAt, serverId }
// 按场次隔离：同一浏览器扫多场婚礼时，待传队列互不干扰。
window.Queue = (function () {
  const slug = (window.Event && window.Event.slug) || 'default';
  const DB_NAME = 'wallq_' + slug;
  const STORE = 'items';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'cid' });
          s.createIndex('status', 'status');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function add(item) {
    const store = await tx('readwrite');
    const rec = {
      cid: uid(),
      blob: item.blob,
      fileName: item.fileName || 'photo.jpg',
      mime: item.mime || 'image/jpeg',
      size: item.size || (item.blob && item.blob.size) || 0,
      width: item.width || 0,
      height: item.height || 0,
      mediaType: item.mediaType || (String(item.mime || '').startsWith('video/') ? 'video' : 'image'),
      status: 'queued',
      attempts: 0,
      lastError: '',
      nextAt: 0,
      createdAt: Date.now(),
      serverId: null
    };
    await new Promise((res, rej) => {
      const r = store.put(rec);
      r.onsuccess = res; r.onerror = () => rej(r.error);
    });
    return rec;
  }

  async function update(cid, patch) {
    const store = await tx('readwrite');
    const rec = await new Promise((res, rej) => {
      const r = store.get(cid); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (!rec) return null;
    const next = Object.assign(rec, patch);
    await new Promise((res, rej) => {
      const r = store.put(next); r.onsuccess = res; r.onerror = () => rej(r.error);
    });
    return next;
  }

  async function get(cid) {
    const store = await tx('readonly');
    return new Promise((res, rej) => {
      const r = store.get(cid); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  }

  async function remove(cid) {
    const store = await tx('readwrite');
    return new Promise((res, rej) => {
      const r = store.delete(cid); r.onsuccess = res; r.onerror = () => rej(r.error);
    });
  }

  async function all() {
    const store = await tx('readonly');
    return new Promise((res, rej) => {
      const r = store.getAll(); r.onsuccess = () => res(r.result.sort((a, b) => a.createdAt - b.createdAt)); r.onerror = () => rej(r.error);
    });
  }

  // 可处理的任务：queued 且已到达退避时间（手动重试会把 nextAt 清零）
  async function ready() {
    const items = await all();
    const now = Date.now();
    return items.filter((i) => i.status === 'queued' && now >= i.nextAt);
  }

  async function counts() {
    const items = await all();
    const c = { total: items.length, queued: 0, uploading: 0, failed: 0 };
    for (const i of items) {
      if (i.status === 'uploading') c.uploading++;
      else if (i.status === 'failed') c.failed++;
      else c.queued++;
    }
    return c;
  }

  return { add, update, get, remove, all, ready, counts };
})();
