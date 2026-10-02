/**
 * cloudfunctions/templateService/index.js
 * ---------------------------------------------------------------------------
 * 周期任务模板服务（仅管理员）。
 *
 * 需求第 7 节：「模板配置入口：本期提供"管理员在云数据库直接维护模板"即可，
 * 不做管理界面」。因此本函数的界面入口不是必需的 —— 但保留完整的
 * 管理员 action，有两个实际价值：
 *   1. 管理员可在云函数测试面板里改模板，比在数据库控制台手改不容易写错字段；
 *   2. 手动补跑（generateNow）必须有个可调用的入口，
 *      否则某个周期漏生成时只能干等第二天。
 *
 * action 一览：
 *   list         模板列表
 *   create       新建模板
 *   update       修改模板
 *   toggle       启用/停用
 *   delete       删除模板
 *   generateNow  立即生成指定周期（幂等，可反复调用）
 *   preview      预演：不写库，只返回"会生成什么"，用于上线前核对模板
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { COLLECTIONS, CATEGORY, SOURCE, PRIORITY, RECUR_FREQ, QUERY_BATCH } = require('./lib/shared/constants');
const validate = require('./lib/shared/validate');
const { runGenerate } = require('./lib/shared/periodicRunner');
const { periodKeyOf } = require('./lib/shared/dates');
const { renderName, deadlineOf } = require('./lib/shared/periodic');

const TEMPLATES = COLLECTIONS.PERIODIC_TEMPLATES;

/** 允许的周期类型。与 shared/periodic.js 的 shouldGenerate 保持一致。 */
const PERIOD_TYPES = ['monthly', 'quarterly', 'yearly'];

// ---------------------------------------------------------------------------

async function list(payload, ctx) {
  await ctx.requireAdmin();
  const r = await ctx.db.collection(TEMPLATES).orderBy('createdAt', 'desc').limit(QUERY_BATCH).get();
  return { list: r.data || [] };
}

/**
 * 新建模板。
 *
 * ★ 主办人必须以 openid 指定（ownerId），姓名由服务端解析成快照。
 *   不接受前端直接传 ownerName —— 否则模板里存的姓名可能与 members 不一致，
 *   生成的周期任务就会出现一个"不存在的人"。
 */
async function create(payload, ctx) {
  await ctx.requireAdmin();

  const name = validate.assertNonEmptyString(payload.name, '模板名称', 60);
  const taskNameTemplate = validate.assertNonEmptyString(payload.taskNameTemplate, '任务名称模板', 100);
  const ownerId = validate.assertNonEmptyString(payload.ownerId, '主办人');

  const periodType = String(payload.periodType || 'monthly');
  if (PERIOD_TYPES.indexOf(periodType) === -1) {
    throw new BizError(Codes.INVALID_PARAM, `周期类型应为 ${PERIOD_TYPES.join('/')} 之一`);
  }

  // 解析主办人姓名快照
  const ownerNames = await ctx.resolveNames([ownerId]);
  if (!ownerNames.length) throw new BizError(Codes.MEMBER_NOT_FOUND, '主办人不存在或尚未认领该成员');

  // 解析协办人
  const collaboratorIds = validate.normalizeIds(payload.collaboratorIds, ownerId);
  const collaboratorNames = await ctx.resolveNames(collaboratorIds);
  if (collaboratorNames.length !== collaboratorIds.length) {
    throw new BizError(Codes.INVALID_PARAM, '协办人中包含不存在的成员');
  }

  const deadlineRule = String(payload.deadlineRule || '当月末').slice(0, 60);

  // 用当前周期试算一次，若占位符或截止规则写错，在创建时就能发现，
  // 而不是等到一个月后定时任务跑出奇怪的任务名。
  const sampleKey = periodKeyOf(new Date());
  const sampleName = renderName(taskNameTemplate, {
    periodKey: sampleKey,
    deadline: deadlineOf(deadlineRule, sampleKey),
  });

  const doc = {
    name,
    periodType,
    triggerDate: String(payload.triggerDate || '每月 1 日').slice(0, 40),
    taskNameTemplate,
    ownerId,
    ownerName: ownerNames[0],
    collaboratorIds,
    collaboratorNames,
    deadlineRule,
    enabled: payload.enabled !== false,

    // 生成任务时的默认值
    category: CATEGORY.indexOf(payload.category) !== -1 ? payload.category : '其他',
    source: SOURCE.indexOf(payload.source) !== -1 ? payload.source : '自发创新',
    // 周期模板生成的任务，性质恒为「周期性」，不给配置项以免配出矛盾组合
    taskType: '周期性',
    recurFreq: RECUR_FREQ.indexOf(payload.recurFreq) !== -1 ? payload.recurFreq : '每月',
    priority: PRIORITY.indexOf(payload.priority) !== -1 ? payload.priority : 'P2',
    detail: String(payload.detail || '').slice(0, 2000),

    createdAt: ctx.db.serverDate(),
    updatedAt: ctx.db.serverDate(),
  };

  const res = await ctx.db.collection(TEMPLATES).add({ data: doc });
  return { _id: res._id, sampleName, template: doc };
}

