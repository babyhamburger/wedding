'use strict';
// 前端场次上下文：从 URL 路径解析 slug，统一构造带场次前缀的 API / WS / 资源地址。
// 规则：/e/<slug>/... => 该场次；其余 => default（向后兼容旧 URL）。
window.Event = (function () {
  const m = location.pathname.match(/^\/e\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])(?:\/|$)/);
  const slug = m ? m[1] : 'default';
  const isDefault = slug === 'default';

  // 业务 API 前缀：/api 或 /api/e/<slug>
  function api(p) {
    return isDefault ? `/api${p}` : `/api/e/${slug}${p}`;
  }
  // 页面/资源路径：/upload 或 /e/<slug>/upload
  function page(p) {
    return isDefault ? p : `/e/${slug}${p}`;
  }
  // WebSocket 连接地址（带房间参数）
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws?e=${encodeURIComponent(slug)}`;
  }

  return { slug, isDefault, api, page, wsUrl };
})();
