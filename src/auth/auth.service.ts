import { FastifyRequest } from 'fastify';
import { config } from '../config/index.js';

export class AuthService {
  /**
   * 校验 Token 是否合法
   */
  public static isValidToken(token?: string | null): boolean {
    if (config.isNoAuthMode) {
      return true;
    }

    if (!token) {
      return false;
    }

    const trimmed = token.trim();
    return config.authTokensSet.has(trimmed);
  }

  /**
   * 从 Fastify WebSocket 握手请求中提取鉴权 Token
   */
  public static extractTokenFromRequest(req: FastifyRequest): string | null {
    // 1. 从 Query 参数提取: ?token=xxx 或 ?apiKey=xxx 或 ?key=xxx
    const query = req.query as Record<string, string | undefined>;
    if (query?.token) return query.token;
    if (query?.apiKey) return query.apiKey;
    if (query?.key) return query.key;

    // 2. 从 Header 提取: Authorization: Bearer xxx
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
        return parts[1];
      }
      return authHeader;
    }

    // 3. 从自定义 Header 提取: x-api-key / x-token
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string') return xApiKey;

    const xToken = req.headers['x-token'];
    if (typeof xToken === 'string') return xToken;

    return null;
  }
}
