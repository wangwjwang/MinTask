/**
 * shared/dates.js
 * ---------------------------------------------------------------------------
 * 日期工具。双端共用（小程序端与云函数端均无第三方日期库，故手写）。
 *
 * ★ 关键约定：所有日期一律使用 **YYYY-MM-DD 定长补零** 字符串。
 *   理由：定长补零后字典序 === 时间序，可以直接用字符串比较做范围查询
 *   与排序（如 _.gte('2026-10-01')）。一旦出现 '2026-9-5' 这种非补零写法，
 *   排序与范围查询会立刻错乱。
 * ---------------------------------------------------------------------------
 */

/** 个位数补零 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Date → 'YYYY-MM-DD'（本地时区，非 UTC）。
 * 注意：不能用 toISOString()——那是 UTC，跨时区会差一天。
 * @param {Date|number|string} d
 */
function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 今天 'YYYY-MM-DD' */
function todayStr() {
  return formatDate(new Date());
}

/**
 * Date → 'YYYY-MM'（周期键）。
 * 定长补零，可直接字符串比较与相等匹配，用于周期任务幂等。
 */
function periodKeyOf(d) {
  const date = d instanceof Date ? d : new Date();
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/**
 * 解析 periodKey '2026-10' → { year: 2026, month: 10 }
 */
function parsePeriodKey(periodKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ''));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** 某年某月的天数（处理闰年；month 为 1-12） */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * 校验 'YYYY-MM-DD' 格式且为真实存在的日期。
 * 会拒绝 '2026-02-30' 这类格式正确但不存在的日期。
 */
function isValidDateStr(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(y, mo)) return false;
  return true;
}

/**
 * 比较两个日期字符串。定长补零后等价于时间比较。
 * @returns {number} 负数 a<b，0 相等，正数 a>b
 */
function compareDateStr(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

/**
 * 相对今天的天数差（负数=已逾期）。入参须为 'YYYY-MM-DD'。
 */
function daysFromToday(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  const today = new Date(todayStr() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

/**
 * 用于展示的友好日期：今天 / 明天 / 昨天 / MM-DD / YYYY-MM-DD。
 */
function friendlyDate(dateStr) {
  if (!isValidDateStr(dateStr)) return '';
  const diff = daysFromToday(dateStr);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return dateStr.slice(5); // MM-DD
}

module.exports = {
  pad2,
  formatDate,
  todayStr,
  periodKeyOf,
  parsePeriodKey,
  daysInMonth,
  isValidDateStr,
  compareDateStr,
  daysFromToday,
  friendlyDate,
};
