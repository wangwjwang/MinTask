/**
 * cloudfunctions/demandService/index.js
 * ---------------------------------------------------------------------------
 * 需求池服务。需求是"还没成形的事"（没人负责、无交付物），
 * 任务是"已经有人认领的事" —— 领走 = 基于一条需求建一个任务。
 *
 * ★★★ 本文件是全局**唯一**一个故意不调用 ctx.requireWriter() 的写域。★★★
 *
 *   现有硬规则里「管理者」（ROLE.VIEWER）是纯只读，三道闸口一致：
 *   ctx.requireWriter() 一刀切、custom-tab-bar 置灰、README §5 权限矩阵。
 *   用户 2026-10-09 拍板：管理者能看需求池、能建需求、能改能关自己提的。
 *
 *   这个粒度（"只能写他自己提的那几条"）用一刀切表达不了，只能在纯函数里表达。
 *   所以这里全部 action 走 requireMember()，写权限交给 perm.canEditDemand ——
 *   它与前端共用同一个函数，前端控显隐、后端做强制校验，口径不会漂。
 *
 *   ★ 其余全部数据域（任务、进展、计划、成员）**一行不改**，管理者在那里
 *     仍是 FORBIDDEN_VIEWER。他领不走需求，因为领走 = 建任务，
 *     而 taskService.create 的第一步仍是 requireWriter()。
 *
 * action 一览：
 *   list    需求列表（分段筛在前端做，一次拉全量）
 *   get     单条（不存在返回 null，不抛错）
 *   create  建需求
 *   update  改标题/描述/对接人/期望时间
 *   close   关闭（写 closeReason）
 *   reopen  清空关闭痕迹 → 交给重算定状态
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { COLLECTIONS, ROLE } = require('./lib/shared/constants');
const validate = require('./lib/shared/validate');
const perm = require('./lib/shared/perm');
const {
  buildDemandDoc,
  readDemand,
  tasksOfDemand,
  listAllDemands,
  syncDemandStatus,
} = require('./lib/shared/demandRepo');

const DEMANDS = COLLECTIONS.DEMANDS;

/**
 * 拒绝编辑权的统一判据。
 *
 * ★ 错误码用 FORBIDDEN_NOT_PARTICIPANT 而不是新造一个：它的语义正是
 *   "你不是这件事的参与方"，且 utils/api.js 的 REFRESH_ON_ERROR 已经收录它
 *   （用户会看到提示 + 当前页自动刷新，拿到最新的归属）。
 */
function assertCanEdit(demand, ctx, me) {
  if (!perm.canEditDemand(demand, ctx.openid, me.role === ROLE.ADMIN)) {
    throw new BizError(
      Codes.FORBIDDEN_NOT_PARTICIPANT,
      '只能处置与自己相关的需求（提出人、领走人或管理员）'
    );
  }
}

/** 读一条需求，不存在则抛错（close / reopen / update 用；get 不抛，见下） */
async function getDemandOrThrow(ctx, demandId) {
  const d = await readDemand(ctx.db, demandId);
  if (!d) throw new BizError(Codes.INVALID_PARAM, '需求不存在或已被删除');
  return d;
}

// ---------------------------------------------------------------------------

/**
 * 需求列表。一次拉全量，分段筛在前端做。
 * ★ 10 人规模下需求总量是几十条，一次拉完在前端分组比三次查询简单，
 *   也和任务看板"一次拉全量再归并"是同一套路。
 */
async function list(payload, ctx) {
  await ctx.requireMember();
  return { list: await listAllDemands(ctx.db) };
}

/**
 * 读一条需求 + 它的关联任务。
 * ★ 需求不存在时返回 { demand: null }，**不抛错** —— 手上的 id 是几秒前
 *   从列表点进来的，那一条刚被别人删掉是正常竞态，不该说成"加载失败"。
 * ★ 顺带把关联任务带回来（而不是让页面再查一次）：这是"这条需求后来怎么样了"
 *   的唯一入口，两个来源分两次查会出现互相矛盾的中间态。
 */
async function get(payload, ctx) {
  await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await readDemand(ctx.db, demandId);
  if (!demand) return { demand: null, tasks: [] };
  return { demand, tasks: await tasksOfDemand(ctx.db, demandId) };
}

/**
 * 建需求。
 * ★ 门禁是 requireMember —— 管理者正是在这里进来的（见文件头）。
 *   其余全部校验与写入都按普通成员处理，不做任何角色分支。
 */
async function create(payload, ctx) {
  const me = await ctx.requireMember();
  const fields = validate.validateDemandFields(payload.demand || {}, { isCreate: true });
  validate.assertDemandRequiredForCreate(fields);

  const doc = buildDemandDoc({
    fields,
    proposerId: ctx.openid,
    proposerName: me.name,
    db: ctx.db,
  });

  const res = await ctx.db.collection(DEMANDS).add({ data: doc });
  return { _id: res._id, demand: Object.assign({ _id: res._id }, doc) };
}

/** 改需求。状态不在这里改 —— 那是领走/关闭/重算的事 */
async function update(payload, ctx) {
  const me = await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await getDemandOrThrow(ctx, demandId);
  assertCanEdit(demand, ctx, me);

  const patch = validate.validateDemandFields(payload.patch || {}, { isCreate: false });
  if (!Object.keys(patch).length) {
    throw new BizError(Codes.INVALID_PARAM, '没有需要更新的字段');
  }

  patch.updatedAt = ctx.db.serverDate();
  await ctx.db.collection(DEMANDS).doc(demandId).update({ data: patch });
  return { demandId, patch };
}

/**
 * 关闭需求（"这件事不做了"）。
 * ★ 已关闭的直接幂等返回：重复点是正常的（网络重试、连点），不是错误。
 */
async function close(payload, ctx) {
  const me = await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await getDemandOrThrow(ctx, demandId);
  assertCanEdit(demand, ctx, me);

  if (demand.status === '已关闭') {
    return { demandId, status: '已关闭', idempotent: true };
  }

  const closeReason = String(payload.closeReason || '').trim().slice(0, 200);
  await ctx.db.collection(DEMANDS).doc(demandId).update({
    data: {
      status: '已关闭',
      closedByName: me.name,   // 快照
      closedAt: ctx.db.serverDate(),
      closeReason,
      updatedAt: ctx.db.serverDate(),
    },
  });
  return { demandId, status: '已关闭' };
}

/**
 * 重新打开。
 *
 * ★ 不硬写「待认领」：用户的原话是"回到待认领"，那只说对了一半 ——
 *   没建任务就关的确实回待认领；但「已领走」的需求也能被关闭，
 *   那种需求重开时该回「已领走」，而不是把人已经领走的事实抹掉。
 *   一份重算逻辑回答所有情况，比在这里再写一遍分支可靠。
 */
async function reopen(payload, ctx) {
  const me = await ctx.requireMember();
  const demandId = validate.assertNonEmptyString(payload.demandId, '需求');
  const demand = await getDemandOrThrow(ctx, demandId);
  assertCanEdit(demand, ctx, me);

  if (demand.status !== '已关闭') {
    return { demandId, status: demand.status, idempotent: true };
  }

  const r = await syncDemandStatus(ctx.db, demandId, { fromReopen: true });
  return { demandId, status: r.status };
}

exports.main = createRouter({
  list,
  get,
  create,
  update,
  close,
  reopen,
});
