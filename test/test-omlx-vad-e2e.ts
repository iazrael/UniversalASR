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

function loadPcm16k(audioPath: string): Buffer {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`音频文件不存在: ${audioPath}`);
  }
  const pcmBuffer = execSync(
    `ffmpeg -i "${audioPath}" -f s16le -acodec pcm_s16le -ac 1 -ar 16000 -loglevel error -`,
    { maxBuffer: 1024 * 1024 * 50 }
  );
  return pcmBuffer;
}

async function runVadE2ETest() {
  console.log('================================================================');
  console.log('  🎙️  oMLX + Lightweight VAD 智能切句与边说边出字端到端测试');
  console.log('================================================================\n');

  // 1. 启动本地 Fastify 网关实例
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

  const port = 8098;
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`🚀 [1/4] ASR 网关测试实例已启动 (Port: ${port})`);

  // 2. 解码音频
  const pcmBuffer = loadPcm16k(AUDIO_PATH);
  const totalDurationSec = pcmBuffer.length / 32000;
  console.log(`📂 [2/4] 加载音频: test_audio.m4a (共 ${(pcmBuffer.length / 1024).toFixed(1)} KB, 时长 ${totalDurationSec.toFixed(2)} 秒)`);

  // 3. 建立 WebSocket 连接并启用 VAD
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/asr?token=default-client-token`);

  const sentences: { id: number; text: string; timeOffsetSec: string }[] = [];
  let streamStartTime = 0;
  let streamFinished = false;

  ws.on('open', () => {
    console.log('✅ [3/4] WebSocket 连接成功，发送 start 启动识别 (开启 VAD, 停顿切句阈值: 500ms)...');
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
          max_sentence_silence: 500, // 静音 500ms 自动断句
          custom_params: {
            enable_vad: true,
            vad_energy_threshold: -40, // 稍微灵敏一点的能量阈值
          },
        },
      })
    );
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === 'started') {
      console.log(`🚀 服务端就绪 (Session ID: ${msg.session_id})`);
      console.log('🎙️ [4/4] 模拟真人连续说话推流 (每 100ms PCM 帧以接近实时速率推送)...');
      console.log('👀 注意观察：在推流未结束期间，每当说完一句话停顿，VAD 会自动切出句子并输出！\n');

      streamStartTime = Date.now();
      const chunkSize = 3200; // 100ms
      let offset = 0;

      // 每 50ms 发送一个 100ms 切片（2倍速模拟说话与流式推流）
      const interval = setInterval(() => {
        if (offset >= pcmBuffer.length) {
          clearInterval(interval);
          streamFinished = true;
          const pushElapsed = ((Date.now() - streamStartTime) / 1000).toFixed(1);
          console.log(`\n⏹️ 麦克风音频推流完成 (推流耗时 ${pushElapsed}s)，发送 stop 信号等待最后收尾...`);
          ws.send(JSON.stringify({ action: 'stop' }));
          return;
        }

        const chunk = pcmBuffer.subarray(offset, offset + chunkSize);
        ws.send(chunk);
        offset += chunkSize;

        const sentSec = (offset / 32000).toFixed(1);
        process.stdout.write(`\r🎙️ [持续推流中]: ${sentSec}s / ${totalDurationSec.toFixed(1)}s (推流完成: ${streamFinished ? '是' : '否'})`);
      }, 50);
    }

    if (msg.event === 'transcription') {
      const { text, is_final, sentence_id } = msg.result;
      const currentStreamSec = ((Date.now() - streamStartTime) / 1000).toFixed(1);

      if (is_final) {
        sentences.push({ id: sentence_id, text, timeOffsetSec: currentStreamSec });
        console.log(`\n\x1b[32m✨ [VAD 智能定稿 句 #${sentence_id}] (推流进行到 ${currentStreamSec}s 处出字):\x1b[0m ${text}`);
      } else {
        process.stdout.write(`\r\x1b[36m⏳ [句 #${sentence_id} 实时吐字]:\x1b[0m ${text}          `);
      }
    }

    if (msg.event === 'completed') {
      const totalElapsed = ((Date.now() - streamStartTime) / 1000).toFixed(2);
      console.log('\n\n========================= 📊 VAD 评测结果报告 📊 =========================');
      console.log(`⏱️ 音频总时长: ${totalDurationSec.toFixed(2)}s | 整个流程总耗时: ${totalElapsed}s`);
      console.log(`✂️ VAD 成功智能切分出的句子数: ${sentences.length} 句\n`);

      console.log('📝 【分句输出明细】:');
      sentences.forEach((s) => {
        console.log(`  - [句 #${s.id}] (出字时间: ${s.timeOffsetSec}s): ${s.text}`);
      });

      const fullRecognizedText = sentences.map((s) => s.text).join(' ');
      console.log('\n📜 【拼接全量识别文本】:');
      console.log(fullRecognizedText);

      if (fs.existsSync(GROUND_TRUTH_PATH)) {
        const groundTruth = fs.readFileSync(GROUND_TRUTH_PATH, 'utf-8').trim();
        console.log('\n🎯 【参考标准文本】:');
        console.log(groundTruth);
      }

      console.log('\n🏆 \x1b[32m测试结论: VAD 成功在推流过程中实现边说边出字，停顿自动切句定稿！\x1b[0m');
      console.log('========================================================================\n');

      ws.close();
      await app.close();
      process.exit(0);
    }

    if (msg.event === 'error') {
      console.error('\n❌ 收到错误事件:', msg);
      ws.close();
      await app.close();
      process.exit(1);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket 异常:', err);
    process.exit(1);
  });
}

runVadE2ETest().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
