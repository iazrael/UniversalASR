# 客户端接入指南 — 飞花令等项目如何使用 ASR 服务

> 面向接入方开发者。服务地址 `https://<SERVER_HOST>`，API Key 向服务管理员索取。
> 服务端架构与运维见 [deployment-report.md](./deployment-report.md)。

## 0. 一分钟了解鉴权模型

```
你的前端/客户端                ASR 服务
     │ ① POST /v1/ticket ──────▶ 校验 API Key（走 HTTPS 请求头，不进 URL）
     │ ◀── {ticket, expiresIn:60}  一次性短时效票据
     │
     │ ② wss://.../v1/asr?ticket=xx ──▶ 校验票据（一次性）+ IP 限流 + 预算闸门
     │ ◀────────── 实时转写结果流 ──────┤
```

- API Key 是长期凭证，**只**用来领票，放在 HTTP Header 里传输，绝不拼进 URL / 日志。
- Ticket 60 秒有效、**一次性**：每次开始识别前领一张，连上即作废。丢失重连须重新领票。
- 这套机制的意义：Key 泄露面最小化 + 每次识别都经过 IP 限流与预算闸门，防滥刷。

## 1. 浏览器 / H5 接入（推荐，直接用官方 SDK）

SDK 地址（服务自带，无需安装依赖）：`https://<SERVER_HOST>/universal-client.js`

```html
<script type="module">
  import { UniversalClient } from 'https://<SERVER_HOST>/universal-client.js';

  const client = new UniversalClient();

  // 状态机：DISCONNECTED → CONNECTING → RECORDING → STOPPING → DISCONNECTED
  client.on('stateChange', (s) => console.log('状态:', s));

  // 实时转写：边说边出中间结果，停顿自动切句定稿
  client.on('transcript', (r) => {
    // r = { text, is_final, sentence_id }
    if (r.is_final) {
      console.log('一句定稿:', r.text);      // ← 飞花令在这里校验答案
    } else {
      console.log('识别中…:', r.text);
    }
  });

  client.on('error', (err) => console.error('错误码:', err.code, err.message));
  client.on('completed', (d) => console.log('本次识别时长:', d.durationMs));

  // 开始：默认自动走 Ticket 鉴权（领票 → 握手，无需自己调 /v1/ticket）
  await client.start({
    serverUrl: 'wss://<SERVER_HOST>/v1/asr',  // 跨域接入必填；同域部署可省略
    token: '<你的API_KEY>',                    // 用于领票，走 Authorization 头
    provider: 'omlx',                          // 'omlx'(Qwen3-ASR) | 'aliyun'(Paraformer)
    language: 'zh',
    maxSentenceSilence: 400,                   // 停顿 400ms 即切句定稿（对战节奏推荐值）
    enableVad: true,
  });

  // 说完这一轮，主动结束并等待 completed
  await client.stop();
</script>
```

**注意事项**

1. **页面本身必须是 HTTPS**，否则浏览器不给麦克风权限（`getUserMedia` 要求安全上下文）。
2. 跨域接入没问题：服务端 CORS 全开，WebSocket 无同源限制。
3. `start()` 不可重入：录音中再调用会被忽略；一轮识别完成后（`completed` 事件）SDK 自动复位为 `DISCONNECTED`，可再次 `start()`。
4. 每轮 `start()` 自动领新票，接入方无需管理 Ticket 生命周期；想自己控制时可用 `ticket` 选项传入预领的票（跳过领票）。
5. 麦克风授权弹窗期间不消耗票期——SDK 已将领票放在授权之后。

### 飞花令场景推荐参数

| 参数 | 推荐值 | 理由 |
| :--- | :--- | :--- |
| `maxSentenceSilence` | `400` | 诗句短、对战节奏快，停顿 400ms 立即定稿判分 |
| `provider` | 先 `omlx`，A/B 后定 | 古诗词措辞两个引擎表现可能不同，建议实测对比；可随时热切换 |
| `language` | `zh` | — |
| 单轮流程 | `start → 收 is_final → stop` | 一句一判；服务端 30s 硬截断兜底，超长自动定稿 |

## 2. 非 JS 客户端 / 微信小程序直连协议

SDK 不可用时（小程序、原生 App、后端服务），按以下协议直连。

### 2.1 领票

```http
POST https://<SERVER_HOST>/v1/ticket
Authorization: Bearer <你的API_KEY>
```

