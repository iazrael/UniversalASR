import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { AuthService } from './auth/auth.service.js';
import { ASRSession } from './core/session.js';
import { ASRErrorCode } from './types/protocol.js';
import { ASRProviderFactory } from './providers/factory.js';
import { RateLimiter } from './guard/rate-limiter.js';
import { CircuitBreaker } from './guard/circuit-breaker.js';
import { TicketService } from './guard/ticket.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '../public');

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
  // 信任代理（Nginx / Cloudflare 等反代场景下获取真实 IP）
  trustProxy: true,
});

// ── 初始化防护组件 ──────────────────────────────────────────

const rateLimiter = new RateLimiter();
const circuitBreaker = new CircuitBreaker();
const ticketService = new TicketService();

// 注入日志器
circuitBreaker.setLogger(app.log);

// 注册插件
await app.register(cors, { origin: '*' });
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: '/',
});
await app.register(websocket, {
  options: {
    maxPayload: 1024 * 1024 * 5, // 5MB 最大包限制
  },
});

// 活动会话表统计
const activeSessions = new Map<string, ASRSession>();

// ── 1. 健康检查路由 ─────────────────────────────────────────

app.get('/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    active_sessions: activeSessions.size,
    supported_providers: ASRProviderFactory.getSupportedProviders(),
    default_provider: config.DEFAULT_PROVIDER,
    budget: circuitBreaker.getStatus(),
    rate_limiter: rateLimiter.getStats(),
    pending_tickets: ticketService.getPendingCount(),
  };
});

// ── 2. Ticket 签发接口 ──────────────────────────────────────

app.post('/v1/ticket', async (req, reply) => {
  // 鉴权：必须携带有效的静态 API Key
  const token = AuthService.extractTokenFromRequest(req);
  if (!AuthService.isValidToken(token)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: '请提供有效的 API Key',
    });
  }

  const ip = req.ip;

  // 熔断检查
  if (circuitBreaker.isTripped()) {
    const status = circuitBreaker.getStatus();
    app.log.warn({ ip, reason: status.tripReason }, 'Ticket 签发被熔断器拒绝');
    return reply.status(503).send({
      error: 'service_suspended',
      message: `ASR 服务已暂停：${status.tripReason}`,
    });
  }

  // IP 限流检查（检查日额度，不递增——递增在 WS 连接建立时做）
  const dailyCheck = rateLimiter.checkDaily(ip);
  if (!dailyCheck.allowed) {
    app.log.warn({ ip, limit: dailyCheck.limit }, 'Ticket 签发被 IP 日限额拒绝');
    return reply.status(429).send({
      error: 'rate_limited',
      message: `当前 IP 今日调用已达上限 (${dailyCheck.limit} 次)`,
      limit: dailyCheck.limit,
      remaining: 0,
    });
  }

  // 签发 ticket
  const result = ticketService.issue(ip);
  app.log.info({ ip, ticket: result.ticket.slice(0, 8) + '...' }, 'Ticket 签发成功');

  return reply.status(200).send(result);
});

// ── 3. 通用 ASR 实时 WebSocket 接入端点 ─────────────────────

