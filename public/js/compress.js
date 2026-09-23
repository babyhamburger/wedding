'use strict';
// 图片压缩：解码 -> 缩放至长边 maxEdge -> 重编码 JPEG。
// iOS 相册 HEIC 也能被 createImageBitmap 解码后转 JPEG。
window.compressImage = async function compressImage(file, opts) {
  const { maxEdge = 1600, quality = 0.82 } = opts || {};
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    // 解码失败（如个别 Android 上的 HEIC），原样返回，交给后端/浏览器
    return { blob: file, width: 0, height: 0, mime: file.type || 'image/jpeg', failed: true };
  }
  const { width: w0, height: h0 } = bitmap;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close && bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return { blob: file, width: w0, height: h0, mime: file.type || 'image/jpeg', failed: true };
  return { blob, width: w, height: h, mime: 'image/jpeg', failed: false };
};
