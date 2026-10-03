/**
 * cloudfunctions/templateService/index.js
 * ---------------------------------------------------------------------------
 * 周期计划服务。
 *
 * ★ 语义（2026-10-03 改造后的定论）：
 *   用户在表单里选「任务性质 = 周期性」时，建的是一份**计划**（模板），
 *   不是任务。系统在**本期开始日那天**自动生成当期任务，任务名形如
 *   「2026年10月写报告」，与手工建的任务同构。
 *
 * ★ 权限：与新建任务一致，不再"仅管理员"。
 *   任何人可以建自己的计划；只能改 / 停用 / 删自己建的（ownerId 比对 openid）；
 *   管理员可以管全部。管理者（只读角色）在建计划的第一步就被
 *   ctx.requireWriter() 挡下 —— 不用在每个 action 里重复判角色。
 *
 * ★ 归属判据是 ownerId（主办人），不是"创建人"：
 *   计划是「谁主办谁负责」的东西，生成出来的任务也落在主办人头上。
 *   管理员替别人建一份并指派主办之后，该由那个人自己维护。
 *
 * action 一览：
 *   list         我的计划（管理员为全部）
 *   listAll      全体成员的计划（任务看板那一段用，不看归属）
 *   get          按 _id 读一份（看板上点开一条计划；不存在返回 null）
 *   create       新建计划（建完若已到本期开始日，立即生成当期任务）
 *   update       修改计划
 *   toggle       启用 / 停用
 *   delete       删除计划（只删计划，已生成的历史任务不动）
 *   generateNow  立即生成（管理员，幂等；asOf 可补跑历史周期）
 *   preview      预演：不写库，只返回"会生成什么"
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { COLLECTIONS, CATEGORY, SOURCE, PRIORITY, ROLE, QUERY_BATCH } = require('./lib/shared/constants');
const validate = require('./lib/shared/validate');
const { runGenerate } = require('./lib/shared/periodicRunner');
const { isValidDateStr } = require('./lib/shared/dates');
const perm = require('./lib/shared/perm');
const { MONTHS_PER_PERIOD, NAME_PREFIX, evaluate } = require('./lib/shared/periodic');

const TEMPLATES = COLLECTIONS.PERIODIC_TEMPLATES;

/** 表单里会碰「排期」的字段。改到其中任何一个，都要整体重算并校验。 */
const SCHEDULE_FIELDS = ['periodType', 'startMonthIdx', 'startDay', 'endMonthIdx', 'endDay'];

// ---------------------------------------------------------------------------
// 参数读取
// ---------------------------------------------------------------------------

/** 周期类型必须是月/季/年之一（自然月/自然季/自然年，跨度固定不可配置）。 */
function readPeriodType(v) {
  const t = String(v === undefined || v === null || v === '' ? 'monthly' : v).toLowerCase();
  if (!MONTHS_PER_PERIOD[t]) {
    throw new BizError(Codes.INVALID_PARAM, '周期类型应为 monthly / quarterly / yearly 之一');
  }
  return t;
}

/**
 * 校验并归一化「期内偏移」，返回 { startMonthIdx, startDay, endMonthIdx, endDay }。
 *
 *   月度：第几号开始、第几号截止
 *   季度：本季度第几个月的几号（开始、截止各两个数）
 *   年度：本年度几月的几号（同上）
 *
 * ★ 边界用「期内的偏移」比大小，不用算出来的绝对日期比。
 *   因为绝对日期会被"当月没有 31 号"收敛到月末：2 月的 30 号和 31 号
 *   都会变成 28 号，用绝对日期比就分不出 30>25 这种越界配置到底合不合法。
 *   偏移的比较与具体是哪个月无关，因此对每一期都成立。
 *
 * @param {object} src 可以是整份 payload，也可以是「改完之后的样子」
 */
