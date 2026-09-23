'use strict';
// 阿里云 OSS 存储：签发 presigned PUT URL，客户端直传，不经服务器中转。
// 自签 OSS V1 签名，不引入官方 SDK。
const crypto = require('crypto');
const { extFor } = require('./ext');

class OssStorage {
  constructor(env) {
    this.env = env;
    this.type = 'oss';
    const o = env.OSS;
    if (!o.bucket || !o.region || !o.accessKeyId || !o.accessKeySecret) {
      throw new Error('STORAGE=oss 需配置 OSS_BUCKET / OSS_REGION / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
    }
    this.bucket = o.bucket;
    this.region = o.region;
    this.ak = o.accessKeyId;
    this.sk = o.accessKeySecret;
    this.prefix = o.prefix;
    this.host = `${this.bucket}.${this.region}.aliyuncs.com`;
    this.publicBase = o.publicBase || `https://${this.host}`;
  }

  keyFor(id, mime, slug) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${this.prefix}/${slug || 'default'}/${day}/${id}${extFor(mime)}`;
  }

  // presigned PUT (OSS signature version 1)
  createUpload(id, mime, slug) {
    const key = this.keyFor(id, mime, slug);
    const expires = Math.floor(Date.now() / 1000) + 10 * 60; // 10 分钟
    const canonical = `PUT\n\n${mime}\n${expires}\n/${this.bucket}/${key}`;
    const signature = crypto.createHmac('sha1', this.sk).update(canonical).digest('base64');
    const params = new URLSearchParams({
      'OSSAccessKeyId': this.ak,
      'Expires': String(expires),
      'Signature': signature
    });
    const uploadUrl = `https://${this.host}/${key}?${params.toString()}`;
    return {
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      expires: expires * 1000,
      key
    };
  }

  // 私有 bucket：签发带有效期的 GET URL（默认 24h，覆盖整个婚礼当天）
  getPublicUrl(fileKey) {
    const expires = Math.floor(Date.now() / 1000) + 24 * 3600;
    const canonical = `GET\n\n\n${expires}\n/${this.bucket}/${fileKey}`;
    const signature = crypto.createHmac('sha1', this.sk).update(canonical).digest('base64');
    const params = new URLSearchParams({
      'OSSAccessKeyId': this.ak,
      'Expires': String(expires),
      'Signature': signature
    });
    return `https://${this.host}/${fileKey}?${params.toString()}`;
  }

  async exists(fileKey) {
    const res = await this.head(fileKey);
    return !!res && res.statusCode === 200;
  }

  async size(fileKey) {
    const res = await this.head(fileKey);
    if (res && res.statusCode === 200) return parseInt(res.headers['content-length'] || '0', 10);
    return 0;
  }

  head(fileKey) {
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.request({
        method: 'HEAD',
        hostname: this.host,
        path: '/' + encodeURI(fileKey),
        headers: this.authHeader('HEAD', '', '', fileKey)
      }, (res) => {
        res.resume();
        resolve(res);
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  async delete(fileKey) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'DELETE',
        hostname: this.host,
        path: '/' + encodeURI(fileKey),
        headers: this.authHeader('DELETE', '', '', fileKey)
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  // 服务端拉取对象流（打包下载用），GET 走签名 URL
  getStream(fileKey) {
    const https = require('https');
    const url = new URL(this.getPublicUrl(fileKey));
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('oss_get_' + res.statusCode));
        } else {
          resolve(res);
        }
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(new Error('oss_get_timeout')); });
    });
  }

  // 服务端写入小文件（视频封面帧）：Authorization 头签名的 PUT
  putBuffer(fileKey, buffer, contentType) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'PUT',
        hostname: this.host,
        path: '/' + encodeURI(fileKey),
        headers: {
          'Content-Type': contentType || 'image/jpeg',
          ...this.authHeader('PUT', '', contentType || 'image/jpeg', fileKey),
          'Content-Length': buffer.length
        }
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error('oss_put_' + res.statusCode + ' ' + body.slice(0, 200)));
        });
      });
      req.on('error', reject);
      req.end(buffer);
    });
  }

  // OSS 日期格式 Authorization 头（用于服务端 HEAD/DELETE）
  authHeader(verb, contentMd5, contentType, key) {
    const date = new Date().toUTCString();
    const canonical = `${verb}\n${contentMd5}\n${contentType}\n${date}\n/${this.bucket}/${key}`;
    const signature = crypto.createHmac('sha1', this.sk).update(canonical).digest('base64');
    return {
      Date: date,
      Authorization: `OSS ${this.ak}:${signature}`
    };
  }
}

module.exports = OssStorage;
