# Linux 服务器部署计划

## 项目概述
- **项目名称**: Claude Code Web Server
- **技术栈**: Node.js (Express + WebSocket)
- **Node.js 版本要求**: >= 18
- **默认端口**: 3001 (API + WebSocket)

## 部署架构选择

### 方案 A: PM2 进程管理（推荐）
**优点**:
- 自动重启崩溃进程
- 日志管理
- 开机自启动
- 集群模式（多核 CPU 利用）

**适用场景**: 生产环境，需要高可用性

### 方案 B: Docker 容器
**优点**:
- 环境隔离
- 易于迁移和扩展
- 依赖管理简单

**适用场景**: 容器化部署环境

---

## 部署步骤（方案 A - PM2）

### 阶段 1: 服务器环境准备

#### 1.1 安装 Node.js
```bash
# 使用 NodeSource 仓库安装 Node.js 18.x 或 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version
npm --version
```

#### 1.2 安装 PM2
```bash
sudo npm install -g pm2
```

#### 1.4 安装 Nginx（反向代理）
```bash
sudo apt-get install -y nginx
```

### 阶段 2: 应用部署

#### 2.1 创建部署目录
```bash
sudo mkdir -p /opt/claude-code-web
sudo chown $USER:$USER /opt/claude-code-web
cd /opt/claude-code-web
```

#### 2.2 上传代码到服务器
**方式 1: Git Clone**
```bash
git clone <your-repository-url> .
```

**方式 2: SCP 上传**
```bash
# 在本地执行
scp -r ./claudecodeWebServer user@server:/opt/claude-code-web/
```

**方式 3: 压缩包上传**
```bash
# 本地打包
tar -czf claudecodeWebServer.tar.gz claudecodeWebServer/

# 上传
scp claudecodeWebServer.tar.gz user@server:/tmp/

# 服务器解压
cd /opt/claude-code-web
tar -xzf /tmp/claudecodeWebServer.tar.gz --strip-components=1
```

#### 2.3 安装依赖
```bash
cd /opt/claude-code-web
npm ci --production=false  # 使用 npm ci 确保依赖一致性
```

#### 2.4 构建前端（如有）
```bash
npm run build
```

#### 2.5 配置环境变量
```bash
# 编辑 .env 文件
nano .env
```

**生产环境 .env 配置示例**:
```env
# 服务器配置
PORT=3001
NODE_ENV=production

# 上下文窗口配置
CONTEXT_WINDOW=160000
VITE_CONTEXT_WINDOW=160000

# 平台模式（如无需认证）
VITE_IS_PLATFORM=true

# OpenAI API Key（可选，语音功能需要）
# OPENAI_API_KEY=your-key-here

# 日志级别（可选）
# LOG_LEVEL=info
```

#### 2.6 设置文件权限
```bash
# 设置应用目录权限
chmod -R 755 /opt/claude-code-web

# 或者创建专用运行用户
sudo useradd -r -s /bin/false claudecode
sudo chown -R claudecode:claudecode /opt/claude-code-web
```

### 阶段 3: 配置 PM2

#### 3.1 创建 PM2 配置文件
```bash
nano ecosystem.config.js
```

**ecosystem.config.js 内容**:
```javascript
module.exports = {
  apps: [{
    name: 'claude-code-web',
    script: './index.js',
    cwd: '/opt/claude-code-web',
    instances: 1,  // 或 'max' 用于集群模式
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: '/var/log/pm2/claude-code-error.log',
    out_file: '/var/log/pm2/claude-code-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // 如果使用专用用户运行
    // user: 'claudecode'
  }]
};
```

#### 3.2 创建日志目录
```bash
sudo mkdir -p /var/log/pm2
sudo chown $USER:$USER /var/log/pm2
```

#### 3.3 启动应用
```bash
cd /opt/claude-code-web
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 执行输出的命令配置开机自启
```

### 阶段 4: 配置 Nginx 反向代理

#### 4.1 创建 Nginx 配置
```bash
sudo nano /etc/nginx/sites-available/claude-code-web
```

**Nginx 配置内容**:
```nginx
# HTTP 配置（开发/测试环境）
server {
    listen 80;
    server_name your-domain.com;  # 或服务器 IP

    # 日志
    access_log /var/log/nginx/claude-code-access.log;
    error_log /var/log/nginx/claude-code-error.log;

    # 客户端最大请求体大小（用于文件上传）
    client_max_body_size 10M;

    # 代理到 Node.js 应用
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # 超时设置（长连接）
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }

    # WebSocket 代理
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 超时设置
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    # 终端 WebSocket
    location /shell {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # PTTY 长连接超时
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }
}
```

#### 4.2 启用站点配置
```bash
sudo ln -s /etc/nginx/sites-available/claude-code-web /etc/nginx/sites-enabled/
sudo nginx -t  # 测试配置
sudo systemctl reload nginx
```

### 阶段 5: SSL/HTTPS 配置（可选但推荐）

#### 5.1 使用 Let's Encrypt 免费证书
```bash
# 安装 Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 获取并自动配置 SSL
sudo certbot --nginx -d your-domain.com

# 自动续期
sudo certbot renew --dry-run
```

