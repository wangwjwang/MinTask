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

/** 任务名长度上限（防止把整篇任务详情塞进 prompt 白烧 token） */
const TASK_NAME_MAX = 100;

/**
 * 任务目标长度上限。
 * 任务详情本身可以写很长，但这里只需要模型认出「这是哪件事」——
 * 开头一段就够了，多给的部分只是成本，不是信息。
 */
const TASK_DETAIL_MAX = 500;

/**
 * 组装 system prompt。
 *
 * ★ 为什么要带任务上下文：AI 看不到页面。不告诉它这是哪件事，它只能**盲整理** ——
 *   原文说「还剩几个没弄完」，它没法把「对方」写成任务里写明的合作方，
 *   也没法判断「弄完了」指的是哪个环节。用户提的「和任务要求的进展尽量一致」
 *   就落在这里。
 *
 * ★ 为什么任务信息放 system 而不是 user：user message 必须**原样**保留用户的
 *   口述内容 —— 它是唯一的事实来源，混进别的东西会模糊模型对"原文边界"的判断。
 *   任务信息则是每次调用固定不变的背景，放 system 才合位置。
 *
 * ★ 任务名 / 任务目标都是用户自己填的，理论上可以往里写指令。这在本项目
 *   不构成新的攻击面：能建任务的人本来就能直接写进展正文，两者权限完全相同。
 *
 * ⚠ 规则 1 的后半句是本文件最要紧的一句话。把任务目标喂进去之后，模型很容易
 *   顺手把目标里的数字、结论当成"已完成"写进进展 —— 那就是编造。
 *   改动提示词时不要删掉它。
 *
 * @param {string} taskName
 * @param {string} taskDetail
 * @returns {string}
 */
function buildSystemPrompt(taskName, taskDetail) {
  const name = String(taskName || '').trim().slice(0, TASK_NAME_MAX);
  const detail = String(taskDetail || '').trim().slice(0, TASK_DETAIL_MAX);

  // 两个都空时整块不出现 —— 「任务名：（未填）」这种空壳只会让模型分神
  const taskBlock =
    name || detail
      ? `【当前任务】\n任务名：${name || '（未填）'}\n任务目标：${detail || '（未填）'}\n\n`
      : '';

  return `你是团队任务管理系统的进展记录整理助手。用户会给你一段语音转写的口语文本，请把它整理成规范的进展记录。

${taskBlock}严格遵守以下规则：
1. 只整理，不创造。绝对不能添加原文中没有的任何信息（不要编造数字、日期、人名、结论）。
   上面的「当前任务」只用来帮你**读懂原文在说什么、把用词写准**，它不是事实来源 ——
   原文没说的进展，绝不能因为任务目标里提过就写进去。
2. 贴合当前任务：把原文里含糊的指代（"那个""对方""弄完了"）按任务信息写具体，
   让读的人不看任务也能知道**这项任务**推进到哪了。
3. 改正错别字：明显的同音、形近误写要改（「部属」→「部署」、「连调」→「联调」）。
   但**人名、部门名、系统名等专有名词一律照原文抄** —— 你手里没有名单，
   改错比不改更糟；拿不准的词不要动。
4. 删除口语填充词：嗯、啊、那个、就是说、然后就是、这个这个等，
   把口语转成简洁的书面表达，保留说话人的原意和事实。
5. 精简到 50 字左右（含标点）。超了按这个顺序删：先删客套和铺垫，再删重复的修饰，
   再舍弃细节、保留结论和数字。★ 50 字是目标，不是硬指标 —— 事情确实多、
   压到 50 字会丢掉关键进展时，可以写到 60-70 字，但不要再长。
6. blocker：原文明确提到阻碍或困难才填，一句话，30 字以内，没有填空字符串。
7. needSupport：原文明确请求了他人协助/资源/决策才填，一句话，30 字以内，没有填空字符串。

请严格返回如下 JSON 格式（不要输出 JSON 以外的任何内容）：
{
  "description": "整理后的进展，一句话说清做了什么、现在什么结果，50 字左右",
  "blocker": "遇到的阻碍，没有则填空字符串",
  "needSupport": "需要谁提供什么支持，没有则填空字符串"
}`;
}

/**
 * 主处理逻辑。
 *
 * @param {object} payload
 * @param {string} payload.text        语音转写的原文
 * @param {string} [payload.taskName]  当前任务名，用来让整理结果贴合这件事
 * @param {string} [payload.taskDetail] 当前任务目标。两者都可缺省 ——
 *   缺省时退化成"盲整理"，与加任务上下文之前的行为完全一致。
 * @returns {Promise<{text:string, aiApplied:boolean, reason?:string, fields?:object}>}
 */
async function refine(payload, ctx) {
  // 仅已认领成员可调用（AI 额度不该被未登录请求消耗）
  await ctx.requireWriter();

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
        // 任务上下文在这里拼进 system prompt。截断与 trim 都收在
        // buildSystemPrompt 内部 —— 云函数不假设调用方永远听话
        //（前端漏字段、旧版本客户端都可能发生）。
        { role: 'system', content: buildSystemPrompt(payload && payload.taskName, payload && payload.taskDetail) },
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