function readOffsets(periodType, src) {
  const span = MONTHS_PER_PERIOD[periodType];
  const s = src || {};

  const monthIdx = (v, dft) => {
    if (v === undefined || v === null || v === '') return dft;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > span) {
      throw new BizError(Codes.INVALID_PARAM, `本期共 ${span} 个月，月份序号应为 1-${span}`);
    }
    return n;
  };
  const dayOf = (v, dft, label) => {
    if (v === undefined || v === null || v === '') return dft;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      throw new BizError(Codes.INVALID_PARAM, `${label}应为 1-31 之间的整数`);
    }
    return n;
  };

  const out = {
    startMonthIdx: monthIdx(s.startMonthIdx, 1),
    startDay: dayOf(s.startDay, 1, '开始日'),
    endMonthIdx: monthIdx(s.endMonthIdx, span),
    endDay: dayOf(s.endDay, 31, '截止日'),
  };
  if (
    out.startMonthIdx > out.endMonthIdx ||
    (out.startMonthIdx === out.endMonthIdx && out.startDay > out.endDay)
  ) {
    throw new BizError(Codes.INVALID_PARAM, '开始日不能晚于截止日');
  }
  return out;
}

/** 把 asOf 读成 'YYYY-MM-DD'；没给返回 undefined（表示按真实今天算）。 */
function readAsOf(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (!isValidDateStr(s)) {
    throw new BizError(Codes.INVALID_PARAM, '日期格式应为 YYYY-MM-DD，如 2026-09-05');
  }
  return s;
}

// ---------------------------------------------------------------------------

/**
 * 计划列表。
 *
 * ★ 不做额外的角色闸门：非管理员一律只看得到自己的，而管理者建不了计划，
 *   所以管理者调 list 得到的是空表 —— 挡不挡结果一样，不如少一层判断。
 */
async function list(payload, ctx) {
  const me = await ctx.requireMember();
  const filter = me.role === ROLE.ADMIN ? {} : { ownerId: ctx.openid };
  const r = await ctx.db
    .collection(TEMPLATES)
    .where(filter)
    .orderBy('createdAt', 'desc')
    .limit(QUERY_BATCH)
    .get();
  return { list: r.data || [] };
}

/**
 * 全部计划，不看归属 —— 任务看板最左那一段「周期性计划」用它。
 *
 * ★ 与 list 的分工：list 是「管理我的计划」的数据源，"我的"就是那个页面的
 *   语义，不能为了看板把它放开；这里则是"现在有哪些计划"的全貌。
 *   合并成一个动作会让两个页面里至少一个拿到错的范围。
 *
 * ★ 闸门只要 requireMember，管理员/普通成员/管理者一视同仁。
 *   任务看板是管理者（只读）能看的两块看板之一，若这里按 requireWriter 挡，
 *   那一段对他就永远是空的；而计划里没有任何任务里没有的东西
 *   （名字、主办、分类、排期），看板本来就把所有人的任务摊开给人看。
 *
 * ★ 停用的计划照样返回：这是"有哪些计划"的清单，不是"正在跑哪些"。
 *   少一条会让人以为计划被删了；停用与否由前端的状态徽标说清楚。
 */
async function listAll(payload, ctx) {
  await ctx.requireMember();
  const r = await ctx.db
    .collection(TEMPLATES)
    .orderBy('createdAt', 'desc')
    .limit(QUERY_BATCH)
    .get();
  return { list: r.data || [] };
}

/**
 * 读一份计划（按 _id）—— 从看板上点开那一条时走这里。
 *
 * ★ 为什么不能继续让前端从 list 里翻：看板上点开的那份计划，多半**不是
 *   自己建的**，而 list 对非管理员只返回自己建的那些 —— 于是在列表里找不到，
 *   被当成「计划已被删除」。单条读取是"看别人的计划"这件事唯一说得通的数据源。
 *
 * ★ 闸门与 listAll 同一条：requireMember。能进任务看板的人就能看计划详情 ——
 *   这里没有任何 listAll 没有的东西（listAll 本来就把同一批文档成批返回）。
 *   管理者（只读）照常能读；写操作在 update / toggle / delete 里另有
 *   requireWriter + assertCanManage 把关。
 *
 * ★ 不存在返回 { template: null }，不抛错：
 *   这条路径上的"没有"十有八九是**刚被别人删了**（看板上的名单是几秒前拉的），
 *   属于正常竞态而不是异常。若写成异常，前端只能靠错误码去猜"是没找到、
 *   还是网炸了" —— 那两句话对用户是两回事：一个是"计划没了"，
 *   一个是"你重试一下"。
 */
