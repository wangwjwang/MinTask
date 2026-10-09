/**
 * shared/validate.js
 * ---------------------------------------------------------------------------
 * 入参校验与字段白名单。双端共用（前端做即时提示，云函数做强制拦截）。
 *
 * ★ 白名单是防越权写入的核心机制：
 *   任何不在白名单里的字段，云函数一律丢弃，前端永远改不动。
 *   以下字段**刻意不出现在任何白名单中**：
 *     leaderId / creatorId / updaterId / leader / collaborator
 *     createdAt / updatedAt / hasOpenBlocker / latestProgressAt
 *   它们是服务端派生字段，只能由云函数按 openid 与 members 解析后写入。
 * ---------------------------------------------------------------------------
 */

const C = require('./constants');
const { BizError, Codes } = require('./errors');
const { isValidDateStr } = require('./dates');

/** 从对象中挑选指定字段（丢弃 undefined，保留 null 与空串以便清空字段） */
function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * 任务创建时允许前端提交的字段。
 * 注意：不含 leaderId —— 创建者强制成为主办人（管理员代建走单独 action）。
 */
const TASK_CREATE_FIELDS = [
  'task_name',
  'category',
  'source',
  'task_type',
  'recur_freq',
  'recur_rule',
  'priority',
  'progress',
  'start_date',
  'due_date',
  'detail',
  'collaboratorIds', // 服务端会校验、去重、剔除 leaderId，并据此重建姓名快照
];

/**
 * 主办人可修改的任务字段。
 * 比创建多出 status / stage / actualCompleteTime（这三个是"推进中"才会变的）。
 */
const TASK_LEADER_UPDATE_FIELDS = [
  'task_name',
  'category',
  'source',
  'task_type',
  'recur_freq',
  'recur_rule',
  'priority',
  'progress',
  'start_date',
  'due_date',
  'detail',
  'collaboratorIds',
  'status',
  'stage',
  'actualCompleteTime',
];

/** 进展记录：主办人与协办人都可提交的字段 */
const PROGRESS_BASE_FIELDS = ['description', 'blocker', 'needSupport'];

/**
 * 进展记录：**仅主办人**可提交的字段。
 * 协办人若在请求中携带这些字段，云函数返回 FORBIDDEN_FIELD，
 * 而不是静默丢弃——静默丢弃会让越权尝试不留痕迹。
 */
const PROGRESS_LEADER_EXTRA_FIELDS = ['progress', 'status', 'stage'];

/**
 * 需求创建时允许前端提交的字段。
 * ★ 不含 status / proposerId / proposerName / claimedBy* / closedBy* ——
 *   它们是服务端派生字段，只能由云函数按 openid 与成员档案写入。
 *   提出人与领走人若能被前端指定，权限判据（perm.canEditDemand）就形同虚设。
 */
const DEMAND_CREATE_FIELDS = ['title', 'detail', 'contactDept', 'contactName', 'expectDate'];

/** 需求可修改的字段 —— 与创建完全一致，需求没有"推进中才会变"的字段 */
const DEMAND_UPDATE_FIELDS = DEMAND_CREATE_FIELDS;

/** 校验枚举值是否合法 */
function assertEnum(value, allowed, fieldLabel) {
  if (allowed.indexOf(value) === -1) {
    throw new BizError(
      Codes.INVALID_PARAM,
      `${fieldLabel}取值不合法：${value}（应为 ${allowed.join('/')} 之一）`
    );
  }
  return value;
}

/** 校验必填字符串 */
function assertNonEmptyString(value, fieldLabel, maxLen) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BizError(Codes.INVALID_PARAM, `${fieldLabel}不能为空`);
  }
  const v = value.trim();
  if (maxLen && v.length > maxLen) {
    throw new BizError(Codes.INVALID_PARAM, `${fieldLabel}长度不能超过 ${maxLen} 字`);
  }
  return v;
}

/** 校验日期格式（可空：空串/null 视为清空，直接放行） */
function assertDateOrEmpty(value, fieldLabel) {
  if (value === '' || value === null || value === undefined) return '';
  if (!isValidDateStr(value)) {
    throw new BizError(Codes.INVALID_PARAM, `${fieldLabel}格式应为 YYYY-MM-DD`);
  }
  return value;
}

/** 校验并要求为合法日期 */
function assertDateRequired(value, fieldLabel) {
  if (!isValidDateStr(value)) {
    throw new BizError(Codes.INVALID_PARAM, `${fieldLabel}不能为空且格式应为 YYYY-MM-DD`);
  }
  return value;
}

/** 校验进度为 0-100 的整数 */
function assertProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new BizError(Codes.INVALID_PARAM, '进度应为 0-100 之间的数字');
  }
  return Math.round(n);
}

/**
 * 校验并规范化协办人 openid 数组。
 * 规则：去重、剔除空值、剔除主办人自己（主办人不需要出现在协办名单里）。
 */
