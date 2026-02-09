/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
// Used to mint unique approval request IDs when randomUUID is not available.
// This keeps parallel tool approvals from colliding; it does not add any crypto/security guarantees.
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_MODELS } from './shared/modelConstants.js';

// Session tracking: Map of session IDs to active query instances
const activeSessions = new Map();
// In-memory registry of pending tool approvals keyed by requestId.
// This does not persist approvals or share across processes; it exists so the
// SDK can pause tool execution while the UI decides what to do.
const pendingToolApprovals = new Map();

// Default approval timeout kept under the SDK's 60s control timeout.
// This does not change SDK limits; it only defines how long we wait for the UI,
// introduced to avoid hanging the run when no decision arrives.
const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// Generate a stable request ID for UI approval flows.
// This does not encode tool details or get shown to users; it exists so the UI
// can respond to the correct pending request without collisions.
function createRequestId() {
  // if clause is used because randomUUID is not available in older Node.js versions
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

// Wait for a UI approval decision, honoring SDK cancellation.
// This does not auto-approve or auto-deny; it only resolves with UI input,
// and it cleans up the pending map to avoid leaks, introduced to prevent
// replying after the SDK cancels the control request.
function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // Timeout is local to this process; it does not override SDK timing.
    // It exists to prevent the UI prompt from lingering indefinitely.
    const timeout = setTimeout(() => {
      onCancel?.('timeout');
      finalize(null);
    }, timeoutMs);

    const abortHandler = () => {
      // If the SDK cancels the control request, stop waiting to avoid
      // replying after the process is no longer ready for writes.
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    pendingToolApprovals.set(requestId, (decision) => {
      finalize(decision);
    });
  });
}

