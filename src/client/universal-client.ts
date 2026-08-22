import {
  AudioFormat,
  ASROptions,
  C2SStartMessage,
  C2SStopMessage,
  S2CMessage,
  TranscriptResultPayload,
} from '../types/protocol.js';

export type ClientState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECORDING' | 'STOPPING';

/** 鉴权方式：ticket（默认）= 先领一次性短时效 Ticket 再握手；token = 静态 Token 直连 */
export type ClientAuthMode = 'ticket' | 'token';

export interface ClientStartOptions {
  serverUrl?: string;
  /** 鉴权方式，默认 'ticket'（先 POST /v1/ticket 领票，再 ?ticket= 握手） */
  auth?: ClientAuthMode;
  /** API Key：ticket 模式下用于领取 Ticket；token 模式下直接用于 WS 握手 */
  token?: string;
  /** 已签发的一次性 Ticket，传入后跳过领票步骤直接握手 */
  ticket?: string;
  provider?: string;
  language?: string;
  maxSentenceSilence?: number;
  enableVad?: boolean;
  vadEnergyThreshold?: number;
  customParams?: Record<string, any>;
}

export type EventCallbackMap = {
  stateChange: (state: ClientState) => void;
  started: (data: { sessionId: string; provider: string }) => void;
  transcript: (result: TranscriptResultPayload) => void;
  completed: (data: { sessionId: string; durationMs?: number }) => void;
  error: (err: { code?: number; message: string }) => void;
  volume: (level: number) => void; // 0.0 ~ 1.0 音量大小
};

/**
 * Universal ASR 跨平台客户端 SDK (支持浏览器麦克风录音与 WebSocket 实时流式传输)
 */
export class UniversalClient {
  private ws: WebSocket | null = null;
  private state: ClientState = 'DISCONNECTED';
  private listeners: Map<keyof EventCallbackMap, Set<Function>> = new Map();

  // Web Audio 录音与采样相关
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioInputNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private animFrameId: number | null = null;

  private currentSessionId: string = '';
  private currentProvider: string = '';

  constructor() {
    // 初始化事件池
    const events: (keyof EventCallbackMap)[] = [
      'stateChange',
      'started',
      'transcript',
      'completed',
      'error',
      'volume',
    ];
    events.forEach((evt) => this.listeners.set(evt, new Set()));
  }

  public on<K extends keyof EventCallbackMap>(event: K, fn: EventCallbackMap[K]): this {
    this.listeners.get(event)?.add(fn);
    return this;
  }

