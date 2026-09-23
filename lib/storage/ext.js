'use strict';
// mime -> 文件扩展名
const MAP = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm'
};
function extFor(mime) {
  return MAP[mime] || '.bin';
}
module.exports = { extFor };