Certbot 会自动修改 Nginx 配置添加 HTTPS。

### 阶段 6: 防火墙配置

#### 6.1 配置 UFW 防火墙
```bash
sudo apt-get install -y ufw

# 允许 SSH
sudo ufw allow 22/tcp

# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 启用防火墙
sudo ufw enable

# 查看状态
sudo ufw status
```

### 阶段 7: 验证部署

#### 7.1 检查应用状态
```bash
# PM2 状态
pm2 status
pm2 logs claude-code-web

# 检查端口
sudo netstat -tlnp | grep 3001

# 测试健康检查
curl http://localhost:3001/health
```

#### 7.2 检查 Nginx
```bash
sudo systemctl status nginx
```

#### 7.3 浏览器访问
```
http://your-server-ip
```

---

## 部署步骤（方案 B - Docker）

### C.1 创建 Dockerfile
```dockerfile
FROM node:20-slim

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci

# 复制应用代码
COPY . .

# 构建前端
RUN npm run build

# 暴露端口
EXPOSE 3001

# 启动命令
CMD ["node", "index.js"]
```

### C.2 创建 docker-compose.yml
```yaml
version: '3.8'

services:
  app:
    build: .
    container_name: claude-code-web
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PORT=3001
      - VITE_IS_PLATFORM=true
    volumes:
      - ./logs:/app/logs
    networks:
      - claude-network

networks:
  claude-network:
    driver: bridge
```

### C.3 构建和运行
```bash
# 构建镜像
docker-compose build

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

---

## 常见问题和解决方案

### 1. 端口被占用
**问题**: 3001 端口已被其他服务占用

**解决方案**:
```bash
# 查找占用端口的进程
sudo lsof -i :3001

# 杀死进程或更改 .env 中的 PORT
```

### 2. 权限问题
**问题**: 文件写入失败

**解决方案**:
```bash
# 确保应用目录可写
chmod -R 755 /opt/claude-code-web

# 或使用专用用户运行
sudo chown -R www-data:www-data /opt/claude-code-web
```

### 3. WebSocket 连接失败
**问题**: WebSocket 连接频繁断开

**解决方案**: 检查 Nginx 配置中的超时设置和代理头配置

### 4. 内存不足
**问题**: 应用崩溃或重启

**解决方案**:
```javascript
// 在 ecosystem.config.js 中限制内存
max_memory_restart: '500M'

// 或增加服务器 swap 空间
```

---

## 运维命令

### PM2 常用命令
```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs claude-code-web
pm2 logs claude-code-web --lines 100

# 重启应用
pm2 restart claude-code-web

# 停止应用
pm2 stop claude-code-web

# 删除应用
pm2 delete claude-code-web

# 监控
pm2 monit
```

### 更新应用
```bash
cd /opt/claude-code-web
git pull
npm ci
npm run build
pm2 restart claude-code-web
```

---

## 安全建议

1. **不要以 root 用户运行应用**
2. **配置防火墙**，只开放必要端口
3. **使用 HTTPS**，保护通信安全
4. **定期更新依赖**: `npm audit fix`
5. **限制 API 访问**，配置 API Key
6. **设置日志轮转**，防止磁盘占满
7. **监控服务器资源**使用情况

---

## 监控和告警（可选）

### 安装监控工具
```bash
# PM2 Plus (监控多个服务器)
pm2 link <secret_key> <public_key>

# 或使用其他监控方案
# - Prometheus + Grafana
# - DataDog
# - New Relic
```

---

## 扩展性考虑

### 负载均衡
如果有多个应用实例，可以使用 Nginx 负载均衡:

```nginx
upstream claude_backend {
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    server 127.0.0.1:3003;
}

server {
    location / {
        proxy_pass http://claude_backend;
    }
}
```

### 集群模式
```javascript
// ecosystem.config.js
instances: 'max',  // 使用所有 CPU 核心
exec_mode: 'cluster'
```

---

## 附件：快速部署脚本

```bash
#!/bin/bash
# quick-deploy.sh

set -e

echo "开始部署 Claude Code Web Server..."

# 1. 安装依赖
echo "安装系统依赖..."
sudo apt-get update
sudo apt-get install -y curl git nginx

# 2. 安装 Node.js
echo "安装 Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 3. 安装 PM2
echo "安装 PM2..."
sudo npm install -g pm2

# 4. 创建部署目录
echo "创建部署目录..."
sudo mkdir -p /opt/claude-code-web
sudo chown $USER:$USER /opt/claude-code-web

# 5. 上传代码（手动执行或使用 git）
# cd /opt/claude-code-web && git clone <repo-url> .

echo "请手动上传代码到 /opt/claude-code-web"
read -p "代码上传完成? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# 6. 安装依赖
cd /opt/claude-code-web
echo "安装应用依赖..."
npm ci
npm run build

# 7. 配置环境变量
echo "请配置 .env 文件..."
nano .env

# 8. 启动应用
echo "启动应用..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "部署完成!"
echo "应用运行在: http://localhost:3001"
echo "请配置 Nginx 反向代理以对外提供服务"
```

使用方法:
```bash
chmod +x quick-deploy.sh
./quick-deploy.sh
```