async function get(payload, ctx) {
  await ctx.requireMember();
  const templateId = validate.assertNonEmptyString(payload.templateId, '计划');
  const r = await ctx.db.collection(TEMPLATES).doc(templateId).get().catch(() => null);
  return { template: (r && r.data) || null };
}

/**
 * 新建计划。
 *
 * ★ 任务名前缀由**服务端**拼（NAME_PREFIX[periodType] + name），不接收前端拼好的
 *   模板字符串：前缀是"这个计划多久一次"的表达，与 periodType 必须一致。
 *   前端只提交裸名字（如「写报告」），实时预览用同一份 NAME_PREFIX 渲染，
 *   因此预览与最终落库不会漂。
 */
async function create(payload, ctx) {
  const me = await ctx.requireWriter();

  const name = validate.assertNonEmptyString(payload.name, '计划名称', 60);
  const periodType = readPeriodType(payload.periodType);
  const offsets = readOffsets(periodType, payload);

  // ── 主办人 ────────────────────────────────────────────────────────
  // 普通成员建的只能是自己的：payload.ownerId 根本不读。
  // 管理员可以替别人建并指派（前端已按此隐藏/显示选人控件）。
  let ownerId = ctx.openid;
  if (payload.ownerId && me.role === ROLE.ADMIN) {
    ownerId = validate.assertNonEmptyString(payload.ownerId, '主办人');
  }

  const owners = await ctx.resolveMembers([ownerId]);
  if (!owners.length) throw new BizError(Codes.MEMBER_NOT_FOUND, '主办人不存在或尚未认领该成员');
  ctx.assertAssignable(owners, '主办人');

  const collaboratorIds = validate.normalizeIds(payload.collaboratorIds, ownerId);
  const collaboratorMembers = await ctx.resolveMembers(collaboratorIds);
  if (collaboratorMembers.length !== collaboratorIds.length) {
    throw new BizError(Codes.INVALID_PARAM, '协办人中包含不存在的成员');
  }
  ctx.assertAssignable(collaboratorMembers, '协办人');

  const doc = {
    name,
    periodType: periodType,
    startMonthIdx: offsets.startMonthIdx,
    startDay: offsets.startDay,
    endMonthIdx: offsets.endMonthIdx,
    endDay: offsets.endDay,
    taskNameTemplate: NAME_PREFIX[periodType] + name,
    ownerId,
    ownerName: owners[0].name,
    collaboratorIds,
    collaboratorNames: collaboratorMembers.map((m) => m.name),
    enabled: payload.enabled !== false,

    // 生成任务时的默认值。★ 分类/来源/优先级一律严格校验，不做"越界就退回默认值"
    // —— 表单只可能提交合法值，越界说明是客户端 bug 或被改过的请求，
    // 静默兜底会让一份配错的计划从此每个月生成分类错误的任务。
    category: validate.assertEnum(payload.category || '其他', CATEGORY, '任务分类'),
    source: validate.assertEnum(payload.source || '自发创新', SOURCE, '任务来源'),
    // 周期计划生成的任务，性质恒为「周期性」，不给配置项以免配出矛盾组合
    taskType: '周期性',
    priority: validate.assertEnum(payload.priority || 'P2', PRIORITY, '优先级'),
    detail: String(payload.detail || '').slice(0, 2000),

    createdAt: ctx.db.serverDate(),
    updatedAt: ctx.db.serverDate(),
  };

  const res = await ctx.db.collection(TEMPLATES).add({ data: doc });

  // ── 建完立即生成 ──────────────────────────────────────────────────
  // 「本期的开始日」这个概念对季度/年度同样成立：季度计划填「本季度第 1 个月
  // 5 号开始」，那 7 月 5 日就是本期的开始日。evaluate 统一算，这里不重写一份。
  const saved = Object.assign({ _id: res._id }, doc);
  const now = new Date();
  const due = evaluate(saved, now);

  const result = await runGenerate(ctx.db, {
    today: now,
    templateId: res._id,
    operator: ctx.openid,
  });

  return {
    _id: res._id,
    periodKey: due.periodKey,
    startDate: due.startDate,
    dueDate: due.dueDate,
    taskName: due.taskName,
    reason: due.reason,
    created: result.created[0] || null,
  };
}

