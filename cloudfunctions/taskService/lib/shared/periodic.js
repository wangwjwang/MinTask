/**
 * shared/periodic.js
 * ---------------------------------------------------------------------------
 * 周期计划（periodic_templates）的纯逻辑核心。被两处共用：
 *   1. cloudfunctions/generatePeriodicTasks —— 每日定时巡检调用
 *   2. cloudfunctions/templateService      —— 建完立即生成 / 管理员手动补跑
 *
 * 本文件只做「纯计算」，不碰数据库，便于单独验证与测试。
 *
 * ★ 触发策略：
 *   需求原文是「每月 1 日 0 点生成」，但云开发定时触发器**失败没有重试机制**，
 *   那一刻若环境异常，会导致整整一期没有任务，且没有任何提示。
 *   所以改为「每日 00:05 巡检」，由本文件判定「本期该不该生成」。
 *   配合确定性 _id，一天跑 30 次也只生成一份。
 *
 * ★ 生成时机 = 本期的**开始日**到了（用户 2026-10-03 明确）。
 *   「每月 5 号开始」的计划，5 号那轮巡检才生成当期任务，1 号不生成。
 *   判定用「今天 ≥ 开始日」而不是「今天 == 开始日」：漏跑一天次日自动补上。
 *   代价是每天一次空读（可忽略），收益是永远不会整期缺失。
 *
 * ★ 本期已过期（今天 > 截止日）就不再生成。
 *   否则 28 号启用一个「5 号开始、25 号截止」的计划，会立刻得到一条
 *   一出生就逾期的任务 —— 那比没有更糟：它会污染逾期统计，还得手工删。
 *   真要补跑历史周期，用 generateNow 的 asOf 参数假装回到那一天。
 *
 * ★ 自然月/自然季/自然年固定，模板填的是**期内的偏移**：
 *   月度 = 第几号；季度 = 本季度第几个月的几号；年度 = 本年度几月几号。
 *   这样一套字段同时表达三种周期，不用为每种周期各写一套规则。
 * ---------------------------------------------------------------------------
 */

const {
  periodKeyOf,
  parsePeriodKey,
  daysInMonth,
  formatDate,
  isValidDateStr,
  todayStr,
  pad2,
} = require('./dates');

/** 支持的占位符。模板里写 {{YYYY}} 等，生成时被替换。 */
const PLACEHOLDERS = [
  '{{YYYY}}',
  '{{MM}}',
  '{{YYYYMM}}',
  '{{YYYY年MM月}}',
  '{{季度}}',
  '{{deadline}}',
];

/**
 * 周期类型 → 一期的月数。
 * 这三个是「自然」周期，跨度固定，不可配置（用户 2026-10-03 确认）。
 */
const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, yearly: 12 };

const QUARTER_CN = ['一季度', '二季度', '三季度', '四季度'];

/**
 * 周期类型 → 任务名前缀模板。
 *
 * 「建计划时填名字，周期由系统加」这条规则的真源在这里：
 * 前端拿它做实时预览，后端拿它拼最终存库的 taskNameTemplate ——
 * 两边都用这一份，不会出现「预览写 2026年10月、存进去变 2026-10」。
 *
 * ★ 前缀由**服务端**拼（create 只收裸名字 name），不让前端拼好整体提交：
 *   前缀是"多久一次"的表达，必须与 periodType 一致，前端拼错了没人拦得住。
 */
const NAME_PREFIX = {
  monthly: '{{YYYY年MM月}}',
  quarterly: '{{YYYY}}年{{季度}}',
  yearly: '{{YYYY}}年',
};

/**
 * 周期类型 → 生成的任务上要写的 recur_freq。
 *
 * ★ 由 periodType 派生，不再单独让用户填 —— 两个字段表达同一件事时，
 *   迟早会配出「periodType=monthly 但 recur_freq=每年」这种自相矛盾的任务。
 */
const RECUR_FREQ_OF = { monthly: '每月', quarterly: '每季', yearly: '每年' };

