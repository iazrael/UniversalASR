import { config } from '../config/index.js';

/**
 * IP 维度限流器
 *
 * - 每 IP 每日最大识别次数（滑动窗口计数器，每日 0 点重置）
 * - 每 IP 最大并发 WebSocket 连接数
 * - 定时清理过期条目，防止内存泄漏
 *
 * 纯内存实现，单进程场景下 Map 查找 O(1)。
 */

interface DailyCounter {
  count: number;
  /** 该计数器的过期时间戳（当日 23:59:59.999） */
  resetAt: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export interface ConcurrencyCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
}

export class RateLimiter {
  private dailyCounters = new Map<string, DailyCounter>();
  private activeConnections = new Map<string, number>();
  private cleanupTimer: NodeJS.Timeout;

  private readonly dailyLimit: number;
  private readonly concurrencyLimit: number;

  constructor() {
    this.dailyLimit = config.RATE_LIMIT_DAILY_PER_IP;
    this.concurrencyLimit = config.RATE_LIMIT_MAX_CONCURRENT_PER_IP;

    // 每 10 分钟清理过期的日计数器条目
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    // 允许进程在只剩定时器时正常退出
    this.cleanupTimer.unref();
  }

  /**
   * 检查并递增 IP 的日调用计数
   * @returns 是否放行 + 剩余次数
   */
  public checkAndIncrement(ip: string): RateLimitCheckResult {
    const now = Date.now();
    let counter = this.dailyCounters.get(ip);

    // 不存在或已过期 → 新建计数器
    if (!counter || now >= counter.resetAt) {
      counter = { count: 0, resetAt: this.getEndOfDay(now) };
      this.dailyCounters.set(ip, counter);
    }

    if (counter.count >= this.dailyLimit) {
      return { allowed: false, remaining: 0, limit: this.dailyLimit };
    }

    counter.count++;
    return {
      allowed: true,
      remaining: this.dailyLimit - counter.count,
      limit: this.dailyLimit,
    };
  }

  /**
   * 仅检查 IP 的日调用计数（不递增）
   */
  public checkDaily(ip: string): RateLimitCheckResult {
    const now = Date.now();
    const counter = this.dailyCounters.get(ip);

    if (!counter || now >= counter.resetAt) {
      return { allowed: true, remaining: this.dailyLimit, limit: this.dailyLimit };
    }

    const remaining = Math.max(0, this.dailyLimit - counter.count);
    return { allowed: counter.count < this.dailyLimit, remaining, limit: this.dailyLimit };
  }

  /**
   * 检查 IP 的并发连接数是否超限
   */
  public checkConcurrency(ip: string): ConcurrencyCheckResult {
    const current = this.activeConnections.get(ip) || 0;
    return {
      allowed: current < this.concurrencyLimit,
      current,
      limit: this.concurrencyLimit,
    };
  }

  /**
   * 记录新连接（并发计数 +1）
   */
  public trackConnect(ip: string): void {
    const current = this.activeConnections.get(ip) || 0;
    this.activeConnections.set(ip, current + 1);
  }

  /**
   * 记录连接断开（并发计数 -1）
   */
  public trackDisconnect(ip: string): void {
    const current = this.activeConnections.get(ip) || 0;
    if (current <= 1) {
      this.activeConnections.delete(ip);
    } else {
      this.activeConnections.set(ip, current - 1);
    }
  }

  /**
   * 获取统计信息（用于 /health 接口）
   */
  public getStats(): { trackedIps: number; totalActiveConnections: number } {
    let totalActive = 0;
    for (const count of this.activeConnections.values()) {
      totalActive += count;
    }
    return {
      trackedIps: this.dailyCounters.size,
      totalActiveConnections: totalActive,
    };
  }

  /**
   * 清理过期的日计数器条目
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [ip, counter] of this.dailyCounters) {
      if (now >= counter.resetAt) {
        this.dailyCounters.delete(ip);
      }
    }
  }

  /**
   * 获取当天 23:59:59.999 的时间戳
   */
  private getEndOfDay(now: number): number {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  /**
   * 销毁定时器
   */
  public destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