async function update(payload, ctx) {
  await ctx.requireWriter();
  const templateId = validate.assertNonEmptyString(payload.templateId, '计划');
  const cur = await getTemplate(ctx, templateId);
  await assertCanManage(cur, ctx);

  const patch = payload.patch || {};
  const data = {};

  // ── 先把"改完之后的样子"合出来，再整体校验 ────────────────────────
  //   ★ 必须整体校验：把 periodType 从 yearly 改成 monthly 时，只校验 patch 里带
  //     的字段会漏掉"原来的 startMonthIdx=6 在月度下非法"这类跨字段冲突。
  const nextType =
    patch.periodType === undefined ? readPeriodType(cur.periodType) : readPeriodType(patch.periodType);

  const touchesSchedule = SCHEDULE_FIELDS.some((k) => patch[k] !== undefined);
  if (touchesSchedule) {
    const merged = {};
    for (const k of SCHEDULE_FIELDS) merged[k] = patch[k] === undefined ? cur[k] : patch[k];
    const offsets = readOffsets(nextType, merged);
    data.periodType = nextType;
    data.startMonthIdx = offsets.startMonthIdx;
    data.startDay = offsets.startDay;
    data.endMonthIdx = offsets.endMonthIdx;
    data.endDay = offsets.endDay;
  }

  // 改名或改周期类型都要重拼任务名前缀 —— 前缀是周期类型的表达，
  // 类型变了前缀还留着旧的，任务名就会写成「2026年10月」却每年才生成一次。
  const nextName =
    patch.name === undefined ? cur.name : validate.assertNonEmptyString(patch.name, '计划名称', 60);
  if (patch.name !== undefined) data.name = nextName;
  if (nextName && (patch.name !== undefined || patch.periodType !== undefined)) {
    data.taskNameTemplate = NAME_PREFIX[nextType] + nextName;
  }

  if (patch.detail !== undefined) data.detail = String(patch.detail).slice(0, 2000);
  if (patch.enabled !== undefined) data.enabled = !!patch.enabled;
  if (patch.category !== undefined) data.category = validate.assertEnum(patch.category, CATEGORY, '任务分类');
  if (patch.source !== undefined) data.source = validate.assertEnum(patch.source, SOURCE, '任务来源');
  if (patch.priority !== undefined) data.priority = validate.assertEnum(patch.priority, PRIORITY, '优先级');

  // 主办人变更 = 把计划交出去，仅管理员可做。
  // （若允许本人改，等于能把自己的计划塞给一个不想要的同事，
  //   而对方还得替它负责 —— 那是"代办"，不是"移交"。）
  if (patch.ownerId !== undefined) {
    const me = await ctx.requireMember();
    if (me.role !== ROLE.ADMIN) {
      throw new BizError(Codes.FORBIDDEN_ADMIN, '只有管理员可以变更计划的主办人');
    }
    const ownerId = validate.assertNonEmptyString(patch.ownerId, '主办人');
    const owners = await ctx.resolveMembers([ownerId]);
    if (!owners.length) throw new BizError(Codes.MEMBER_NOT_FOUND, '主办人不存在');
    ctx.assertAssignable(owners, '主办人');
    data.ownerId = ownerId;
    data.ownerName = owners[0].name;
  }

  // 协办人变更
  if (patch.collaboratorIds !== undefined) {
    const ownerId = data.ownerId || cur.ownerId;
    const ids = validate.normalizeIds(patch.collaboratorIds, ownerId);
    const members = await ctx.resolveMembers(ids);
    if (members.length !== ids.length) throw new BizError(Codes.INVALID_PARAM, '协办人中包含不存在的成员');
    ctx.assertAssignable(members, '协办人');
    data.collaboratorIds = ids;
    data.collaboratorNames = members.map((m) => m.name);
  }

  if (!Object.keys(data).length) throw new BizError(Codes.INVALID_PARAM, '没有需要更新的字段');

  data.updatedAt = ctx.db.serverDate();
  await ctx.db.collection(TEMPLATES).doc(templateId).update({ data });
  return { templateId, patch: data };
}

