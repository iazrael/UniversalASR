import { BaseASRProvider, ProviderStartConfig } from '../base.provider.js';
import { config } from '../../config/index.js';
import { LightweightVAD } from '../../core/vad.js';
import WebSocket from 'ws';

export interface OmlxProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
  prompt?: string;
  preferRealtimeWs?: boolean; // 是否优先尝试 WebSocket 实时模式
}

/**
 * 将 16-bit PCM 二进制 Buffer 包装为标准 WAV 格式文件 Buffer
 */
export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number = 16000,
  channels: number = 1,
  bitDepth: number = 16
): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataLength = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataLength);

  // RIFF 标识符
  buffer.write('RIFF', 0);
  // RIFF chunk 大小 = 整个文件大小 - 8 (即 36 + dataLength)
  buffer.writeUInt32LE(36 + dataLength, 4);
  // WAVE 标识符
  buffer.write('WAVE', 8);
  // fmt 子 chunk 标识符
  buffer.write('fmt ', 12);
  // fmt 子 chunk 大小 (对于 PCM 为 16)
  buffer.writeUInt32LE(16, 16);
  // 音频格式 (1 为 PCM)
  buffer.writeUInt16LE(1, 20);
  // 声道数
  buffer.writeUInt16LE(channels, 22);
  // 采样率
  buffer.writeUInt32LE(sampleRate, 24);
  // 字节率 (Byte Rate)
  buffer.writeUInt32LE(byteRate, 28);
  // 块对齐 (Block Align)
  buffer.writeUInt16LE(blockAlign, 32);
  // 位深 (Bits per sample)
  buffer.writeUInt16LE(bitDepth, 34);
  // data 子 chunk 标识符
  buffer.write('data', 36);
  // data 子 chunk 大小
  buffer.writeUInt32LE(dataLength, 40);
  // 写入 PCM 原始数据
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

export class OmlxASRProvider extends BaseASRProvider {
  public readonly name = 'omlx-asr';

  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private preferRealtimeWs: boolean;

  private startConfig: ProviderStartConfig | null = null;
  private isDestroyed = false;
  private isStarted = false;
  private totalAudioBytes = 0;

  // VAD 智能断句引擎
  private vad: LightweightVAD | null = null;
  private sentenceIndex = 1;
  private pendingTranscriptions: Set<Promise<void>> = new Set();

  // 如果禁用 VAD，回退到全量音频缓存
  private enableVad: boolean = true;
  private rawAudioChunks: Buffer[] = [];

  // 如果启用 WebSocket realtime
  private ws: WebSocket | null = null;
  private isUsingRealtimeWs = false;

  constructor(options?: OmlxProviderOptions) {
    super();
    // 规避 http 301 重定向导致 fetch 自动剥离 Authorization Header 的问题
    let base = options?.baseUrl || config.OMLX_BASE_URL;
    if (base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
      base = base.replace('http://', 'https://');
    }
    this.baseUrl = base.replace(/\/+$/, '');
    this.apiKey = options?.apiKey || config.OMLX_API_KEY;
    this.model = options?.model || config.OMLX_MODEL;
    this.preferRealtimeWs = options?.preferRealtimeWs ?? false;
  }

  /**
   * 启动 ASR 会话
   */
  public async start(startConfig: ProviderStartConfig): Promise<void> {
    this.startConfig = startConfig;
    this.isDestroyed = false;
    this.isStarted = false;
    this.totalAudioBytes = 0;
    this.sentenceIndex = 1;
    this.pendingTranscriptions.clear();
    this.rawAudioChunks = [];

    // 判断是否启用 VAD 智能切句（默认开启）
    this.enableVad = startConfig.options?.custom_params?.enable_vad ?? true;

    // 如果配置指定了优先尝试 WebSocket Realtime (如配合 Whisper/Voxtral)
    if (this.preferRealtimeWs) {
      try {
        await this.startRealtimeWs(startConfig);
        return;
      } catch (err: any) {
        // 如果后端提示不支持 realtime（如 Qwen3-ASR），平滑降级为 VAD / SSE 转写
        this.isUsingRealtimeWs = false;
      }
    }

    // 初始化轻量级 VAD 引擎
    if (this.enableVad) {
      const sampleRate = startConfig.audioFormat.sample_rate || 16000;
      // 客户端 options 中 max_sentence_silence (默认 600ms)
      const silenceMs = startConfig.options?.max_sentence_silence ?? 600;
      const silenceEndFrames = Math.max(10, Math.round(silenceMs / 20));
      const energyThresholdDb = startConfig.options?.custom_params?.vad_energy_threshold ?? -38;

      this.vad = new LightweightVAD(
        {
          sampleRate,
          frameSizeMs: 20,
          energyThresholdDb,
          speechStartFrames: 5,
          silenceEndFrames,
          preSpeechMs: 200,
          maxSentenceMs: 15000,
        },
        {
          onSentenceEnd: (sentencePcm: Buffer, durationMs: number) => {
            this.handleVadSentenceEnd(sentencePcm, durationMs);
          },
          onSpeechStart: () => {
            // 可在此处触发 vad 说话开始通知
          },
        }
      );
    }

    this.isStarted = true;
    setTimeout(() => {
      if (!this.isDestroyed) {
        this.emit('ready');
      }
    }, 10);
  }

