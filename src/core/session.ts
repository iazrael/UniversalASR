import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { FastifyBaseLogger } from 'fastify';
import {
  C2SMessage,
  S2CMessage,
  ASRErrorCode,
  AudioFormat,
} from '../types/protocol.js';
import { BaseASRProvider } from '../providers/base.provider.js';
import { ASRProviderFactory } from '../providers/factory.js';
import { config } from '../config/index.js';

export type SessionState = 'INITIAL' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'CLOSED';

export class ASRSession {
  public readonly id: string;
  private ws: WebSocket;
  private logger: FastifyBaseLogger;
  private state: SessionState = 'INITIAL';

  private provider: BaseASRProvider | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private utteranceTimer: NodeJS.Timeout | null = null;

  /** 外部注入的用量上报回调（由 server.ts 注入，用于预算熔断器计数） */
  public onUsageReport: ((durationMs: number) => void) | null = null;

  constructor(ws: WebSocket, logger: FastifyBaseLogger, customSessionId?: string) {
    this.id = customSessionId || uuidv4();
    this.ws = ws;
    this.logger = logger.child({ sessionId: this.id });

    this.initWebSocketListeners();
    this.resetIdleTimer();

    // 设置会话总最大时长保护
    this.maxDurationTimer = setTimeout(() => {
      this.logger.warn('会话达到最大时长限制，强制关闭');
      this.sendError(ASRErrorCode.SESSION_TIMEOUT, '会话达到最大时长限制');
      this.destroy();
    }, config.SESSION_MAX_DURATION_MS);
  }

  /**
   * 初始化客户端 WebSocket 事件监听
   */
  private initWebSocketListeners(): void {
    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.resetIdleTimer();

      if (isBinary) {
        this.handleBinaryMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
      } else {
        this.handleTextMessage(data.toString());
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.info({ code, reason: reason.toString() }, '客户端 WebSocket 连接已断开');
      this.destroy();
    });

