/**
 * miniprogram/utils/format.js
 * ---------------------------------------------------------------------------
 * 展示层格式化。页面里不要散落写格式化逻辑，否则同一个字段在
 * 列表页、详情页、看板页的显示口径会慢慢跑偏。
 * ---------------------------------------------------------------------------
 */

const C = require('../shared/constants');
const dates = require('../shared/dates');

/** 状态徽标配色 key */
function statusTone(status) {
  return C.STATUS_TONE[status] || 'idle';
}

/** 阶段徽标配色 key */
function stageTone(stage) {
  return C.STAGE_TONE[stage] || 'idle';
}

/** 优先级徽标配色 key */
function priorityTone(priority) {
  return C.PRIORITY_TONE[priority] || 'idle';
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
 * 给任务卡片补上所有展示用派生字段。
 * 所有列表页统一调它，保证卡片显示口径一致。
 */
function decorateTask(task) {
  if (!task) return task;
  const due = dueInfo(task.due_date, task.stage);
  return Object.assign({}, task, {
    _statusTone: statusTone(task.status),
    _stageTone: stageTone(task.stage),
    _priorityTone: priorityTone(task.priority),
    _dueText: due.text,
    _dueTone: due.tone,
    _overdue: due.overdue,
    _progressWidth: progressWidth(task.progress),
    _collaboratorText: collaboratorText(task.collaborator),
    _hasBlocker: !!task.hasOpenBlocker,
  });
}

/** 批量装饰 */
function decorateTasks(tasks) {
  return (tasks || []).map(decorateTask);
}

module.exports = {
  statusTone,
  stageTone,
  priorityTone,
  dueInfo,
  splitCollaborators,
  collaboratorText,
  timeAgo,
  fullTime,
  progressWidth,
  decorateTask,
  decorateTasks,
};
