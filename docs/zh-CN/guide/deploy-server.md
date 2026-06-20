# 服务器部署 (Docker)

## 配置

```bash
cd server
cp .env.example .env
```

编辑 `.env` 文件：

```ini
PORT=3456

# 必须修改！使用随机字符串
JWT_SECRET=your-very-long-random-secret-key-here
AGENT_SECRET=your-agent-shared-secret-here

# 可选：邮箱验证
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=Yeaft Web Code Agent <noreply@example.com>

# 可选：TOTP 双因素认证
TOTP_ENABLED=true
```

## Docker Compose

```yaml
services:
  webchat:
    build:
      context: .
      dockerfile: Dockerfile
    expose:
      - "3456"
    env_file:
      - server/.env
    environment:
      - NODE_ENV=production
      - SKIP_AUTH=false
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
# 启动服务器（首次运行会自动创建 data/ 目录和 SQLite 数据库）
docker compose up -d --build webchat

# 创建第一个 admin 用户
docker compose exec webchat node server/create-user.js admin your-password admin@example.com
```

后续用户可直接在登录页注册（开放注册，无需邀请码）。

![登录页面](/images/login.png)

## Nginx 反向代理

```nginx
server {
    listen 443 ssl;
    server_name cc.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://webchat:3456;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 长连接超时
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```
