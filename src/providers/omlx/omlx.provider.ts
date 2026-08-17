import { BaseASRProvider, ProviderStartConfig } from '../base.provider.js';
import { config } from '../../config/index.js';
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
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;

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
    this.audioChunks = [];
    this.totalAudioBytes = 0;

    // 如果配置指定了优先尝试 WebSocket Realtime (如配合 Whisper/Voxtral)
    if (this.preferRealtimeWs) {
      try {
        await this.startRealtimeWs(startConfig);
        return;
      } catch (err: any) {
        // 如果后端提示不支持 realtime（如 Qwen3-ASR），平滑降级为音频缓冲与 SSE 转写
        this.isUsingRealtimeWs = false;
      }
    }

    // 默认模式：音频流缓冲并在 stop 时通过 SSE 流式转写下发
    this.isStarted = true;
    // 触发就绪事件，通知网关准备好接收音频
    setTimeout(() => {
      if (!this.isDestroyed) {
        this.emit('ready');
      }
    }, 10);
  }

  /**
   * 启动 WebSocket 实时双向流 (用于 Whisper / Voxtral 等原生支持推流的模型)
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

    if (this.isUsingRealtimeWs && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
      this.totalAudioBytes += chunk.length;
      return;
    }

    // 缓存 PCM 音频数据
    this.audioChunks.push(chunk);
    this.totalAudioBytes += chunk.length;
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
   * 停止识别，开始执行最终转写
   */
  public async stop(): Promise<void> {
    if (this.isDestroyed) return;

    if (this.isUsingRealtimeWs && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      return;
    }

    // 检查是否有音频数据
    if (this.audioChunks.length === 0) {
      this.emit('transcript', { text: '', is_final: true });
      this.emit('completed', { durationMs: 0 });
      return;
    }

    // 将收到的 PCM 拼接并封装为 WAV 格式
    const rawPcm = Buffer.concat(this.audioChunks);
    const sampleRate = this.startConfig?.audioFormat.sample_rate || 16000;
    const channels = this.startConfig?.audioFormat.channels || 1;
    const bitDepth = this.startConfig?.audioFormat.bit_depth || 16;

    let audioWavBuffer: Buffer;
    const codec = (this.startConfig?.audioFormat.codec || 'pcm').toLowerCase();

    if (codec === 'wav') {
      audioWavBuffer = rawPcm;
    } else {
      audioWavBuffer = pcmToWav(rawPcm, sampleRate, channels, bitDepth);
    }

    // 发起 HTTP /v1/audio/transcriptions 请求 (开启 stream=true 获得 SSE 逐词输出)
    await this.transcribeWithSSE(audioWavBuffer);
  }

  /**
   * 发起 SSE 转写请求
   */
  private async transcribeWithSSE(wavBuffer: Buffer): Promise<void> {
    const endpoint = `${this.baseUrl}/v1/audio/transcriptions`;
    const formData = new FormData();
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });

    formData.append('file', blob, 'recording.wav');
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
                text: accumulatedText,
                is_final: false,
              });
            } else if (eventData.type === 'transcript.text.done') {
              doneReceived = true;
              const finalText = eventData.text || accumulatedText;
              this.emit('transcript', {
                text: finalText,
                is_final: true,
              });
              this.emit('completed', {
                durationMs: this.calculateAudioDurationMs(),
                raw: eventData,
              });
            }
          } catch {
            // 忽略非 json 行
          }
        }
      }

      // 如果流结束但没有收到 transcript.text.done，发出最终结果
      if (!doneReceived && !this.isDestroyed) {
        if (accumulatedText) {
          this.emit('transcript', {
            text: accumulatedText,
            is_final: true,
          });
        }
        this.emit('completed', {
          durationMs: this.calculateAudioDurationMs(),
        });
      }
    } catch (err: any) {
      if (!this.isDestroyed) {
        this.emit('error', err);
      }
    } finally {
      this.destroy();
    }
  }

  /**
   * 销毁实例
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.audioChunks = [];

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