// Resolve a pending approval. This does not validate the decision payload;
// validation and tool matching remain in canUseTool, which keeps this as a
// lightweight WebSocket -> SDK relay.
function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * 将 CLI 选项映射为 SDK 兼容的选项格式
 *
 * 此方法负责将前端传来的 CLI 风格选项转换为 @anthropic-ai/claude-agent-sdk
 * 所需的选项格式，包括工作目录、权限模式、工具设置、模型配置等
 *
 * @param {Object} options - CLI 选项对象
 * @param {string} options.sessionId - 会话 ID，用于恢复已有会话
 * @param {string} options.cwd - 当前工作目录路径
 * @param {Object} options.toolsSettings - 工具权限配置
 * @param {Array<string>} options.toolsSettings.allowedTools - 允许使用的工具列表
 * @param {Array<string>} options.toolsSettings.disallowedTools - 禁止使用的工具列表
 * @param {boolean} options.toolsSettings.skipPermissions - 是否跳过权限检查
 * @param {string} options.permissionMode - 权限模式（default/plan/bypassPermissions）
 * @param {Array} options.images - 图片数据数组
 * @param {string} options.model - 指定使用的模型
 * @returns {Object} SDK 兼容的选项对象
 */
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, images } = options;

  const sdkOptions = {};

  // 映射工作目录
  // 设置 SDK 执行命令时的工作目录
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // 映射权限模式
  // 仅当权限模式非默认时才设置
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // 映射工具设置
  // 从选项中获取工具配置，或使用默认空配置
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // 处理工具权限配置
  // 如果设置了跳过权限且非计划模式，则使用绕过权限模式
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // 跳过权限检查时，使用 bypassPermissions 模式
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  // 映射允许的工具列表
  // 始终设置此选项以避免隐式的"允许所有"默认行为
  // 这只是配置 SDK，实际权限由 canUseTool 函数控制
  // 引入此配置是因为未定义时 SDK 会将其视为"允许所有工具"
  let allowedTools = [...(settings.allowedTools || [])];

  // 添加计划模式默认工具
  // 在计划模式下，自动添加用于规划任务的基础工具
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // 映射禁止的工具列表
  // 始终设置此选项，避免 SDK 将"undefined"视为允许
  // 这不会覆盖允许列表，只是传递给 canUseTool 函数作为判断依据
  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // 映射模型配置（默认使用 sonnet）
  // 有效模型：sonnet, opus, haiku, opusplan, sonnet[1m]
  sdkOptions.model = options.model || CLAUDE_MODELS.DEFAULT;
  console.log(`Using model: ${sdkOptions.model}`);

  // 映射系统提示词配置
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // 必须使用此预设才能加载 CLAUDE.md
  };

  // 映射 CLAUDE.md 加载来源设置
  // 按优先级从以下位置加载 CLAUDE.md：
  // 1. project - 项目目录
  // 2. user - 用户目录 (~/.config/claude/CLAUDE.md)
  // 3. local - 本地目录
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // 映射会话恢复配置
  // 如果提供了 sessionId，则恢复之前的会话
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // SDK messages are already in a format compatible with the frontend
  // The CLI sends them wrapped in {type: 'claude-response', data: message}
  // We'll do the same here to maintain compatibility
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(resultMessage) {
  if (resultMessage.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }

  // Get the first model's usage data
  const modelKey = Object.keys(resultMessage.modelUsage)[0];
  const modelData = resultMessage.modelUsage[modelKey];

  if (!modelData) {
    return null;
  }

  // Use cumulative tokens if available (tracks total for the session)
  // Otherwise fall back to per-request tokens
  const inputTokens = modelData.cumulativeInputTokens || modelData.inputTokens || 0;
  const outputTokens = modelData.cumulativeOutputTokens || modelData.outputTokens || 0;
  const cacheReadTokens = modelData.cumulativeCacheReadInputTokens || modelData.cacheReadInputTokens || 0;
  const cacheCreationTokens = modelData.cumulativeCacheCreationInputTokens || modelData.cacheCreationInputTokens || 0;

  // Total used = input + output + cache tokens
  const totalUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Use configured context window budget from environment (default 160000)
  // This is the user's budget limit, not the model's context window
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW) || 160000;

  console.log(`Token calculation: input=${inputTokens}, output=${outputTokens}, cache=${cacheReadTokens + cacheCreationTokens}, total=${totalUsed}/${contextWindow}`);

  return {
    used: totalUsed,
    total: contextWindow
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create temp directory in the project directory
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    console.log(`Processed ${tempImagePaths.length} images to temp directory: ${tempDir}`);
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  if (!tempImagePaths || tempImagePaths.length === 0) {
    return;
  }

  try {
    // Delete individual temp files
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(err =>
        console.error(`Failed to delete temp image ${imagePath}:`, err)
      );
    }

    // Delete temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(err =>
        console.error(`Failed to delete temp directory ${tempDir}:`, err)
      );
    }

    console.log(`Cleaned up ${tempImagePaths.length} temp image files`);
  } catch (error) {
    console.error('Error during temp file cleanup:', error);
  }
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      console.log('No ~/.claude.json found, proceeding without MCP servers');
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      console.log(`Loaded ${Object.keys(mcpServers).length} global MCP servers`);
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        console.log(`Loaded ${Object.keys(projectConfig.mcpServers).length} project-specific MCP servers`);
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      console.log('No MCP servers configured');
      return null;
    }

    console.log(`Total MCP servers loaded: ${Object.keys(mcpServers).length}`);
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * 使用 SDK 执行 Claude 查询
 *
 * 这是核心方法，负责：
 * 1. 将 CLI 选项映射为 SDK 格式
 * 2. 加载 MCP 服务器配置
 * 3. 处理图片输入（保存为临时文件）
 * 4. 设置工具权限校验回调
 * 5. 创建并执行 SDK 查询实例
 * 6. 流式处理消息并通过 WebSocket 发送给前端
 * 7. 提取并报告 token 使用情况
 * 8. 处理会话管理和清理工作
 *
 * @param {string} command - 用户的提示词/命令
 * @param {Object} options - 查询选项
 * @param {string} options.sessionId - 会话 ID，用于恢复已有会话
 * @param {string} options.cwd - 工作目录
 * @param {Object} options.toolsSettings - 工具权限设置
 * @param {string} options.permissionMode - 权限模式
 * @param {Array} options.images - 图片数据数组
 * @param {string} options.model - 指定使用的模型
 * @param {Object} ws - WebSocket 连接对象，用于向前端发送消息
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  // 提取会话 ID
  const { sessionId } = options;
  // capturedSessionId 用于捕获实际的会话 ID（可能是新创建的）
  let capturedSessionId = sessionId;
  // 标记是否已发送会话创建事件，防止重复发送
  let sessionCreatedSent = false;
  // 存储临时图片文件路径，用于后续清理
  let tempImagePaths = [];
  // 存储临时目录路径，用于后续清理
  let tempDir = null;

  try {
    // 步骤 1: 将 CLI 选项映射为 SDK 兼容格式
    const sdkOptions = mapCliOptionsToSDK(options);

    // 步骤 2: 加载 MCP 服务器配置
    // 从 ~/.claude.json 读取全局和项目特定的 MCP 服务器配置
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      // 将加载的 MCP 服务器配置添加到 SDK 选项中
      sdkOptions.mcpServers = mcpServers;
    }

    // 步骤 3: 处理图片输入
    // 将 base64 图片保存为临时文件，并修改命令以包含图片路径
    const imageResult = await handleImages(command, options.images, options.cwd);
    // 获取修改后的命令（包含图片路径信息）
    const finalCommand = imageResult.modifiedCommand;
    // 保存临时图片路径，用于后续清理
    tempImagePaths = imageResult.tempImagePaths;
    // 保存临时目录路径，用于后续清理
    tempDir = imageResult.tempDir;

    // 步骤 4: 设置工具权限校验回调函数
    // 此函数在每次工具调用前被触发，用于控制是否允许使用该工具
    sdkOptions.canUseTool = async (toolName, input, context) => {
      // 如果是绕过权限模式，直接允许所有工具调用
      if (sdkOptions.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      // 检查工具是否在禁止列表中
      const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }

      // 检查工具是否在允许列表中
      const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: input };
      }

      // 如果工具既不在允许列表也不在禁止列表，需要向用户请求权限
      // 生成唯一的请求 ID，用于匹配用户响应
      const requestId = createRequestId();
      // 向前端发送权限请求消息
      ws.send({
        type: 'claude-permission-request',
        requestId,
        toolName,
        input,
        sessionId: capturedSessionId || sessionId || null
      });

      // 等待用户的权限决策
      // 如果 SDK 取消了请求，通知前端关闭权限提示横幅
      const decision = await waitForToolApproval(requestId, {
        signal: context?.signal,
        onCancel: (reason) => {
          ws.send({
            type: 'claude-permission-cancelled',
            requestId,
            reason,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      });

      // 如果没有收到决策（超时），拒绝工具调用
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      // 如果用户取消了请求，拒绝工具调用
      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // 如果用户允许了工具调用
      if (decision.allow) {
        // rememberEntry 只更新本次运行内存中的允许列表
        // 防止同一会话中重复提示，持久化由前端处理
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          // 将工具添加到允许列表
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          // 从禁止列表中移除该工具（如果存在）
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        // 返回允许，使用用户修改后的输入（如果有）
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      // 用户拒绝工具调用
      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // 步骤 5: 创建 SDK 查询实例
    // 此实例是一个异步生成器，会流式输出 Claude 的响应
    const queryInstance = query({
      prompt: finalCommand,
      options: sdkOptions
    });

    // 步骤 6: 跟踪查询实例，以便支持中断操作
    // 如果是恢复已有会话，立即注册会话
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir);
    }

    // 步骤 7: 处理流式消息
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    // 遍历查询实例输出的每条消息
    for await (const message of queryInstance) {
      // 从首条消息中捕获会话 ID
      if (message.session_id && !capturedSessionId) {

        // 保存 SDK 返回的会话 ID
        capturedSessionId = message.session_id;
        // 注册会话到活跃会话列表
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir);

        // 在 WebSocket 连接上设置会话 ID
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // 仅为新会话发送一次会话创建事件
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send({
            type: 'session-created',
            sessionId: capturedSessionId
          });
        } else {
          console.log('Not sending session-created. sessionId:', sessionId, 'sessionCreatedSent:', sessionCreatedSent);
        }
      } else {
        console.log('No session_id in message or already captured. message.session_id:', message.session_id, 'capturedSessionId:', capturedSessionId);
      }

      // 转换消息格式并通过 WebSocket 发送给前端
      const transformedMessage = transformMessage(message);
      console.log('message', message)
      ws.send({
        type: 'claude-response',
        data: transformedMessage,
        sessionId: capturedSessionId || sessionId || null
      });

      // 从结果消息中提取并发送 token 使用情况
      if (message.type === 'result') {
        const tokenBudget = extractTokenBudget(message);
        if (tokenBudget) {
          console.log('Token budget from modelUsage:', tokenBudget);
          ws.send({
            type: 'token-budget',
            data: tokenBudget,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      }
    }

    // 步骤 8: 查询完成后清理会话
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // 步骤 9: 清理临时图片文件
    await cleanupTempFiles(tempImagePaths, tempDir);

    // 步骤 10: 发送完成事件
    console.log('Streaming complete, sending claude-complete event');
    ws.send({
      type: 'claude-complete',
      sessionId: capturedSessionId,
      exitCode: 0,
      isNewSession: !sessionId && !!command  // 判断是否为新会话
    });
    console.log('claude-complete event sent');

  } catch (error) {
    // 捕获错误并记录
    console.error('SDK query error:', error);

    // 错误处理：清理会话
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // 错误处理：清理临时图片文件
    await cleanupTempFiles(tempImagePaths, tempDir);

    // 错误处理：通过 WebSocket 发送错误消息
    ws.send({
      type: 'claude-error',
      error: error.message,
      sessionId: capturedSessionId || sessionId || null
    });

    // 重新抛出错误，让调用方处理
    throw error;
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval
};
