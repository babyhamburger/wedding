'use strict';
// 本地磁盘存储：开发/无公网演示用。
// 与 OSS 实现同一接口，客户端统一走 init -> PUT uploadUrl -> confirm 三步。
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const { extFor } = require('./ext');

class LocalDiskStorage {
  constructor(env) {
    this.env = env;
    this.type = 'local';
  }

  keyFor(id, mime, slug) {
    const prefix = slug && slug !== 'default' ? `${slug}_` : '';
    return `${prefix}${id}${extFor(mime)}`;
  }

  // uploadUrl 指向本服务器的 PUT 接收路由（挂载路径由 req.baseUrl 决定，兼容 /api/uploads 与 /api/e/:slug/uploads）
  createUpload(id, mime, slug, req) {
    const base = this.publicBase(req);
    const mount = (req && req.baseUrl) || '/api/uploads';
    return {
      uploadUrl: `${base}${mount}/raw/${id}`,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      expires: Date.now() + 10 * 60 * 1000
    };
  }

  publicBase(req) {
    if (this.env.PUBLIC_URL) return this.env.PUBLIC_URL;
    const proto = req ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') : 'http';
    const host = req ? (req.headers['x-forwarded-host'] || req.headers.host) : `localhost:${this.env.PORT}`;
    return `${proto}://${host}`;
  }

  getPublicUrl(fileKey, req) {
    return `${this.publicBase(req)}/uploads/${fileKey}`;
  }

  async exists(fileKey) {
    try {
      await fsp.access(path.join(UPLOADS_DIR, path.basename(fileKey)));
      return true;
    } catch {
      return false;
    }
  }

  async size(fileKey) {
    try {
      const st = await fsp.stat(path.join(UPLOADS_DIR, path.basename(fileKey)));
      return st.size;
    } catch {
      return 0;
    }
  }

  async delete(fileKey) {
    try {
      await fsp.unlink(path.join(UPLOADS_DIR, path.basename(fileKey)));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  getStream(fileKey) {
    return fs.createReadStream(path.join(UPLOADS_DIR, path.basename(fileKey)));
  }

  // 服务端写入小文件（视频封面帧）
  async putBuffer(fileKey, buffer, contentType) {
    await fsp.writeFile(path.join(UPLOADS_DIR, path.basename(fileKey)), buffer);
  }

  // 供路由层流式写盘使用（按已存的 file_key 落盘，保证与 init 时一致）
  writeStream(fileKey) {
    return fs.createWriteStream(path.join(UPLOADS_DIR, path.basename(fileKey)));
  }
}

module.exports = LocalDiskStorage;
