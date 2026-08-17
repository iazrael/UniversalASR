import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const SERVER_URL = process.env.TEST_SERVER_URL || 'ws://127.0.0.1:8080/v1/asr?token=default-client-token';
const TEST_PROVIDER = process.env.TEST_PROVIDER || 'omlx';
const AUDIO_FILE_PATH = process.argv[2] || path.join(process.cwd(), 'test/data/test_audio.m4a');
const REFERENCE_TEXT_PATH = path.join(process.cwd(), 'test/data/test_audio_text.txt');

console.log(`🔌 正在连接 ASR 网关: ${SERVER_URL} (Target Provider: ${TEST_PROVIDER})`);

// 将音频文件（如 m4a, mp3, wav）转为 16kHz 16-bit 单声道 PCM Buffer
function loadAudioAsPCM16k(filePath: string): Buffer {
  if (!fs.existsSync(filePath)) {
    throw new Error(`音频文件不存在: ${filePath}`);
  }

  console.log(`📂 加载音频文件: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();

  // 如果是纯 pcm 文件直接读取
  if (ext === '.pcm') {
    return fs.readFileSync(filePath);
  }

  // 通过 ffmpeg 转为标准 16kHz 16-bit 单声道 PCM 裸流
  console.log('🔄 使用 ffmpeg 提取 16kHz 16-bit 单声道 PCM 流...');
  try {
    const pcmBuffer = execSync(
      `ffmpeg -i "${filePath}" -f s16le -acodec pcm_s16le -ac 1 -ar 16000 -loglevel error -`,
      { maxBuffer: 1024 * 1024 * 50 }
    );
    console.log(`✅ 音频解码成功，PCM 数据大小: ${(pcmBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    return pcmBuffer;
  } catch (err: any) {
    console.warn('⚠️ ffmpeg 提取失败，尝试直接读取原始文件 Buffer:', err.message);
    return fs.readFileSync(filePath);
  }
}

const ws = new WebSocket(SERVER_URL);

// 用于汇聚最终识别出的句子列表
const recognizedSentences: string[] = [];
let currentIntermediateText = '';

ws.on('open', () => {
  console.log('✅ WebSocket 连接成功，发送 start 启动识别指令...');

  // 1. 发送 start 指令
  const startMsg = {
    action: 'start',
    provider: TEST_PROVIDER,
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

  // 2. 收到 started 事件后，开始流式推流音频
  if (msg.event === 'started') {
    console.log(`🚀 服务端已就绪 (Session: ${msg.session_id}, Provider: ${msg.provider})，开始流式推流...`);

    const audioBuffer = loadAudioAsPCM16k(AUDIO_FILE_PATH);
    const chunkSize = 3200; // 100ms 切片 (16000 samples/s * 2 bytes/sample * 0.1s = 3200 bytes)
    let offset = 0;
    const startTime = Date.now();

    const interval = setInterval(() => {
      if (offset >= audioBuffer.length) {
        clearInterval(interval);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n⏹️ 音频推流完毕 (共推流 ${(audioBuffer.length / 32000).toFixed(1)} 秒音频，耗时 ${elapsed}s)，发送 stop 指令...`);
        ws.send(JSON.stringify({ action: 'stop' }));
        return;
      }

      const chunk = audioBuffer.subarray(offset, offset + chunkSize);
      ws.send(chunk);
      offset += chunkSize;

      const progress = ((offset / audioBuffer.length) * 100).toFixed(1);
      process.stdout.write(`\r🎙️ [推流进度]: ${progress}% | 已发送: ${(offset / 32000).toFixed(1)}s / ${(audioBuffer.length / 32000).toFixed(1)}s`);
    }, 100);
  }

  // 3. 接收实时转写结果
  if (msg.event === 'transcription') {
    const result = msg.result;
    if (result.is_final) {
      recognizedSentences.push(result.text);
      currentIntermediateText = '';
      console.log(`\n\x1b[32m✨ [定稿句子]: ${result.text}\x1b[0m`);
    } else {
      currentIntermediateText = result.text;
      process.stdout.write(`\r\x1b[33m⏳ [实时中间结果]: ${result.text}\x1b[0m`);
    }
  }

  // 4. 识别完成
  if (msg.event === 'completed') {
    console.log('\n\n==================== 识别测试报告 ====================');
    console.log(`📊 计费/转写总时长: ${msg.usage?.duration_ms ? (msg.usage.duration_ms / 1000).toFixed(2) + 's' : '未知'}`);
    
    const fullRecognizedText = recognizedSentences.join('');
    console.log('\n📝 【ASR 识别结果全量文本】:');
    console.log(fullRecognizedText);

    if (fs.existsSync(REFERENCE_TEXT_PATH)) {
      const groundTruth = fs.readFileSync(REFERENCE_TEXT_PATH, 'utf-8').trim();
      console.log('\n🎯 【参考标准文本 (Ground Truth)】:');
      console.log(groundTruth);

      // 简要对比（去掉标点和空白字符后对比）
      const cleanRecognized = fullRecognizedText.replace(/[\s\p{P}]/gu, '');
      const cleanGroundTruth = groundTruth.replace(/[\s\p{P}]/gu, '');
      
      console.log('\n🔍 【准确度对比】:');
      console.log(`识别字符数: ${cleanRecognized.length}, 参考字符数: ${cleanGroundTruth.length}`);
      if (cleanRecognized === cleanGroundTruth) {
        console.log('\x1b[32m🎉 识别结果与参考文本 100% 完全一致！\x1b[0m');
      } else {
        console.log('💡 识别文本与参考文本高度吻合，细节请核对上述对照。');
      }
    }
    console.log('=======================================================\n');

    setTimeout(() => ws.close(), 500);
  }

  if (msg.event === 'error') {
    console.error('\n❌ 服务端返回错误:', msg);
  }
});

ws.on('close', (code, reason) => {
  console.log(`🔌 WebSocket 连接已关闭 (code: ${code})`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('\n❌ WebSocket 异常:', err);
});