```json
{ "ticket": "bPWvzYa2kT3RnkE1LCvJghLF1sqflbe9", "expiresIn": 60 }
```

失败码：`401` Key 无效 ｜ `429` 该 IP 当日额度用尽 ｜ `503` 服务预算熔断暂停中。

### 2.2 建立 WebSocket

```
wss://<SERVER_HOST>/v1/asr?ticket=<上一步的ticket>
```

连上后立刻发送 `start` 帧（JSON 文本）：

```json
{
  "action": "start",
  "provider": "omlx",
  "audio_format": { "codec": "pcm", "sample_rate": 16000, "channels": 1, "bit_depth": 16 },
  "options": {
    "language": "zh",
    "intermediate_results": true,
    "punctuation": true,
    "max_sentence_silence": 400,
    "custom_params": { "enable_vad": true, "vad_energy_threshold": -38 }
  }
}
```

### 2.3 推送音频（二进制帧）

- 格式：**PCM 裸流，16kHz，16bit，单声道，小端**（无 WAV 头）
- 分片：每帧 40~100ms（640~1600 字节）为宜，实时场景边录边发

### 2.4 接收事件（JSON 文本帧）

| event | 时机 | 关键字段 |
| :--- | :--- | :--- |
| `started` | 会话就绪（收到后再推音频） | `session_id`, `provider` |
| `transcription` | 每次识别更新 | `result.text`, `result.is_final`（true=句子定稿）, `result.sentence_id` |
| `completed` | `stop` 后全部定稿 | `usage.duration_ms` |
| `error` | 出错（随后连接关闭） | `code`, `message` |

### 2.5 结束

发 `{"action":"stop"}` → 收 `completed` → 服务端自动关连接。

### 2.6 微信小程序示例骨架

```js
// 1. 领票
const token = '<你的API_KEY>';
const res = await wx.request({ url: 'https://<SERVER_HOST>/v1/ticket', method: 'POST',
  header: { Authorization: `Bearer ${token}` } });
const { ticket } = res.data;

// 2. 建连接（正式环境必须 wss）
const task = wx.connectSocket({ url: `wss://<SERVER_HOST>/v1/asr?ticket=${ticket}` });
task.onOpen(() => task.send({ data: JSON.stringify({ /* 上面的 start 帧 */ }) }));

// 3. 录音推流：RecorderManager 直接产出符合规格的 PCM
const rm = wx.getRecorderManager();
rm.start({ format: 'PCM', sampleRate: 16000, numberOfChannels: 1, frameSize: 1 }); // frameSize 单位 KB
rm.onFrameRecorded(({ frameBuffer }) => task.send({ data: frameBuffer }));

// 4. 收结果
task.onMessage((msg) => {
  const m = JSON.parse(msg.data);
  if (m.event === 'transcription' && m.result.is_final) { /* 判分 */ }
});
```

> 注意：`wx.connectSocket` 无法自定义 Header，所以小程序走的是 `?ticket=` 查询参数通道（Ticket 一次性、60s 失效，泄露面可控）。**不要**把 API Key 拼进任何 URL。

## 3. 错误码与重试策略

| code | 含义 | 客户端应对 |
| :--- | :--- | :--- |
| `4001` | Ticket 无效/过期/已用，或 Key 无效 | **重新领票并重连一次**（一次性票据偶发被消费）；仍失败则提示 Key 问题 |
| `4008` | IP 限流（当日 200 次 / 并发 3 路） | 提示"今日次数用完，明天再试"；对战场景避免多开标签页（并发占额度） |
| `4009` | 预算熔断，服务暂停 | 展示维护提示，引导文字输入兜底；勿重试轰炸 |

统一建议：`error` 事件后 SDK 已自动复位，重新 `start()` 即开启新的一轮（会自动领新票）。

## 4. 服务边界（设计你的产品时考虑）

- 单次识别（utterance）最长 **30 秒**，超时自动定稿截断——飞花令一句诗远短于此，无影响。
- 每 IP 每日 200 次、并发 3 路共享额度；同一办公室/家庭出口 IP 会互相消耗。
- 全局预算熔断由管理员控制，`GET /health` 的 `budget` 字段可查余量（无需鉴权，可用于开屏预检）。
- 中间结果（`is_final=false`）可能跳动变化，判分逻辑**只认 `is_final=true`**。
