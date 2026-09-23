# 婚礼现场"扫码即传"照片墙系统 — 实施计划

## Context

为婚礼现场构建一个参考 LiveDrop 的照片上传系统：宾客扫码即可上传随手拍的照片，大屏实时展示。核心约束：

1. **移动端零门槛**：扫码 → 打开页面 → 选照片/拍照 → 上传，无注册登录；弱网下未完成的上传保存在手机本地（IndexedDB），恢复网络后自动续传，并提供手动重试入口。
2. **照片不入库**：文件存对象存储（阿里云 OSS / 腾讯云 COS），数据库只存元数据；后端签发临时上传凭证（presigned URL），手机直传对象存储，不经服务器中转。
3. **大屏与上传解耦**：独立实时照片墙页面，自动刷新/轮播新照片；WS 订阅新增事件，带轮询降级，上传端故障不影响大屏展示。

项目目录为空，全新搭建。

## 技术选型

- **后端**：Node 20+ / Express 4 / better-sqlite3（元数据）/ ws（实时广播）/ qrcode（服务端生成二维码 PNG）。共 5 个运行时依赖，无构建步骤。
- **存储抽象层**：`LocalDiskStorage`（开发/无公网演示，走本服务器）与 `OssStorage`（生产，presigned PUT 直传，自签 V1 签名不引 SDK），环境变量 `STORAGE=local|oss` 切换。`CosStorage` 预留同接口。
- **关键统一**：客户端永远执行「init → PUT uploadUrl → confirm」三步，local 模式的 uploadUrl 指向本服务器，OSS 模式指向 bucket——**前端对存储零分支**。
- **前端**：原生 HTML/CSS/JS 三个页面（上传页 / 大屏页 / 管理页），无框架。
- **裁剪决策**：不做服务端 sharp 缩略图（客户端压缩到 1600px 即可，OSS 可用 `x-oss-process` 参数）；不做阻塞式审核队列（默认自动上墙，管理页可一键撤回）。

## 目录结构

```
hunli/
├── package.json / .env.example / server.js
├── lib/
│   ├── db.js                 # better-sqlite3 初始化建表
│   ├── storage/              # index.js 工厂 + local.js + oss.js
│   ├── routes/
│   │   ├── uploads.js        # init / confirm / local 模式 PUT 接收
│   │   ├── photos.js         # 大屏列表（since 增量）
│   │   └── admin.js          # ADMIN_TOKEN 校验、撤回/删除
│   └── ws.js                 # WebSocket hub + 心跳
├── public/
│   ├── upload.html / wall.html / admin.html
│   ├── css/  (upload.css wall.css admin.css)
│   └── js/   compress.js queue.js upload.js wall.js
└── data/  uploads/           # gitignore
```

## 数据模型

```sql
CREATE TABLE photos (
  id TEXT PRIMARY KEY, file_key TEXT NOT NULL,
  original_name TEXT, mime TEXT, size INTEGER,
  width INTEGER, height INTEGER, uploader_ip TEXT,
  status TEXT DEFAULT 'init',      -- init | confirmed | hidden
  created_at INTEGER, confirmed_at INTEGER
);
CREATE INDEX idx_photos_wall ON photos(status, confirmed_at);
```

定时清理：每小时删除 init 超过 24h 的孤儿记录。婚礼标题/日期放 `.env`（`WEDDING_TITLE`）。

## API

| 接口 | 说明 |
|---|---|
| `POST /api/uploads/init` | 校验 mime/大小(≤15MB)/IP 限速 → 签发 `{id, uploadUrl, method, headers}` |
| `PUT /api/uploads/raw/:id` | 仅 local 模式：流式落盘 |
| `POST /api/uploads/:id/confirm` | `storage.exists()` 校验 → status=confirmed → WS 广播 |
| `GET /api/photos?since=&limit=` | 大屏初始加载 + 轮询降级（confirmed 升序） |
| `GET /api/admin/photos`、`POST /api/admin/photos/:id/status` | 管理页（需 `x-admin-token`） |
| `GET /qr.png` | 服务端渲染上传页 URL 二维码 |
| `WS /ws` | 广播 `photo.added` / `photo.removed`，30s 心跳 |

