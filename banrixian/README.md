# 半日闲 · 部署指南

> 偷得浮生半日闲 — 发个链接，拉几个人，聊完即散。

---

## 本地运行（5分钟）

```bash
# 1. 安装依赖
npm install

# 2. 启动
npm start

# 浏览器打开 http://localhost:3000
```

---

## 免费部署到 Railway（推荐，最简单）

1. 注册 [railway.app](https://railway.app)（GitHub 登录即可）
2. New Project → Deploy from GitHub repo（上传本项目）
3. 自动检测 Node.js，点 Deploy
4. Settings → Networking → Generate Domain，得到你的公网地址
5. 把链接发给朋友，完成 ✅

---

## 免费部署到 Render

1. 注册 [render.com](https://render.com)
2. New → Web Service → 连接 GitHub 仓库
3. Build Command: `npm install`
4. Start Command: `node server/index.js`
5. 选 Free 套餐，Deploy

**注意**：Render 免费套餐 15 分钟无活动会休眠，冷启动约 30 秒。

---

## 部署到自己的服务器（VPS）

```bash
# 安装 Node.js（如果没有）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 克隆项目 / 上传文件到服务器
cd /opt/banrixian
npm install

# 用 PM2 保持后台运行
npm install -g pm2
pm2 start server/index.js --name banrixian
pm2 save && pm2 startup

# Nginx 反向代理（可选，支持 HTTPS）
# 见下方配置
```

### Nginx 配置

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # WebSocket 必须加这两行
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

配置好后用 `certbot --nginx` 申请免费 HTTPS 证书。

---

## 项目结构

```
banrixian/
├── server/
│   └── index.js        # Express + WebSocket 后端
├── public/
│   └── index.html      # 前端（单文件，所有 CSS/JS 内联）
├── package.json
├── Dockerfile
└── README.md
```

---

## 技术说明

- **后端**：Node.js + Express + ws（WebSocket）
- **加密**：浏览器 WebCrypto API，AES-256-GCM，PBKDF2 密钥派生
- **存储**：纯内存，服务器只存密文，重启即清空
- **「聊完即删」模式**：最后一人离开自动销毁，服务器不持久化
- **「保留记录」模式**：加密密文保存在内存，重进房间可解密历史

---

## 已知限制（V1）

- 服务器重启后所有房间和历史消息消失（内存存储）
- 图片以 Base64 传输，大图会慢，建议压缩后发送
- 无持久化数据库，适合轻量临时聊天场景

如需持久化，可将 `rooms` 和 `messages` 接入 Redis 或 SQLite。
