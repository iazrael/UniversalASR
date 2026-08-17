export interface VADConfig {
  sampleRate?: number;       // 音频采样率，默认 16000
  frameSizeMs?: number;      // 单帧时间窗大小 (ms)，默认 20ms
  energyThresholdDb?: number;// 能量门限 (dBFS)，默认 -38 dBFS
  speechStartFrames?: number;// 判定说话起始所需的连续发音帧数，默认 5 帧 (100ms)
  silenceEndFrames?: number; // 判定切句所需的连续静音帧数，默认 30 帧 (600ms)
  preSpeechMs?: number;      // 前置预缓冲时长 (ms)，默认 200ms
  maxSentenceMs?: number;    // 单句最长时长保护 (ms)，默认 15000ms
}

export type VADState = 'SILENCE' | 'SPEAKING';

export interface VADCallbacks {
  onSentenceEnd: (sentencePcm: Buffer, durationMs: number) => void;
  onSpeechStart?: () => void;
}

/**
 * 轻量级纯 TypeScript VAD (语音活动检测与智能切句状态机)
 */
export class LightweightVAD {
  private state: VADState = 'SILENCE';
  private preSpeechBuffer: Buffer[] = [];
  private currentSentenceChunks: Buffer[] = [];
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;

  private readonly sampleRate: number;
  private readonly frameSizeMs: number;
  private readonly frameByteSize: number;
  private readonly energyThresholdDb: number;
  private readonly speechStartFrames: number;
  private readonly silenceEndFrames: number;
  private readonly preSpeechMs: number;
  private readonly maxSentenceMs: number;

  constructor(
    config: VADConfig,
    private callbacks: VADCallbacks
  ) {
    this.sampleRate = config.sampleRate ?? 16000;
    this.frameSizeMs = config.frameSizeMs ?? 20;
    this.energyThresholdDb = config.energyThresholdDb ?? -38;
    this.speechStartFrames = config.speechStartFrames ?? 5;
    this.silenceEndFrames = config.silenceEndFrames ?? 30;
    this.preSpeechMs = config.preSpeechMs ?? 200;
    this.maxSentenceMs = config.maxSentenceMs ?? 15000;

    // 16-bit 单声道 PCM 每帧字节数: sampleRate * 2 bytes * frameSizeMs / 1000
    this.frameByteSize = (this.sampleRate * 2 * this.frameSizeMs) / 1000;
  }

  /**
   * 处理输入的 PCM 数据流分片
   */
  public processChunk(chunk: Buffer): void {
    for (let offset = 0; offset < chunk.length; offset += this.frameByteSize) {
      const frame = chunk.subarray(offset, Math.min(offset + this.frameByteSize, chunk.length));
      if (frame.length < this.frameByteSize) {
        // 不足一帧的尾部数据先忽略或暂存
        break;
      }

      const energyDb = this.calculateFrameEnergyDb(frame);
      const isSpeechFrame = energyDb > this.energyThresholdDb;

      if (this.state === 'SILENCE') {
        // 维持预缓冲环形队列
        this.preSpeechBuffer.push(frame);
        const maxPreFrames = Math.ceil(this.preSpeechMs / this.frameSizeMs);
        if (this.preSpeechBuffer.length > maxPreFrames) {
          this.preSpeechBuffer.shift();
        }

        if (isSpeechFrame) {
          this.consecutiveSpeechFrames++;
          if (this.consecutiveSpeechFrames >= this.speechStartFrames) {
            // 切换为说话状态
            this.state = 'SPEAKING';
            this.consecutiveSilenceFrames = 0;
            // 拼入前置缓冲，防止首字丢失
            this.currentSentenceChunks = [...this.preSpeechBuffer];
            this.preSpeechBuffer = [];
            this.callbacks.onSpeechStart?.();
          }
        } else {
          this.consecutiveSpeechFrames = 0;
        }
      } else if (this.state === 'SPEAKING') {
        this.currentSentenceChunks.push(frame);

        if (!isSpeechFrame) {
          this.consecutiveSilenceFrames++;
          if (this.consecutiveSilenceFrames >= this.silenceEndFrames) {
            // 静音时长达标，切句
            this.commitSentence();
          }
        } else {
          this.consecutiveSilenceFrames = 0;
        }

        // 超长单句强制截断保护
        const currentDurationMs = this.currentSentenceChunks.length * this.frameSizeMs;
        if (currentDurationMs >= this.maxSentenceMs) {
          this.commitSentence();
        }
      }
    }
  }

  /**
   * 外部发送 stop 或会话关闭时，冲刷并提交当前说话中未完成的音频
   */
  public flush(): void {
    if (this.state === 'SPEAKING' && this.currentSentenceChunks.length > 0) {
      this.commitSentence();
    }
  }

  /**
   * 重置状态机
   */
  public reset(): void {
    this.state = 'SILENCE';
    this.preSpeechBuffer = [];
    this.currentSentenceChunks = [];
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
  }

  /**
   * 提交当前句子
   */
  private commitSentence(): void {
    if (this.currentSentenceChunks.length > 0) {
      const completeSentencePcm = Buffer.concat(this.currentSentenceChunks);
      const durationMs = this.currentSentenceChunks.length * this.frameSizeMs;
      this.callbacks.onSentenceEnd(completeSentencePcm, durationMs);
    }
    this.state = 'SILENCE';
    this.currentSentenceChunks = [];
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
  }

  /**
   * 计算单帧 16-bit PCM 的 dBFS 能量
   */
  private calculateFrameEnergyDb(frame: Buffer): number {
    let sumSquares = 0;
    const numSamples = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / numSamples);
    // 归一化到 0~32768 并转为 dBFS (-96dB ~ 0dB)
    return 20 * Math.log10((rms + 1e-6) / 32768);
  }
}
