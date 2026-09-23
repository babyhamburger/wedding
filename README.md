# 婚礼现场扫码照片墙

宾客扫码即可上传现场随手拍的照片/视频，大屏实时轮播展示，无需注册登录。参考 [LiveDrop](https://livedrop.app) 的设计思路，支持同时运营多场不同婚礼。

## 功能特性

- **零门槛上传**：宾客扫码打开上传页，选图/拍照即传；图片客户端自动压缩（最长边 1600px、JPEG 质量 0.82），视频不压缩直传（≤60MB，支持 MP4/MOV/WebM）
- **弱网可靠**：上传任务先写入浏览器 IndexedDB 队列再发送，断网自动重试（指数退避），页面关闭后重开可续传
- **对象存储直传**：服务端签发预签名 URL，手机直接 PUT 到阿里云 OSS，服务器零带宽压力；数据库仅存元数据；也支持 local 磁盘模式（本地开发/无公网演示）
- **大屏实时展示**：WebSocket 推送新照片，秒级上墙；网格 + 轮播两种模式，视频自动播放；断线自动重连并补拉期间遗漏的照片，极端情况降级为轮询
- **管理后台**：口令登录，照片撤回/恢复/删除，勾选批量下载（服务端流式打包 ZIP，一次性票据）；统一 16:9 横屏卡片，竖图模糊背景填充
- **视频封面帧**：服务端 ffmpeg 异步截取视频首帧作封面，解决 iPhone .mov（HEVC）浏览器无法解码导致的空白卡片
- **多场次（多租户）**：每场婚礼独立 URL、独立管理口令、独立二维码；照片数据、存储路径、实时推送、离线队列全部隔离；旧链接向后兼容
- **超管总控台**：创建/改名/停用启用场次，查看各场照片数

## 技术栈

Node.js (≥20) + Express + better-sqlite3 (WAL) + ws + qrcode + archiver；前端为原生 HTML/CSS/JS，无构建步骤。

## 快速开始

```bash
npm install
cp .env.example .env   # 按需修改配置
npm start              # 或 npm run dev（--watch 热重启）
```

打开 http://localhost:3000 即自动跳转上传页。默认 `STORAGE=local`，无需任何云配置即可体验完整流程。

## 页面与路由

| 路径 | 说明 |
| --- | --- |
| `/upload` | 宾客上传页（default 场次） |
| `/wall` | 大屏照片墙（default 场次） |
| `/admin` | 管理后台（default 场次） |
| `/super` | 超管总控台（管理所有场次） |
| `/qr.png` | 上传页二维码（可打印做桌牌） |
| `/e/<slug>/upload\|wall\|admin\|qr.png` | 指定场次的对应页面 |

API 同理：`/api/...` 归 default 场次，`/api/e/<slug>/...` 按场次访问；`/api/super/...` 为超管接口（`x-super-token` 头鉴权）。

上传三步流程：`POST /uploads/init`（校验+签发凭证）→ 客户端 `PUT` 直传存储 → `POST /uploads/:id/confirm`（落库+按场次广播）。

## 配置（.env）

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 3000 |
| `PUBLIC_URL` | 对外访问地址（生成上传链接与二维码），本地可留空 |
| `STORAGE` | `local` 或 `oss` |
| `WEDDING_TITLE` / `WEDDING_DATE` | default 场次的标题/日期 |
| `ADMIN_TOKEN` | default 场次管理口令 |
| `SUPER_TOKEN` | 超管总控台口令（未配置时回退用 `ADMIN_TOKEN`） |
| `OSS_REGION` / `OSS_BUCKET` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 阿里云 OSS 凭证；`OSS_REGION` 只填 `oss-cn-shanghai` 这类区域名 |
| `OSS_PREFIX` | object key 前缀，默认 `wedding` |

`STORAGE=oss` 时 Bucket 需配置 CORS 允许浏览器 `PUT`（来源 `*` 或站点域名、允许头 `Content-Type`）。

## 多场次（多租户）

- 数据模型：`events` 表（slug/标题/日期/独立管理口令/状态），`photos.event_slug` 归属列；升级时自动迁移，历史照片归入 `default`
- 隔离范围：照片查询、管理口令、OSS 路径（`<prefix>/<slug>/<日期>/<id>.<ext>`）、WebSocket 房间（连接带 `?e=<slug>`）、浏览器离线队列（IndexedDB 按 slug 分库）
- 停用场次后宾客无法上传，但大屏/管理仍可查看历史；`default` 场次不可停用
- 通过 `/super` 总控台创建场次，页面直接展示该场的上传/大屏/管理链接、二维码与管理口令

## 生产部署

推荐架构（当前线上方案）：systemd 服务监听 `127.0.0.1:3000` + Caddy 反向代理自动 HTTPS。

1. 服务器安装 Node（≥20）与 ffmpeg（视频封面帧需要）：`apt install ffmpeg`
2. 代码放到 `/opt/wedding`，`npm install --omit=dev`，配置 `.env`（`chmod 600`，含 OSS 凭证与口令）
3. systemd 单元示例：

   ```ini
   [Service]
   WorkingDirectory=/opt/wedding
   ExecStart=/opt/nodejs/bin/node server.js
   EnvironmentFile=/opt/wedding/.env
   Restart=always
   ```

4. Caddy 反代：域名 → `reverse_proxy 127.0.0.1:3000`（自动签发 Let's Encrypt 证书）
5. 更新发布：打包 `server.js lib public` 上传覆盖 → `systemctl restart wedding`（数据库迁移启动时自动执行）

## 目录结构

```
server.js            # 入口：路由挂载、页面、二维码、健康检查
lib/
  env.js             # .env 加载
  db.js              # SQLite schema、迁移、预编译语句
  events.js          # 场次解析（slug 校验）
  dto.js             # 照片 → 前端 DTO（填充 url/posterUrl）
  ws.js              # WebSocket：按场次房间广播、心跳
  poster.js          # ffmpeg 视频封面帧（异步 + 启动补做）
  ratelimit.js       # 内存限流
  routes/            # uploads / photos / admin / super
  storage/           # local 与 oss 两种实现（同一接口）
public/
  upload|wall|admin|super.html
  js/event.js        # 前端场次上下文（window.Event）
  js/queue.js        # IndexedDB 离线上传队列
  js/compress.js     # 客户端图片压缩
  js/upload|wall|admin|super.js
  css/
```

## 已知注意点

- Node `https` 响应对象是 `res.statusCode`，不是 `res.status`
- OSS 服务端签名请求的 `Authorization` 头包含 `Content-Type` 时，实际请求必须带同名头，否则 403
- `archiver` v7+ 的导出是 `const { ZipArchive } = require('archiver')`
- admin 路由需 `express.json()`，否则 `req.body` 为空
