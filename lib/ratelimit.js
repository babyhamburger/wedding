'use strict';
// 极简内存限速：按 key 统计时间窗口内请求数
const buckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return b.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
}, 60000).unref();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

module.exports = { rateLimit, clientIp };
