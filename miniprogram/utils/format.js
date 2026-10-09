/**
 * miniprogram/utils/format.js
 * ---------------------------------------------------------------------------
 * 展示层格式化。页面里不要散落写格式化逻辑，否则同一个字段在
 * 列表页、详情页、看板页的显示口径会慢慢跑偏。
 * ---------------------------------------------------------------------------
 */

const C = require('../shared/constants');
const dates = require('../shared/dates');
const periodic = require('../shared/periodic');
const theme = require('./theme');

/** 状态徽标配色 key */
function statusTone(status) {
  return C.STATUS_TONE[status] || 'idle';
}

/** 阶段徽标配色 key */
function stageTone(stage) {
  return C.STAGE_TONE[stage] || 'idle';
}

/**
 * 截止时间的展示文案与紧急程度。
 * 返回 { text, tone, overdue }
 *   tone: 'danger' 已逾期 | 'warn' 3 天内 | 'idle' 正常
 */
function dueInfo(dueDate, stage) {
  if (!dueDate) return { text: '未设置', tone: 'idle', overdue: false };
  if (stage === '已完成') return { text: dueDate, tone: 'done', overdue: false };

  const diff = dates.daysFromToday(dueDate);
  if (diff === null) return { text: dueDate, tone: 'idle', overdue: false };

  let tone = 'idle';
  let text = dates.friendlyDate(dueDate);

  if (diff < 0) {
    tone = 'danger';
    text = `逾期 ${Math.abs(diff)} 天`;
  } else if (diff === 0) {
    tone = 'danger';
    text = '今天到期';
  } else if (diff <= 3) {
    tone = 'warn';
    text = `${diff} 天后到期`;
  }

  return { text, tone, overdue: diff < 0 };
}