/**
 * 归一化周期类型。返回 '' 表示无法识别。
 *
 * ★ 认几个别名是为了兼容手工在云控制台建的模板（'month' / 'quarter' / 'annual'
 *   这类写法曾经出现在文档里）。识别不了就返回 ''，由调用方保守跳过 ——
 *   「不生成」比「按错误的周期生成」好收拾得多。
 */
function normalizePeriodType(v) {
  const s = String(v === undefined || v === null || v === '' ? 'monthly' : v).toLowerCase();
  if (s === 'monthly' || s === 'month') return 'monthly';
  if (s === 'quarterly' || s === 'quarter') return 'quarterly';
  if (s === 'yearly' || s === 'annual' || s === 'year') return 'yearly';
  return '';
}

/**
 * 渲染任务名称模板。
 *
 * 支持的占位符：
 *   {{YYYY}}      → 2026
 *   {{MM}}        → 10
 *   {{YYYYMM}}    → 2026-10
 *   {{YYYY年MM月}} → 2026年10月
 *   {{季度}}       → 三季度（按 periodKey 所在月算所属季度）
 *   {{deadline}}  → 2026-10-25
 *
 * 未识别的占位符原样保留（不静默删除），便于管理员发现模板写错。
 *
 * ★ 年度计划的「2026年」前缀不需要新占位符：写 `{{YYYY}}年` 即可 ——
 *   花括号里只有 {{YYYY}}，末尾那个「年」在括号外面，替换后自然接上。
 *
 * @param {string} tpl       如 '{{YYYY年MM月}}-XX检查'
 * @param {object} vars      { periodKey, deadline }
 * @returns {string}
 */
function renderName(tpl, vars) {
  const pk = parsePeriodKey(vars && vars.periodKey);
  if (!pk) return String(tpl || '');
  const yyyy = String(pk.year);
  const mm = pad2(pk.month);
  const map = {
    '{{YYYY}}': yyyy,
    '{{MM}}': mm,
    '{{YYYYMM}}': `${yyyy}-${mm}`,
    '{{YYYY年MM月}}': `${yyyy}年${pk.month}月`,
    '{{季度}}': QUARTER_CN[Math.floor((pk.month - 1) / 3)] || '',
    '{{deadline}}': (vars && vars.deadline) || '',
  };
  return String(tpl || '').replace(/\{\{[^}]*\}\}/g, (m) => (m in map ? map[m] : m));
}

/**
 * 由 deadlineRule 计算截止日期。
 *
 * deadlineRule 是管理员在模板里写的自然语言规则，本函数提取其中的日期数字：
 *   '当月 25 号'      → 当月 25 日
 *   '当月25日23:59'   → 当月 25 日（时间部分忽略，只保留日期）
 *   '次月 5 号'       → 下月 5 日
 *   '当月末' / 空     → 当月最后一天
 *
 * 边界处理：若指定日期超过当月天数（如 2 月 30 日），取当月最后一天。
 *
 * @param {string} rule
 * @param {string} periodKey  '2026-10'
 * @returns {string} 'YYYY-MM-DD'
 */
function deadlineOf(rule, periodKey) {
  const pk = parsePeriodKey(periodKey);
  if (!pk) return '';

  const text = String(rule || '');
  // 识别「次月/下月」前缀，否则默认当月
  const nextMonth = /次月|下月/.test(text);
  // 提取首个数字作为日
  const numMatch = text.match(/(\d+)/);
  const day = numMatch ? Number(numMatch[1]) : null;

  let year = pk.year;
  let month = pk.month;
  if (nextMonth) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  const lastDay = daysInMonth(year, month);
  // 没写数字则取月末（'当月末' 或无规则）
  const finalDay = day === null ? lastDay : Math.min(Math.max(day, 1), lastDay);

  return `${year}-${pad2(month)}-${pad2(finalDay)}`;
}

/**
 * 把「今天」归一化成 'YYYY-MM-DD'。
 *
 * 接受 Date 或 'YYYY-MM-DD'；其余（含空）当作"没给"，取真实今天。
 * ★ 必须归一化后再比较：本文件产出的日期都是定长补零字符串，
 *   混进 Date 对象或用 '2026-9-5' 这种非补零写法，字典序立刻失效。
 */
