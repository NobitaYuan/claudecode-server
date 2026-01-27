# Claude Code Web Server

一个为 Claude Code CLI 提供 Web UI 的服务器端应用，支持多种 AI Provider（Claude、Cursor、Codex），提供完整的项目管理、终端会话、Git 操作等功能。

## 目录

- [功能特性](#功能特性)
- [运行方式](#运行方式)
- [项目架构](#项目架构)
- [依赖说明](#依赖说明)
- [数据流](#数据流)
- [接口调用流程](#接口调用流程)
- [配置说明](#配置说明)
- [API 接口文档](#api-接口文档)

## 功能特性

### 核心功能
- **多 AI Provider 支持**
  - Claude SDK（使用 `@anthropic-ai/claude-agent-sdk`）
  - Cursor CLI（通过 `cursor-agent` 命令）
  - OpenAI Codex（使用 `@openai/codex-sdk`）

- **项目管理**
  - 自动发现 Claude 项目（`~/.claude/projects/`）
  - 自动发现 Cursor 会话（`~/.cursor/chats/`）
  - 手动添加项目路径
  - 项目重命名、删除（含/不含会话）

- **会话管理**
  - 查看项目历史会话
  - 恢复/继续会话
  - 分页加载会话消息
  - Token 使用统计（Claude/Codex）
  - 会话中止功能

- **终端集成**
  - 基于 `node-pty` 的伪终端（PTY）支持
  - WebSocket 实时终端输出
  - 支持 Claude/Cursor CLI 交互
  - 终端会话缓存（30分钟超时）
  - 终端尺寸动态调整

- **文件操作**
  - 文件树浏览（递归扫描）
  - 文件内容读取/保存
  - 二进制文件服务（图片等）
  - 图片上传（支持多图）
  - 文件系统浏览

- **Git 集成**
  - Git 操作 API
  - Git 配置管理
  - 支持通过 GitHub Token 认证

- **MCP (Model Context Protocol) 支持**
  - MCP 工具检测
  - MCP 服务器管理
  - MCP 配置工具

- **用户认证**
  - JWT Token 认证
  - API Key 认证
  - 单用户系统
  - 密码加密存储（bcrypt）

- **语音输入**
  - Whisper API 音频转文字
  - 多种增强模式（prompt、instructions、architect）

### WebSocket 功能
- 聊天 WebSocket (`/ws`)：AI 对话交互
- 终端 WebSocket (`/shell`)：实时终端输出
- 项目变更实时广播（文件监听）

## 运行方式

### 环境要求
- Node.js >= 18
- npm 或 pnpm

### 安装依赖
```bash
npm install
# 或
pnpm install
```

### 配置环境变量

编辑 `.env` 文件：

```env
# 服务器端口配置
PORT=3001              # 后端 API + WebSocket 服务器端口
VITE_PORT=5173         # 前端开发服务器端口

# Claude CLI 配置
CLAUDE_CLI_PATH=claude # 自定义 claude 命令路径（可选）

# Context Window 配置
CONTEXT_WINDOW=160000          # 后端上下文窗口大小
VITE_CONTEXT_WINDOW=160000     # 前端上下文窗口大小

# 可选：数据库路径
DATABASE_PATH=/path/to/auth.db # 自定义数据库路径（可选）

# 可选：OpenAI API Key（用于语音转文字）
OPENAI_API_KEY=your-openai-api-key

# 平台模式（可选）
VITE_IS_PLATFORM=false  # 平台模式，无需认证
```

### 启动开发服务器

```bash
# 开发模式（需要单独启动前端）
npm run dev

# 或直接使用 node
node index.js
```

### 构建生产版本

```bash
# 构建前端（如果有前端代码）
npm run build

# 启动生产服务器
npm start
```

### 访问应用

- 开发环境：`http://localhost:3001`
- 生产环境：`http://localhost:3001`（需要先 `npm run build`）

### 健康检查

```bash
curl http://localhost:3001/health
```

## 项目架构

### 目录结构

```
claudecodeWebServer/
├── index.js                 # 主服务器文件（Express + WebSocket）
├── cli.js                   # CLI 入口文件
├── package.json             # 项目配置
├── .env                     # 环境变量配置
│
├── database/                # 数据库模块
│   ├── db.js               # 数据库连接和操作（SQLite）
│   ├── init.sql            # 数据库初始化 SQL
│   └── auth.db             # SQLite 数据库文件（运行时生成）
│
├── middleware/              # 中间件
│   └── auth.js             # 认证中间件（JWT + API Key）
│
├── routes/                  # API 路由
│   ├── auth.js             # 认证路由（登录/注册）
│   ├── agent.js            # Agent API 路由
│   ├── cli-auth.js         # CLI 认证路由
│   ├── codex.js            # Codex API 路由
│   ├── commands.js         # 命令 API 路由
│   ├── cursor.js           # Cursor API 路由
│   ├── git.js              # Git API 路由
│   ├── mcp.js              # MCP API 路由
│   ├── mcp-utils.js        # MCP 工具路由
│   ├── projects.js         # 项目 API 路由
│   ├── settings.js         # 设置 API 路由
│   ├── taskmaster.js       # TaskMaster API 路由
│   └── user.js             # 用户 API 路由
│
├── utils/                   # 工具函数
│   ├── commandParser.js    # 命令解析器
│   ├── gitConfig.js        # Git 配置工具
│   ├── mcp-detector.js     # MCP 检测工具
│   └── taskmaster-websocket.js # TaskMaster WebSocket
│
├── shared/                  # 共享模块
│   └── modelConstants.js   # 模型常量定义
│
└── 核心集成模块
    ├── claude-sdk.js       # Claude SDK 集成
    ├── cursor-cli.js       # Cursor CLI 集成
    ├── openai-codex.js     # OpenAI Codex 集成
    └── projects.js         # 项目发现和管理
```

### 架构设计

#### 1. 服务器层 ([index.js](index.js))
- **Express HTTP 服务器**：提供 RESTful API
- **WebSocket 服务器**：提供实时通信
  - `/ws`：聊天交互
  - `/shell`：终端交互
- **静态文件服务**：生产环境提供前端文件
- **请求体解析**：支持 JSON 和 FormData（最大 50MB）

#### 2. 认证系统
- **JWT Token 认证**：用于常规 API 调用
- **API Key 认证**：用于外部集成
- **WebSocket 认证**：通过 query 参数或 header 传递 token
- **单用户系统**：仅允许一个用户账号

#### 3. AI Provider 集成
- **Claude SDK** ([claude-sdk.js](claude-sdk.js))：使用官方 SDK，支持工具调用审批流程
- **Cursor CLI** ([cursor-cli.js](cursor-cli.js))：通过子进程调用 `cursor-agent` 命令
- **Codex SDK** ([openai-codex.js](openai-codex.js))：使用 OpenAI Codex SDK

#### 4. 项目管理
- **Claude 项目**：读取 `~/.claude/projects/` 目录
- **Cursor 项目**：计算项目路径 MD5，读取 `~/.cursor/chats/{md5}/`
- **手动项目**：存储在 `~/.claude/project-config.json`

#### 5. 数据持久化
- **SQLite 数据库** ([database/db.js](database/db.js))
  - 用户表（users）
  - API Keys 表（api_keys）
  - 用户凭证表（user_credentials）
- **会话文件**：
  - Claude：`~/.claude/projects/{encoded-path}/{session-id}.jsonl`
  - Cursor：`~/.cursor/chats/{md5}/sessions/{session-id}/store.db` (SQLite)
  - Codex：`~/.codex/sessions/{project-path}/{session-id}.jsonl`

#### 6. 文件监听
- 使用 `chokidar` 监控 `~/.claude/projects/` 变化
- 防抖机制（300ms）
- 通过 WebSocket 广播项目更新

## 依赖说明

### 核心依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `express` | ^4.22.1 | HTTP 服务器框架 |
| `ws` | ^8.19.0 | WebSocket 服务器 |
| `better-sqlite3` | ^12.6.2 | SQLite 数据库 |
| `bcrypt` | ^6.0.0 | 密码加密 |
| `jsonwebtoken` | ^9.0.3 | JWT Token 生成 |
| `node-pty` | ^1.1.0 | 伪终端（PTY）支持 |
| `chokidar` | ^5.0.0 | 文件系统监听 |
| `cors` | ^2.8.6 | 跨域资源共享 |

### AI SDK 依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.20 | Claude Agent SDK |
| `@openai/codex-sdk` | ^0.91.0 | OpenAI Codex SDK |

### Git 集成依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `@octokit/rest` | ^22.0.1 | GitHub API 客户端 |
| `simple-git` | (隐式) | Git 操作 |

### 工具依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `node-fetch` | ^3.3.2 | HTTP 请求 |
| `mime-types` | ^3.0.2 | MIME 类型检测 |
| `cross-spawn` | ^7.0.6 | 跨平台子进程 |
| `gray-matter` | ^4.0.3 | Frontmatter 解析 |
| `@iarna/toml` | ^2.2.5 | TOML 文件解析 |

### 开发依赖

（根据 [package.json](package.json) 自动推断）
- `vite`：前端构建工具
- `multer`：文件上传中间件（运行时动态导入）

## 数据流

### 1. 用户认证流程

```
用户请求 → validateApiKey (可选) → authenticateToken (必需) → 业务处理
                    ↓                           ↓
              API Key 验证                JWT Token 验证
                    ↓                           ↓
              从数据库查询               解析并验证签名
                    ↓                           ↓
              返回用户信息                返回用户信息
```

### 2. AI 对话流程（Claude SDK）

```
前端 WebSocket
    ↓
type: 'claude-command'
    ↓
queryClaudeSDK(command, options, writer)
    ↓
创建 ControlStream (SDK)
    ↓
处理事件：
  - 'tool' → 等待用户审批
    ↓
    发送 approval_request 到前端
    ↓
    前端发送 permission_response
    ↓
    resolveToolApproval (继续执行)
  - 'text' → 转发到前端
  - 'error' → 转发错误
  - 'end' → 清理会话
```

### 3. 终端会话流程

```
前端 WebSocket (/shell)
    ↓
type: 'init' + projectPath + sessionId
    ↓
检查 ptySessionsMap (会话缓存)
    ↓
    存在 → 复用 PTY，发送历史输出
    不存在 → 创建新 PTY
              ↓
          pty.spawn(shell, shellArgs, options)
              ↓
          onData → 监听输出
              ↓
          检测 URL 打开 → 发送 url_open 事件
          普通输出 → 发送 output 事件
```

### 4. 项目发现流程

```
GET /api/projects
    ↓
getProjects()
    ↓
并行扫描：
  1. Claude 项目 (~/.claude/projects/)
     → 读取目录名（编码后的路径）
     → 从 .jsonl 提取 cwd
     → 读取 project-config.json
  2. Cursor 会话 (~/.cursor/chats/)
     → 遍历已知项目
     → 计算路径 MD5
     → 检查对应的 Cursor 目录
    ↓
合并结果，去重
    ↓
返回项目列表
```

### 5. 文件操作流程

```
读取文件：
GET /api/projects/:projectName/file?filePath=xxx
    ↓
提取项目目录
    ↓
安全检查（路径必须在项目根目录内）
    ↓
读取文件内容
    ↓
返回 { content, path }

保存文件：
PUT /api/projects/:projectName/file
    ↓
提取项目目录
    ↓
安全检查
    ↓
写入文件
    ↓
返回 { success, path, message }
```

## 接口调用流程

### WebSocket 消息流程

#### 聊天 WebSocket (`/ws`)

**客户端 → 服务器：**

```javascript
// 发起 Claude 对话
{
  type: 'claude-command',
  command: 'User message',
  options: {
    projectPath: '/path/to/project',
    sessionId: 'session-id',  // 可选，恢复会话
    model: 'claude-sonnet-4-5-20250929'
  }
}

// 工具审批响应
{
  type: 'claude-permission-response',
  requestId: 'uuid',
  allow: true,
  updatedInput: 'Modified input',
  message: 'Reason for modification',
  rememberEntry: true  // 记住审批决定
}

// 中止会话
{
  type: 'abort-session',
  sessionId: 'session-id',
  provider: 'claude' // 'cursor' | 'codex'
}

// 检查会话状态
{
  type: 'check-session-status',
  sessionId: 'session-id',
  provider: 'claude'
}

// 获取活跃会话
{
  type: 'get-active-sessions'
}
```

**服务器 → 客户端：**

```javascript
// 文本消息
{
  type: 'text',
  text: 'AI response',
  sessionId: 'session-id'
}

// 工具调用请求
{
  type: 'approval_request',
  requestId: 'uuid',
  tool: {
    name: 'bash',
    input: { command: 'ls' }
  },
  sessionId: 'session-id'
}

// 会话状态
{
  type: 'session-status',
  sessionId: 'session-id',
  provider: 'claude',
  isProcessing: true
}

// 活跃会话列表
{
  type: 'active-sessions',
  sessions: {
    claude: ['session-1', 'session-2'],
    cursor: [],
    codex: []
  }
}

// 项目更新
{
  type: 'projects_updated',
  projects: [...],
  timestamp: '2025-01-27T...',
  changeType: 'add',
  changedFile: 'filename.js'
}
```

#### 终端 WebSocket (`/shell`)

**客户端 → 服务器：**

```javascript
// 初始化终端
{
  type: 'init',
  projectPath: '/path/to/project',
  sessionId: 'session-id',  // 可选
  provider: 'claude',       // 'claude' | 'cursor' | 'plain-shell'
  initialCommand: 'npm install',
  cols: 80,
  rows: 24
}

// 发送输入
{
  type: 'input',
  data: 'user input text'
}

// 调整终端尺寸
{
  type: 'resize',
  cols: 100,
  rows: 30
}
```

**服务器 → 客户端：**

```javascript
// 终端输出
{
  type: 'output',
  data: '\x1b[36mTerminal output\x1b[0m\r\n'
}

// URL 打开
{
  type: 'url_open',
  url: 'https://github.com/...'
}
```

### REST API 调用流程

#### 认证流程

```bash
# 1. 检查认证状态
GET /api/auth/status
# Response: { needsSetup: true, isAuthenticated: false }

# 2. 注册（仅首次）
POST /api/auth/register
{
  "username": "admin",
  "password": "password123"
}
# Response: { success: true, user: {...}, token: "jwt-token" }

# 3. 登录
POST /api/auth/login
{
  "username": "admin",
  "password": "password123"
}
# Response: { success: true, user: {...}, token: "jwt-token" }

# 后续请求在 Header 中携带：
Authorization: Bearer <jwt-token>
```

#### 项目管理流程

```bash
# 获取项目列表
GET /api/projects
Header: Authorization: Bearer <token>

# 获取项目会话
GET /api/projects/:projectName/sessions?limit=5&offset=0

# 获取会话消息
GET /api/projects/:projectName/sessions/:sessionId/messages?limit=50&offset=0

# 获取文件树
GET /api/projects/:projectName/files

# 读取文件
GET /api/projects/:projectName/file?filePath=/path/to/file.js

# 保存文件
PUT /api/projects/:projectName/file
{
  "filePath": "/path/to/file.js",
  "content": "file content"
}

# 重命名项目
PUT /api/projects/:projectName/rename
{
  "displayName": "New Display Name"
}

# 删除会话
DELETE /api/projects/:projectName/sessions/:sessionId

# 删除项目
DELETE /api/projects/:projectName?force=true

# 创建项目
POST /api/projects/create
{
  "path": "/path/to/new/project"
}
```

#### Git 操作流程

```bash
# Git 操作（示例）
POST /api/git/execute
{
  "projectPath": "/path/to/project",
  "command": "status"
}

# Git 配置
GET /api/git/config?projectPath=/path/to/project
PUT /api/git/config
{
  "projectPath": "/path/to/project",
  "name": "User Name",
  "email": "user@example.com"
}
```

#### Token 使用统计

```bash
GET /api/projects/:projectName/sessions/:sessionId/token-usage?provider=claude
# Response: {
#   used: 45000,
#   total: 160000,
#   breakdown: {
#     input: 40000,
#     cacheCreation: 3000,
#     cacheRead: 2000
#   }
# }
```

## 配置说明

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 后端服务器端口 | 3001 |
| `VITE_PORT` | 前端开发服务器端口 | 5173 |
| `CLAUDE_CLI_PATH` | Claude CLI 命令路径 | `claude` |
| `CONTEXT_WINDOW` | 后端上下文窗口大小 | 160000 |
| `VITE_CONTEXT_WINDOW` | 前端上下文窗口大小 | 160000 |
| `DATABASE_PATH` | 数据库文件路径 | `database/auth.db` |
| `OPENAI_API_KEY` | OpenAI API Key（语音功能） | - |
| `VITE_IS_PLATFORM` | 平台模式（无需认证） | false |
| `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS` | 工具审批超时时间 | 55000 |

### 数据库配置

数据库使用 SQLite，默认位置：`database/auth.db`

可通过环境变量 `DATABASE_PATH` 自定义路径。

表结构：
- `users`：用户信息
- `api_keys`：API Keys
- `user_credentials`：用户凭证（GitHub Token、GitLab Token 等）

### 针对不同 AI Provider 的配置

#### Claude SDK
- 自动使用 Claude CLI 的配置文件 (`~/.claude/config.json`)
- 支持的模型在 [shared/modelConstants.js](shared/modelConstants.js) 中定义

#### Cursor CLI
- 需要系统已安装 `cursor-agent` 命令
- 使用 Cursor 的配置文件

#### Codex SDK
- 需要配置 OpenAI API Key
- 使用 Codex SDK 的默认配置

### 文件监听配置

使用 `chokidar` 监控 `~/.claude/projects/`：
- 忽略：`node_modules`, `.git`, `dist`, `build` 等
- 防抖：300ms
- 深度：10 层

## API 接口文档

### 认证接口

#### `GET /api/auth/status`
检查认证状态

**响应：**
```json
{
  "needsSetup": true,
  "isAuthenticated": false
}
```

#### `POST /api/auth/register`
注册用户（仅首次允许）

**请求体：**
```json
{
  "username": "admin",
  "password": "password123"
}
```

**响应：**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "username": "admin"
  },
  "token": "jwt-token"
}
```

#### `POST /api/auth/login`
用户登录

**请求体：**
```json
{
  "username": "admin",
  "password": "password123"
}
```

### 项目接口

#### `GET /api/projects`
获取所有项目列表

**需要认证：** 是

**响应：**
```json
[
  {
    "name": "project-name",
    "displayName": "Project Display Name",
    "path": "/absolute/path/to/project",
    "lastModified": "2025-01-27T...",
    "sessionCount": 5,
    "manuallyAdded": false,
    "hasTaskmaster": true
  }
]
```

#### `GET /api/projects/:projectName/sessions`
获取项目的会话列表

**查询参数：**
- `limit`: 返回数量（默认 5）
- `offset`: 偏移量（默认 0）

**响应：**
```json
{
  "sessions": [
    {
      "id": "session-id",
      "title": "Session Title",
      "createdAt": "2025-01-27T...",
      "messageCount": 23
    }
  ],
  "total": 10,
  "hasMore": true
}
```

#### `GET /api/projects/:projectName/sessions/:sessionId/messages`
获取会话消息

**查询参数：**
- `limit`: 返回数量
- `offset`: 偏移量

**响应：**
```json
{
  "messages": [
    {
      "type": "user",
      "content": "User message",
      "timestamp": "2025-01-27T..."
    },
    {
      "type": "assistant",
      "content": "AI response",
      "timestamp": "2025-01-27T..."
    }
  ],
  "total": 100,
  "hasMore": true
}
```

### Git 接口

#### `POST /api/git/execute`
执行 Git 命令

**请求体：**
```json
{
  "projectPath": "/path/to/project",
  "command": "status"
}
```

**响应：**
```json
{
  "success": true,
  "output": "git output...",
  "error": null
}
```

### MCP 接口

#### `GET /api/mcp/detect`
检测项目中的 MCP 工具

**查询参数：**
- `projectPath`: 项目路径

**响应：**
```json
{
  "tools": [
    {
      "name": "tool-name",
      "config": {...}
    }
  ]
}
```

### 语音接口

#### `POST /api/transcribe`
音频转文字

**请求：** multipart/form-data
- `audio`: 音频文件
- `mode`: 增强模式（default/prompt/instructions/architect）

**响应：**
```json
{
  "text": "transcribed text"
}
```

### 其他接口

#### `GET /health`
健康检查（无需认证）

**响应：**
```json
{
  "status": "ok",
  "timestamp": "2025-01-27T..."
}
```

#### `POST /api/system/update`
系统更新（git pull + npm install）

**需要认证：** 是

**响应：**
```json
{
  "success": true,
  "output": "update output...",
  "message": "Update completed. Please restart the server."
}
```

## 开发指南

### 添加新的 AI Provider

1. 创建新的集成文件（如 `newprovider-cli.js`）
2. 实现标准接口：
   - `query(command, options, writer)`：发起查询
   - `abortSession(sessionId)`：中止会话
   - `isSessionActive(sessionId)`：检查会话状态
   - `getActiveSessions()`：获取活跃会话
3. 在 [index.js](index.js) 中导入并注册
4. 在 WebSocket 消息处理中添加新的 `type` 分支

### 添加新的 API 路由

1. 在 `routes/` 目录创建新文件
2. 使用 Express Router：
```javascript
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/endpoint', authenticateToken, async (req, res) => {
  // 处理逻辑
});

export default router;
```

3. 在 [index.js](index.js) 中注册：
```javascript
import newRoutes from './routes/new-route.js';
app.use('/api/new', authenticateToken, newRoutes);
```

### WebSocket 消息扩展

在 [index.js](index.js:731) 的 `handleChatConnection` 函数中添加新的消息类型处理：

```javascript
if (data.type === 'your-new-type') {
  // 处理逻辑
  writer.send({
    type: 'response-type',
    data: responseData
  });
}
```

## 故障排查

### 常见问题

1. **端口被占用**
   - 修改 `.env` 中的 `PORT` 变量

2. **数据库初始化失败**
   - 检查 `database/` 目录权限
   - 删除 `auth.db` 重新初始化

3. **Claude CLI 未找到**
   - 确保已安装 Claude Code CLI
   - 设置 `CLAUDE_CLI_PATH` 环境变量

4. **WebSocket 连接失败**
   - 检查防火墙设置
   - 确认 Token 有效
   - 查看服务器日志

### 日志查看

服务器日志包含详细的调试信息：
- `[INFO]`：一般信息
- `[WARN]`：警告
- `[ERROR]`：错误
- `[DEBUG]`：调试信息

## 许可证

本项目使用 Claude Code CLI 和相关 SDK，请遵守相应的许可证。

## 贡献

欢迎提交 Issue 和 Pull Request！

## 相关链接

- [Claude Code CLI](https://github.com/anthropics/claude-code)
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
- [Cursor](https://cursor.sh)
