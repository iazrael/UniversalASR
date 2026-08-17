import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { AuthService } from '../src/auth/auth.service.js';
import { ASRSession } from '../src/core/session.js';
import { ASRProviderFactory } from '../src/providers/factory.js';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

async function main() {
  console.log('🏁 启动测试 Fastify 服务...');
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

  const port = 8089;
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`🚀 测试 ASR 服务已在端口 ${port} 启动`);

  // 客户端连接测试
  const pcmPath = path.join(process.cwd(), 'test/data/test_10s.pcm');
  if (!fs.existsSync(pcmPath)) {
    console.error('❌ PCM 测试文件不存在: ', pcmPath);
    process.exit(1);
  }
  const pcmBuffer = fs.readFileSync(pcmPath);
  console.log(`📂 加载测试 PCM 数据: ${pcmBuffer.length} bytes (~${(pcmBuffer.length / 32000).toFixed(1)}s)`);

  const clientWs = new WebSocket(`ws://127.0.0.1:${port}/v1/asr?token=default-client-token`);

  clientWs.on('open', () => {
    console.log('✅ 客户端 WebSocket 连接成功，发送 start 启动指令 (provider: omlx)...');
    clientWs.send(
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

  const receivedDeltas: string[] = [];
  let finalizedText = '';

  clientWs.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`📥 [S2C 消息] 事件: ${msg.event}`, msg.result ? `| 文本: "${msg.result.text}" (final: ${msg.result.is_final})` : '');

    if (msg.event === 'started') {
      console.log('🎙️ 服务端就绪，开始流式推送 PCM 数据切片 (模拟麦克风输入)...');
      const chunkSize = 3200; // 100ms
      for (let i = 0; i < pcmBuffer.length; i += chunkSize) {
        const chunk = pcmBuffer.subarray(i, i + chunkSize);
        clientWs.send(chunk);
        // 快速推送
        await new Promise((r) => setTimeout(r, 20));
      }
      console.log('⏹️ 音频切片推流完毕，发送 stop 指令...');
      clientWs.send(JSON.stringify({ action: 'stop' }));
    }

    if (msg.event === 'transcription') {
      if (msg.result.is_final) {
        finalizedText = msg.result.text;
      } else {
        receivedDeltas.push(msg.result.text);
      }
    }

    if (msg.event === 'completed') {
      console.log('\n🎉 [测试成功] ASR 流程顺利完成！');
      console.log('📝 最终转写文本:', finalizedText);
      console.log(`⏱️ 转写时长: ${msg.usage?.duration_ms}ms`);
      
      clientWs.close();
      await app.close();
      console.log('🏁 测试完成，服务正常退出。');
      process.exit(0);
    }

    if (msg.event === 'error') {
      console.error('❌ 收到错误事件:', msg);
      clientWs.close();
      await app.close();
      process.exit(1);
    }
  });

  clientWs.on('error', (err) => {
    console.error('❌ WebSocket 异常:', err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