/** 协办人字符串 '张三;李四' → ['张三','李四'] */
function splitCollaborators(str) {
  return String(str || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 协办人展示：超过 max 个折叠为 "张三、李四 等 3 人" */
function collaboratorText(str, max = 2) {
  const arr = splitCollaborators(str);
  if (!arr.length) return '无';
  if (arr.length <= max) return arr.join('、');
  return `${arr.slice(0, max).join('、')} 等 ${arr.length} 人`;
}

/**
 * 时间戳（Date 或服务端时间对象）→ 'MM-DD HH:mm'
 * 云数据库的 serverDate 存的是 Date，小程序端拿到的也是 Date。
 */
function timeAgo(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';

  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;

  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;

  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;

  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 完整时间 'YYYY-MM-DD HH:mm' */
function fullTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return `${dates.formatDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 本周一 00:00（本地时区）。周一才是一周的开始，不是周日。 */
function mondayOfWeek(now) {
  const d = new Date(now === undefined ? Date.now() : now);
  d.setHours(0, 0, 0, 0);
  // getDay()：周日=0 … 周六=6。换算成 周一=0 … 周日=6，再往回退。
  // ★ 用 setDate 而不是减毫秒：跨月、夏令时（部分时区）都由日期运算兜底
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * 「近两周」的时间窗口。
 *
 * @returns {{ since: Date, thisMonday: Date }}
 *   since      = 上周一 00:00 —— 查询下界（>= 它的记录都要）
 *   thisMonday = 本周一 00:00 —— 分「本周 / 上周」的界线
 *
 * ★ 为什么是"上周一"而不是"14 天前"：
 *   用户要看的是「上周 / 本周」，分周必须按自然的周来切；
 *   若下界取 14 天前，星期三查询就会把上上周四~周日也捞进来，
 *   只能靠前端再丢一次，不如一开始就按周对齐。
 */
function twoWeekWindow(now) {
  const thisMonday = mondayOfWeek(now);
  const since = new Date(thisMonday);
  since.setDate(since.getDate() - 7);
  return { since, thisMonday };
}

/** 时间戳 → '周三 14:20'。按周分组后，日期只差"周几、几点" */
function weekdayTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const p = (n) => String(n).padStart(2, '0');
  return `周${w} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 进度条宽度（限制 0-100，防止脏数据撑破布局） */
function progressWidth(progress) {
  const n = Number(progress);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 多久没动就算「可能被忘了」—— 报任务页顶部提醒区的阈值。
 *
 * ★ 为什么不放 shared/constants.js：
 *   放了就要跑 sync-shared，7 个云函数副本全变脏，按仓库纪律得重新部署
 *   全部云函数 —— 为一个纯展示规则付这个代价不值。服务端不需要知道它。
 *   这与 utils/theme.js「分类色不放 shared」是同一条理由。
 *
 * ★ 10 天是 2026-10-03 与用户确认的值，不是拍的。
 */
const STALE_DAYS = 10;

/** 周期性任务不参与提醒：它们本来就按周期做，10 天没动是正常的 */
const PERIODIC_TYPE = '周期性';

/**
 * 把 Date / 'YYYY-MM-DD' 统一成 'YYYY-MM-DD'，认不出返回空串。
 * 三个日期字段的类型不一样：latestProgressAt / createdAt 是 Date 对象，
 * start_date 是字符串，所以要在这里归一。
 */
function toDateStr(value) {
  if (!value) return '';
  if (typeof value === 'string') return dates.isValidDateStr(value) ? value : '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : dates.formatDate(d);
}

/**
 * 久无进展的判据。
 *
 * 基准日三级回退：最新进展时间 → 开始日期 → 创建时间。
 *   · 有进展就只认进展，不再看开始日期（否则一条老任务只要开始得早就永远提醒）；
 *   · 没有进展退回开始日期，好处是**开始日期还没到的任务天然不算**
 *     （天数会是负数），不用为"刚建还没轮到做"另写一条规则；
 *   · 都没有（脏数据）返回 null，宁可不提醒，也不显示成"0 天没动"。
 *
 * 天数用 dates.daysFromToday 算，与卡片上「逾期 N 天」同一套整天口径 ——
 * 不另写一个天数差实现，免得两处对不齐。
 */
function idleInfo(task) {
  const base = toDateStr(task.latestProgressAt)
    || toDateStr(task.start_date)
    || toDateStr(task.createdAt);
  if (!base) return { days: null, stale: false };

  const diff = dates.daysFromToday(base); // 负数=在过去
  if (diff === null) return { days: null, stale: false };

  // diff 为 0 时 -diff 得到 -0，归一成 0（否则这个值会一路带到模板和数据里）
  const days = diff === 0 ? 0 : -diff;
  const stale = days >= STALE_DAYS
    && task.stage !== '已完成'
    && task.task_type !== PERIODIC_TYPE;
  return { days, stale };
}

/**
 * 给任务卡片补上所有展示用派生字段。
 * 所有列表页统一调它，保证卡片显示口径一致。
 */
function decorateTask(task) {
  if (!task) return task;
  const due = dueInfo(task.due_date, task.stage);
  const idle = idleInfo(task);
  return Object.assign({}, task, {
    _statusTone: statusTone(task.status),
    _stageTone: stageTone(task.stage),
    /**
     * 分类展示色（十六进制字面量）。
     * 挂在这里而不是让页面各自取，是因为 WXML 不能调 JS 函数 ——
     * 卡片模板要直接拿它做内联 style。decorateTask 有 8 个调用方，
     * 挂在这里所有调用方自动获得。
     */
    _catColor: theme.categoryColor(task.category),
    _dueText: due.text,
    _dueTone: due.tone,
    _overdue: due.overdue,
    _progressWidth: progressWidth(task.progress),
    _collaboratorText: collaboratorText(task.collaborator),
    _hasBlocker: !!task.hasOpenBlocker,
    /**
     * 距最后一次进展多少天（没有可用日期时为 null）。
     * 天数是**事实**，_stale 是**判断**（还排除了周期性与已完成）——
     * 分开给，页面想显示"30 天没动"时不必重新推导。
     */
    _idleDays: idle.days,
    _stale: idle.stale,
  });
}

/** 批量装饰 */
function decorateTasks(tasks) {
  return (tasks || []).map(decorateTask);
}

// ── 计划（periodic_templates）──────────────────────────────────────────────

/**
 * evaluate 的 reason → 行上的状态标记。
 *
 * ★ 色号刻意克制：只有「周期类型无法识别」用了黄色告警，其余一律中性灰。
 *   红/黄/绿在这个应用里已经全被任务状态占满（受阻/有风险/已完成），
 *   计划的本期过没过不是那种级别的信息 —— 借一个红色过来，
 *   用户会以为计划出事了。
 */
const PLAN_STATE_TEXT = {
  ok: '进行中',
  not_started: '待开始',
  period_expired: '本期已过',
  disabled: '已停用',
  bad_period_type: '周期类型无法识别',
};
const PLAN_STATE_TONE = {
  ok: 'badge--active',
  not_started: 'badge--idle',
  period_expired: 'badge--idle',
  disabled: 'badge--idle',
  bad_period_type: 'badge--warn',
};

/**
 * 给一份计划补上展示用的派生字段。
 *
 * ★ 放在这里而不是各自页面里：「管理我的计划」和任务看板的「周期性计划」段
 *   都要回答同一个问题 —— 这个计划现在处于什么状态、本期从哪天到哪天。
 *   两处各写一份，迟早会一个说"待开始"、另一个已经生成出任务了。
 *
 * 状态取 evaluate().reason（与云函数是同一个函数），日期与任务名则另算 ——
 * evaluate 在 disabled / 认不出周期类型时会短路返回空，而这两种情况下
 * 排期和本期日期恰恰是用户最想看的（"我停掉的那个计划原本是什么节奏"）。
 *
 * @param {object} t      计划（periodic_templates 的一条）
 * @param {string} [today] YYYY-MM-DD，省略即今天。只有测试会显式传
 */
function decoratePlan(t, today) {
  if (!t) return t;
  const day = today || dates.todayStr();
  const type = periodic.normalizePeriodType(t.periodType);
  const periodKey = type ? periodic.periodKeyFor(type, day) : '';
  const span = periodKey ? periodic.periodDates(t, periodKey) : { startDate: '', dueDate: '' };
  const ev = periodic.evaluate(t, day);

  return Object.assign({}, t, {
    _schedule: periodic.describeOffsets(t),
    _taskName: periodKey
      ? periodic.renderName(t.taskNameTemplate, { periodKey, deadline: span.dueDate })
      : '',
    _periodText: periodKey ? `${span.startDate} — ${span.dueDate}` : '',
    _state: ev.reason,
    _stateText: PLAN_STATE_TEXT[ev.reason] || '',
    _stateTone: PLAN_STATE_TONE[ev.reason] || 'badge--idle',
  });
}

/** 批量装饰计划 */
function decoratePlans(plans, today) {
  return (plans || []).map((p) => decoratePlan(p, today));
}

// ── 需求（demands）────────────────────────────────────────────────────────

/**
 * 给一条需求补上展示用的派生字段。
 *
 * ★ 放在 format.js 而不是各页面里：需求池列表与需求详情都要回答
 *   "这条需求现在什么状态、对接的是谁、什么时候提的"，
 *   两处各写一份迟早会一个说"待认领"、另一个已经显示领走人了。
 *
 * ★ 状态色取自 C.DEMAND_STATUS_TONE，认不出的状态兜底 'idle' ——
 *   与 statusTone/stageTone 完全同款：新状态还没加进枚举时，
 *   界面显示成中性灰而不是没有颜色。
 */
function decorateDemand(d) {
  if (!d) return d;

  // 对接部门与对接人拼一行；两个都没有时给空串，让模板整行不渲染
  const contact = [d.contactDept, d.contactName].map((s) => String(s || '').trim()).filter(Boolean);

  return Object.assign({}, d, {
    _statusTone: C.DEMAND_STATUS_TONE[d.status] || 'idle',
    _statusText: d.status || '',
    _contactText: contact.join(' · '),
    // '期望 10月31日' / '' —— 前缀在 JS 里拼，模板不做字符串拼接
    _expectText: d.expectDate ? `期望 ${dates.friendlyDate(d.expectDate)}` : '',
    /**
     * 提出时间用 timeAgo（"刚刚 / 3 天前 / 10月5日"）而不是绝对日期：
     * 需求卡上要回答的是"这条放了多久了"，不是"哪一天提的"。
     */
    _createdText: timeAgo(d.createdAt),
  });
}

/** 批量装饰需求 */
function decorateDemands(list) {
  return (list || []).map(decorateDemand);
}

module.exports = {
  STALE_DAYS,
  statusTone,
  stageTone,
  dueInfo,
  splitCollaborators,
  collaboratorText,
  timeAgo,
  fullTime,
  mondayOfWeek,
  twoWeekWindow,
  weekdayTime,
  progressWidth,
  idleInfo,
  decorateTask,
  decorateTasks,
  decoratePlan,
  decoratePlans,
  decorateDemand,
  decorateDemands,
};
