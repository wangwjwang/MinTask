/**
 * cloudfunctions/callAI/providers/deepseek.js
 * ---------------------------------------------------------------------------
 * DeepSeek 适配器。用 Node 内置 https 发起请求，不引入第三方 SDK
 * （云函数体积越小冷启动越快，且少一个依赖少一处版本风险）。
 *
 * DeepSeek 提供 OpenAI 兼容协议，因此本文件稍作改动即可换成任何
 * OpenAI 兼容的服务（通义、Kimi、自建 vLLM 等）。
 *
 * ★ 本文件的所有失败路径都必须抛出，由上层 callAI/index.js 统一兜底成
 *   "返回原文"。绝不允许把网络异常泄漏成业务异常阻断用户录入。
 * ---------------------------------------------------------------------------
 */

const https = require('https');

const HOST = 'api.deepseek.com';
const PATH = '/chat/completions';
const MODEL = 'deepseek-chat';

/**
 * 发起一次对话补全请求。
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Array}  opts.messages   [{role, content}]
 * @param {number} [opts.timeoutMs] 超时毫秒数，超时后主动断开
 * @param {number} [opts.maxTokens]
 * @returns {Promise<string>} 模型返回的正文
 */
function chat(opts) {
  const { apiKey, messages, timeoutMs = 8000, maxTokens = 800 } = opts;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.2, // 精简任务要稳定复现，温度调低
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }, // 强制返回 JSON 对象
      stream: false,
    });

    const req = https.request(
      {
        host: HOST,
        path: PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          }
          try {
            const parsed = JSON.parse(raw);
            const content =
              parsed &&
              parsed.choices &&
              parsed.choices[0] &&
              parsed.choices[0].message &&
              parsed.choices[0].message.content;
            if (!content) return reject(new Error('DeepSeek 返回内容为空'));
            resolve(content);
          } catch (e) {
            reject(new Error(`DeepSeek 响应解析失败: ${e.message}`));
          }
        });
      }
    );

    // 超时控制：8 秒拿不到结果就断开并报错，由上层降级回原文。
    // 用户在页面上等 8 秒已经接近忍耐上限，宁可给原文也不让他干等。
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`DeepSeek 请求超时（${timeoutMs}ms）`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { chat, MODEL, HOST };
