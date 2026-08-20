import { randomBytes } from 'crypto';
import { config } from '../config/index.js';

/**
 * 短时效 Ticket 签发与校验服务
 *
 * - 密码学安全随机生成 ticket（base64url，32 字符）
 * - 一次性使用，用过即废
 * - 可选绑定签发时的 IP
 * - 定时清理过期 ticket，防内存泄漏
 */

interface TicketEntry {
  createdAt: number;
  /** 签发时的客户端 IP */
  ip: string;
  /** 是否已被使用 */
  used: boolean;
}

export interface TicketIssueResult {
  ticket: string;
  /** 有效期（秒） */
  expiresIn: number;
}

export interface TicketValidateResult {
  valid: boolean;
  reason?: string;
}

export class TicketService {
  private tickets = new Map<string, TicketEntry>();
  private cleanupTimer: NodeJS.Timeout;

  private readonly ttlMs: number;
  private readonly bindIp: boolean;

  constructor() {
    this.ttlMs = config.TICKET_TTL_MS;
    this.bindIp = config.TICKET_BIND_IP;

    // 每 30 秒清理过期 ticket
    this.cleanupTimer = setInterval(() => this.cleanup(), 30 * 1000);
    this.cleanupTimer.unref();
  }

  /**
   * 签发一张新 ticket
   */
  public issue(ip: string): TicketIssueResult {
    const ticket = randomBytes(24).toString('base64url'); // 32 字符
    this.tickets.set(ticket, {
      createdAt: Date.now(),
      ip,
      used: false,
    });

    return {
      ticket,
      expiresIn: Math.floor(this.ttlMs / 1000),
    };
  }

  /**
   * 校验并消费 ticket（一次性使用）
   * @param ticket 待校验的 ticket
   * @param ip 使用时的客户端 IP
   */
  public validate(ticket: string, ip: string): TicketValidateResult {
    const entry = this.tickets.get(ticket);

    if (!entry) {
      return { valid: false, reason: 'Ticket 不存在或已过期' };
    }

    // 无论校验结果如何，都从 Map 中移除（防止重试攻击）
    this.tickets.delete(ticket);

    // 检查是否已使用
    if (entry.used) {
      return { valid: false, reason: 'Ticket 已被使用' };
    }

    // 检查是否过期
    if (Date.now() - entry.createdAt > this.ttlMs) {
      return { valid: false, reason: 'Ticket 已过期' };
    }

    // 可选：检查 IP 是否一致
    if (this.bindIp && entry.ip !== ip) {
      return { valid: false, reason: 'Ticket 的使用 IP 与签发 IP 不一致' };
    }

    // 标记为已使用（虽然已从 Map 删除，但保持语义完整性）
    entry.used = true;

    return { valid: true };
  }

  /**
   * 获取当前活跃 ticket 数量（用于监控）
   */
  public getPendingCount(): number {
    return this.tickets.size;
  }

  /**
   * 清理过期 ticket
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (now - entry.createdAt > this.ttlMs) {
        this.tickets.delete(ticket);
      }
    }
  }

  /**
   * 销毁定时器
   */
  public destroy(): void {
    clearInterval(this.cleanupTimer);
    this.tickets.clear();
  }
}
