import { EventEmitter } from 'events';
import { AudioFormat, ASROptions, TranscriptResultPayload } from '../types/protocol.js';

export interface ProviderStartConfig {
  sessionId: string;
  audioFormat: AudioFormat;
  options?: ASROptions;
}

export interface ProviderCompletedPayload {
  durationMs?: number;
  raw?: any;
}

export declare interface BaseASRProvider {
  on(event: 'ready', listener: () => void): this;
  on(event: 'transcript', listener: (result: TranscriptResultPayload) => void): this;
  on(event: 'completed', listener: (payload: ProviderCompletedPayload) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;

  emit(event: 'ready'): boolean;
  emit(event: 'transcript', result: TranscriptResultPayload): boolean;
  emit(event: 'completed', payload: ProviderCompletedPayload): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'close'): boolean;
}

export abstract class BaseASRProvider extends EventEmitter {
  public abstract readonly name: string;

  /**
   * 初始化并启动与厂商 ASR 服务的流式会话
   */
  public abstract start(config: ProviderStartConfig): Promise<void>;

  /**
   * 向厂商 ASR 发送音频二进制数据块 (PCM/WAV/OPUS)
   */
  public abstract sendAudio(chunk: Buffer): void;

  /**
   * 通知厂商 ASR 会话结束，等待最终结果下发并关闭
   */
  public abstract stop(): Promise<void>;

  /**
   * 立即强行销毁连接并释放资源
   */
  public abstract destroy(): void;
}
