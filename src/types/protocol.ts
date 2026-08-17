/**
 * 通用 ASR 协议定义
 */

// 音频编码格式
export type AudioCodec = 'pcm' | 'wav' | 'opus' | 'aac';

// 音频格式描述
export interface AudioFormat {
  codec: AudioCodec;
  sample_rate: number;
  channels?: number;
  bit_depth?: number;
}

// 客户端启动配置选项
export interface ASROptions {
  language?: string;               // 语言代码，如 zh, en, yue 等
  intermediate_results?: boolean;  // 是否返回中间转写结果（默认 true）
  punctuation?: boolean;           // 是否启用标点符号预测（默认 true）
  disfluency_removal?: boolean;    // 是否过滤语气词（如“嗯”、“啊”）
  vocabulary_id?: string;          // 自定义热词表 ID
  custom_params?: Record<string, any>; // 厂商专属自定义透传参数
}

// C2S: 客户端动作类型
export type C2SAction = 'start' | 'stop' | 'ping' | 'auth';

// C2S 消息格式
export interface C2SStartMessage {
  action: 'start';
  session_id?: string;
  provider?: string;
  audio_format?: Partial<AudioFormat>;
  options?: ASROptions;
}

export interface C2SStopMessage {
  action: 'stop';
}

export interface C2SPingMessage {
  action: 'ping';
}

export interface C2SAuthMessage {
  action: 'auth';
  token: string;
}

export type C2SMessage = C2SStartMessage | C2SStopMessage | C2SPingMessage | C2SAuthMessage;

// S2C: 服务端下发事件类型
export type S2CEvent = 'started' | 'transcription' | 'completed' | 'error' | 'pong';

// 词级时间戳
export interface WordTimestamp {
  text: string;
  begin_time: number;
  end_time: number;
}

// 转写结果对象
export interface TranscriptResultPayload {
  text: string;
  is_final: boolean;
  sentence_id?: number;
  begin_time?: number;
  end_time?: number;
  words?: WordTimestamp[];
}

// S2C 消息格式
export interface S2CStartedMessage {
  event: 'started';
  session_id: string;
  provider: string;
}

export interface S2CTranscriptionMessage {
  event: 'transcription';
  session_id: string;
  result: TranscriptResultPayload;
}

export interface S2CCompletedMessage {
  event: 'completed';
  session_id: string;
  usage?: {
    duration_ms?: number;
  };
}

export interface S2CErrorMessage {
  event: 'error';
  session_id?: string;
  code: number;
  message: string;
}

export interface S2CPongMessage {
  event: 'pong';
}

export type S2CMessage =
  | S2CStartedMessage
  | S2CTranscriptionMessage
  | S2CCompletedMessage
  | S2CErrorMessage
  | S2CPongMessage;

// 标准错误码定义
export enum ASRErrorCode {
  UNAUTHORIZED = 4001,
  INVALID_STATE = 4002,
  INVALID_MESSAGE = 4003,
  PROVIDER_NOT_FOUND = 4004,
  PROVIDER_INIT_FAILED = 4005,
  VENDOR_ERROR = 4006,
  SESSION_TIMEOUT = 4007,
  INTERNAL_ERROR = 5000,
}
