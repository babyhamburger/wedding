'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const connDot = $('conn');
  const countEl = $('count');
  const carousel = $('carousel');
  const slide = $('slide');
  const newBadge = $('new-badge');

  const MAX_CELLS = 240;         // 网格最多保留的格子数
  const CAROUSEL_POOL = 40;      // 轮播候选池（最近 N 张）
  const SLIDE_MS = 6000;         // 轮播每张停留
  const VIDEO_MS = 12000;        // 轮播视频最长停留

  // 照片状态：按 confirmedAt 升序
  const photos = new Map();      // id -> photo
  let latestConfirmedAt = 0;
  let totalCount = 0;

  // ---------- 初始加载 ----------
  $('qr').src = window.Event.page('/qr.png');
  fetch(window.Event.api('/config')).then((r) => r.json()).then((c) => {
    if (c.title) $('title').textContent = c.title;
    if (c.date) $('date').textContent = c.date;
  }).catch(() => {});

  async function loadAll() {
    try {
      const res = await fetch(window.Event.api('/photos?since=0&limit=500'));
      const data = await res.json();
      for (const p of data.photos) addPhoto(p, false);
      totalCount = data.count;
      updateCount();
    } catch { /* 启动时服务未就绪，稍后轮询会补上 */ }
  }

  // ---------- 增量补拉（重连后/轮询降级） ----------
  async function refreshSince() {
    try {
      const res = await fetch(window.Event.api(`/photos?since=${latestConfirmedAt}&limit=500`));
      const data = await res.json();
      for (const p of data.photos) addPhoto(p, false);
      totalCount = data.count;
      updateCount();
    } catch { /* ignore */ }
  }

  function updateCount() { countEl.textContent = `${totalCount} 张`; }

  function makeMedia(p, cls) {
    if (p.mediaType === 'video') {
      const v = document.createElement('video');
      v.className = cls;
      v.src = p.url;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.preload = 'metadata';
      v.setAttribute('playsinline', '');
      return v;
    }
    const img = document.createElement('img');
    img.className = cls;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = p.url;
    img.alt = '';
    return img;
  }

  // ---------- 网格 ----------
  function addPhoto(p, isNew) {
    if (photos.has(p.id)) return;
    photos.set(p.id, p);
    if (p.confirmedAt > latestConfirmedAt) latestConfirmedAt = p.confirmedAt;

    const cell = document.createElement('figure');
    cell.className = 'cell' + (isNew ? ' cell-new' : '') + (p.mediaType === 'video' ? ' cell-video' : '');
    cell.dataset.id = p.id;

    // 视频：服务端封面帧垫底，浏览器能解码时视频淡入覆盖
    if (p.mediaType === 'video' && p.posterUrl) {
      const cover = document.createElement('img');
      cover.className = 'cell-poster';
      cover.src = p.posterUrl;
      cover.alt = '';
      cell.appendChild(cover);
    }
    const media = makeMedia(p, '');
    media.addEventListener('error', () => media.remove()); // 无法解码/文件被删则移除，露出封面
    media.addEventListener('loadeddata', () => media.classList.add('media-ready'));
    cell.appendChild(media);
    if (p.mediaType === 'video') {
      const tag = document.createElement('span');
      tag.className = 'cell-video-tag';
      tag.textContent = '🎬';
      cell.appendChild(tag);
    }

    // 最新照片插到最前
    grid.prepend(cell);

    // 超出上限移除最旧的格子（数据仍保留在 photos Map 中用于轮播）
    while (grid.children.length > MAX_CELLS) grid.lastElementChild.remove();

    if (isNew) onNewPhoto(p);
  }

  function removePhoto(id) {
    const had = photos.delete(id);
    if (had && totalCount > 0) { totalCount--; updateCount(); }
    const cell = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (cell) {
      cell.classList.add('cell-removing');
      setTimeout(() => cell.remove(), 400);
    }
    if (carouselOpen && currentPhotoId === id) nextSlide(true);
  }

  // 封面帧稍后生成完成：给已存在的视频格子补插封面
  function applyPoster(p) {
    const known = photos.get(p.id);
    if (known) known.posterUrl = p.posterUrl;
    const cell = grid.querySelector(`[data-id="${CSS.escape(p.id)}"]`);
    if (!cell || !p.posterUrl || cell.querySelector('.cell-poster')) return;
    const cover = document.createElement('img');
    cover.className = 'cell-poster';
    cover.src = p.posterUrl;
    cover.alt = '';
    cell.insertBefore(cover, cell.firstChild);
  }

  // ---------- WebSocket 实时 ----------
  let ws = null;
  let wsFails = 0;
  let pollTimer = null;
  let reconnectTimer = null;

  function setConn(state) {
    connDot.className = 'conn conn-' + state;
    connDot.title = { live: '实时连接正常', retry: '正在重连', poll: '轮询模式', down: '已断开' }[state] || '';
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try { ws = new WebSocket(window.Event.wsUrl()); } catch { scheduleReconnect(); return; }

    ws.onopen = () => {
      wsFails = 0;
      setConn('live');
      stopPolling();
      refreshSince(); // 重连成功后补拉断线期间的照片（正确性关键）
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'photo.added') addPhoto(msg.photo, true);
      else if (msg.type === 'photo.removed') removePhoto(msg.id);
      else if (msg.type === 'photo.poster') applyPoster(msg.photo);
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function scheduleReconnect() {
    wsFails++;
    setConn(wsFails >= 3 ? 'poll' : 'retry');
    if (wsFails >= 3) startPolling();
    const delay = Math.min(Math.pow(2, Math.min(wsFails, 5)) * 1000, 30000);
    reconnectTimer = setTimeout(connect, delay);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(refreshSince, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---------- 轮播模式 ----------
  let carouselOpen = false;
  let currentPhotoId = null;
  let slideTimer = null;
  let slideIdx = 0;

  function pool() {
    return Array.from(photos.values())
      .sort((a, b) => b.confirmedAt - a.confirmedAt)
      .slice(0, CAROUSEL_POOL);
  }

  function openCarousel() {
    if (photos.size === 0) return;
    carouselOpen = true;
    carousel.classList.remove('hidden');
    $('btn-mode').textContent = '网格';
    slideIdx = 0;
    showSlide(pool()[0]);
    scheduleSlide();
  }
  function closeCarousel() {
    carouselOpen = false;
    carousel.classList.add('hidden');
    $('btn-mode').textContent = '轮播';
    clearTimeout(slideTimer);
  }

  function showSlide(p) {
    if (!p) return;
    currentPhotoId = p.id;
    slide.innerHTML = '';
    if (p.mediaType === 'video' && p.posterUrl) {
      const cover = document.createElement('img');
      cover.className = 'slide-media slide-poster';
      cover.src = p.posterUrl;
      slide.appendChild(cover);
    }
    const media = makeMedia(p, 'slide-media');
    media.addEventListener('error', () => media.remove()); // 解码失败露出封面，不整张移除
    media.addEventListener('loadeddata', () => media.classList.add('media-ready'));
    slide.appendChild(media);
    if (p.mediaType === 'video') {
      // 视频：静音循环播放，播满一个上限时长后切下一张
      media.loop = true;
      const play = media.play();
      if (play && play.catch) play.catch(() => {});
    } else {
      void slide.offsetWidth;
      media.classList.add('kb');
    }
  }

  function nextSlide(skipAnim) {
    const list = pool();
    if (!list.length) return;
    slideIdx = (slideIdx + 1) % list.length;
    showSlide(list[slideIdx]);
    if (!skipAnim) scheduleSlide();
  }

  function scheduleSlide() {
    clearTimeout(slideTimer);
    const cur = photos.get(currentPhotoId);
    const ms = cur && cur.mediaType === 'video' ? VIDEO_MS : SLIDE_MS;
    slideTimer = setTimeout(() => { nextSlide(); scheduleSlide(); }, ms);
  }

  function preload(p) { if (p.mediaType !== 'video') { const i = new Image(); i.src = p.url; } }

  function onNewPhoto(p) {
    preload(p);
    totalCount++;
    updateCount();
    if (carouselOpen) {
      // 新照片立即切入并显示角标
      slideIdx = 0;
      showSlide(p);
      scheduleSlide();
      newBadge.classList.remove('hidden');
      setTimeout(() => newBadge.classList.add('hidden'), 2500);
    }
  }

  $('btn-mode').addEventListener('click', () => (carouselOpen ? closeCarousel() : openCarousel()));
  $('btn-exit').addEventListener('click', closeCarousel);

  // ---------- 点击格子查看大图 ----------
  const lightbox = $('lightbox');
  const lbStage = $('lb-stage');
  let lbOpen = false;

  function openLightbox(p) {
    if (!p || !p.url) return;
    lbStage.innerHTML = '';
    if (p.mediaType === 'video') {
      const v = document.createElement('video');
      v.src = p.url;
      if (p.posterUrl) v.poster = p.posterUrl;
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      lbStage.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = '';
      lbStage.appendChild(img);
    }
    lbOpen = true;
    lightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    if (!lbOpen) return;
    lbOpen = false;
    lightbox.classList.add('hidden');
    lbStage.innerHTML = ''; // 移除 video 以停止播放
  }

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const p = photos.get(cell.dataset.id);
    if (p) openLightbox(p);
  });

  lightbox.addEventListener('click', (e) => {
    // 点击空白处或关闭按钮退出；点在媒体本身上不关闭（视频要能操作控件）
    if (e.target === lbStage || e.target === lightbox || e.target.id === 'btn-lb-close') closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !lbOpen) { e.preventDefault(); carouselOpen ? closeCarousel() : openCarousel(); }
    if (e.code === 'Escape') {
      if (lbOpen) closeLightbox();
      else if (carouselOpen) closeCarousel();
    }
    if (carouselOpen && e.code === 'ArrowRight') { nextSlide(); scheduleSlide(); }
    if (carouselOpen && e.code === 'ArrowLeft') {
      const list = pool();
      slideIdx = (slideIdx - 2 + list.length) % list.length;
      showSlide(list[slideIdx]); scheduleSlide();
    }
  });

  // ---------- 启动 ----------
  loadAll().then(connect);
})();
