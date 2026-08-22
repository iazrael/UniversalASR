/**
 * Universal ASR 客户端 SDK (浏览器原生 ES Module 版，供 script 标签直接引入)
 * 支持麦克风音频采集、实时 16kHz 下采样、PCM 封装、WebSocket 流式推流与事件派发
 *
 * 与 src/client/universal-client.ts 功能保持一致（TS 版为零依赖单文件，
 * 可直接复制进项目）；修改鉴权/音频逻辑时两处需同步。
 */
export class UniversalClient {
  constructor() {
    this.ws = null;
    this.state = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | RECORDING | STOPPING
    this.listeners = new Map();

    // 音频处理相关
    this.audioContext = null;
    this.mediaStream = null;
    this.audioInputNode = null;
    this.processorNode = null;
    this.analyserNode = null;
    this.animFrameId = null;

    this.currentSessionId = '';
    this.currentProvider = '';

    const events = ['stateChange', 'started', 'transcript', 'completed', 'error', 'volume'];
    events.forEach((evt) => this.listeners.set(evt, new Set()));
  }

  on(event, fn) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).add(fn);
    }
    return this;
  }

  off(event, fn) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(fn);
    }
    return this;
  }

  emit(event, ...args) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((fn) => {
        try {
          fn(...args);
        } catch (e) {
          console.error(`Error in event listener for "${event}":`, e);
        }
      });
    }
  }

  setState(nextState) {
    if (this.state !== nextState) {
      this.state = nextState;
      this.emit('stateChange', nextState);
    }
  }

  getState() {
    return this.state;
  }

  /**
   * 启动录音并建立 ASR 会话
   *
   * 鉴权默认走 Ticket 通道：先用 options.token（API Key）POST /v1/ticket 领取
   * 一次性短时效 Ticket，再用 ?ticket= 握手，长期 Key 不会暴露在 WS URL 中。
   * options.auth = 'token' 可回退静态 Token 直连；options.ticket 可传入已领的 Ticket。
   */
  async start(options = {}) {
    if (this.state === 'RECORDING' || this.state === 'CONNECTING') {
      console.warn('当前已在录音或连接中');
      return;
    }

    this.setState('CONNECTING');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const defaultWsUrl = `${protocol}//${window.location.host}/v1/asr`;
    const baseWsUrl = options.serverUrl || defaultWsUrl;

    try {
      // 1. 初始化麦克风（可能阻塞等待用户授权，须在领票之前完成，
      //    避免 Ticket 60s 有效期在权限弹窗期间耗尽）
      await this.initMicrophone();

      // 2. 鉴权并构造握手 URL
      const wsUrl = await this.buildAuthedWsUrl(baseWsUrl, options);

      // 3. 连接 WebSocket
      await this.connectWebSocket(wsUrl);

      // 4. 发送 start 信令
      const startMsg = {
        action: 'start',
        provider: options.provider || 'omlx',
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
    } catch (err) {
      this.emit('error', { message: err.message || '启动录音或连接失败' });
      this.destroy();
    }
  }

  /**
   * 停止录音并收尾
   */
  async stop() {
    if (this.state !== 'RECORDING' && this.state !== 'CONNECTING') {
      return;
    }

    this.setState('STOPPING');
    this.stopMicrophone();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendWsJson({ action: 'stop' });
    } else {
      this.destroy();
    }
  }

  /**
   * 根据鉴权方式构造带凭证的 WS 握手 URL
   * - ticket 模式（默认）：先 POST /v1/ticket 领一次性 Ticket，再拼 ?ticket=
   * - token 模式：直接拼 ?token=（静态直连，适用于受信/调试环境）
   */
  async buildAuthedWsUrl(baseWsUrl, options) {
    let credential;

    if (options.ticket) {
      // 外部已领票（如页面加载时预领），直接使用
      credential = `ticket=${encodeURIComponent(options.ticket)}`;
    } else if ((options.auth || 'ticket') === 'ticket') {
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
  async fetchTicket(baseWsUrl, token) {
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
  resolveHttpBaseUrl(baseWsUrl) {
    const httpUrl = baseWsUrl.replace(/^ws/, 'http'); // ws://→http://, wss://→https://
    try {
      return new URL(httpUrl).origin;
    } catch {
      return httpUrl.replace(/\/v1\/asr.*$/, '').replace(/\/+$/, '');
    }
  }

  /**
   * 初始化麦克风采集与 16kHz 下采样
   */
  async initMicrophone() {
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error('浏览器不支持录音 API，请确保使用 HTTPS 或 Localhost 访问');
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.audioInputNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // 频谱与音量分析
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.audioInputNode.connect(this.analyserNode);
    this.startVolumeMonitoring();

    // 采样处理 (Buffer 4096)
    const bufferSize = 4096;
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    const inputSampleRate = this.audioContext.sampleRate;
    const targetSampleRate = 16000;

    this.processorNode.onaudioprocess = (e) => {
      if (this.state !== 'RECORDING') return;

      const inputData = e.inputBuffer.getChannelData(0);
      const downsampled = this.downsampleTo16k(inputData, inputSampleRate, targetSampleRate);
      const pcm16 = this.floatTo16BitPCM(downsampled);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(pcm16);
      }
    };

    this.audioInputNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
  }

  stopMicrophone() {
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

  startVolumeMonitoring() {
    if (!this.analyserNode) return;
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

    const monitor = () => {
      if (!this.analyserNode || this.state !== 'RECORDING') {
        this.emit('volume', 0);
        return;
      }

      this.analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      const normalized = Math.min(1.0, avg / 128.0);
      this.emit('volume', normalized);

      this.animFrameId = requestAnimationFrame(monitor);
    };

    this.animFrameId = requestAnimationFrame(monitor);
  }

  downsampleTo16k(buffer, inputSampleRate, targetSampleRate = 16000) {
    if (inputSampleRate === targetSampleRate) return buffer;
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

  floatTo16BitPCM(input) {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  connectWebSocket(wsUrl) {
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
          const msg = JSON.parse(event.data);
          this.handleServerMessage(msg);
        } catch (e) {
          console.warn('收到非 JSON 消息:', event.data);
        }
      };

      this.ws.onerror = (err) => {
        this.emit('error', { message: 'WebSocket 连接出现错误' });
      };

      this.ws.onclose = () => {
        if (this.state !== 'DISCONNECTED') {
          this.destroy();
        }
      };
    });
  }

  handleServerMessage(msg) {
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

  sendWsJson(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  destroy() {
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