OSS presigned PUT：`StringToSign = PUT\n\n{content-type}\n{expires}\n/{bucket}/{key}`，HMAC-SHA1 拼接签名参数，约 30 行代码。Bucket 需配置 CORS 允许 PUT。

## 客户端上传页

- 两个入口：相册多选（`accept="image/*" multiple`）+ 直接唤起相机（`capture="environment"`）。不用 getUserMedia，避开 HTTPS 权限问题。
- 压缩：`createImageBitmap` → canvas 缩放至长边 1600px → JPEG q0.82（约 300–600KB/张）。
- **IndexedDB 离线队列**：DB `wallq`，核心原则"先入库再上传，成功才删除"；触发时机 = 入队 / `online` 事件 / `visibilitychange` 回前台 / 15s 定时器；串行上传；`XMLHttpRequest` 驱动进度条；指数退避重试（2^n×2s，封顶 60s，8 次后标记失败）。
- UI：底部"待上传 N 张"徽标条 → 展开列表含缩略图/状态/单条重试/全部重试/删除；无网络时顶部横幅提示"照片已保存在本机，联网后自动继续"。

## 大屏照片墙

- 初始加载 `GET /api/photos`，网格布局，最新在左上，新照片 scale+fade 入场动画。
- WS 订阅 `photo.added/removed`；断线指数退避重连，**重连成功后必须用 `?since=` 补拉断线期间照片**（正确性关键）；连续 3 次 WS 失败切 5s 轮询降级，恢复后切回。
- 轮播模式：单张全屏 + Ken Burns 动画，5–8s 切换，预加载防黑屏；图片加载失败自动移除格子。
- 页头：婚礼标题、照片数、右下角小二维码（宾客扫大屏即可上传）。

## 实施顺序（每步可验证）

1. 脚手架：Express + 静态页 + DB 建表 → `curl /healthz`
2. Local 存储链路：init/raw/confirm 三接口 → curl 手动走通
3. 上传页 MVP：选图→压缩→三步上传→进度条（DevTools 手机模拟）
4. 大屏 MVP：列表 + WS 广播 + 入场动画（双窗口验证 <1s 出现）
5. 离线队列：IDB + 重试 UI + online 事件（DevTools Offline 切换验证自动续传）
6. 大屏健壮性：重连补拉 + 轮询降级 + 轮播（kill 服务器重启验证）
7. 管理页 + 安全：撤回、限速、token 校验
8. OSS Adapter：presigned + CORS，`STORAGE=oss` 回归三步链路（前端零改动）
9. 二维码 + `.env.example` + 真机彩排

## 验证方式

- 手机连同一 Wi-Fi 访问 `http://<局域网IP>:3000`，扫 `/qr.png`。
- 断网模拟：DevTools Offline / 手机飞行模式 30s（含杀掉标签页后队列仍在）/ 停服重启验证大屏补拉。
- 弱网：DevTools Slow 3G 验证进度与重试。
- 边界：>15MB、非图片、连点 20 张、iOS HEIC。

## 部署注意

- **推荐**：云服务器 + Caddy 自动 HTTPS 反代 + OSS 模式（宾客走 4G 访问公网域名；微信内置浏览器对 http 拦截较凶，强烈建议 HTTPS）。
- **备选（无公网）**：笔记本 + 手机热点 + `STORAGE=local`；注意现场 Wi-Fi 常有 AP 隔离。
- OSS：CORS 允许 PUT 且 Content-Type 与签名严格一致；object key 加日期前缀；生命周期规则归档。
- 进程用 pm2 守护；当天定时备份 SQLite 与 uploads 目录。容量估算：200 人 × 5 张 × 0.5MB ≈ 500MB，无压力。
