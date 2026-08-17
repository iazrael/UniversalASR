import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { AuthService } from '../src/auth/auth.service.js';
import { ASRSession } from '../src/core/session.js';
import { config } from '../src/config/index.js';

const AUDIO_PATH = path.join(process.cwd(), 'test/data/test_audio.m4a');
const GROUND_TRUTH_PATH = path.join(process.cwd(), 'test/data/test_audio_text.txt');

/**
 * 计算字准确率 (Character Error Rate & Accuracy)
 */
function calculateCER(recognized: string, reference: string) {
  const r = recognized.replace(/[\s\p{P}]/gu, '');
  const ref = reference.replace(/[\s\p{P}]/gu, '');

  const n = ref.length;
  const m = r.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === r[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // Deletion
          dp[i][j - 1] + 1,      // Insertion
          dp[i - 1][j - 1] + 1   // Substitution
        );
      }
    }
  }

  const distance = dp[n][m];
  const cer = n > 0 ? (distance / n) * 100 : 0;
  const accuracy = Math.max(0, 100 - cer);
  return { distance, totalChars: n, cer, accuracy, cleanRec: r, cleanRef: ref };
}

/**
 * 使用 ffmpeg 将音频文件转换为 16kHz 16-bit 单声道 PCM 裸流
 */
function loadPcm16k(audioPath: string): Buffer {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`音频文件不存在: ${audioPath}`);
  }
  console.log(`📂 加载音频文件: ${audioPath}`);
  console.log('🔄 使用 ffmpeg 提取 16kHz 16-bit 单声道 PCM 裸流...');
  const pcmBuffer = execSync(
    `ffmpeg -i "${audioPath}" -f s16le -acodec pcm_s16le -ac 1 -ar 16000 -loglevel error -`,
    { maxBuffer: 1024 * 1024 * 50 }
  );
  return pcmBuffer;
}