app.get('/v1/asr', { websocket: true }, (socket, req) => {
  const query = req.query as Record<string, string | undefined>;
  const ip = req.ip;

  // ── 鉴权路径 1: 静态 token 直连（调试/内部/控制台） ──

  const token = AuthService.extractTokenFromRequest(req);
  if (token && AuthService.isValidToken(token)) {
    app.log.info({ ip, auth: 'static-token' }, '客户端通过静态 Token 鉴权，建立 ASR 实时会话');
    createSession(socket, req, ip);
    return;
  }

  // ── 鉴权路径 2: Ticket 通道（生产前端） ──

  const ticket = query?.ticket;
  if (ticket) {
    // Ticket 校验
    const ticketResult = ticketService.validate(ticket, ip);
    if (!ticketResult.valid) {
      app.log.warn({ ip, reason: ticketResult.reason }, '客户端 Ticket 校验失败');
      socket.send(JSON.stringify({
        event: 'error',
        code: ASRErrorCode.UNAUTHORIZED,
        message: `Ticket 校验失败: ${ticketResult.reason}`,
      }));
      socket.close(4001, 'Invalid ticket');
      return;
    }

    // 熔断检查
    if (circuitBreaker.isTripped()) {
      const status = circuitBreaker.getStatus();
      app.log.warn({ ip, reason: status.tripReason }, 'WebSocket 连接被熔断器拒绝');
      socket.send(JSON.stringify({
        event: 'error',
        code: ASRErrorCode.SERVICE_SUSPENDED,
        message: `ASR 服务已暂停: ${status.tripReason}`,
      }));
      socket.close(4009, 'Service suspended');
      return;
    }

    // IP 日限流检查（递增计数）
    const dailyCheck = rateLimiter.checkAndIncrement(ip);
    if (!dailyCheck.allowed) {
      app.log.warn({ ip, limit: dailyCheck.limit }, 'WebSocket 连接被 IP 日限额拒绝');
      socket.send(JSON.stringify({
        event: 'error',
        code: ASRErrorCode.RATE_LIMITED,
        message: `当前 IP 今日调用已达上限 (${dailyCheck.limit} 次)`,
      }));
      socket.close(4008, 'Rate limited');
      return;
    }

    // IP 并发限流检查
    const concurrencyCheck = rateLimiter.checkConcurrency(ip);
    if (!concurrencyCheck.allowed) {
      app.log.warn(
        { ip, current: concurrencyCheck.current, limit: concurrencyCheck.limit },
        'WebSocket 连接被 IP 并发上限拒绝'
      );
      socket.send(JSON.stringify({
        event: 'error',
        code: ASRErrorCode.RATE_LIMITED,
        message: `当前 IP 并发连接数已达上限 (${concurrencyCheck.limit})`,
      }));
      socket.close(4008, 'Rate limited');
      return;
    }

    app.log.info(
      { ip, auth: 'ticket', remaining: dailyCheck.remaining },
      '客户端通过 Ticket 鉴权，建立 ASR 实时会话'
    );
    createSession(socket, req, ip);
    return;
  }

  // ── 无有效凭证 ──

  app.log.warn({ ip }, '客户端鉴权失败：无 Token 也无 Ticket');
  socket.send(JSON.stringify({
    event: 'error',
    code: ASRErrorCode.UNAUTHORIZED,
    message: 'Unauthorized: 请提供有效的 Token 或 Ticket',
  }));
  socket.close(4001, 'Unauthorized');
});

/**
 * 创建 ASR 会话（提取公共逻辑）
 */
function createSession(socket: import('ws').WebSocket, req: import('fastify').FastifyRequest, ip: string): void {
  // 跟踪并发连接
  rateLimiter.trackConnect(ip);

  const session = new ASRSession(socket, app.log);
  activeSessions.set(session.id, session);

  // 注入用量上报回调
  session.onUsageReport = (durationMs: number) => {
    circuitBreaker.recordUsage(durationMs);
  };

  socket.on('close', () => {
    activeSessions.delete(session.id);
    rateLimiter.trackDisconnect(ip);
  });
}

// ── 启动服务 ────────────────────────────────────────────────

const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`🚀 Universal ASR Service 已在 http://${config.HOST}:${config.PORT} 启动`);
    app.log.info(`⚡ WebSocket ASR 端点: ws://${config.HOST}:${config.PORT}/v1/asr?ticket=<TICKET>`);
    app.log.info(`🎫 Ticket 签发端点: POST http://${config.HOST}:${config.PORT}/v1/ticket`);
    app.log.info(`🎯 默认 ASR 引擎: ${config.DEFAULT_PROVIDER} (Paraformer v2)`);
    app.log.info(`🛡️ 成本防护: IP 日限额 ${config.RATE_LIMIT_DAILY_PER_IP}次 | 并发上限 ${config.RATE_LIMIT_MAX_CONCURRENT_PER_IP} | 单次识别 ≤${config.UTTERANCE_MAX_DURATION_MS / 1000}s | 日预算 ${config.BUDGET_DAILY_MAX_COUNT}次`);
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
    // 销毁防护组件
    rateLimiter.destroy();
    circuitBreaker.destroy();
    ticketService.destroy();
    await app.close();
    process.exit(0);
  });
});

start();
