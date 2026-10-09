/**
 * shared/errors.js
 * ---------------------------------------------------------------------------
 * 统一错误码与业务异常。双端共用。
 *
 * 约定：
 *   - 云函数只抛出 BizError；非 BizError 一律被 router 兜底为 INTERNAL
 *     并打印完整堆栈到云函数日志，但不把内部细节返回给前端。
 *   - 前端按 code 做统一处理（见 miniprogram/utils/api.js 的 handleError）。
 * ---------------------------------------------------------------------------
 */

/** 错误码字典。新增错误码时同步补充 MESSAGES 与前端提示文案。 */
const Codes = {
  /** getWXContext().OPENID 为空（非小程序环境调用） */
  NO_IDENTITY: 'NO_IDENTITY',
  /** openid 已拿到，但尚未认领成员身份 */
  NOT_CLAIMED: 'NOT_CLAIMED',
  /** 目标成员已被他人认领 */
  MEMBER_TAKEN: 'MEMBER_TAKEN',
  /** 当前 openid 已绑定其他成员，不能再认领 */
  ALREADY_CLAIMED_OTHER: 'ALREADY_CLAIMED_OTHER',
  /** 成员不存在 */
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  /** 非主办人却尝试执行主办人专属操作 */
  FORBIDDEN_NOT_LEADER: 'FORBIDDEN_NOT_LEADER',
  /** 非主办人也非协办人 */
  FORBIDDEN_NOT_PARTICIPANT: 'FORBIDDEN_NOT_PARTICIPANT',
  /** 非管理员 */
  FORBIDDEN_ADMIN: 'FORBIDDEN_ADMIN',
  /** 只读角色（管理者）尝试执行写操作 */
  FORBIDDEN_VIEWER: 'FORBIDDEN_VIEWER',
  /** 协办人尝试提交 progress/status/stage 等主办人专属字段 */
  FORBIDDEN_FIELD: 'FORBIDDEN_FIELD',
  /** 任务不存在 */
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  /** 进展记录不存在 */
  RECORD_NOT_FOUND: 'RECORD_NOT_FOUND',
  /** 参数校验失败（枚举越界、格式错误、必填缺失） */
  INVALID_PARAM: 'INVALID_PARAM',
  /** action 路由未命中 */
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  /** 未预期异常 */
  INTERNAL: 'INTERNAL',
};

/** 默认中文文案。云函数抛出时可覆盖 message 提供更具体的说明。 */
const MESSAGES = {
  [Codes.NO_IDENTITY]: '无法识别身份，请在微信内打开',
  [Codes.NOT_CLAIMED]: '请先认领你的姓名',
  [Codes.MEMBER_TAKEN]: '该成员已被他人认领，请刷新后重试',
  [Codes.ALREADY_CLAIMED_OTHER]: '你已绑定其他成员，如需变更请联系管理员',
  [Codes.MEMBER_NOT_FOUND]: '成员不存在',
  [Codes.FORBIDDEN_NOT_LEADER]: '仅主办人可执行此操作',
  [Codes.FORBIDDEN_NOT_PARTICIPANT]: '仅主办人或协办人可执行此操作',
  [Codes.FORBIDDEN_ADMIN]: '仅管理员可执行此操作',
  [Codes.FORBIDDEN_VIEWER]: '管理者账号只有查看权限',
  [Codes.FORBIDDEN_FIELD]: '协办人无权修改进度与状态',
  [Codes.TASK_NOT_FOUND]: '任务不存在或已被删除',
  [Codes.RECORD_NOT_FOUND]: '进展记录不存在',
  [Codes.INVALID_PARAM]: '参数不合法',
  [Codes.UNKNOWN_ACTION]: '未知操作',
  [Codes.INTERNAL]: '服务异常，请稍后重试',
};

/**
 * 业务异常。只有这类异常的信息会被原样返回给前端。
 */
