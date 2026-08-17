import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { BaseASRProvider, ProviderStartConfig, ProviderCompletedPayload } from '../base.provider.js';
import { config } from '../../config/index.js';

export interface DashScopeProviderOptions {
  apiKey?: string;
  workspaceId?: string;
  model?: string;
  wsUrl?: string;
}

export class DashScopeParaformerProvider extends BaseASRProvider {
  public readonly name = 'aliyun-dashscope';

  private ws: WebSocket | null = null;
  private taskId: string = '';
  private apiKey: string;
  private workspaceId: string;
  private model: string;
  private wsUrl: string;

  private isStarted = false;
  private isDestroyed = false;
  private audioBufferQueue: Buffer[] = [];
  private lastRecordedDurationMs: number = 0;

  constructor(options?: DashScopeProviderOptions) {
    super();
    this.apiKey = options?.apiKey || config.DASHSCOPE_API_KEY;
    this.workspaceId = options?.workspaceId || config.DASHSCOPE_WORKSPACE_ID;
    this.model = options?.model || config.DASHSCOPE_MODEL;
    
    // 如果配置了专属 Workspace ID 且使用的是默认公用 URL，自动使用北京专属加速域名
    if (this.workspaceId && config.DASHSCOPE_WS_URL === 'wss://dashscope.aliyuncs.com/api-ws/v1/inference') {
      this.wsUrl = `wss://${this.workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
    } else {
      this.wsUrl = options?.wsUrl || config.DASHSCOPE_WS_URL;
    }
  }

  /**
   * 启动与百炼 DashScope 的实时流式会话
   */
  public async start(startConfig: ProviderStartConfig): Promise<void> {
    if (!this.apiKey) {
      throw new Error('DASHSCOPE_API_KEY 未配置，请在环境变量或配置文件中设置');
    }

    // 官方规范要求 task_id 必须为标准 UUID 格式
    this.taskId = uuidv4();
    this.isStarted = false;
    this.isDestroyed = false;
    this.audioBufferQueue = [];
    this.lastRecordedDurationMs = 0;

    return new Promise((resolve, reject) => {
      let isResolved = false;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'user-agent': 'universal-asr-service/1.0.0',
      };

      if (this.workspaceId) {
        headers['X-DashScope-WorkSpace'] = this.workspaceId;
      }

      try {
        this.ws = new WebSocket(this.wsUrl, { headers });
      } catch (err) {
        return reject(err);
      }

      this.ws.on('open', () => {
        const sampleRate = startConfig.audioFormat.sample_rate || 16000;
        let format = (startConfig.audioFormat.codec || 'pcm').toLowerCase();

        // 构造官方标准的 run-task 请求帧
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
            input: {},
            parameters: {
              format,
              sample_rate: sampleRate,
              vocabulary_id: startConfig.options?.vocabulary_id,
              disfluency_removal_enabled: startConfig.options?.disfluency_removal ?? false,
              language_hints: startConfig.options?.language ? [startConfig.options.language] : undefined,
              semantic_punctuation_enabled: startConfig.options?.semantic_punctuation,
              max_sentence_silence: startConfig.options?.max_sentence_silence,
              multi_threshold_mode_enabled: startConfig.options?.multi_threshold_mode,
              punctuation_prediction_enabled: startConfig.options?.punctuation ?? true,
              inverse_text_normalization_enabled: startConfig.options?.inverse_text_normalization ?? true,
              ...(startConfig.options?.custom_params || {}),
            },
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
              // 冲刷握手期间缓存的音频数据帧
              this.flushQueuedAudio();
              break;

            case 'result-generated': {
              const sentence = data?.payload?.output?.sentence;
              if (!sentence) break;

              // 忽略内部心跳包
              if (sentence.heartbeat === true) break;

              const isFinal = Boolean(sentence.sentence_end);

              // 提取计费时长
              if (typeof data?.payload?.usage?.duration === 'number') {
                this.lastRecordedDurationMs = data.payload.usage.duration * 1000;
              }

              this.emit('transcript', {
                text: sentence.text || '',
                is_final: isFinal,
                begin_time: sentence.begin_time,
                end_time: sentence.end_time,
                emo_tag: sentence.emo_tag,
                emo_confidence: sentence.emo_confidence,
                words: sentence.words?.map((w: any) => ({
                  text: w.text,
                  begin_time: w.begin_time,
                  end_time: w.end_time,
                  punctuation: w.punctuation || '',
                })),
              });
              break;
            }

            case 'task-finished': {
              const durationSec = data?.payload?.usage?.duration;
              const durationMs =
                typeof durationSec === 'number'
                  ? durationSec * 1000
                  : this.lastRecordedDurationMs || undefined;

              const payload: ProviderCompletedPayload = {
                durationMs,
                raw: data,
              };
              this.emit('completed', payload);
              this.destroy();
              break;
            }

            case 'task-failed': {
              const errorCode = data?.header?.error_code || 'UNKNOWN_ERROR';
              const errorMsg = data?.header?.error_message || 'DashScope task failed';
              const error = new Error(`DashScope ASR Error: [${errorCode}] ${errorMsg}`);
              
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
        } catch {
          // 忽略非标准 JSON 解析错误
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
      // 若 DashScope 还未返回 task-started，先入队缓冲以防首包音频丢失
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
   * 通知 DashScope 结束会话
   */
  public async stop(): Promise<void> {
    if (this.isDestroyed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

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
   * 彻底销毁连接与清理资源
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