async function update(payload, ctx) {
  await ctx.requireAdmin();
  const templateId = validate.assertNonEmptyString(payload.templateId, '模板');
  const patch = payload.patch || {};
  const data = {};

  if (patch.name !== undefined) data.name = validate.assertNonEmptyString(patch.name, '模板名称', 60);
  if (patch.taskNameTemplate !== undefined) {
    data.taskNameTemplate = validate.assertNonEmptyString(patch.taskNameTemplate, '任务名称模板', 100);
  }
  if (patch.periodType !== undefined) {
    if (PERIOD_TYPES.indexOf(patch.periodType) === -1) {
      throw new BizError(Codes.INVALID_PARAM, `周期类型应为 ${PERIOD_TYPES.join('/')} 之一`);
    }
    data.periodType = patch.periodType;
  }
  if (patch.deadlineRule !== undefined) data.deadlineRule = String(patch.deadlineRule).slice(0, 60);
  if (patch.triggerDate !== undefined) data.triggerDate = String(patch.triggerDate).slice(0, 40);
  if (patch.detail !== undefined) data.detail = String(patch.detail).slice(0, 2000);
  if (patch.enabled !== undefined) data.enabled = !!patch.enabled;
  if (patch.category !== undefined) data.category = validate.assertEnum(patch.category, CATEGORY, '任务分类');
  if (patch.source !== undefined) data.source = validate.assertEnum(patch.source, SOURCE, '任务来源');
  if (patch.priority !== undefined) data.priority = validate.assertEnum(patch.priority, PRIORITY, '优先级');

  // 主办人变更需重新解析姓名快照
  if (patch.ownerId !== undefined) {
    const ownerId = validate.assertNonEmptyString(patch.ownerId, '主办人');
    const names = await ctx.resolveNames([ownerId]);
    if (!names.length) throw new BizError(Codes.MEMBER_NOT_FOUND, '主办人不存在');
    data.ownerId = ownerId;
    data.ownerName = names[0];
  }

  // 协办人变更
  if (patch.collaboratorIds !== undefined) {
    const ownerId = data.ownerId || (await getTemplate(ctx, templateId)).ownerId;
    const ids = validate.normalizeIds(patch.collaboratorIds, ownerId);
    const names = await ctx.resolveNames(ids);
    if (names.length !== ids.length) throw new BizError(Codes.INVALID_PARAM, '协办人中包含不存在的成员');
    data.collaboratorIds = ids;
    data.collaboratorNames = names;
  }

  if (!Object.keys(data).length) throw new BizError(Codes.INVALID_PARAM, '没有需要更新的字段');

  data.updatedAt = ctx.db.serverDate();
  await ctx.db.collection(TEMPLATES).doc(templateId).update({ data });
  return { templateId, patch: data };
}

async function toggle(payload, ctx) {
  await ctx.requireAdmin();
  const templateId = validate.assertNonEmptyString(payload.templateId, '模板');
  const cur = await getTemplate(ctx, templateId);
  const enabled = !cur.enabled;
  await ctx.db.collection(TEMPLATES).doc(templateId).update({
    data: { enabled, updatedAt: ctx.db.serverDate() },
  });
  return { templateId, enabled };
}

async function remove(payload, ctx) {
  await ctx.requireAdmin();
  const templateId = validate.assertNonEmptyString(payload.templateId, '模板');
  await getTemplate(ctx, templateId);
  // 只删模板，不动它已经生成的历史任务 —— 那些任务已独立存在
  await ctx.db.collection(TEMPLATES).doc(templateId).remove();
  return { templateId, deleted: true };
}

/**
 * 立即生成指定周期。
 *
 * ★ 幂等保证：核心逻辑与定时任务共用 runGenerate，靠确定性 _id 去重。
 *   因此本 action 可以随意重试、反复调用，绝不会生成重复任务。
 *   这正是「定时触发无重试」的兜底手段。
 */
async function generateNow(payload, ctx) {
  await ctx.requireAdmin();
  const periodKey = payload.periodKey ? String(payload.periodKey) : undefined;
  if (periodKey && !/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new BizError(Codes.INVALID_PARAM, '周期格式应为 YYYY-MM，如 2026-11');
  }
  const result = await runGenerate(ctx.db, {
    periodKey,
    dryRun: !!payload.dryRun,
    operator: ctx.openid,
  });
  return result;
}

/** 预演：不写库，只返回会生成什么。上线前核对模板用。 */
async function preview(payload, ctx) {
  await ctx.requireAdmin();
  return runGenerate(ctx.db, { periodKey: payload.periodKey, dryRun: true, operator: ctx.openid });
}

// ---------------------------------------------------------------------------

async function getTemplate(ctx, templateId) {
  const r = await ctx.db.collection(TEMPLATES).doc(templateId).get().catch(() => null);
  if (!r || !r.data) throw new BizError(Codes.INVALID_PARAM, '模板不存在');
  return r.data;
}

exports.main = createRouter({
  list,
  create,
  update,
  toggle,
  delete: remove,
  generateNow,
  preview,
});