function normalizeIds(ids, excludeId) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id) continue;
    if (id === excludeId) continue;
    if (out.indexOf(id) !== -1) continue;
    out.push(id);
  }
  return out;
}

/**
 * 校验任务创建/更新的业务字段。返回规范化后的对象。
 * 只做「字段级」校验，不涉及权限（权限在 ctx 里判）。
 */
function validateTaskFields(input, { isCreate }) {
  const allowed = isCreate ? TASK_CREATE_FIELDS : TASK_LEADER_UPDATE_FIELDS;
  const raw = pick(input, allowed);
  const out = {};

  if ('task_name' in raw) out.task_name = assertNonEmptyString(raw.task_name, '任务名称', 100);
  if ('category' in raw) out.category = assertEnum(raw.category, C.CATEGORY, '任务分类');
  if ('source' in raw) out.source = assertEnum(raw.source, C.SOURCE, '任务来源');
  if ('task_type' in raw) out.task_type = assertEnum(raw.task_type, C.TASK_TYPE, '任务性质');
  if ('recur_freq' in raw) out.recur_freq = assertEnum(raw.recur_freq, C.RECUR_FREQ, '周期频率');
  if ('priority' in raw) out.priority = assertEnum(raw.priority, C.PRIORITY, '优先级');
  if ('status' in raw) out.status = assertEnum(raw.status, C.STATUS, '任务状态');
  if ('stage' in raw) out.stage = assertEnum(raw.stage, C.STAGE, '任务阶段');

  if ('progress' in raw) out.progress = assertProgress(raw.progress);
  if ('start_date' in raw) out.start_date = assertDateOrEmpty(raw.start_date, '计划开始时间');
  if ('due_date' in raw) out.due_date = assertDateOrEmpty(raw.due_date, '计划截止时间');
  if ('actualCompleteTime' in raw) {
    out.actualCompleteTime = assertDateOrEmpty(raw.actualCompleteTime, '实际完成时间');
  }

  // 自由文本字段，限制长度防止超长内容撑爆文档
  if ('detail' in raw) out.detail = String(raw.detail || '').slice(0, 2000);
  if ('recur_rule' in raw) out.recur_rule = String(raw.recur_rule || '').slice(0, 200);

  // collaboratorIds 单独处理：需要知道 leaderId 才能剔除，故由调用方传入排除项
  if ('collaboratorIds' in raw) out.__rawCollaboratorIds = raw.collaboratorIds;

  return out;
}

/**
 * 创建任务的必填项校验（在 validateTaskFields 之后调用）。
 */
function assertTaskRequiredForCreate(fields) {
  if (!fields.task_name) throw new BizError(Codes.INVALID_PARAM, '任务名称不能为空');
  if (!fields.category) throw new BizError(Codes.INVALID_PARAM, '请选择任务分类');
  if (!fields.due_date) throw new BizError(Codes.INVALID_PARAM, '计划截止时间不能为空');
  if (!fields.source) throw new BizError(Codes.INVALID_PARAM, '请选择任务来源');
  if (!fields.task_type) throw new BizError(Codes.INVALID_PARAM, '请选择任务性质');
  return fields;
}

/**
 * 校验需求创建/更新的业务字段。返回规范化后的对象。
 * 只做「字段级」校验，不涉及权限（权限在云函数里走 perm.canEditDemand）。
 */
function validateDemandFields(input, { isCreate }) {
  const allowed = isCreate ? DEMAND_CREATE_FIELDS : DEMAND_UPDATE_FIELDS;
  const raw = pick(input, allowed);
  const out = {};

  if ('title' in raw) out.title = assertNonEmptyString(raw.title, '需求标题', 100);
  if ('expectDate' in raw) out.expectDate = assertDateOrEmpty(raw.expectDate, '期望时间');

  // 自由文本字段，限制长度防止超长内容撑爆文档
  if ('detail' in raw) out.detail = String(raw.detail || '').slice(0, 2000);
  if ('contactDept' in raw) out.contactDept = String(raw.contactDept || '').slice(0, 50);
  if ('contactName' in raw) out.contactName = String(raw.contactName || '').slice(0, 50);

  return out;
}

/** 创建需求的必填项校验（在 validateDemandFields 之后调用） */
function assertDemandRequiredForCreate(fields) {
  if (!fields.title) throw new BizError(Codes.INVALID_PARAM, '需求标题不能为空');
  return fields;
}

module.exports = {
  pick,
  TASK_CREATE_FIELDS,
  TASK_LEADER_UPDATE_FIELDS,
  PROGRESS_BASE_FIELDS,
  PROGRESS_LEADER_EXTRA_FIELDS,
  DEMAND_CREATE_FIELDS,
  DEMAND_UPDATE_FIELDS,
  validateDemandFields,
  assertDemandRequiredForCreate,
  assertEnum,
  assertNonEmptyString,
  assertDateOrEmpty,
  assertDateRequired,
  assertProgress,
  normalizeIds,
  validateTaskFields,
  assertTaskRequiredForCreate,
};
