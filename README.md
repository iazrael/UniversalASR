# Universal Real-time ASR Service

通用实时语音识别（ASR）网关服务，基于 Node.js / Fastify / TypeScript 构建。

对外提供统一、标准的流式 WebSocket 接入协议，对内采用**适配器架构**无缝对接各主流云厂商与私有化部署 ASR 引擎。支持：
- **阿里云百炼**（DashScope Paraformer-realtime-v2）
- **本地私有化 oMLX ASR**（Qwen3-ASR、Whisper、Voxtral 等，支持 SSE 增量流式转写与 WebSocket 实时双向流）

---

## 🌟 核心特性

- **统一客户端协议**：抹平不同厂商与本地大模型（阿里云 DashScope、oMLX Qwen3-ASR、Whisper）的协议差异，业务客户端只需对接一套 WS 协议。
- **高性能 & 低延迟**：基于 Fastify + `@fastify/websocket`，全双工流式转发音频与实时转写结果。
- **灵活鉴权**：双通道鉴权——**短时效一次性 Ticket**（默认推荐：先 `POST /v1/ticket` 领票再用 `?ticket=xxx` 握手，长期 API Key 不暴露在 WS URL 中）+ 静态 API Key 直连（`?token=xxx` / `Authorization: Bearer xxx`，调试与受信环境）。
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

编辑 `.env`，按需配置提供商（阿里云 DashScope 或 本地 oMLX）：

```env
PORT=8080
HOST=0.0.0.0

# 客户端接入 Token 白名单（英文逗号隔开，* 代表免鉴权开发模式）
AUTH_TOKENS=default-client-token,test-token-123

# 默认 ASR 引擎 (aliyun / omlx / qwen3-asr)
DEFAULT_PROVIDER=omlx

# 1. 阿里云 DashScope 配置
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DASHSCOPE_WORKSPACE_ID=
DASHSCOPE_MODEL=paraformer-realtime-v2
DASHSCOPE_WS_URL=wss://dashscope.aliyuncs.com/api-ws/v1/inference

# 2. 本地私有化 oMLX ASR 配置 (Qwen3-ASR / Whisper 等)
OMLX_BASE_URL=https://omlx.com
OMLX_API_KEY=omlx-05yfs07frti3p4lz
OMLX_MODEL=Qwen3-ASR-1.7B-8bit
```

### 3. 启动服务

```bash
# 开发模式 (自动热重载)
npm run dev

# 生产模式
npm run build
npm start
```

服务启动后，在浏览器直接访问 **`http://localhost:8080`** 即可打开 **Web 实时语音识别控制台**（支持 PC 与手机移动端竖屏录音测试）。

服务启动后将监听：
- **健康检查**：`GET http://localhost:8080/health`
- **Ticket 签发**：`POST http://localhost:8080/v1/ticket`（Header 携带 `Authorization: Bearer <API_KEY>`，返回 60 秒有效的一次性 Ticket）
- **实时 ASR WebSocket**：`ws://localhost:8080/v1/asr?ticket=<TICKET>`（推荐）或 `?token=default-client-token`（调试直连）

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

### 1. 握手连接（鉴权）

**通道 A：短时效 Ticket（推荐，生产前端默认）**

先凭 API Key 领取一次性 Ticket（60 秒有效、单次使用，长期 Key 只出现在 HTTPS 请求头中）：

```bash
curl -X POST http://<server_host>:<port>/v1/ticket \
  -H "Authorization: Bearer <YOUR_API_KEY>"
# → { "ticket": "<32字符随机串>", "expiresIn": 60 }
```

再用 Ticket 建立 WebSocket 连接：

```text
ws://<server_host>:<port>/v1/asr?ticket=<TICKET>
```

Ticket 通道的请求链路经过完整的成本防护闸门（IP 限流 → 熔断检查 → Ticket 校验）。

**通道 B：静态 API Key 直连（调试 / 受信环境）**

```text
ws://<server_host>:<port>/v1/asr?token=<YOUR_TOKEN>
```
*也可以在 WebSocket 握手时通过 Header `Authorization: Bearer <YOUR_TOKEN>` 传递。静态 Token 通道绕过限流，适用于内部环境。*

**浏览器 SDK（UniversalClient）默认即走 Ticket 通道：**

```html
<script type="module">
  import { UniversalClient } from '/universal-client.js';

  const client = new UniversalClient();
  client.on('transcript', (r) => console.log(r.text, r.is_final));

  // 默认 auth:'ticket' —— SDK 自动先 POST /v1/ticket 领票（token 走 Authorization 头），
  // 再用 ?ticket= 握手；领票发生在麦克风授权之后，避免 Ticket 在权限弹窗期间过期
  await client.start({ token: '<YOUR_API_KEY>', provider: 'omlx', language: 'zh' });

  // 已在外部预领 Ticket 时可直接传入，跳过领票步骤
  // await client.start({ ticket: '<PRE_FETCHED_TICKET>', ... });

  // 调试/受信环境可显式回退静态 Token 直连
  // await client.start({ auth: 'token', token: '<YOUR_API_KEY>', ... });
</script>
```

### 2. 启动识别 (`start`)
连接建立后，客户端先发送一条 JSON 格式的 `start` 帧：
```json
{
  "action": "start",
  "provider": "omlx",
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
    "max_sentence_silence": 600,
    "custom_params": {
      "enable_vad": true,
      "vad_energy_threshold": -38,
      "vad_pre_speech_ms": 200,
      "vad_max_sentence_ms": 15000
    }
  }
}
```

#### ⚙️ ASR 与 VAD 参数详细说明

| 参数字段 | 类型 | 默认值 | 说明与推荐配置 |
| :--- | :--- | :--- | :--- |
| `provider` | `string` | `"aliyun"` | ASR 提供商：`"omlx"` / `"qwen3-asr"` / `"aliyun"` |
| `options.language` | `string` | `"zh"` | 识别语种，支持 `zh` (中文), `en` (英文), `ja`, `ko` 等 |
| `options.max_sentence_silence` | `number` | `600` | **VAD 停顿切句/拖尾阈值 (ms)**。用户停止说话后，持续静音达到此时间即自动切句转写定稿。推荐值：<br>• **实时交互/语音助手**：`400` ~ `600` ms<br>• **长演讲/会议记录**：`800` ~ `1200` ms |
| `options.custom_params.enable_vad` | `boolean` | `true` | 是否启用网关端轻量级 VAD 智能切句与边说边出字 |
| `options.custom_params.vad_energy_threshold` | `number` | `-38` | VAD 声音能量判定门限 (dBFS，范围 `-50` ~ `-25`)。数值越小越灵敏，数值越大越抗嘈杂环境底噪 |
| `options.custom_params.vad_pre_speech_ms` | `number` | `200` | **前置预缓冲时长 (ms)**。保留说话起始前 200ms 的音频，**彻底避免首辅音/爆破音被吞字** |
| `options.custom_params.vad_max_sentence_ms` | `number` | `15000` | 单句最大时长保护 (ms)，持续说话超过该时长时强制截断切句，防止长难句造成延迟堆积 |

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
