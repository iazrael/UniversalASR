import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { BaseASRProvider, ProviderStartConfig, ProviderCompletedPayload } from '../base.provider.js';
import { config } from '../../config/index.js';

export interface DashScopeProviderOptions {
  apiKey?: string;
  model?: string;
  wsUrl?: string;
}

export class DashScopeParaformerProvider extends BaseASRProvider {
  public readonly name = 'aliyun-dashscope';

  private ws: WebSocket | null = null;
  private taskId: string = '';
  private apiKey: string;
  private model: string;
  private wsUrl: string;

  private isStarted = false;
  private isDestroyed = false;
  private audioBufferQueue: Buffer[] = [];

  constructor(options?: DashScopeProviderOptions) {
    super();
    this.apiKey = options?.apiKey || config.DASHSCOPE_API_KEY;
    this.model = options?.model || config.DASHSCOPE_MODEL;
    this.wsUrl = options?.wsUrl || config.DASHSCOPE_WS_URL;
  }

  /**
   * 启动与百炼 DashScope 的实时流式会话
   */
  public async start(startConfig: ProviderStartConfig): Promise<void> {
    if (!this.apiKey) {
      throw new Error('DASHSCOPE_API_KEY 未配置，请在环境变量或启动参数中设置');
    }

    this.taskId = uuidv4().replace(/-/g, '');
    this.isStarted = false;
    this.isDestroyed = false;
    this.audioBufferQueue = [];

    return new Promise((resolve, reject) => {
      let isResolved = false;

      try {
        this.ws = new WebSocket(this.wsUrl, {
          headers: {
            Authorization: `bearer ${this.apiKey}`,
            'X-DashScope-DataInspection': 'enable',
          },
        });
      } catch (err) {
        return reject(err);
      }

      this.ws.on('open', () => {
        // 连接建立后，向 DashScope 发送 run-task 控制指令
        const sampleRate = startConfig.audioFormat.sample_rate || 16000;
        let format = startConfig.audioFormat.codec.toLowerCase();
        if (format === 'pcm') format = 'pcm';

        const runTaskMessage = {
          header: {
            action: 'run-task',
            task_id: this.taskId,
            streaming: 'duplex',
          },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: this.model,
            parameters: {
              format,
              sample_rate: sampleRate,
              vocabulary_id: startConfig.options?.vocabulary_id,
              disfluency_removal_enabled: startConfig.options?.disfluency_removal ?? false,
              language_hints: startConfig.options?.language ? [startConfig.options.language] : undefined,
              ...(startConfig.options?.custom_params || {}),
            },
            input: {},
          },
        };

        this.ws?.send(JSON.stringify(runTaskMessage));
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString());
          const event = data?.header?.event;

          switch (event) {
            case 'task-started':
              this.isStarted = true;
              if (!isResolved) {
                isResolved = true;
                resolve();
              }
              this.emit('ready');
              // 冲刷在 task-started 之前接收到的缓存音频分片
              this.flushQueuedAudio();
              break;

            case 'result-generated': {
              const sentence = data?.payload?.output?.sentence;
              if (sentence) {
                this.emit('transcript', {
                  text: sentence.text || '',
                  is_final: Boolean(sentence.fixed),
                  sentence_id: sentence.sentence_id,
                  begin_time: sentence.begin_time,
                  end_time: sentence.end_time,
                  words: sentence.words?.map((w: any) => ({
                    text: w.text,
                    begin_time: w.begin_time,
                    end_time: w.end_time,
                  })),
                });
              }
              break;
            }

            case 'task-finished': {
              const durationSec = data?.payload?.usage?.duration;
              const payload: ProviderCompletedPayload = {
                durationMs: typeof durationSec === 'number' ? durationSec * 1000 : undefined,
                raw: data,
              };
              this.emit('completed', payload);
              this.destroy();
              break;
            }

            case 'task-failed': {
              const errorMsg = data?.header?.error_message || 'DashScope task failed';
              const error = new Error(`DashScope ASR Error: [${data?.header?.error_code || 'UNKNOWN'}] ${errorMsg}`);
              if (!isResolved) {
                isResolved = true;
                reject(error);
              }
              this.emit('error', error);
              this.destroy();
              break;
            }

            default:
              break;
          }
        } catch (parseErr) {
          // 忽略非 JSON 异常
        }
      });

      this.ws.on('error', (err: Error) => {
        if (!isResolved) {
          isResolved = true;
          reject(err);
        }
        this.emit('error', err);
      });

      this.ws.on('close', () => {
        this.emit('close');
      });
    });
  }

  /**
   * 发送音频二进制分片
   */
  public sendAudio(chunk: Buffer): void {
    if (this.isDestroyed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this.isStarted) {
      // 若 DashScope 还未返回 task-started，先缓存音频避免首包丢失
      this.audioBufferQueue.push(chunk);
      return;
    }

    this.ws.send(chunk);
  }

  /**
   * 冲刷缓存队列
   */
  private flushQueuedAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.audioBufferQueue.length > 0) {
      const chunk = this.audioBufferQueue.shift();
      if (chunk) {
        this.ws.send(chunk);
      }
    }
  }

  /**
   * 通知 DashScope 完成识别
   */
  public async stop(): Promise<void> {
    if (this.isDestroyed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // 先冲刷完毕
    this.flushQueuedAudio();

    const finishMessage = {
      header: {
        action: 'finish-task',
        task_id: this.taskId,
        streaming: 'duplex',
      },
      payload: {
        input: {},
      },
    };

    this.ws.send(JSON.stringify(finishMessage));
  }

  /**
   * 销毁连接与清理
   */
  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.audioBufferQueue = [];

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