  // 异步句子转写队列 (保证单会话顺序执行与后端压力控制)
  private sentenceQueue: { sentenceId: number; wavBuffer: Buffer; durationMs: number }[] = [];
  private isProcessingQueue = false;
  private queueCompletionPromise: Promise<void> | null = null;
  private queueCompletionResolver: (() => void) | null = null;

  /**
   * 处理 VAD 切出的单句音频
   */
  private handleVadSentenceEnd(sentencePcm: Buffer, durationMs: number): void {
    if (this.isDestroyed || sentencePcm.length === 0) return;

    const sentenceId = this.sentenceIndex++;
    const sampleRate = this.startConfig?.audioFormat.sample_rate || 16000;
    const channels = this.startConfig?.audioFormat.channels || 1;
    const bitDepth = this.startConfig?.audioFormat.bit_depth || 16;

    const wavBuffer = pcmToWav(sentencePcm, sampleRate, channels, bitDepth);
    this.sentenceQueue.push({ sentenceId, wavBuffer, durationMs });
    this.triggerProcessQueue();
  }

  /**
   * 触发队列处理
   */
  private triggerProcessQueue(): void {
    if (this.isProcessingQueue || this.sentenceQueue.length === 0) return;
    this.isProcessingQueue = true;

    (async () => {
      while (this.sentenceQueue.length > 0 && !this.isDestroyed) {
        const item = this.sentenceQueue.shift();
        if (!item) break;

        // 尝试执行，失败时进行一次自动重试
        let retry = 2;
        while (retry > 0 && !this.isDestroyed) {
          try {
            await this.transcribeSentenceSSE(item.wavBuffer, item.sentenceId, item.durationMs);
            break;
          } catch (err: any) {
            retry--;
            if (retry === 0) {
              this.emit('error', err);
            } else {
              // 稍候 300ms 重试
              await new Promise((r) => setTimeout(r, 300));
            }
          }
        }
      }

      this.isProcessingQueue = false;
      if (this.sentenceQueue.length === 0 && this.queueCompletionResolver) {
        this.queueCompletionResolver();
        this.queueCompletionResolver = null;
      }
    })();
  }

  /**
   * 启动 WebSocket 实时双向流
   */
  private async startRealtimeWs(startConfig: ProviderStartConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/v1/audio/transcriptions/realtime';

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        return reject(err);
      }

      let isResolved = false;

