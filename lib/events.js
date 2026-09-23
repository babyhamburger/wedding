'use strict';
// 场次解析：从 URL 前缀 /e/<slug>/ 或旧路径（归入 default）确定当前场次
const { stmts } = require('./db');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function validSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

// 返回 { ok, event } 或 { ok:false, code }
function resolveEvent(slug) {
  if (!validSlug(slug)) return { ok: false, code: 400, error: 'bad_slug' };
  const ev = stmts.eventGet.get(slug);
  if (!ev) return { ok: false, code: 404, error: 'event_not_found' };
  return { ok: true, event: ev };
}

module.exports = { resolveEvent, validSlug };
