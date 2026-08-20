import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';

/**
 * 预算熔断器
 *
 * - 统计当日/当月的调用次数和累计识别时长
 * - 超过阈值自动熔断（tripped），拒绝新请求
 * - 用量达到告警阈值时输出警告日志
 * - 次日/次月自动重置
 * - 用量数据持久化到文件，防止进程重启丢数据
 */

interface PeriodUsage {
  count: number;
  durationMs: number;
  /** 格式：YYYY-MM-DD（日）或 YYYY-MM（月） */
  period: string;
}

interface PersistedData {
  daily: PeriodUsage;
  monthly: PeriodUsage;
  lastUpdated: string;
}

export interface UsageStatus {
  daily: {
    count: number;
    maxCount: number;
    durationMs: number;
    maxDurationMs: number;
  };
  monthly: {
    count: number;
    maxCount: number;
  };
  tripped: boolean;
  tripReason?: string;
}

export class CircuitBreaker {
  private daily: PeriodUsage;
  private monthly: PeriodUsage;
  private tripped = false;
  private tripReason?: string;

  private readonly persistPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  // 阈值
  private readonly dailyMaxCount: number;
  private readonly dailyMaxDurationMs: number;
  private readonly monthlyMaxCount: number;
  private readonly warnThreshold: number;

  private logger: { warn: (...args: any[]) => void; info: (...args: any[]) => void; error: (...args: any[]) => void } | null = null;

  constructor() {
    this.dailyMaxCount = config.BUDGET_DAILY_MAX_COUNT;
    this.dailyMaxDurationMs = config.BUDGET_DAILY_MAX_DURATION_MS;
    this.monthlyMaxCount = config.BUDGET_MONTHLY_MAX_COUNT;
    this.warnThreshold = config.BUDGET_WARN_THRESHOLD;
    this.persistPath = path.resolve(config.BUDGET_PERSIST_PATH);

    const today = this.getTodayString();
    const thisMonth = this.getMonthString();

    this.daily = { count: 0, durationMs: 0, period: today };
    this.monthly = { count: 0, durationMs: 0, period: thisMonth };

    // 从磁盘恢复
    this.loadFromDisk();

    // 每 5 秒检查是否有脏数据需要持久化（debounce 写入）
    this.persistTimer = setInterval(() => {
      if (this.dirty) {
        this.persistToDisk();
        this.dirty = false;
      }
    }, 5000);
    this.persistTimer.unref();
  }

  /**
   * 注入日志器（可选，来自 Fastify）
   */
  public setLogger(logger: { warn: (...args: any[]) => void; info: (...args: any[]) => void; error: (...args: any[]) => void }): void {
    this.logger = logger;
  }

  /**
   * 是否已熔断
   */
  public isTripped(): boolean {
    // 先检查是否需要自动重置（跨日/跨月）
    this.maybeReset();
    return this.tripped;
  }

  /**
   * 记录一次识别完成的用量
   */
  public recordUsage(durationMs: number): void {
    this.maybeReset();

    this.daily.count++;
    this.daily.durationMs += durationMs;
    this.monthly.count++;
    this.monthly.durationMs += durationMs;

    this.dirty = true;

    // 检查告警阈值
    this.checkWarnThreshold();

    // 检查熔断阈值
    this.checkTripThreshold();
  }

  /**
   * 获取当前用量状态（用于 /health 接口等）
   */
  public getStatus(): UsageStatus {
    this.maybeReset();
    return {
      daily: {
        count: this.daily.count,
        maxCount: this.dailyMaxCount,
        durationMs: this.daily.durationMs,
        maxDurationMs: this.dailyMaxDurationMs,
      },
      monthly: {
        count: this.monthly.count,
        maxCount: this.monthlyMaxCount,
      },
      tripped: this.tripped,
      tripReason: this.tripReason,
    };
  }

  /**
   * 手动重置熔断状态（紧急恢复用）
   */
  public manualReset(): void {
    this.tripped = false;
    this.tripReason = undefined;
    this.logger?.info('预算熔断器已手动重置');
  }

  // ── 内部方法 ─────────────────────────────────────────────