      this.ws.on('open', () => {
        const startMsg = {
          type: 'start',
          model: this.model,
          api_key: this.apiKey,
          language: startConfig.options?.language,
        };
        this.ws?.send(JSON.stringify(startMsg));
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ready') {
            this.isUsingRealtimeWs = true;
            this.isStarted = true;
            if (!isResolved) {
              isResolved = true;
              resolve();
            }
            this.emit('ready');
          } else if (msg.type === 'transcript.delta') {
            this.emit('transcript', {
              text: msg.delta || '',
              is_final: false,
            });
          } else if (msg.type === 'transcript.done') {
            this.emit('transcript', {
              text: msg.text || '',
              is_final: true,
            });
            this.emit('completed', {
              durationMs: this.calculateAudioDurationMs(),
            });
          } else if (msg.type === 'error') {
            const err = new Error(msg.detail || 'omlx realtime error');
            if (!isResolved) {
              isResolved = true;
              reject(err);
            } else {
              this.emit('error', err);
            }
          }
        } catch {
          // ignore
        }
      });

      this.ws.on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this.ws.on('close', () => {
        this.emit('close');
      });
    });
  }

  /**
   * 接收客户端推过来的音频切片 (PCM)
   */
  public sendAudio(chunk: Buffer): void {
    if (this.isDestroyed) return;

    this.totalAudioBytes += chunk.length;

    if (this.isUsingRealtimeWs && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
      return;
    }

    if (this.enableVad && this.vad) {
      // 送入 VAD 进行实时帧切分与状态迁移
      this.vad.processChunk(chunk);
    } else {
      this.rawAudioChunks.push(chunk);
    }
  }

  /**
   * 计算音频持续时长 (毫秒)
   */
  private calculateAudioDurationMs(): number {
    const sampleRate = this.startConfig?.audioFormat.sample_rate || 16000;
    const channels = this.startConfig?.audioFormat.channels || 1;
    const bitDepth = this.startConfig?.audioFormat.bit_depth || 16;
    const bytesPerSec = (sampleRate * channels * bitDepth) / 8;
    return bytesPerSec > 0 ? (this.totalAudioBytes / bytesPerSec) * 1000 : 0;
  }

  /**
   * 停止识别，冲刷未完结音频并等待全部句子转写完成
   */
  public async stop(): Promise<void> {
    if (this.isDestroyed) return;

    if (this.isUsingRealtimeWs && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      return;
    }

    if (this.enableVad && this.vad) {
      // 冲刷最后一句话
      this.vad.flush();
    } else if (this.rawAudioChunks.length > 0) {
      // 非 VAD 模式下，整段转写
      const rawPcm = Buffer.concat(this.rawAudioChunks);
      const sampleRate = this.startConfig?.audioFormat.sample_rate || 16000;
      const channels = this.startConfig?.audioFormat.channels || 1;
      const bitDepth = this.startConfig?.audioFormat.bit_depth || 16;
      const wavBuffer = pcmToWav(rawPcm, sampleRate, channels, bitDepth);
      this.sentenceQueue.push({ sentenceId: 1, wavBuffer, durationMs: this.calculateAudioDurationMs() });
      this.triggerProcessQueue();
    }

    // 等待所有队列中的句子转写请求全部完成
    if (this.sentenceQueue.length > 0 || this.isProcessingQueue) {
      await new Promise<void>((resolve) => {
        this.queueCompletionResolver = resolve;
      });
    }

    if (!this.isDestroyed) {
      this.emit('completed', {
        durationMs: this.calculateAudioDurationMs(),
      });
      this.destroy();
    }
  }

  /**
   * 发起单句 SSE 转写请求
   */
  private async transcribeSentenceSSE(
    wavBuffer: Buffer,
    sentenceId: number,
    durationMs: number
  ): Promise<void> {
    const endpoint = `${this.baseUrl}/v1/audio/transcriptions`;
    const formData = new FormData();
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });

    formData.append('file', blob, `sentence_${sentenceId}.wav`);
    formData.append('model', this.model);
    formData.append('stream', 'true');

    if (this.startConfig?.options?.language) {
      formData.append('language', this.startConfig.options.language);
    }

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OMLX ASR HTTP ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('未获得响应流 body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';
      let doneReceived = false;

      while (true) {
        if (this.isDestroyed) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const eventData = JSON.parse(jsonStr);

            if (eventData.type === 'transcript.text.delta') {
              accumulatedText += eventData.delta || '';
              this.emit('transcript', {
                sentence_id: sentenceId,
                text: accumulatedText,
                is_final: false,
              });
            } else if (eventData.type === 'transcript.text.done') {
              doneReceived = true;
              const finalText = eventData.text || accumulatedText;
              // 忽略纯空白无意义切片
              if (finalText.trim()) {
                this.emit('transcript', {
                  sentence_id: sentenceId,
                  text: finalText.trim(),
                  is_final: true,
                });
              }
            }
          } catch {
            // 忽略非 json 行
          }
        }
      }

      // 如果流结束但没有收到 transcript.text.done，发出最终定稿
      if (!doneReceived && !this.isDestroyed && accumulatedText.trim()) {
        this.emit('transcript', {
          sentence_id: sentenceId,
          text: accumulatedText.trim(),
          is_final: true,
        });
      }
    } catch (err: any) {
      if (!this.isDestroyed) {
        this.emit('error', err);
      }
    }
  }

  /**
   * 销毁实例
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.rawAudioChunks = [];
    this.sentenceQueue = [];
    this.isProcessingQueue = false;
    if (this.queueCompletionResolver) {
      this.queueCompletionResolver();
      this.queueCompletionResolver = null;
    }
    this.vad?.reset();
    this.vad = null;

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try {
          this.ws.close();
        } catch {
          // ignore
        }
      }
      this.ws = null;
    }
  }
}