function normalizeToday(today) {
  if (today instanceof Date) return formatDate(today);
  const s = String(today || '');
  return isValidDateStr(s) ? s : todayStr();
}

/**
 * 「今天」属于哪一期 —— 返回该期的 periodKey（**期首月**）。
 *
 *   monthly   '2026-08-15' → '2026-08'
 *   quarterly '2026-08-15' → '2026-07'   （Q3 的季首月）
 *   yearly    '2026-08-15' → '2026-01'
 *
 * ★ 用期首月而不是「当天所在月」：季度计划在 8 月巡检时算出的仍是 Q3，
 *   与 7 月那次是同一个 key，确定性 _id 因此命中，不会重复生成。
 *
 * @returns {string} 周期类型无法识别时返回 ''
 */
function periodKeyFor(periodType, today) {
  const span = MONTHS_PER_PERIOD[normalizePeriodType(periodType)];
  if (!span) return '';
  const d = normalizeToday(today);
  const month = Number(d.slice(5, 7));
  const firstMonth = month - ((month - 1) % span);
  return `${d.slice(0, 4)}-${pad2(firstMonth)}`;
}

/**
 * 期内偏移 → 绝对日期。
 *
 *   dateInPeriod('2026-10', 1, 5)   → '2026-10-05'   月度
 *   dateInPeriod('2026-07', 3, 20)  → '2026-09-20'   季度：本季度第 3 个月
 *   dateInPeriod('2026-01', 12, 25) → '2026-12-25'   年度：本年度第 12 个月
 *
 * ★ 天数超出该月天数时**收敛到月末**（2 月填 30 号 → 2/28），不往后溢出：
 *   「2 月 30 号」在任何年份都不该变成 3 月 2 号。
 *   月份索引溢出则正常进位到次年（如 '2026-11' 的第 3 个月 → 2027-01）。
 *
 * @param {string} periodKey 期首月
 * @param {number} monthIdx  期内第几个月，从 1 起
 * @param {number} day       该月第几天
 */
function dateInPeriod(periodKey, monthIdx, day) {
  const pk = parsePeriodKey(periodKey);
  if (!pk) return '';
  const idx = Math.max(1, Math.floor(Number(monthIdx)) || 1);
  let year = pk.year;
  let month = pk.month + (idx - 1);
  year += Math.floor((month - 1) / 12);
  month = ((month - 1) % 12) + 1;

  const last = daysInMonth(year, month);
  const d = Math.min(Math.max(Math.floor(Number(day)) || 1, 1), last);
  return `${year}-${pad2(month)}-${pad2(d)}`;
}

/**
 * 把期内偏移描述成一句人话，用于生成任务上的 recur_rule。
 *
 *   月度 → '每月5日—25日'
 *   季度 → '每季第1个月5日—第3个月20日'
 *   年度 → '每年4月5日—12月25日'
 *
 * ★ 纯展示文案，不参与任何判定 —— 判定一律走 periodDates 算出的绝对日期。
 *   生成的任务里 recur_rule 原本由 deadlineRule 填，改成结构化字段后若不再填，
 *   周期任务就会比手工任务少一行说明，所以补上。
 *   （recur_rule 在任务表单里是可编辑的，主办人想改随时能改。）
 */
function describeOffsets(template) {
  const t = template || {};
  const type = normalizePeriodType(t.periodType);
  if (!type) return '';
  const span = MONTHS_PER_PERIOD[type];
  const idx = (v, dft) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= span ? n : dft;
  };
  const day = (v, dft) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 31 ? n : dft;
  };
  const monthIdx = idx(t.startMonthIdx, 1);
  const endIdx = idx(t.endMonthIdx, span);
  const startDay = day(t.startDay, 1);
  const endDay = day(t.endDay, 31);

  if (type === 'monthly') return `每月${startDay}日—${endDay}日`;
  if (type === 'quarterly') return `每季第${monthIdx}个月${startDay}日—第${endIdx}个月${endDay}日`;
  return `每年${monthIdx}月${startDay}日—${endIdx}月${endDay}日`;
}