  /**
   * 检查是否跨日/跨月，自动重置对应计数器
   */
  private maybeReset(): void {
    const today = this.getTodayString();
    const thisMonth = this.getMonthString();

    if (this.daily.period !== today) {
      this.logger?.info(
        { prevCount: this.daily.count, prevDuration: this.daily.durationMs },
        `预算熔断器：日计数器重置（${this.daily.period} → ${today}）`
      );
      this.daily = { count: 0, durationMs: 0, period: today };
      // 跨日自动解除熔断
      if (this.tripped) {
        this.tripped = false;
        this.tripReason = undefined;
        this.logger?.info('预算熔断器：跨日自动解除熔断');
      }
      this.dirty = true;
    }

    if (this.monthly.period !== thisMonth) {
      this.logger?.info(
        { prevCount: this.monthly.count },
        `预算熔断器：月计数器重置（${this.monthly.period} → ${thisMonth}）`
      );
      this.monthly = { count: 0, durationMs: 0, period: thisMonth };
      this.dirty = true;
    }
  }

  /**
   * 检查是否达到告警阈值
   */
  private checkWarnThreshold(): void {
    const dailyCountRatio = this.daily.count / this.dailyMaxCount;
    const dailyDurationRatio = this.daily.durationMs / this.dailyMaxDurationMs;
    const monthlyCountRatio = this.monthly.count / this.monthlyMaxCount;

    if (dailyCountRatio >= this.warnThreshold && dailyCountRatio < 1) {
      this.logger?.warn(
        { count: this.daily.count, max: this.dailyMaxCount, ratio: dailyCountRatio.toFixed(2) },
        '⚠️ 预算告警：日调用次数接近上限'
      );
    }
    if (dailyDurationRatio >= this.warnThreshold && dailyDurationRatio < 1) {
      this.logger?.warn(
        { durationMs: this.daily.durationMs, max: this.dailyMaxDurationMs, ratio: dailyDurationRatio.toFixed(2) },
        '⚠️ 预算告警：日识别时长接近上限'
      );
    }
    if (monthlyCountRatio >= this.warnThreshold && monthlyCountRatio < 1) {
      this.logger?.warn(
        { count: this.monthly.count, max: this.monthlyMaxCount, ratio: monthlyCountRatio.toFixed(2) },
        '⚠️ 预算告警：月调用次数接近上限'
      );
    }
  }

  /**
   * 检查是否触发熔断
   */
  private checkTripThreshold(): void {
    if (this.tripped) return; // 已熔断，不重复触发

    let reason: string | undefined;

    if (this.daily.count >= this.dailyMaxCount) {
      reason = `日调用次数达到上限 (${this.daily.count}/${this.dailyMaxCount})`;
    } else if (this.daily.durationMs >= this.dailyMaxDurationMs) {
      reason = `日识别时长达到上限 (${Math.round(this.daily.durationMs / 1000)}s/${Math.round(this.dailyMaxDurationMs / 1000)}s)`;
    } else if (this.monthly.count >= this.monthlyMaxCount) {
      reason = `月调用次数达到上限 (${this.monthly.count}/${this.monthlyMaxCount})`;
    }

    if (reason) {
      this.tripped = true;
      this.tripReason = reason;
      this.logger?.warn({ reason }, '🔴 预算熔断器触发！ASR 服务已暂停，新请求将被拒绝');
      // 立即持久化
      this.persistToDisk();
    }
  }

  /**
   * 将用量数据持久化到磁盘
   */
  private persistToDisk(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: PersistedData = {
        daily: this.daily,
        monthly: this.monthly,
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger?.error({ err }, '持久化用量数据失败');
    }
  }

  /**
   * 从磁盘恢复用量数据
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;

      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedData;

      const today = this.getTodayString();
      const thisMonth = this.getMonthString();

      // 仅恢复当日/当月的数据
      if (data.daily?.period === today) {
        this.daily = data.daily;
      }
      if (data.monthly?.period === thisMonth) {
        this.monthly = data.monthly;
      }

      // 恢复后检查是否应处于熔断状态
      this.checkTripThreshold();
    } catch {
      // 文件损坏则忽略，从零开始
    }
  }

  private getTodayString(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private getMonthString(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  /**
   * 销毁定时器
   */
  public destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    // 最后一次持久化
    if (this.dirty) {
      this.persistToDisk();
    }
  }
}
