/**
 * miniprogram/utils/format.js
 * ---------------------------------------------------------------------------
 * 展示层格式化。页面里不要散落写格式化逻辑，否则同一个字段在
 * 列表页、详情页、看板页的显示口径会慢慢跑偏。
 * ---------------------------------------------------------------------------
 */

const C = require('../shared/constants');
const dates = require('../shared/dates');
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

module.exports = {
  STALE_DAYS,
  statusTone,
  stageTone,
  dueInfo,
  splitCollaborators,
  collaboratorText,
  timeAgo,
  fullTime,
  progressWidth,
  idleInfo,
  decorateTask,
  decorateTasks,
};
