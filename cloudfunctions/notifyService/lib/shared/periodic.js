/**
 * shared/periodic.js
 * ---------------------------------------------------------------------------
 * 周期任务生成的纯逻辑核心。被两处共用：
 *   1. cloudfunctions/generatePeriodicTasks —— 每日定时巡检调用
 *   2. cloudfunctions/templateService 的 generateNow —— 管理员手动补跑
 *
 * 本文件只做「纯计算」，不碰数据库，便于单独验证与测试。
 *
 * ★ 触发策略说明：
 *   需求原文是「每月 1 日 0 点」，但云开发定时触发器**失败没有重试机制**，
 *   那一刻若环境异常，会导致整整一个月没有任务，且没有任何提示。
 *   现改为「每日 00:05 巡检」：每天跑一次，由本文件判定本月是否该生成。
 *   配合确定性 _id，一个月跑 30 次也只生成一份。
 *   成本是每天一次空读（可忽略），收益是漏跑一天次日自动补上。
 * ---------------------------------------------------------------------------
 */

const { periodKeyOf, parsePeriodKey, daysInMonth, pad2 } = require('./dates');

/** 支持的占位符。模板里写 {{YYYY}} 等，生成时被替换。 */
const PLACEHOLDERS = ['{{YYYY}}', '{{MM}}', '{{YYYYMM}}', '{{YYYY年MM月}}', '{{deadline}}'];

/**
 * 渲染任务名称模板。
 *
 * 支持的占位符：
 *   {{YYYY}}      → 2026
 *   {{MM}}        → 10
 *   {{YYYYMM}}    → 2026-10
 *   {{YYYY年MM月}} → 2026年10月
 *   {{deadline}}  → 2026-10-25
 *
 * 未识别的占位符原样保留（不静默删除），便于管理员发现模板写错。
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
 * 判断某模板在本周期是否「应该生成」。
 *
 * 每日巡检时用此函数过滤，避免给「季/年」周期模板每月都生成任务。
 *
 * @param {object} template  periodic_templates 文档
 * @param {string} periodKey '2026-10'
 * @returns {boolean}
 */
function shouldGenerate(template, periodKey) {
  if (!template || !template.enabled) return false;
  const pk = parsePeriodKey(periodKey);
  if (!pk) return false;

  const periodType = String(template.periodType || 'monthly').toLowerCase();

  // 月度：每月都生成
  if (periodType === 'monthly' || periodType === 'month') return true;

  // 季度：仅在 1/4/7/10 月生成
  if (periodType === 'quarterly' || periodType === 'quarter') {
    return (pk.month - 1) % 3 === 0;
  }

  // 年度：仅在 1 月生成
  if (periodType === 'yearly' || periodType === 'annual' || periodType === 'year') {
    return pk.month === 1;
  }

  // 未识别的周期类型：保守起见不生成，并让调用方记录到日志便于排查
  return false;
}

/**
 * 生成本次巡检的完整执行计划（纯计算，不写库）。
 *
 * @param {Array}  templates 已启用的模板数组
 * @param {string} periodKey
 * @returns {Array<{template, taskName, dueDate, docId, startDate}>}
 */
function buildPlan(templates, periodKey) {
  const { periodicTaskId } = require('./idempotency');
  const plan = [];
  for (const t of templates || []) {
    if (!shouldGenerate(t, periodKey)) continue;
    const dueDate = deadlineOf(t.deadlineRule, periodKey);
    const taskName = renderName(t.taskNameTemplate, { periodKey, deadline: dueDate });
    plan.push({
      template: t,
      taskName,
      dueDate,
      startDate: `${periodKey}-01`,
      docId: periodicTaskId(t._id, periodKey),
    });
  }
  return plan;
}

module.exports = {
  PLACEHOLDERS,
  renderName,
  deadlineOf,
  shouldGenerate,
  buildPlan,
  periodKeyOf,
};
