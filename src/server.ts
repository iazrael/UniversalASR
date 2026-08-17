import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { config } from './config/index.js';
import { AuthService } from './auth/auth.service.js';
import { ASRSession } from './core/session.js';
import { ASRErrorCode } from './types/protocol.js';
import { ASRProviderFactory } from './providers/factory.js';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

// 注册插件
await app.register(cors, { origin: '*' });
await app.register(websocket, {
  options: {
    maxPayload: 1024 * 1024 * 5, // 5MB 最大包限制
  },
});

// 活动会话表统计
const activeSessions = new Map<string, ASRSession>();

// 1. 健康检查路由
app.get('/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    supported_providers: ASRProviderFactory.getSupportedProviders(),
    default_provider: config.DEFAULT_PROVIDER,
  };
});

// 2. 通用 ASR 实时 WebSocket 接入端点
app.get('/v1/asr', { websocket: true }, (socket, req) => {
  const token = AuthService.extractTokenFromRequest(req);

  // 校验鉴权 Token
  if (!AuthService.isValidToken(token)) {
    app.log.warn({ ip: req.ip, token }, '客户端鉴权失败，拒绝连接');
    
    // 发送鉴权失败错误信息后关闭
    socket.send(
      JSON.stringify({
        event: 'error',
        code: ASRErrorCode.UNAUTHORIZED,
        message: 'Unauthorized: 鉴权失败，请在 Query 参数 (?token=xxx) 或 Header 中提供有效 API Key',
      })
    );
    socket.close(4001, 'Unauthorized');
    return;
  }

  app.log.info({ ip: req.ip }, '客户端鉴权通过，建立 ASR 实时会话');

  // 创建会话
  const session = new ASRSession(socket, app.log);
  activeSessions.set(session.id, session);

  socket.on('close', () => {
    activeSessions.delete(session.id);
  });
});

// 启动服务
const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`🚀 Universal ASR Service 已在 http://${config.HOST}:${config.PORT} 启动`);
    app.log.info(`⚡ WebSocket ASR 端点: ws://${config.HOST}:${config.PORT}/v1/asr?token=<YOUR_TOKEN>`);
    app.log.info(`🎯 默认 ASR 引擎: ${config.DEFAULT_PROVIDER} (Paraformer v2)`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// 优雅停机
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    app.log.info(`收到 ${signal} 信号，正在平滑关闭服务...`);
    // 关闭所有现有会话
    for (const session of activeSessions.values()) {
      session.destroy();
    }
    activeSessions.clear();
    await app.close();
    process.exit(0);
  });
});

start();