    this.ws.on('error', (err) => {
      this.logger.error({ err }, '客户端 WebSocket 发生异常');
      this.destroy();
    });
  }

  /**
   * 处理文本指令消息 (JSON)
   */
  private async handleTextMessage(text: string): Promise<void> {
    try {
      const message = JSON.parse(text) as C2SMessage;

      switch (message.action) {
        case 'start':
          await this.handleStart(message);
          break;

        case 'stop':
          await this.handleStop();
          break;

        case 'ping':
          this.sendMessage({ event: 'pong' });
          break;

        default:
          this.sendError(
            ASRErrorCode.INVALID_MESSAGE,
            `未知 action: ${(message as any).action}`
          );
      }
    } catch (err: any) {
      this.logger.error({ err, raw: text }, '解析客户端消息失败');
      this.sendError(ASRErrorCode.INVALID_MESSAGE, `JSON 解析失败: ${err.message}`);
    }
  }

  /**
   * 处理开始识别指令
   */
  private async handleStart(msg: Extract<C2SMessage, { action: 'start' }>): Promise<void> {
    if (this.state !== 'INITIAL') {
      this.sendError(
        ASRErrorCode.INVALID_STATE,
        `当前状态 (${this.state}) 不允许执行 start，必须处于 INITIAL 状态`
      );
      return;
    }

    this.state = 'STARTING';

    const audioFormat: AudioFormat = {
      codec: msg.audio_format?.codec || 'pcm',
      sample_rate: msg.audio_format?.sample_rate || 16000,
      channels: msg.audio_format?.channels || 1,
      bit_depth: msg.audio_format?.bit_depth || 16,
    };

    try {
      this.provider = ASRProviderFactory.createProvider(msg.provider);

      // 绑定 Provider 标准事件
      this.provider.on('ready', () => {
        this.state = 'RUNNING';
        this.logger.info({ provider: this.provider?.name }, 'ASR 厂商已就绪');
        this.sendMessage({
          event: 'started',
          session_id: this.id,
          provider: this.provider?.name || 'unknown',
        });

        // 启动单次识别硬截断定时器
        this.clearUtteranceTimer();
        this.utteranceTimer = setTimeout(() => {
          this.logger.warn(
            { maxMs: config.UTTERANCE_MAX_DURATION_MS },
            '单次识别达到最大时长限制，强制停止'
          );
          this.handleStop();
        }, config.UTTERANCE_MAX_DURATION_MS);
      });

      this.provider.on('transcript', (result) => {
        this.sendMessage({
          event: 'transcription',
          session_id: this.id,
          result,
        });
      });

      this.provider.on('completed', (payload) => {
        this.logger.info({ usage: payload }, 'ASR 转写完成');
        this.clearUtteranceTimer();
        this.sendMessage({
          event: 'completed',
          session_id: this.id,
          usage: payload.durationMs ? { duration_ms: payload.durationMs } : undefined,
        });
        // 上报用量给预算熔断器
        if (this.onUsageReport) {
          this.onUsageReport(payload.durationMs || 0);
        }
        this.state = 'INITIAL';
        this.cleanupProvider();
      });

      this.provider.on('error', (err) => {
        this.logger.error({ err }, 'ASR Provider 报错');
        this.clearUtteranceTimer();
        this.sendError(ASRErrorCode.VENDOR_ERROR, err.message);
        this.cleanupProvider();
        this.state = 'INITIAL';
      });

      await this.provider.start({
        sessionId: this.id,
        audioFormat,
        options: msg.options,
      });
    } catch (err: any) {
      this.logger.error({ err }, '启动 ASR 实例失败');
      this.sendError(ASRErrorCode.PROVIDER_INIT_FAILED, err.message || 'Provider 初始化失败');
      this.cleanupProvider();
      this.state = 'INITIAL';
    }
  }

  /**
   * 处理停止识别指令
   */
  private async handleStop(): Promise<void> {
    if (this.state !== 'RUNNING' && this.state !== 'STARTING') {
      this.logger.warn({ state: this.state }, '非识别状态收到 stop 指令，忽略');
      return;
    }

    this.state = 'STOPPING';
    this.logger.info('收到客户端 stop 指令，等待 ASR 厂商收尾');

    if (this.provider) {
      try {
        await this.provider.stop();
      } catch (err: any) {
        this.logger.error({ err }, 'ASR Provider 停止失败');
        this.sendError(ASRErrorCode.VENDOR_ERROR, err.message);
      }
    }
  }

  /**
   * 处理客户端发送的二进制音频切片
   */
  private handleBinaryMessage(chunk: Buffer): void {
    if (this.state !== 'RUNNING' && this.state !== 'STARTING') {
      // 未启动或已停止状态下推流，不打断连接但记录调试日志
      this.logger.debug({ state: this.state, size: chunk.length }, '非 RUNNING 状态接收到音频切片');
      return;
    }

    if (this.provider) {
      this.provider.sendAudio(chunk);
    }
  }

  /**
   * 重置空闲超时计时器
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.warn('会话长时间无任何活动，空闲超时释放');
      this.sendError(ASRErrorCode.SESSION_TIMEOUT, '会话空闲超时');
      this.destroy();
    }, config.SESSION_IDLE_TIMEOUT_MS);
  }

  /**
   * 发送下行 JSON 消息给客户端
   */
  public sendMessage(msg: S2CMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * 发送错误下行消息
   */
  public sendError(code: number, message: string): void {
    this.sendMessage({
      event: 'error',
      session_id: this.id,
      code,
      message,
    });
  }

  /**
   * 清理 Provider 资源
   */
  private cleanupProvider(): void {
    if (this.provider) {
      this.provider.removeAllListeners();
      this.provider.destroy();
      this.provider = null;
    }
  }

  /**
   * 清理单次识别截断定时器
   */
  private clearUtteranceTimer(): void {
    if (this.utteranceTimer) {
      clearTimeout(this.utteranceTimer);
      this.utteranceTimer = null;
    }
  }

  /**
   * 销毁会话与彻底清理
   */
  public destroy(): void {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.clearUtteranceTimer();
    this.cleanupProvider();

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(1000, 'Session Closed');
      } catch {
        // ignore
      }
    }
  }
}