class BizError extends Error {
  /**
   * @param {string} code     Codes 中的错误码
   * @param {string} [message] 自定义中文提示，缺省取 MESSAGES[code]
   */
  constructor(code, message) {
    super(message || MESSAGES[code] || '操作失败');
    this.name = 'BizError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 部署期基础设施错误的识别与翻译
// ---------------------------------------------------------------------------

/** 本项目的全部集合，用于在错误提示里给出可执行的清单 */
const ALL_COLLECTIONS = [
  'members',
  'tasks',
  'progress_records',
  'periodic_templates',
  'job_logs',
  'demands',
];

/** 把任意异常拼成一段可做关键字匹配的文本 */
function rawText(e) {
  if (!e) return '';
  return [e.errCode, e.errMsg, e.message, e.code, e.name]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join(' | ');
}

/**
 * 数据库 SDK 在 collection 上的方法名。
 *
 * ★ 为什么必须排除它们：
 *   微信对"集合不存在"的报错文本是 `collection.get:fail ...` ——
 *   这里的 get 是**方法名**，不是集合名。
 *   第一版只取 `collection.` 后的第一个词，于是提示用户去建一个叫「get」的集合。
 *   宁可提不出名字，也绝不能报一个错的：错的会把人引到完全无关的方向。
 */
const SDK_METHODS = new Set([
  'get', 'add', 'count', 'doc', 'where', 'field', 'limit', 'skip',
  'orderby', 'remove', 'update', 'watch', 'aggregate', 'group', 'set',
]);

/** 也不该被当成集合名的词 */
const NOT_A_NAME = /^(not|does|is|the|fail)$/i;

/**
 * 从错误文本里尽力提取集合名。提取不出返回空串，由调用方兜底。
 *
 * 错误文本存在多种形态：
 *   `collection.get:fail ...`          → 只有方法名，提不出集合
 *   `collection.members not exists`    → 能提到
 *   `[ResourceNotFound] Db or Table not exist` → 提不到
 * 所以这里做全局扫描，取第一个**不是方法名**的候选，
 * 而不是盲取第一个匹配 —— 后者会在 `collection.get:fail collection.members ...`
 * 这类混合形态里错过真正的名字。
 *
 * ★ 分隔符只认 `.` 和 `:`。若把空格也算上，`collection not exists`
 *   会被解析成集合名 "not"。
 */
function extractCollectionName(text) {
  const re = /collection[.:]([A-Za-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (SDK_METHODS.has(name.toLowerCase())) continue;
    if (NOT_A_NAME.test(name)) continue;
    return name;
  }
  return '';
}

/**
 * "集合不存在"在错误文本里的各种写法。
 *
 * 微信同一个错误在不同版本/调用形态下文案不一致，实测见过：
 *   -502005 database collection not exists
 *   collection.get:fail database collection not exists
 *   [ResourceNotFound] Db or Table not exist
 *   collection.members not exists
 * 逐条列出而不是用一条宽松的正则，是为了**宁可漏判也不误判** ——
 * 漏判只是退回"服务异常"，误判会把别的错误说成"集合不存在"。
 */
const COLLECTION_MISSING_PATTERNS = [
  /-502005/,
  /collection not exists/i,
  /collection[.:][A-Za-z0-9_]+\s+not\s+exist/i,
  /Db or Table not exist/i,
  /ResourceNotFound/i,
];

function isCollectionMissing(text) {
  return COLLECTION_MISSING_PATTERNS.some((re) => re.test(text));
}

/**
 * 识别"部署没做完"类错误，翻译成可执行的中文提示。
 *
 * ★ 为什么需要它：
 *   集合没建、依赖没装、云函数部署到了另一个环境 —— 这些跟业务无关，
 *   纯粹是部署步骤缺了一步。它们在云函数里就是普通异常，会被 router
 *   兜底成「服务异常，请稍后重试」。而使用者拿着这句话只会反复重试，
 *   真正该做的是回控制台补一步。这和 utils/api.js 处理 -601034 是同一个判断：
 *   错误码本身不携带可用信息时，由知道上下文的一方补上。
 *
 * ★ 为什么这一类可以回传前端（router 对其他未预期异常只进日志）：
 *   它们只在"部署不完整"时出现，那一刻整个小程序没有任何可用功能，
 *   不存在需要保护的业务数据；而提示的可读性对部署者价值极高。
 *   注意仍然只暴露**结构**（哪个集合缺了），绝不暴露任何记录内容。
 *
 * @returns {BizError|null} 不认识则返回 null，交回调用方按 INTERNAL 处理
 */
function describeInfraError(e) {
  const text = rawText(e);

  // ① 集合不存在。
  //    注意这里有个高频陷阱：云函数用 DYNAMIC_CURRENT_ENV，即"跟随部署环境"。
  //    如果函数传到了 A 环境、小程序 config.js 却指向 B 环境，
  //    函数就会去 A 里找集合 —— 而集合建在 B 里。表现与"忘了建集合"一模一样。
  if (isCollectionMissing(text)) {
    // ★ 优先信 e.collectionName —— 由 ctx.js 在发起查询处打上（见 taggedQuery）。
    //   从错误文本里提取只是退路：微信的报错常常压根不含集合名
    //   （`collection.get:fail` 里 get 是方法不是集合），
    //   而"到底该建哪个集合"恰恰是使用者唯一想知道的事。
    const name = (e && e.collectionName) || extractCollectionName(text);
    return new BizError(
      Codes.INTERNAL,
      name
        ? `数据库集合「${name}」不存在。两种可能：① 还没创建；② 云函数被部署到了另一个环境（云函数跟随部署环境，不是 config.js 里的 envId）。详见 README 3.4。`
        : `数据库集合不存在。请确认已创建 ${ALL_COLLECTIONS.join(' / ')}，且云函数与本小程序在同一个环境。详见 README 3.4。`
    );
  }

  // ② 云函数依赖没装。用「上传并更新文件」而非「云端安装依赖」时会这样。
  if (/Cannot find module ['"]?wx-server-sdk/i.test(text)) {
    return new BizError(
      Codes.INTERNAL,
      '云函数依赖未安装：请右键该云函数，选择「上传并部署：云端安装依赖」，不要选「上传并更新文件」。'
    );
  }

  // ③ 数据库层拒绝访问。云函数以管理员身份运行、本不受安全规则约束，
  //    所以出现它通常意味着集合属于另一个环境或已被删除。
  if (/-502001/.test(text) || /permission denied|DATABASE_PERMISSION_DENIED/i.test(text)) {
    return new BizError(
      Codes.INTERNAL,
      '云函数访问数据库被拒绝。请确认集合存在，且云函数与本小程序在同一个云开发环境。'
    );
  }

  return null;
}

module.exports = { Codes, MESSAGES, BizError, describeInfraError, ALL_COLLECTIONS };