/**
 * 算出一期的开始日与截止日。
 *
 * 新模板读结构化字段（startMonthIdx/startDay/endMonthIdx/endDay）。
 * 2026-10-03 之前建的模板只有 deadlineRule 这个字符串规则，没有上述字段，
 * 此时退回：开始日 = 当期 1 号，截止日 = 仍按字符串规则解析。
 * 这类模板只减不增（新表单只写结构化字段），兼容是为了不让已经配好的
 * 计划在升级当天突然不生成。
 */
function periodDates(template, periodKey) {
  const t = template || {};
  const filled = (v) => v !== undefined && v !== null && v !== '';
  return {
    startDate: filled(t.startDay)
      ? dateInPeriod(periodKey, t.startMonthIdx, t.startDay)
      : dateInPeriod(periodKey, 1, 1),
    dueDate: filled(t.endDay)
      ? dateInPeriod(periodKey, t.endMonthIdx, t.endDay)
      : deadlineOf(t.deadlineRule, periodKey),
  };
}

/**
 * 评估一个模板在「今天」该不该生成本期任务。
 *
 * ★ due 的语义是「**本期任务现在应该存在**」，不是「现在要插一条」。
 *   本函数是纯计算，看不到库里已经有什么 —— 「是不是已经存在」由调用方
 *   查库或靠确定性 _id 判断。所以 due 为 true 只意味着"该有"，
 *   每天触发一次也不会因此产生重复任务。
 *
 * @param {object} template periodic_templates 文档
 * @param {Date|string} today
 * @returns {{periodKey,startDate,dueDate,taskName,docId,due,reason}}
 *   reason: 'ok' | 'disabled' | 'bad_period_type' | 'not_started' | 'period_expired'
 */
function evaluate(template, today) {
  const { periodicTaskId } = require('./idempotency');
  const t = template || {};
  const day = normalizeToday(today);
  const blank = { periodKey: '', startDate: '', dueDate: '', taskName: '', docId: '', due: false };

  if (!t.enabled) return Object.assign(blank, { reason: 'disabled' });

  const type = normalizePeriodType(t.periodType);
  if (!type) return Object.assign(blank, { reason: 'bad_period_type' });

  const periodKey = periodKeyFor(type, day);
  const { startDate, dueDate } = periodDates(t, periodKey);

  let due = true;
  let reason = 'ok';
  if (day < startDate) {
    due = false;
    reason = 'not_started';
  } else if (day > dueDate) {
    due = false;
    reason = 'period_expired';
  }

  return {
    periodKey,
    startDate,
    dueDate,
    taskName: renderName(t.taskNameTemplate, { periodKey, deadline: dueDate }),
    docId: periodicTaskId(t._id, periodKey),
    due,
    reason,
  };
}

/**
 * 生成本次巡检的完整执行计划（纯计算，不写库）。
 *
 * @param {Array} templates 模板数组
 * @param {Date|string} today
 * @returns {{plan: Array, skipped: Array}}
 *   plan    每项 = evaluate 的结果 + { template }
 *   skipped 每项 = { templateId, name, reason }，便于排查"为什么没生成"
 */
function buildPlan(templates, today) {
  const plan = [];
  const skipped = [];
  for (const t of templates || []) {
    const e = evaluate(t, today);
    if (e.due) {
      plan.push(Object.assign({ template: t }, e));
    } else {
      skipped.push({ templateId: t._id, name: t.name, reason: e.reason });
    }
  }
  return { plan, skipped };
}

module.exports = {
  PLACEHOLDERS,
  MONTHS_PER_PERIOD,
  QUARTER_CN,
  NAME_PREFIX,
  RECUR_FREQ_OF,
  normalizePeriodType,
  renderName,
  deadlineOf,
  normalizeToday,
  periodKeyFor,
  dateInPeriod,
  describeOffsets,
  periodDates,
  evaluate,
  buildPlan,
  periodKeyOf,
};
