# 通用实时 ASR 网关服务设计文档 (Universal Real-time ASR Gateway)

## 1. 概述与设计目标

本项目旨在构建一个基于 Node.js 的**通用实时 ASR（语音识别）网关服务**。通过统一的 WebSocket 协议对下游客户端提供标准化接口，对上游适配多个云厂商的 ASR 服务（如阿里云、腾讯云、火山引擎、开源 Whisper/FunASR 等），解耦业务客户端与具体底层 ASR 厂商。

### 核心目标
1. **统一协议**：对外暴露一致的流式 WebSocket 控制信令与音频传输协议。
2. **厂商解耦**：基于适配器模式，业务端无需关心具体 ASR 厂商协议细节，支持动态切换厂商。
3. **安全鉴权**：提供 API Key / Token 校验机制，保障接口访问安全与用量可控。
4. **低延迟与高并发**：流式全双工中继，最小化音频缓冲和转发时延。

---

## 2. 总体系统架构

```mermaid
flowchart TD
    subgraph ClientLayer [客户端接入层]
        Client1[Web 浏览器]
        Client2[移动端 App]
        Client3[后端业务服务 / IoT]
    end

    subgraph ASRGateway [Node.js ASR 统一网关服务]
        WSServer[WebSocket Ingress & 路由网关]
        AuthModule[鉴权与频控模块]
        SessionMgr[Session 会话管理器]
        
        subgraph AdapterLayer [Provider 适配器抽象层]
            BaseAdapter[BaseASRProvider 统一抽象接口]
            AliyunAdapter[阿里云 ASR 适配器 (NLS / DashScope)]
            TencentAdapter[腾讯云 ASR 适配器 (待扩展)]
            VolcAdapter[火山引擎 ASR 适配器 (待扩展)]
            WhisperAdapter[Whisper / FunASR 适配器 (待扩展)]
        end
    end

    subgraph VendorCloud [云厂商 ASR 服务]
        AliyunCloud[阿里云智能语音交互 / 百炼]
        TencentCloud[腾讯云 ASR]
        VolcCloud[火山引擎 ASR]
    end

    Client1 & Client2 & Client3 -- 1. WS 握手 (鉴权认证) --> WSServer
    WSServer --> AuthModule
    WSServer --> SessionMgr
    SessionMgr -- 2. 调度 ASR 实例 --> BaseAdapter
    BaseAdapter --> AliyunAdapter
    BaseAdapter -.-> TencentAdapter
    BaseAdapter -.-> VolcAdapter
    BaseAdapter -.-> WhisperAdapter
    AliyunAdapter <== 3. 双向流式转发 ==> AliyunCloud
    SessionMgr <== 4. 实时转写流推回 ==> Client1 & Client2 & Client3
```

---

## 3. 客户端 WebSocket 通信协议规范

协议原则：**控制信令采用 JSON 格式，实时音频数据采用二进制帧（Binary Frame）传输**。

### 3.1 握手与鉴权
- **URL 查询参数**：`ws://<host>:<port>/v1/asr?token=<YOUR_API_KEY>`
- **HTTP Header**：`Authorization: Bearer <YOUR_API_KEY>`
- **首包 JSON 鉴权**（兼容无法配置 Header 的客户端环境）。

### 3.2 客户端 -> 服务端（C2S）指令

#### (1) 启动识别会话 (`start`)
在建立连接并通过鉴权后，客户端发送 `start` 帧初始化识别会话：
```json
{
  "action": "start",
  "session_id": "req-uuid-123456",
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
    "vocabulary_id": "custom-dict-id",
    "custom_params": {
      "enable_vad": true,
      "vad_energy_threshold": -38,
      "vad_pre_speech_ms": 200,
      "vad_max_sentence_ms": 15000
    }
  }
}
```

##### 常用 Options 参数说明
- `max_sentence_silence` (number): **VAD 停顿切句/静音判定拖尾阈值 (ms)**。用户停止说话后，持续静音达到该阈值时自动触发切句定稿（默认 `600`，实时交互推荐 `400~600`，长语音推荐 `800~1200`）。
- `custom_params.enable_vad` (boolean): 是否开启网关轻量级 VAD 智能分句。
- `custom_params.vad_energy_threshold` (number): VAD 声音能量判定门限 (dBFS，默认 `-38`)。
- `custom_params.vad_pre_speech_ms` (number): 前置预缓冲时长 (ms，默认 `200`)，防止句首吞字。
- `custom_params.vad_max_sentence_ms` (number): 单句最长保护时长 (ms，默认 `15000`)。

#### (2) 发送音频分片 (Binary Frame)
- 客户端通过 WebSocket Binary Frame 持续发送音频切片（如 PCM 数据）。
- 建议发送频率：每 100ms ~ 200ms 发送一个数据块（16kHz/16bit/单声道对应 3.2KB ~ 6.4KB）。

#### (3) 停止识别 (`stop`)
音频推流结束时发送，通知服务端及厂商收尾并获取最终识别结果：
```json
{
  "action": "stop"
}
```

#### (4) 心跳保活 (`ping`)
```json
{
  "action": "ping"
}
```

---

