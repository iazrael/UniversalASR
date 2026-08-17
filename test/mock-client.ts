import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const SERVER_URL = process.env.TEST_SERVER_URL || 'ws://127.0.0.1:8080/v1/asr?token=default-client-token';
const AUDIO_FILE_PATH = process.argv[2]; // 可选传入本地 wav/pcm 音频文件路径

console.log(`🔌 正在连接 ASR 网关: ${SERVER_URL}`);

const ws = new WebSocket(SERVER_URL);

// 生成 100ms 的 16kHz 16bit 单声道 PCM 静音/模拟测试数据 (3200 字节)
function generateSilentPCM(durationSeconds = 3, sampleRate = 16000): Buffer {
  const bytesPerSample = 2; // 16bit = 2 bytes
  const totalSamples = sampleRate * durationSeconds;
  const buffer = Buffer.alloc(totalSamples * bytesPerSample);
  
  // 生成 440Hz 正弦波测试音（避免纯静音被 VAD 彻底忽略）
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 1000; // 较小音量
    buffer.writeInt16LE(Math.floor(sample), i * 2);
  }
  return buffer;
}

ws.on('open', () => {
  console.log('✅ WebSocket 连接成功，发送 start 启动识别指令...');

  // 1. 发送 start 指令
  const startMsg = {
    action: 'start',
    provider: 'aliyun',
    audio_format: {
      codec: 'pcm',
      sample_rate: 16000,
      channels: 1,
      bit_depth: 16,
    },
    options: {
      language: 'zh',
      intermediate_results: true,
      punctuation: true,
      disfluency_removal: false,
    },
  };

  ws.send(JSON.stringify(startMsg));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('📩 [收到服务端消息]:', JSON.stringify(msg, null, 2));

  // 2. 收到 started 事件后，开始流式推流
  if (msg.event === 'started') {
    console.log('🚀 服务端已就绪，开始流式推送音频数据...');

    let audioBuffer: Buffer;

    if (AUDIO_FILE_PATH && fs.existsSync(AUDIO_FILE_PATH)) {
      console.log(`📂 读取本地音频文件: ${AUDIO_FILE_PATH}`);
      audioBuffer = fs.readFileSync(AUDIO_FILE_PATH);
      // 如果是 wav 格式，跳过 44 字节头部
      if (AUDIO_FILE_PATH.endsWith('.wav') && audioBuffer.length > 44) {
        audioBuffer = audioBuffer.subarray(44);
      }
    } else {
      console.log('🎵 未指定音频文件，生成 4 秒合成测试音频推流...');
      audioBuffer = generateSilentPCM(4, 16000);
    }

    // 每次发送 100ms 音频块 (16000 * 2 * 0.1 = 3200 字节)
    const chunkSize = 3200;
    let offset = 0;

    const interval = setInterval(() => {
      if (offset >= audioBuffer.length) {
        clearInterval(interval);
        console.log('⏹️ 音频推流完毕，发送 stop 指令...');
        ws.send(JSON.stringify({ action: 'stop' }));
        return;
      }

      const chunk = audioBuffer.subarray(offset, offset + chunkSize);
      ws.send(chunk);
      offset += chunkSize;
    }, 100);
  }

  // 3. 识别完成或报错
  if (msg.event === 'completed') {
    console.log('🎉 识别流程完整结束！');
    setTimeout(() => ws.close(), 1000);
  }

  if (msg.event === 'error') {
    console.error('❌ 发生错误:', msg);
  }
});

ws.on('close', (code, reason) => {
  console.log(`🔌 连接关闭: code=${code}, reason=${reason.toString()}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('❌ WebSocket 异常:', err);
});
