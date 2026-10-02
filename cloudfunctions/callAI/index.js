/**
 * cloudfunctions/callAI/index.js
 * ---------------------------------------------------------------------------
 * AI 文本精简：把语音转写的口语原文整理成结构化的进展描述。
 *
 * ★★ 本期默认关闭（AI_ENABLED 未设置即为关闭）★★
 *
 * 关闭时本函数直接返回原文、aiApplied=false。前端的完整流程
 * 「语音转文字 → 人工确认编辑 → 提交」照常走通，只是中间少了 AI 这一步。
 * 拿到 DeepSeek API Key 后，在云函数控制台配两个环境变量即可启用：
 *     AI_ENABLED=true
 *     DEEPSEEK_API_KEY=sk-xxxxxxxx
 * 不需要改任何代码。
 *
 * ★★ 最重要的设计约束：本函数**永不抛出业务异常** ★★
 *
 * 无论发生什么 —— 超时、网络错误、API Key 无效、余额不足、返回的不是
 * JSON、返回的 JSON 缺字段 —— 都返回原文 + aiApplied:false + 失败原因。
 * AI 是锦上添花，绝不能因为第三方服务抖动而阻断用户录入进展。
 * 这是需求第 10 节第 3 条明确要求的。
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');

/** 原文长度上限。超长文本直接跳过 AI（省 token，且长文本精简收益低） */
const TEXT_MAX = 1500;

/** 调用超时。用户等待超过这个时长体验就开始变差，宁可给原文。 */
const TIMEOUT_MS = 8000;

/**
 * 精简用的 system prompt。
 *
 * 设计取向（对应需求第 6 节「保留事实、去掉口头禅、补全要素」）：
 *   - 只做整理，不做创作：严禁添加原文没有的信息
 *   - 补全要素：按「做了什么 / 当前结果 / 下一步 / 需支持」组织
 *   - 输出严格 JSON，便于前端稳定填表单
 *   - 口语转书面：去「那个」「就是说」「嗯」这类填充词
 */
const SYSTEM_PROMPT = `你是团队任务管理系统的进展记录整理助手。用户会给你一段语音转写的口语文本，请把它整理成规范的进展记录。

严格遵守以下规则：
1. 只整理，不创造。绝对不能添加原文中没有的任何信息（不要编造数字、日期、人名、结论）。
2. 删除口语填充词：嗯、啊、那个、就是说、然后就是、这个这个等。
3. 把口语转成简洁的书面表达，保留说话人的原意和事实。
4. 按要素组织内容，缺失的要素留空字符串，不要臆造。
5. 如果原文中明确提到了阻碍或困难，提取到 blocker 字段。
6. 如果原文中明确请求了他人协助/资源/决策，提取到 needSupport 字段。

请严格返回如下 JSON 格式（不要输出 JSON 以外的任何内容）：
{
  "description": "整理后的进展描述，一句话到三句话，客观陈述做了什么、当前结果如何",
  "blocker": "遇到的阻碍，没有则填空字符串",
  "needSupport": "需要谁提供什么支持，没有则填空字符串"
}`;

/**
 * 主处理逻辑。
 *
 * @param {object} payload
 * @param {string} payload.text  语音转写的原文
 * @returns {Promise<{text:string, aiApplied:boolean, reason?:string, fields?:object}>}
 */
async function refine(payload, ctx) {
  // 仅已认领成员可调用（AI 额度不该被未登录请求消耗）
  await ctx.requireMember();

  const raw = String((payload && payload.text) || '').trim();

  // ── 各种"直接返回原文"的情形 ────────────────────────────────────────
  if (!raw) {
    return { text: '', aiApplied: false, reason: 'EMPTY_INPUT' };
  }
  if (raw.length > TEXT_MAX) {
    return { text: raw, aiApplied: false, reason: 'TEXT_TOO_LONG' };
  }
  if (process.env.AI_ENABLED !== 'true') {
    // ★ 本期默认走这里
    return { text: raw, aiApplied: false, reason: 'AI_DISABLED' };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 配了 AI_ENABLED=true 却忘了配 Key —— 常见配置失误，明确告知而不是静默降级
    console.warn('[callAI] AI_ENABLED=true 但缺少 DEEPSEEK_API_KEY');
    return { text: raw, aiApplied: false, reason: 'MISSING_API_KEY' };
  }

  // ── 调用 AI（所有异常都在此被吞掉）──────────────────────────────────
  try {
    const deepseek = require('./providers/deepseek');
    const content = await deepseek.chat({
      apiKey,
      timeoutMs: TIMEOUT_MS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: raw },
      ],
    });

    const fields = parseFields(content);
    if (!fields) {
      return { text: raw, aiApplied: false, reason: 'INVALID_JSON' };
    }

    // 描述为空说明模型没按格式来，不值得信任，退回原文
    if (!fields.description) {
      return { text: raw, aiApplied: false, reason: 'EMPTY_RESULT' };
    }

    return {
      text: fields.description,
      aiApplied: true,
      fields,
    };
  } catch (e) {
    // 超时 / 网络错误 / 4xx / 5xx / 解析失败 —— 全部降级
    console.error('[callAI] 调用失败，降级返回原文', e && e.message);
    return { text: raw, aiApplied: false, reason: 'AI_ERROR', detail: String(e && e.message) };
  }
}

/**
 * 解析模型返回的 JSON。做三层防御，任何一层失败返回 null：
 *   1. 直接 JSON.parse
 *   2. 剥离 ```json 代码围栏后再试
 *   3. 截取第一个 { 到最后一个 } 之间再试
 * 模型偶尔会在 JSON 外面加一句客套话，这个兜底很实用。
 */
function parseFields(content) {
  const text = String(content || '').trim();
  const attempts = [text];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') {
        return {
          description: String(obj.description || '').trim().slice(0, 2000),
          blocker: String(obj.blocker || '').trim().slice(0, 500),
          needSupport: String(obj.needSupport || '').trim().slice(0, 500),
        };
      }
    } catch (e) {
      // 换下一种解析方式
    }
  }
  return null;
}

exports.main = createRouter({ refine, default: refine });
