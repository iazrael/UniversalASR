import { BaseASRProvider } from './base.provider.js';
import { DashScopeParaformerProvider } from './aliyun/dashscope-paraformer.provider.js';
import { config } from '../config/index.js';

export class ASRProviderFactory {
  /**
   * 根据厂商标识创建对应的 ASR Provider 实例
   */
  public static createProvider(providerName?: string, customConfig?: any): BaseASRProvider {
    const target = (providerName || config.DEFAULT_PROVIDER).toLowerCase();

    switch (target) {
      case 'aliyun':
      case 'dashscope':
      case 'paraformer':
      case 'paraformer-v2':
      case 'paraformer-realtime-v2':
        return new DashScopeParaformerProvider(customConfig);

      // 后续厂商直接在这里扩展：
      // case 'tencent':
      //   return new TencentASRProvider(customConfig);
      // case 'volcengine':
      //   return new VolcengineASRProvider(customConfig);
      // case 'whisper':
      //   return new WhisperASRProvider(customConfig);

      default:
        throw new Error(`不支持的 ASR Provider: "${providerName}"，当前支持: aliyun/dashscope`);
    }
  }

  /**
   * 获取当前支持的厂商列表
   */
  public static getSupportedProviders(): string[] {
    return ['aliyun', 'dashscope', 'paraformer-realtime-v2'];
  }
}
