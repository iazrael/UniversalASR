import dotenv from 'dotenv';
import { z } from 'zod';

// 加载 .env 环境变量
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  // 客户端接入鉴权 Token 列表（英文逗号隔开，* 代表不鉴权/开发模式）
  AUTH_TOKENS: z.string().default('default-client-token,test-token'),

  // 默认 ASR 提供商
  DEFAULT_PROVIDER: z.string().default('aliyun'),

  // 阿里云 DashScope / Paraformer 配置
  DASHSCOPE_API_KEY: z.string().optional().default(''),
  DASHSCOPE_MODEL: z.string().default('paraformer-realtime-v2'),
  DASHSCOPE_WS_URL: z.string().default('wss://dashscope.aliyuncs.com/api-v1/services/audio/asr/transcription'),

  // 会话空闲超时时间（毫秒，默认 60 秒无音频/交互则自动释放）
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().default(60000),
  // 最大会话持续时长（毫秒，默认 30 分钟）
  SESSION_MAX_DURATION_MS: z.coerce.number().default(1800000),
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
