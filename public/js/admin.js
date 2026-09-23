'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const EVT = window.Event;
  const tokenInput = $('token');
  let token = sessionStorage.getItem('adminToken_' + EVT.slug) || '';
  tokenInput.value = token;

  $('upload-url').textContent = location.origin + EVT.page('/upload');
  $('btn-wall').href = EVT.page('/wall');
  $('qr').src = EVT.page('/qr.png');

  async function api(path, opts) {
    const res = await fetch(EVT.api(path), Object.assign({
      headers: { 'x-admin-token': token, 'Content-Type': 'application/json' }
    }, opts));
    if (res.status === 403) { throw new Error('口令错误'); }
    if (!res.ok) { throw new Error('HTTP ' + res.status); }
    return res.json();
  }

  const STATUS_LABEL = { init: '待确认', confirmed: '已上墙', hidden: '已撤回' };

  // ---------- 批量选择状态 ----------
  const selected = new Set();
  let currentList = [];

  async function load() {
    try {
      const data = await api('/admin/photos?limit=500');
      currentList = data.photos;
      // 丢弃已删除的选中项
      const alive = new Set(currentList.map((p) => p.id));
      for (const id of Array.from(selected)) if (!alive.has(id)) selected.delete(id);
      render(currentList);
      updateSelbar();
    } catch (e) {
      $('grid').innerHTML = '';
      $('empty').textContent = e.message === '口令错误' ? '口令错误，请重新输入。' : '加载失败：' + e.message;
      $('empty').classList.remove('hidden');
    }
  }

  function render(list) {
    const grid = $('grid');
    grid.innerHTML = '';
    $('empty').classList.toggle('hidden', list.length > 0);
    $('empty').textContent = '暂无照片。';
    $('selbar').classList.toggle('hidden', list.length === 0);
    for (const p of list) {
      const card = document.createElement('div');
      card.className = 'p-card s-' + p.status + (selected.has(p.id) ? ' picked' : '');

      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'p-pick';
      pick.checked = selected.has(p.id);
      pick.title = '选择以批量下载';
      pick.addEventListener('click', (e) => e.stopPropagation());
      pick.addEventListener('change', () => {
        if (pick.checked) selected.add(p.id); else selected.delete(p.id);
        card.classList.toggle('picked', pick.checked);
        updateSelbar();
      });
      card.appendChild(pick);

      const isVideo = p.mediaType === 'video';
      const wrap = document.createElement('div');
      wrap.className = 'p-thumb' + (isVideo ? ' p-thumb-video' : '');
      const known = p.width > 0 && p.height > 0;
      const portrait = known && p.height > p.width;
      const img = document.createElement(isVideo ? 'video' : 'img');
      img.src = p.url || '';
      img.loading = 'lazy';
      img.className = portrait || !known ? 'fg' : 'cover';
      if (isVideo) {
        // 底层：优先用服务端截取的封面帧；没有则显示占位海报（🎬 + 文件名）
        if (p.posterUrl) {
          const cover = document.createElement('img');
          cover.className = 'v-cover';
          cover.src = p.posterUrl;
          cover.alt = '';
          cover.addEventListener('error', () => cover.remove());
          wrap.appendChild(cover);
          const open = document.createElement('a');
          open.className = 'v-play';
          open.href = p.url || '#';
          open.target = '_blank';
          open.rel = 'noopener';
          open.textContent = '▶ 播放';
          wrap.appendChild(open);
        } else {
          const poster = document.createElement('div');
          poster.className = 'v-poster';
          const ico = document.createElement('span');
          ico.className = 'v-ico';
          ico.textContent = '🎬';
          const nm = document.createElement('span');
          nm.className = 'v-name';
          nm.textContent = p.originalName || '视频';
          const open = document.createElement('a');
          open.className = 'v-open';
          open.href = p.url || '#';
          open.target = '_blank';
          open.rel = 'noopener';
          open.textContent = '新标签页播放';
          poster.append(ico, nm, open);
          wrap.appendChild(poster);
        }
        img.muted = true;
        img.playsInline = true;
        img.loop = true;
        img.preload = 'metadata';
        img.autoplay = true;
        // 解码成功：淡入盖住封面并循环预览；失败：移除视频元素，保留封面
        img.addEventListener('loadeddata', () => { img.classList.add('ready'); wrap.classList.add('v-playing'); });
        img.addEventListener('error', () => img.remove());
      } else {
        img.addEventListener('error', () => wrap.classList.add('broken'));
      }
      // 竖版图片：模糊背景填充两侧，主体完整居中
      if (portrait && !isVideo) {
        const bg = document.createElement('img');
        bg.src = img.src;
        bg.className = 'bg';
        bg.alt = '';
        bg.addEventListener('error', () => bg.remove());
        wrap.appendChild(bg);
      }
      wrap.appendChild(img);
      if (known) {
        const badge = document.createElement('span');
        badge.className = 'p-ratio';
        badge.textContent = (p.width === p.height ? '方 ' : p.width > p.height ? '横 ' : '竖 ') + p.width + '×' + p.height;
        wrap.appendChild(badge);
      }
      card.appendChild(wrap);

      const meta = document.createElement('div');
      meta.className = 'p-meta';
      const t = new Date(p.confirmedAt || p.createdAt);
      meta.innerHTML = `<span class="p-status">${STATUS_LABEL[p.status] || p.status}</span>
        <span class="p-time">${t.toLocaleTimeString('zh-CN', { hour12: false })}</span>
        <span class="p-size">${p.size ? (p.size / 1024).toFixed(0) + 'KB' : ''}</span>`;
      card.appendChild(meta);

      const ops = document.createElement('div');
      ops.className = 'p-ops';

      if (p.status === 'confirmed') {
        const hide = document.createElement('button');
        hide.className = 'btn small';
        hide.textContent = '撤回';
        hide.addEventListener('click', async () => {
          await api(`/admin/photos/${p.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'hidden' }) });
          load();
        });
        ops.appendChild(hide);
      } else if (p.status === 'hidden') {
        const show = document.createElement('button');
        show.className = 'btn small primary';
        show.textContent = '恢复';
        show.addEventListener('click', async () => {
          await api(`/admin/photos/${p.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'confirmed' }) });
          load();
        });
        ops.appendChild(show);
      }

      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        if (!confirm('确定删除这张照片？不可恢复。')) return;
        await fetch(EVT.api(`/admin/photos/${p.id}`), { method: 'DELETE', headers: { 'x-admin-token': token } });
        load();
      });
      ops.appendChild(del);

      card.appendChild(ops);
      grid.appendChild(card);
    }
  }

  // ---------- 选择工具栏 ----------
  function updateSelbar() {
    const n = selected.size;
    $('sel-count').textContent = `已选 ${n} 项`;
    $('btn-download').disabled = n === 0;
    const all = currentList.length;
    const chkAll = $('chk-all');
    chkAll.checked = all > 0 && n === all;
    chkAll.indeterminate = n > 0 && n < all;
  }

  $('chk-all').addEventListener('change', (e) => {
    selected.clear();
    if (e.target.checked) for (const p of currentList) selected.add(p.id);
    render(currentList);
    updateSelbar();
  });

  $('btn-clear-sel').addEventListener('click', () => {
    selected.clear();
    render(currentList);
    updateSelbar();
  });

  let downloading = false;
  $('btn-download').addEventListener('click', async () => {
    if (downloading || !selected.size) return;
    downloading = true;
    const status = $('dl-status');
    status.className = 'dl-status';
    status.textContent = '正在打包…';
    $('btn-download').disabled = true;
    try {
      const { token } = await api('/admin/download/ticket', {
        method: 'POST', body: JSON.stringify({ ids: Array.from(selected) })
      });
      // 用隐藏 <a> 触发浏览器原生下载（大文件不进内存）
      const a = document.createElement('a');
      a.href = EVT.api('/admin/download/zip/' + token);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      status.textContent = `已开始下载 ${selected.size} 个文件`;
    } catch (e) {
      status.className = 'dl-status err';
      status.textContent = '下载失败：' + e.message;
    } finally {
      downloading = false;
      $('btn-download').disabled = selected.size === 0;
      setTimeout(() => { status.textContent = ''; }, 6000);
    }
  });

  $('btn-login').addEventListener('click', () => {
    token = tokenInput.value.trim();
    sessionStorage.setItem('adminToken_' + EVT.slug, token);
    load();
  });
  $('btn-refresh').addEventListener('click', load);
  tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click(); });

  if (token) load();
})();