async function runTest() {
  console.log('===============================================================');
  console.log('  🎙️  oMLX ASR (Qwen3-ASR-1.7B-8bit) 全量音频识别端到端测试');
  console.log('===============================================================\n');

  // 1. 启动本地 Fastify ASR 实例
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: '*' });
  await app.register(websocket);

  const activeSessions = new Map<string, ASRSession>();
  app.get('/v1/asr', { websocket: true }, (socket, req) => {
    const token = AuthService.extractTokenFromRequest(req);
    if (!AuthService.isValidToken(token)) {
      socket.close(4001, 'Unauthorized');
      return;
    }
    const session = new ASRSession(socket, app.log);
    activeSessions.set(session.id, session);
    socket.on('close', () => activeSessions.delete(session.id));
  });

  const testPort = 8099;
  await app.listen({ port: testPort, host: '127.0.0.1' });
  console.log(`🚀 [1/4] ASR 网关测试实例就绪 (Port: ${testPort})`);
  console.log(`🎯 [配置] oMLX Base URL: ${config.OMLX_BASE_URL} | Model: ${config.OMLX_MODEL}`);

  // 2. 解码音频
  const pcmBuffer = loadPcm16k(AUDIO_PATH);
  const audioDurationSec = pcmBuffer.length / 32000;
  console.log(`✅ [2/4] 音频解码完成: PCM 大小 ${(pcmBuffer.length / 1024).toFixed(1)} KB (时长: ${audioDurationSec.toFixed(2)} 秒)`);

  // 3. 连接 WebSocket
  const wsUrl = `ws://127.0.0.1:${testPort}/v1/asr?token=default-client-token`;
  console.log(`🔌 [3/4] 正在连接 WebSocket: ${wsUrl}`);
  const ws = new WebSocket(wsUrl);

  const recognizedSentences: string[] = [];
  let intermediateCount = 0;
  let streamStartTime = 0;
  let streamEndTime = 0;
  let recognitionStartTime = 0;

  ws.on('open', () => {
    console.log('✅ WebSocket 握手成功，发送 start 启动指令 (provider: omlx)...');
    ws.send(
      JSON.stringify({
        action: 'start',
        provider: 'omlx',
        audio_format: {
          codec: 'pcm',
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
        },
        options: {
          language: 'zh',
        },
      })
    );
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === 'started') {
      console.log(`🚀 服务端已就绪 (Session ID: ${msg.session_id}, Provider: ${msg.provider})`);
      console.log('\n🎙️ [4/4] 开始模拟实时麦克风推流 (以 100ms 切片持续推流)...');
      
      streamStartTime = Date.now();
      const chunkSize = 3200; // 100ms
      let offset = 0;

      // 模拟每 25ms 快速推流一个 100ms 分块（加速测试推流过程）
      const interval = setInterval(() => {
        if (offset >= pcmBuffer.length) {
          clearInterval(interval);
          streamEndTime = Date.now();
          recognitionStartTime = Date.now();
          console.log(`\n⏹️ 音频推流完毕 (共推流 ${audioDurationSec.toFixed(2)}s 音频，推流耗时 ${((streamEndTime - streamStartTime) / 1000).toFixed(2)}s)`);
          console.log('⏳ 发送 stop 指令，等待 oMLX Qwen3-ASR 流式生成与定稿...\n');
          ws.send(JSON.stringify({ action: 'stop' }));
          return;
        }

        const chunk = pcmBuffer.subarray(offset, offset + chunkSize);
        ws.send(chunk);
        offset += chunkSize;

        const percent = ((offset / pcmBuffer.length) * 100).toFixed(1);
        process.stdout.write(`\r📡 [推流进度]: ${percent}% | 已推送: ${(offset / 32000).toFixed(1)}s / ${audioDurationSec.toFixed(1)}s`);
      }, 25);
    }

    if (msg.event === 'transcription') {
      if (msg.result.is_final) {
        recognizedSentences.push(msg.result.text);
        console.log(`\n\x1b[32m✨ [定稿文本]:\x1b[0m ${msg.result.text}`);
      } else {
        intermediateCount++;
        process.stdout.write(`\r\x1b[36m⏳ [增量流式中间结果 (#${intermediateCount})]:\x1b[0m ${msg.result.text}`);
      }
    }

    if (msg.event === 'completed') {
      const recognitionElapsedMs = Date.now() - recognitionStartTime;
      const totalElapsedMs = Date.now() - streamStartTime;
      const fullText = recognizedSentences.join('');

      console.log('\n\n========================= 📊 识别评测报告 📊 =========================');
      console.log(`⏱️ 音频实际时长: ${audioDurationSec.toFixed(2)} 秒 (${(audioDurationSec * 1000).toFixed(0)} ms)`);
      console.log(`⚡ 模型推理转写耗时: ${(recognitionElapsedMs / 1000).toFixed(2)} 秒 (${recognitionElapsedMs} ms)`);
      console.log(`🚀 实时率 (RTF): ${(recognitionElapsedMs / (audioDurationSec * 1000)).toFixed(3)} (越低越快，<1.0 即为快于实时)`);
      console.log(`🔄 接收到的流式增量更新次数: ${intermediateCount} 次`);

      console.log('\n📝 【oMLX Qwen3-ASR 识别结果】:');
      console.log(`\x1b[32m${fullText}\x1b[0m`);

      if (fs.existsSync(GROUND_TRUTH_PATH)) {
        const groundTruth = fs.readFileSync(GROUND_TRUTH_PATH, 'utf-8').trim();
        console.log('\n🎯 【参考标准文本 (Ground Truth)】:');
        console.log(`\x1b[33m${groundTruth}\x1b[0m`);

        const cerStats = calculateCER(fullText, groundTruth);
        console.log('\n📈 【精度评测 (CER)】:');
        console.log(`- 参考字符数: ${cerStats.totalChars}`);
        console.log(`- 编辑距离 (差错字符数): ${cerStats.distance}`);
        console.log(`- 字符准确率 (Accuracy): \x1b[32m${cerStats.accuracy.toFixed(2)}%\x1b[0m`);
        console.log(`- 字错率 (CER): ${cerStats.cer.toFixed(2)}%`);

        if (cerStats.accuracy >= 98) {
          console.log('\n🏆 \x1b[32m评测结论: 识别准确率极高 (≥98%)，完美契合标准文本！\x1b[0m');
        } else {
          console.log('\n💡 评测结论: 识别完成，请比对上述文本差异。');
        }
      }
      console.log('=====================================================================\n');

      ws.close();
      await app.close();
      process.exit(0);
    }

    if (msg.event === 'error') {
      console.error('\n❌ 识别过程中收到错误事件:', msg);
      ws.close();
      await app.close();
      process.exit(1);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket 连接出错:', err);
    process.exit(1);
  });
}

runTest().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