  public off<K extends keyof EventCallbackMap>(event: K, fn: EventCallbackMap[K]): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  private emit<K extends keyof EventCallbackMap>(event: K, ...args: Parameters<EventCallbackMap[K]>): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((fn) => {
        try {
          (fn as any)(...args);
        } catch (e) {
          console.error(`Error in event listener for "${event}":`, e);
        }
      });
    }
  }

  private setState(nextState: ClientState): void {
    if (this.state !== nextState) {
      this.state = nextState;
      this.emit('stateChange', nextState);
    }
  }

  public getState(): ClientState {
    return this.state;
  }

  /**
   * 开始录音并启动 ASR 会话
   */
  public async start(options: ClientStartOptions = {}): Promise<void> {
    if (this.state === 'RECORDING' || this.state === 'CONNECTING') {
      console.warn('当前已处于连接或录音中，忽略重复启动');
      return;
    }

    this.setState('CONNECTING');

    const defaultWsUrl =
      typeof window !== 'undefined'
        ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/v1/asr`
        : 'ws://127.0.0.1:8080/v1/asr';

    const baseWsUrl = options.serverUrl || defaultWsUrl;

    try {
      // 1. 初始化并请求浏览器麦克风权限（可能阻塞等待用户确认，须在领票之前完成，
      //    避免 Ticket 60s 有效期在权限弹窗期间耗尽）
      await this.initMicrophone();

      // 2. 鉴权：默认走 Ticket 通道（一次性短时效 Ticket，避免长期 API Key 暴露在 WS URL 中）
      const wsUrl = await this.buildAuthedWsUrl(baseWsUrl, options);

      // 3. 连接 WebSocket
      await this.connectWebSocket(wsUrl);

      // 4. 发送 start 控制指令
      const provider = options.provider || 'omlx';
      const startMsg: C2SStartMessage = {
        action: 'start',
        provider,
        audio_format: {
          codec: 'pcm',
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
        },
        options: {
          language: options.language || 'zh',
          intermediate_results: true,
          punctuation: true,
          max_sentence_silence: options.maxSentenceSilence ?? 600,
          custom_params: {
            enable_vad: options.enableVad ?? true,
            vad_energy_threshold: options.vadEnergyThreshold ?? -38,
            ...(options.customParams || {}),
          },
        },
      };

      this.sendWsJson(startMsg);
    } catch (err: any) {
      this.emit('error', { message: err.message || '启动录音或连接失败' });
      this.destroy();
    }
  }

  /**
   * 停止录音并等待最终转写完成
   */
  public async stop(): Promise<void> {
    if (this.state !== 'RECORDING' && this.state !== 'CONNECTING') {
      return;
    }

    this.setState('STOPPING');

    // 停止麦克风采集
    this.stopMicrophone();

    // 向服务端发送 stop 指令
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const stopMsg: C2SStopMessage = { action: 'stop' };
      this.sendWsJson(stopMsg);
    } else {
      this.destroy();
    }
  }

  /**
   * 根据鉴权方式构造带凭证的 WS 握手 URL
   * - ticket 模式（默认）：先 POST /v1/ticket 领一次性 Ticket，再拼 ?ticket=
   * - token 模式：直接拼 ?token=（静态直连，适用于受信/调试环境）
   */
  private async buildAuthedWsUrl(baseWsUrl: string, options: ClientStartOptions): Promise<string> {
    let credential: string;

    if (options.ticket) {
      // 外部已领票（如页面加载时预领），直接使用
      credential = `ticket=${encodeURIComponent(options.ticket)}`;
    } else if ((options.auth ?? 'ticket') === 'ticket') {
      const token = options.token || 'default-client-token';
      const { ticket } = await this.fetchTicket(baseWsUrl, token);
      credential = `ticket=${encodeURIComponent(ticket)}`;
    } else {
      const token = options.token || 'default-client-token';
      credential = `token=${encodeURIComponent(token)}`;
    }

    return baseWsUrl.includes('?') ? `${baseWsUrl}&${credential}` : `${baseWsUrl}?${credential}`;
  }

  /**
   * 调用 POST /v1/ticket 领取一次性短时效 Ticket（API Key 走 Authorization 头，不进 URL）
   */
  private async fetchTicket(
    baseWsUrl: string,
    token: string
  ): Promise<{ ticket: string; expiresIn: number }> {
    const res = await fetch(`${this.resolveHttpBaseUrl(baseWsUrl)}/v1/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        data?.message ||
          `Ticket 签发失败 (HTTP ${res.status})，请检查 API Key 是否有效；旧版本服务可用 auth: 'token' 直连`
      );
    }
    if (!data?.ticket) {
      throw new Error('Ticket 签发响应格式异常：缺少 ticket 字段');
    }
    return data;
  }

  /**
   * 从 WS 端点地址推导 Ticket 签发的 HTTP 基础地址（ws→http / wss→https，取 origin）
   */
  private resolveHttpBaseUrl(baseWsUrl: string): string {
    const httpUrl = baseWsUrl.replace(/^ws/, 'http'); // ws://→http://, wss://→https://
    try {
      return new URL(httpUrl).origin;
    } catch {
      return httpUrl.replace(/\/v1\/asr.*$/, '').replace(/\/+$/, '');
    }
  }

  /**
   * 初始化麦克风与 Web Audio 上下文
   */
  private async initMicrophone(): Promise<void> {
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持 getUserMedia 麦克风录音，请使用 HTTPS 或 Localhost');
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.audioInputNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // 录音音量分析节点 (用于可视化)
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.audioInputNode.connect(this.analyserNode);
    this.startVolumeMonitoring();

    // 音频重采样分片处理器 (缓冲区大小: 4096)
    const bufferSize = 4096;
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    const inputSampleRate = this.audioContext.sampleRate;
    const targetSampleRate = 16000;

    this.processorNode.onaudioprocess = (e) => {
      if (this.state !== 'RECORDING') return;

      const inputData = e.inputBuffer.getChannelData(0);
      // 下采样到 16kHz
      const downsampledBuffer = this.downsampleTo16k(inputData, inputSampleRate, targetSampleRate);
      // 转换为 16-bit Signed Integer PCM
      const pcm16Buffer = this.floatTo16BitPCM(downsampledBuffer);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(pcm16Buffer);
      }
    };

    this.audioInputNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
  }

  /**
   * 停止麦克风与释放 AudioContext
   */
  private stopMicrophone(): void {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }

    if (this.audioInputNode) {
      this.audioInputNode.disconnect();
      this.audioInputNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext.close().catch(() => {});
      }
      this.audioContext = null;
    }

    this.emit('volume', 0);
  }

  /**
   * 监听麦克风音量大小用于动效
   */
  private startVolumeMonitoring(): void {
    if (!this.analyserNode) return;
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

    const checkVolume = () => {
      if (!this.analyserNode || this.state !== 'RECORDING') {
        this.emit('volume', 0);
        return;
      }

      this.analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      const normalizedVolume = Math.min(1.0, average / 128.0);
      this.emit('volume', normalizedVolume);

      this.animFrameId = requestAnimationFrame(checkVolume);
    };

    this.animFrameId = requestAnimationFrame(checkVolume);
  }

  /**
   * 将任意采样率的 Float32 音频线性插值重采样为 16kHz
   */
  private downsampleTo16k(
    buffer: Float32Array,
    inputSampleRate: number,
    targetSampleRate: number = 16000
  ): Float32Array {
    if (inputSampleRate === targetSampleRate) {
      return buffer;
    }
    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  /**
   * Float32Array (-1.0 ~ 1.0) 转 16-bit PCM (ArrayBuffer)
   */
  private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); // Little-Endian
    }
    return buffer;
  }

  /**
   * 连接 WebSocket
   */
  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';
      } catch (err) {
        return reject(err);
      }

      this.ws.onopen = () => {
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as S2CMessage;
          this.handleServerMessage(msg);
        } catch (e) {
          console.warn('收到非 JSON 消息:', event.data);
        }
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket 出错:', err);
        this.emit('error', { message: 'WebSocket 连接异常' });
      };

      this.ws.onclose = (event) => {
        if (this.state !== 'DISCONNECTED') {
          this.destroy();
        }
      };
    });
  }

  /**
   * 处理服务端下发事件
   */
  private handleServerMessage(msg: S2CMessage): void {
    switch (msg.event) {
      case 'started':
        this.currentSessionId = msg.session_id;
        this.currentProvider = msg.provider;
        this.setState('RECORDING');
        this.emit('started', {
          sessionId: msg.session_id,
          provider: msg.provider,
        });
        break;

      case 'transcription':
        this.emit('transcript', msg.result);
        break;

      case 'completed':
        this.emit('completed', {
          sessionId: msg.session_id,
          durationMs: msg.usage?.duration_ms,
        });
        this.destroy();
        break;

      case 'error':
        this.emit('error', {
          code: msg.code,
          message: msg.message,
        });
        this.destroy();
        break;

      case 'pong':
        break;
    }
  }

  /**
   * 发送 JSON 消息给服务端
   */
  private sendWsJson(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * 销毁并彻底重置
   */
  public destroy(): void {
    this.stopMicrophone();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.setState('DISCONNECTED');
  }
}
