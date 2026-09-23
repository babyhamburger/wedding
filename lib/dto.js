'use strict';
// 统一的记录 -> 前端 DTO：填充 url 与视频封面 posterUrl
const { toDto } = require('./db');

function photoDto(row, storage, req) {
  return toDto({
    ...row,
    url: storage.getPublicUrl(row.file_key, req),
    posterUrl: row.poster_key ? storage.getPublicUrl(row.poster_key, req) : null
  });
}

module.exports = { photoDto };
