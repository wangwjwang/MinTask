/**
 * shared/constants.js
 * ---------------------------------------------------------------------------
 * 全站枚举与常量字典。小程序端与云函数端共用同一份，保证双端语义不漂移。
 *
 * 纪律：本文件必须保持「双端安全」——只用 CommonJS，不得 require 任何
 *      Node 内置模块（fs/path/crypto 在小程序端不存在）。
 * ---------------------------------------------------------------------------
 */

/** 任务分类（11 项） */
const CATEGORY = [
  '系统研发',
  '系统运维',
  '信创改造',
  '数据提取',
  '数据治理',
  '智能体AI开发',
  '安全合规',
  '监管报送',
  '竞赛活动',
  '培训',
  '其他',
];

/**
 * 任务来源（8 项业务来源，不含 period——周期任务用 origin 字段标识）。
 * ★ 第 3 项 2026-10-09 由「业务部门提报」改名为「需求池」。
 *   数组的**长度与顺序都不能动** —— 顺序是 field-picker 高亮下标的依据，
 *   改了顺序所有历史任务的来源都会在界面上显示错位。
 *   库里已有数据的改名见 scripts/make-source-rename-import.js。
 */
const SOURCE = [
  '总行通知',
  '监管检查',
  '需求池',
  '部领导交办',
  '中心领导交办',
  '会议纪要',
  '考评落实',
  '自发创新',
];

/** 任务性质（3 项） */
const TASK_TYPE = ['计划性', '周期性', '临时性'];

/** 周期频率（4 项） */
const RECUR_FREQ = ['每周', '每月', '每季', '每年', '不适用'];

/**
 * 任务状态 —— 「健康度」语义，用于卡片彩色徽标与风险预警。
 * 不要与 STAGE 混淆：STAGE 是「阶段」语义，驱动看板分列。
 */
const STATUS = ['正常', '有风险', '受阻', '已完成'];

/** 任务阶段 —— 「阶段」语义，驱动 Tab3 看板分列 */
const STAGE = ['未开始', '进行中', '已完成'];

/** 优先级（4 项） */
const PRIORITY = ['P0', 'P1', 'P2', 'P3'];

/**
 * 需求状态 —— 需求自己的生命周期，与任务的 STATUS / STAGE 无关。
 *
 * ★ 是**数组**（给 validate.assertEnum 用），不是 ROLE 那样的对象。
 *   写 DEMAND_STATUS.PENDING 会静默得到 undefined，where 条件会变成
 *   "status 等于 undefined" —— 一个不报错、也永远匹配不上的查询。
 */
const DEMAND_STATUS = ['待认领', '已领走', '已完成', '已关闭'];

/**
 * 需求状态 → 徽标配色 key（沿用 app.wxss 的 .badge--{key}）。
 *
 * 语义：
 *   待认领＝蓝色（等着被拿走）
 *   已领走＝黄色（有人在办，还没结论）
 *   已完成＝绿色
 *   已关闭＝灰色（不做也是一种了结，但不需要被庆祝）
 *
 * ★ 复用现有四个 tone，不新增色值。
 */
const DEMAND_STATUS_TONE = {
  待认领: 'active',
  已领走: 'warn',
  已完成: 'done',
  已关闭: 'idle',
};

/** 任务创建方式 —— 与 SOURCE（业务来源）正交，两者都要保留 */
const ORIGIN = {
  MANUAL: 'manual',
  PERIODIC: 'periodic',
};

/** 成员角色 */
const ROLE = {
  NORMAL: '普通',
  ADMIN: '管理员',
  /**
   * 只读角色：不参与报任务 / 改任务，只有查看「任务看板」「人员看板」的权限。
   * ★ 与 ADMIN 是两回事 —— ADMIN 什么都能干，VIEWER 只能看。
   * ★ 服务端由 ctx.requireWriter() 统一拦（前端把入口变灰只是体验，
   *   藏起来不等于安全）；也不允许被选为主办 / 协办。
   */
  VIEWER: '管理者',
};

/**
 * 看板分列顺序。Tab3 按此顺序渲染三列。
 * 顺序即数组顺序，页面不要另行硬编码。
 */
const STAGE_COLUMNS = STAGE;

/**
 * 云数据库单次查询返回条数上限。
 *   小程序端 get() 上限 20，云函数端上限 100。
 *   任何"取全量"的查询都必须分页循环，否则会被静默截断
 *   （不报错，只是少返回数据 —— 这类问题在测试数据少时发现不了）。
 */
const QUERY_BATCH = 100;

/** 小程序端单次查询上限，前端分页循环用 */
const CLIENT_QUERY_BATCH = 20;

/** 集合名集中定义，避免各处硬编码字符串拼错 */
const COLLECTIONS = {
  MEMBERS: 'members',
  TASKS: 'tasks',
  PROGRESS_RECORDS: 'progress_records',
  PERIODIC_TEMPLATES: 'periodic_templates',
  JOB_LOGS: 'job_logs',
  DEMANDS: 'demands',
};

/**
 * 状态 → 徽标配色 key。前端 WXSS 按此 key 取色，不要在页面里散落写颜色。
 * 取值对应 app.wxss 中的 .badge--{key} 类。
 */
const STATUS_TONE = {
  正常: 'ok',
  有风险: 'warn',
  受阻: 'danger',
  已完成: 'done',
};

/** 阶段 → 徽标配色 key */
const STAGE_TONE = {
  未开始: 'idle',
  进行中: 'active',
  已完成: 'done',
};

/** 优先级 → 徽标配色 key */
const PRIORITY_TONE = {
  P0: 'danger',
  P1: 'warn',
  P2: 'active',
  P3: 'idle',
};

module.exports = {
  CATEGORY,
  SOURCE,
  TASK_TYPE,
  RECUR_FREQ,
  STATUS,
  STAGE,
  PRIORITY,
  DEMAND_STATUS,
  DEMAND_STATUS_TONE,
  ORIGIN,
  ROLE,
  STAGE_COLUMNS,
  COLLECTIONS,
  QUERY_BATCH,
  CLIENT_QUERY_BATCH,
  STATUS_TONE,
  STAGE_TONE,
  PRIORITY_TONE,
};
