'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('superToken') || '';
  $('super-token').value = token;

  async function api(path, opts) {
    const res = await fetch('/api/super' + path, Object.assign({
      headers: { 'x-super-token': token, 'Content-Type': 'application/json' }
    }, opts));
    if (res.status === 403) throw new Error('超管口令错误');
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error((body && body.detail) || (body && body.error) || 'HTTP ' + res.status);
    return body;
  }

  // 该场次的页面路径（default 沿用旧路径）
  function pagePath(slug, p) {
    return slug === 'default' ? p : `/e/${slug}${p}`;
  }

  async function load() {
    try {
      const data = await api('/events');
      render(data.events);
    } catch (e) {
      $('event-list').innerHTML = '';
      $('empty').textContent = e.message.includes('口令') ? '超管口令错误，请重新输入。' : '加载失败：' + e.message;
      $('empty').classList.remove('hidden');
    }
  }

  function render(list) {
    const box = $('event-list');
    box.innerHTML = '';
    $('empty').classList.toggle('hidden', list.length > 0);
    $('empty').textContent = '还没有场次，点击右上角「创建场次」。';
    for (const ev of list) {
      const card = document.createElement('div');
      card.className = 'ev-card' + (ev.status === 'archived' ? ' archived' : '');

      const head = document.createElement('div');
      head.className = 'ev-head';
      const title = document.createElement('span');
      title.className = 'ev-title';
      title.textContent = ev.title;
      const slug = document.createElement('span');
      slug.className = 'ev-slug';
      slug.textContent = ev.slug;
      head.append(title, slug);
      if (ev.date) {
        const d = document.createElement('span');
        d.className = 'ev-date';
        d.textContent = ev.date;
        head.appendChild(d);
      }
      const badge = document.createElement('span');
      badge.className = 'ev-badge ' + ev.status;
      badge.textContent = ev.status === 'active' ? '进行中' : '已停用';
      head.appendChild(badge);
      const cnt = document.createElement('span');
      cnt.className = 'ev-count';
      cnt.textContent = `${ev.photoCount} 张照片`;
      head.appendChild(cnt);
      card.appendChild(head);

      const links = document.createElement('div');
      links.className = 'ev-links';
      for (const [label, p] of [['宾客上传', '/upload'], ['大屏', '/wall'], ['管理', '/admin']]) {
        const a = document.createElement('a');
        a.href = pagePath(ev.slug, p);
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = label;
        links.appendChild(a);
      }
      const qr = document.createElement('a');
      qr.href = pagePath(ev.slug, '/qr.png');
      qr.target = '_blank';
      qr.rel = 'noopener';
      qr.textContent = '二维码';
      links.appendChild(qr);
      card.appendChild(links);

      const tk = document.createElement('div');
      tk.className = 'ev-token';
      tk.append('管理口令：');
      const code = document.createElement('code');
      code.textContent = ev.adminToken;
      tk.appendChild(code);
      card.appendChild(tk);

      const ops = document.createElement('div');
      ops.className = 'ev-ops';
      if (ev.status === 'active') {
        const off = document.createElement('button');
        off.className = 'btn small danger';
        off.textContent = '停用';
        off.addEventListener('click', async () => {
          if (!confirm(`停用「${ev.title}」？停用后宾客将无法上传。`)) return;
          try { await api(`/events/${ev.slug}/status`, { method: 'POST', body: JSON.stringify({ status: 'archived' }) }); load(); }
          catch (e) { alert(e.message); }
        });
        ops.appendChild(off);
      } else {
        const on = document.createElement('button');
        on.className = 'btn small primary';
        on.textContent = '启用';
        on.addEventListener('click', async () => {
          try { await api(`/events/${ev.slug}/status`, { method: 'POST', body: JSON.stringify({ status: 'active' }) }); load(); }
          catch (e) { alert(e.message); }
        });
        ops.appendChild(on);
      }
      card.appendChild(ops);

      box.appendChild(card);
    }
  }

  // ---------- 创建对话框 ----------
  const dlg = $('dlg-create');
  function openDlg() {
    $('f-slug').value = ''; $('f-title').value = ''; $('f-date').value = ''; $('f-token').value = '';
    $('dlg-err').textContent = '';
    dlg.classList.remove('hidden');
    $('f-slug').focus();
  }
  function closeDlg() { dlg.classList.add('hidden'); }

  $('btn-create').addEventListener('click', openDlg);
  $('btn-cancel').addEventListener('click', closeDlg);
  dlg.querySelector('.dlg-mask').addEventListener('click', closeDlg);

  $('btn-confirm').addEventListener('click', async () => {
    $('dlg-err').textContent = '';
    const btn = $('btn-confirm');
    btn.disabled = true;
    try {
      const body = {
        slug: $('f-slug').value.trim(),
        title: $('f-title').value.trim(),
        date: $('f-date').value.trim()
      };
      const t = $('f-token').value.trim();
      if (t) body.adminToken = t;
      const res = await api('/events', { method: 'POST', body: JSON.stringify(body) });
      closeDlg();
      await load();
      alert(`场次「${res.event.title}」已创建。\n管理口令：${res.event.adminToken}`);
    } catch (e) {
      $('dlg-err').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-login').addEventListener('click', () => {
    token = $('super-token').value.trim();
    sessionStorage.setItem('superToken', token);
    load();
  });
  $('btn-refresh').addEventListener('click', load);
  $('super-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click(); });

  if (token) load();
})();
