# Universal Real-time ASR Service

通用实时语音识别（ASR）网关服务，基于 Node.js / Fastify / TypeScript 构建。

对外提供统一、标准的流式 WebSocket 接入协议，对内采用**适配器架构**无缝对接各主流云厂商 ASR 引擎。首发支持 **阿里云百炼（DashScope Paraformer-realtime-v2）**。

---

## 🌟 核心特性

- **统一客户端协议**：抹平不同云厂商（阿里云、腾讯云、火山引擎、Whisper）的协议差异，业务客户端只需对接一套 WS 协议。
- **高性能 & 低延迟**：基于 Fastify + `@fastify/websocket`，全双工流式转发音频与实时转写结果。
- **灵活鉴权**：支持基于 URL Query (`?token=xxx`)、HTTP Header (`Authorization: Bearer xxx`) 的 API Key 鉴权白名单机制。
- **会话容错与管理**：自动处理握手缓冲区（避免首包丢失）、心跳保活、空闲超时自动清理与优雅停机。
- **开箱即用**：自带模拟推流测试脚本，支持合成音或直接加载本地 wav/pcm 音频文件进行推流测试。

---

## 🚀 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

编辑 `.env`，填入你的阿里云百炼 API Key：

```env
PORT=8080
HOST=0.0.0.0

# 客户端接入 Token 白名单（英文逗号隔开，* 代表免鉴权开发模式）
AUTH_TOKENS=default-client-token,test-token-123

# 阿里云 DashScope 配置
# 前往获取: https://bailian.console.aliyun.com/
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DASHSCOPE_MODEL=paraformer-realtime-v2
```

### 3. 启动开发服务

```bash
npm run dev
```

服务启动后将监听：
- **健康检查**：`GET http://localhost:8080/health`
- **实时 ASR WebSocket**：`ws://localhost:8080/v1/asr?token=default-client-token`

---

## 🧪 测试验证

我们内置了自动化模拟推流客户端：

```bash
# 1. 使用内置合成音频测试（4秒测试音）
npm run test:client

# 2. 或传入本地真实的 WAV/PCM 音频文件测试
npm run test:client -- ./path/to/test.wav
```

---

## 📖 客户端 WebSocket 交互协议

### 1. 握手连接
```text
ws://<server_host>:<port>/v1/asr?token=<YOUR_TOKEN>
```
*也可以在 WebSocket 握手时通过 Header `Authorization: Bearer <YOUR_TOKEN>` 传递。*

### 2. 启动识别 (`start`)
连接建立后，客户端先发送一条 JSON 格式的 `start` 帧：
```json
{
  "action": "start",
  "provider": "aliyun",
  "audio_format": {
    "codec": "pcm",
    "sample_rate": 16000,
    "channels": 1,
    "bit_depth": 16
  },
  "options": {
    "language": "zh",
    "intermediate_results": true,
    "punctuation": true,
    "disfluency_removal": false
  }
}
```

### 3. 接收就绪响应 (`started`)
服务端确认 ASR 引擎已就绪：
```json
{
  "event": "started",
  "session_id": "848e4209-6447-4952-ba64-cf3607997ec9",
  "provider": "aliyun-dashscope"
}
```

### 4. 发送音频数据 (Binary Frame)
客户端收到 `started` 后，持续通过 WebSocket **二进制帧 (Binary Data)** 发送音频切片（建议每次发送 100ms ~ 200ms 的 PCM 数据）。

### 5. 接收实时转写结果 (`transcription`)
服务端将实时推送识别过程中的临时结果（`is_final: false`）与整句定稿结果（`is_final: true`）：
```json
{
  "event": "transcription",
  "session_id": "848e4209-6447-4952-ba64-cf3607997ec9",
  "result": {
    "text": "北京今天的天气怎么样",
    "is_final": true,
    "sentence_id": 1,
    "begin_time": 100,
    "end_time": 1820,
    "words": [
      { "text": "北京", "begin_time": 100, "end_time": 500 },
      { "text": "今天", "begin_time": 500, "end_time": 900 }
    ]
  }
}
```

### 6. 结束识别 (`stop`)
推流完毕后发送 `stop` 指令通知服务端收尾：
```json
{
  "action": "stop"
}
```

### 7. 识别完成 (`completed`)
```json
{
  "event": "completed",
  "session_id": "848e4209-6447-4952-ba64-cf3607997ec9",
  "usage": {
    "duration_ms": 3200
  }
}
```

---

## 🛠️ 项目目录结构

```text
asr-service/
├── docs/                     # 架构设计文档
│   └── architecture-design.md
├── src/
│   ├── config/               # 环境变量与配置校验 (Zod)
│   ├── auth/                 # 鉴权中间件与 Token 校验
│   ├── core/                 # 核心会话调度与协议编解码
│   │   └── session.ts        # WebSocket 与 ASR 管道 Session
│   ├── providers/            # 厂商适配器层
│   │   ├── base.provider.ts  # Provider 抽象基类
│   │   ├── factory.ts        # Provider 工厂类
│   │   └── aliyun/           # 阿里云百炼 Paraformer-v2 适配器
│   ├── types/                # 全局 TypeScript 协议定义
│   └── server.ts             # 服务启动入口
├── test/
│   └── mock-client.ts        # 模拟推流测试脚本
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 🔮 扩展其他厂商

若需接入腾讯云、火山引擎等新厂商：
1. 在 `src/providers/` 下继承 `BaseASRProvider` 实现对应的适配器类；
2. 在 `src/providers/factory.ts` 中注册厂商名称即可，客户端协议保持 100% 兼容。
