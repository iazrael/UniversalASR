import dotenv from 'dotenv';
import { z } from 'zod';

// 加载 .env 环境变量（允许 .env 覆盖系统已有环境变量）
dotenv.config({ override: true });

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  // 客户端接入鉴权 Token 列表（英文逗号隔开，* 代表不鉴权/开发模式）
  AUTH_TOKENS: z.string().default('default-client-token,test-token'),

  // 默认 ASR 提供商 (aliyun / omlx / qwen3-asr)
  DEFAULT_PROVIDER: z.string().default('aliyun'),

  // 阿里云 DashScope / Paraformer 配置
  DASHSCOPE_API_KEY: z.string().optional().default(''),
  DASHSCOPE_WORKSPACE_ID: z.string().optional().default(''),
  DASHSCOPE_MODEL: z.string().default('paraformer-realtime-v2'),
  DASHSCOPE_WS_URL: z.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/inference'),

  // 本地 / 私有化 OMLX ASR 配置 (支持 Qwen3-ASR, Whisper, Voxtral 等)
  OMLX_BASE_URL: z.string().default('https://omlx.com'),
  OMLX_API_KEY: z.string().default(''),
  OMLX_MODEL: z.string().default('Qwen3-ASR-1.7B-8bit'),

  // 会话空闲超时时间（毫秒，默认 60 秒无音频/交互则自动释放）
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().default(60000),
  // 最大会话持续时长（毫秒，默认 30 分钟）
  SESSION_MAX_DURATION_MS: z.coerce.number().default(1800000),

  // ── 成本防护配置 ──────────────────────────────────────────

  // 单次识别最大时长（毫秒，默认 30 秒，防止单次调用计费过高）
  UTTERANCE_MAX_DURATION_MS: z.coerce.number().default(30000),

  // IP 限流：每 IP 每日最大识别次数（学校/家庭共享出口 IP，默认放宽到 200）
  RATE_LIMIT_DAILY_PER_IP: z.coerce.number().default(200),
  // IP 限流：每 IP 最大并发 WebSocket 连接数
  RATE_LIMIT_MAX_CONCURRENT_PER_IP: z.coerce.number().default(3),

  // 预算熔断：每日最大识别次数
  BUDGET_DAILY_MAX_COUNT: z.coerce.number().default(5000),
  // 预算熔断：每日最大累计识别时长（毫秒，默认 5 小时）
  BUDGET_DAILY_MAX_DURATION_MS: z.coerce.number().default(18000000),
  // 预算熔断：每月最大识别次数
  BUDGET_MONTHLY_MAX_COUNT: z.coerce.number().default(100000),
  // 预算熔断：用量告警阈值（0~1，达到此比例时输出警告日志）
  BUDGET_WARN_THRESHOLD: z.coerce.number().default(0.8),
  // 预算熔断：持久化文件路径
  BUDGET_PERSIST_PATH: z.string().default('data/usage.json'),

  // Ticket：有效期（毫秒，默认 60 秒）
  TICKET_TTL_MS: z.coerce.number().default(60000),
  // Ticket：是否绑定签发时的 IP（开启后换 IP 不可用，学校网络可能有问题）
  TICKET_BIND_IP: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ 环境变量配置错误:', parsedEnv.error.format());
  process.exit(1);
}

export const config = {
  ...parsedEnv.data,
  // 将逗号分隔的 Token 转为 Set 方便 O(1) 校验
  authTokensSet: new Set(
    parsedEnv.data.AUTH_TOKENS.split(',').map((t) => t.trim()).filter(Boolean)
  ),
  isNoAuthMode: parsedEnv.data.AUTH_TOKENS.trim() === '*',
};