async function toggle(payload, ctx) {
  await ctx.requireWriter();
  const templateId = validate.assertNonEmptyString(payload.templateId, '计划');
  const cur = await getTemplate(ctx, templateId);
  await assertCanManage(cur, ctx);

  const enabled = !cur.enabled;
  await ctx.db.collection(TEMPLATES).doc(templateId).update({
    data: { enabled, updatedAt: ctx.db.serverDate() },
  });
  return { templateId, enabled };
}

async function remove(payload, ctx) {
  await ctx.requireWriter();
  const templateId = validate.assertNonEmptyString(payload.templateId, '计划');
  const cur = await getTemplate(ctx, templateId);
  await assertCanManage(cur, ctx);

  // 只删计划，不动它已经生成的历史任务 —— 那些任务已独立存在，
  // 删掉它们等于抹掉同事已经报过的进展。
  await ctx.db.collection(TEMPLATES).doc(templateId).remove();
  return { templateId, deleted: true };
}

/**
 * 立即生成（管理员）。幂等，可反复调用 —— 这正是「定时触发无重试」的兜底。
 *
 * ★ asOf 的语义是「假装今天是哪天」，不是「强行生成哪一期」。
 *   传 '2026-09-05' 得到的是"如果 9 月 5 日那天巡检跑过，会生成什么"——
 *   开始日判定、过期判定都按那天算，所以补跑一个早已过期的周期不会
 *   凭空冒出一条一出生就逾期的任务。想补哪一期，就传那一期的开始日。
 */
async function generateNow(payload, ctx) {
  await ctx.requireAdmin();
  return runGenerate(ctx.db, {
    today: readAsOf(payload.asOf),
    dryRun: !!payload.dryRun,
    operator: ctx.openid,
  });
}

/** 预演：不写库，只返回会生成什么。上线前核对计划用。 */
async function preview(payload, ctx) {
  await ctx.requireAdmin();
  return runGenerate(ctx.db, { today: readAsOf(payload.asOf), dryRun: true, operator: ctx.openid });
}

// ---------------------------------------------------------------------------

async function getTemplate(ctx, templateId) {
  const r = await ctx.db.collection(TEMPLATES).doc(templateId).get().catch(() => null);
  if (!r || !r.data) throw new BizError(Codes.INVALID_PARAM, '计划不存在');
  return r.data;
}

/**
 * 要求当前用户能管这份计划：主办人本人，或管理员。
 * requireWriter 已经保证调用者不是只读角色，这里只判归属。
 */
async function assertCanManage(template, ctx) {
  const me = await ctx.requireMember();
  if (!perm.canManageTemplate(template, ctx.openid, me.role === ROLE.ADMIN)) {
    throw new BizError(Codes.FORBIDDEN_NOT_LEADER, '只有计划的主办人或管理员可以管理该计划');
  }
}

exports.main = createRouter({
  list,
  listAll,
  get,
  create,
  update,
  toggle,
  delete: remove,
  generateNow,
  preview,
});