### 3.3 服务端 -> 客户端（S2C）事件

#### (1) 识别就绪 (`started`)
```json
{
  "event": "started",
  "session_id": "req-uuid-123456"
}
```

#### (2) 实时转写结果 (`transcription`)
```json
{
  "event": "transcription",
  "session_id": "req-uuid-123456",
  "result": {
    "text": "今天天气怎么样",
    "is_final": false,
    "sentence_id": 1,
    "begin_time": 0,
    "end_time": 1280,
    "words": [
      {
        "word": "今天",
        "begin_time": 0,
        "end_time": 400
      }
    ]
  }
}
```

#### (3) 会话完成 (`completed`)
```json
{
  "event": "completed",
  "session_id": "req-uuid-123456"
}
```

#### (4) 异常错误 (`error`)
```json
{
  "event": "error",
  "session_id": "req-uuid-123456",
  "code": 40001,
  "message": "Vendor ASR connection timeout"
}
```

#### (5) 心跳响应 (`pong`)
```json
{
  "event": "pong"
}
```

---

## 4. Provider 适配器抽象层设计

### 4.1 统一接口与生命周期
通过 `EventEmitter` 实现标准事件流，确保各厂商实现逻辑隔离：

```typescript
export interface ASRStartOptions {
  codec: string;
  sampleRate: number;
  channels: number;
  language?: string;
  intermediateResults?: boolean;
  punctuation?: boolean;
  extra?: Record<string, any>;
}

export interface ASRTranscriptResult {
  text: string;
  isFinal: boolean;
  sentenceId?: number;
  beginTime?: number;
  endTime?: number;
  words?: Array<{ word: string; beginTime: number; endTime: number }>;
  raw?: any;
}

export abstract class BaseASRProvider extends EventEmitter {
  abstract start(options: ASRStartOptions): Promise<void>;
  abstract sendAudio(chunk: Buffer): void;
  abstract stop(): Promise<void>;
  abstract destroy(): void;

  // 标准事件:
  // this.emit('ready')
  // this.emit('transcript', result: ASRTranscriptResult)
  // this.emit('completed')
  // this.emit('error', error: Error)
}
```

### 4.2 阿里云 ASR 实现方案
阿里云支持两种主流方案，网关适配器可支持配置切换：
1. **智能语音交互 (NLS)**：
   - 协议：WebSocket (`wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1`)
   - 鉴权机制：由 `AccessKeyId/Secret` 生成临时 Token（默认 24 小时过期，内置 Token 自动缓存与刷新模块）。
   - 帧格式：4 字节二进制头部 + JSON 指令帧 / 纯二进制音频帧。
2. **百炼大模型平台 (DashScope - Paraformer-realtime-v2)**：
   - 协议：官方 WebSocket API (`wss://dashscope.aliyuncs.com/api-ws/v1/inference` 或专属空间 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`)
   - 鉴权机制：静态 `Authorization: Bearer <API_KEY>`。
   - 核心指令：
     - `run-task`：传递模型名称、音频格式（pcm/wav/opus/aac等）、采样率、热词表 ID、语气词过滤、语义断句与标点等丰富参数。
     - `finish-task`：通知厂商推流结束。
   - 核心事件：
     - `task-started`：会话准备就绪。
     - `result-generated`：流式返回识别结果（包含 `sentence_end`、词级时间戳 `words`、标点 `punctuation`、情感标签 `emo_tag` 等）。
     - `task-finished`：会话完成并返回计费时长。
     - `task-failed`：会话异常中断。

---

## 5. 项目结构规范

```text
asr-service/
├── docs/                     # 架构与开发文档
│   └── architecture-design.md
├── src/
│   ├── config/               # 环境变量与应用配置 (dotenv / zod)
│   ├── auth/                 # 鉴权中间件 (API Key / Token 校验)
│   ├── core/                 # 核心网关与调度
│   │   ├── session.ts        # 会话与流中继管理
│   │   ├── protocol.ts       # 协议类型定义与编解码
│   │   └── errors.ts         # 统一错误码与异常
│   ├── providers/            # 厂商适配器目录
│   │   ├── base.provider.ts  # Provider 抽象基类
│   │   ├── factory.ts        # 厂商工厂类
│   │   └── aliyun/           # 阿里云 ASR 实现
│   │       ├── aliyun-nls.provider.ts
│   │       └── token-manager.ts
│   ├── types/                # 全局 TypeScript 类型定义
│   └── server.ts             # 服务启动入口
├── test/
│   ├── mock-client.ts        # 模拟客户端推流测试脚本
│   └── fixtures/             # 测试音频样例 (16k 16bit pcm/wav)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 6. 技术选型总结

| 层次 | 选型 | 优势 |
| :--- | :--- | :--- |
| **开发语言** | TypeScript (Node.js 20+) | 强类型契约，多厂商协议转换可靠安全 |
| **HTTP / WS 框架**| Fastify + `@fastify/websocket` | 极致性能、低开销、生态良好 |
| **鉴权存储** | 内存 Map / Redis (可选) | 支持静态 Key 与分布式动态 Token 校验 |
| **日志组件** | Pino | 高性能结构化 JSON 异步日志 |
