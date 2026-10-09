/**
 * shared/demandRepo.js
 * ---------------------------------------------------------------------------
 * 需求领域仓储助手（云函数侧）。与 taskRepo.js 同款定位：
 * 「需求领域里容易写错的事集中在一处」，四个即时落点 + 每日巡检共用同一份实现。
 *
 * 本文件负责四件容易写错的事：
 *   1. 需求文档的完整构造（提出人是服务端快照，禁止前端传入）
 *   2. 原子领走（靠 where 带上状态条件，不靠先查后写）
 *   3. 领走失败时的尽力回滚
 *   4. 由关联任务重算需求状态
 *
 * ★ 状态值在本文件里一律写中文字面量，不写 DEMAND_STATUS.xxx ——
 *   DEMAND_STATUS 是**数组**（给 assertEnum 用的），不是 ROLE 那样的对象，
 *   写 .PENDING 会静默得到 undefined，where 条件就变成"status 等于 undefined"：
 *   一个不报错、也永远匹配不上的查询。
 *
 * ⚠ 本文件不 require wx-server-sdk（db 与 ctx 由调用方传入），因此会被
 *   sync-shared.js 一并同步到小程序端 —— 与 taskRepo.js 同样的情况，无害。
 * ---------------------------------------------------------------------------
 */

const { COLLECTIONS, QUERY_BATCH } = require('./constants');
const { BizError, Codes, describeInfraError } = require('./errors');
const validate = require('./validate');
const { fetchAll, runBatched } = require('./taskRepo');

const DEMANDS = COLLECTIONS.DEMANDS;
const TASKS = COLLECTIONS.TASKS;

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/**
 * 读一条需求。不存在返回 null（不抛错）—— 与 templateService.get 同一个理由：
 * 手上的 id 是几秒前从列表点进来的，那一条刚被别人删掉是正常竞态，
 * 不该和"加载失败"混成同一句话。
 *
 * ★ 但不能一律吞掉异常：集合不存在、权限被拒也会走到 catch，
 *   若一并转成 null，部署问题就被伪装成了"需求已被删除"，排查方向会完全跑偏。
 *   这与 ctx.getTaskOrThrow 是同一个判断。
 */
async function readDemand(db, demandId) {
  if (!demandId) return null;
  try {
    const r = await db.collection(DEMANDS).doc(String(demandId)).get();
    return (r && r.data) || null;
  } catch (e) {
    const infra = describeInfraError(e);
    if (infra) throw infra;
    return null;
  }
}

/**
 * 一条需求下的全部任务。分页取全量 —— 云函数端单次上限 100，
 * 不循环会被静默截断（而截断会让"全部完成"这个判据误判成"部分完成"）。
 */
async function tasksOfDemand(db, demandId) {
  const out = [];
  for (let skip = 0; ; skip += QUERY_BATCH) {
    const r = await db
      .collection(TASKS)
      .where({ demandId })
      .skip(skip)
      .limit(QUERY_BATCH)
      .get();
    const batch = r.data || [];
    out.push(...batch);
    if (batch.length < QUERY_BATCH) return out;
  }
}

/**
 * 全部需求，按创建时间倒序。
 * ★ 带 orderBy 是必需的：不带排序的 skip 分页在数据变动时可能漏条或重复。
 * ★ 10 人规模下几十条，一次拉完在前端分组，与任务看板"一次拉全量再归并"同一套路。
 */
async function listAllDemands(db) {
  const out = [];
  for (let skip = 0; ; skip += QUERY_BATCH) {
    const r = await db
      .collection(DEMANDS)
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(QUERY_BATCH)
      .get();
    const batch = r.data || [];
    out.push(...batch);
    if (batch.length < QUERY_BATCH) return out;
  }
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/**
 * 构造新建需求的完整文档。
 *
 * ★ 提出人由调用方（服务端）从 ctx.openid + me.name 传入，本函数不接受前端姓名。
 * ★ status 写死「待认领」：新建的需求一定在池子里等人领，没有第二种入口。
 */
function buildDemandDoc(opts) {
  const { fields, proposerId, proposerName, db } = opts;
  return {
    title: fields.title,
    detail: fields.detail || '',
    contactDept: fields.contactDept || '',
    contactName: fields.contactName || '',
    expectDate: fields.expectDate || '',

    status: '待认领',

    // ★ 判据 / 快照分开存，函数里只比对 Id
    proposerId,
    proposerName,

    claimedById: '',
    claimedByName: '',
    claimedAt: null,

    closedByName: '',
    closedAt: null,
    closeReason: '',

    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  };
}

// ---------------------------------------------------------------------------
// 占位 / 回滚
// ---------------------------------------------------------------------------

/**
 * 原子占走一条需求。返回 demandId（无 demandId 时返回 ''）。
 *
 * ★ 为什么用 where().update() 而不是 doc().get() 之后 doc().update()
 *   两个人同时点「领走」时，先查后写会双双查到「待认领」，然后双双写成功 ——
 *   一条需求被领两次。where 里带上 status: '待认领' 这个条件，
 *   数据库的更新是原子的，只有一个人能拿到 stats.updated === 1。
 *   这与 shared/idempotency.js 说的"不靠先查后写"是同一条纪律。
 *
 * @param {object} ctx      执行上下文（要 db 与 resolveMembers）
 * @param {string} demandId 可空 —— 不从需求池来的任务完全正常，此时直接放行
 * @param {string} leaderId 领走人 = 新建任务的主办人
 */
async function claimDemand(ctx, demandId, leaderId) {
  if (!demandId) return '';
  const id = validate.assertNonEmptyString(demandId, '需求');

  const leader = (await ctx.resolveMembers([leaderId]))[0];
  if (!leader) throw new BizError(Codes.MEMBER_NOT_FOUND, '指定的主办人不存在');

  const r = await ctx.db
    .collection(DEMANDS)
    .where({ _id: id, status: '待认领' })
    .update({
      data: {
        status: '已领走',
        claimedById: leaderId,        // ★ 判据，必须是 openid
        claimedByName: leader.name,   // 快照
        claimedAt: ctx.db.serverDate(),
        updatedAt: ctx.db.serverDate(),
      },
    });

  if (!r.stats || r.stats.updated !== 1) {
    // 失败原因分三种，别都笼统说"操作失败"：不存在 / 已被领走 / 已关闭。
    // 这一次回读只在失败路径上发生，不影响上面那条 where 的原子性。
    const cur = await readDemand(ctx.db, id);
    if (!cur) throw new BizError(Codes.INVALID_PARAM, '这条需求不存在或已被删除');
    if (cur.status === '已关闭') throw new BizError(Codes.INVALID_PARAM, '这条需求已关闭，先重新打开再领');
    throw new BizError(Codes.INVALID_PARAM, '这条需求已被领走，刷新后再看看别的');
  }
  return id;
}

/**
 * 领走的逆操作 —— 占位成功但建任务失败时把需求退回池子。
 *
 * ★ 为什么回滚不是可有可无的：不回滚的话，那条需求就停在「已领走」却一条任务
 *   都没有 —— 池子里少了一条，谁也不知道它去哪了。
 * ★ 条件里带上 claimedById：只回滚**自己**占的那条，不误伤别人刚领走的。
 * ★ 本函数**永不抛错**：它在 catch 块里被调用，抛错会盖掉真正要报给用户的
 *   原始错误。回滚失败只进日志，漏网的由每日巡检收敛（见 syncAllDemands）。
 */
async function releaseDemand(ctx, demandId, leaderId) {
  if (!demandId) return;
  try {
    await ctx.db
      .collection(DEMANDS)
      .where({ _id: String(demandId), status: '已领走', claimedById: leaderId })
      .update({
        data: {
          status: '待认领',
          claimedById: '',
          claimedByName: '',
          claimedAt: null,
          updatedAt: ctx.db.serverDate(),
        },
      });
  } catch (e) {
    console.error('[demandRepo] 回滚需求占位失败', demandId, e);
  }
}

// ---------------------------------------------------------------------------
// 状态重算
// ---------------------------------------------------------------------------

/**
 * 由关联任务重算需求状态。**全部状态变化的唯一出口**。
 *
 * 规则（spec §2 的状态表）：
 *   零关联任务        → 待认领，并清空 claimedBy*
 *   全部任务已完成    → 已完成
 *   有任务但未全完成  → 已领走
 *   已关闭            → 不动（除非 opts.fromReopen）
 *
 * ★ 「已关闭不被任何自动规则改动」是刻意的：一个"我决定不做了"的结论，
 *   不该被隔壁任务的状态变化悄悄推翻。重开是唯一能把已关闭拉回来的动作。
 *
 * ★ 不用"任一完成"（那会在第一个任务做完时就误判），也不用进度百分比
 *   （需求没有进度，它是"要不要做"的判断，不是"做了多少"）。
 *
 * @param {object}  db
 * @param {string}  demandId
 * @param {object}  [opts]
 * @param {boolean} [opts.fromReopen] 重开那一刻调用 —— 绕过"已关闭不动"的短路，
 *                                    并在同一次 update 里把关闭痕迹清掉
 * @returns {Promise<{status:string, changed:boolean}|{skipped:string}>}
 */
async function syncDemandStatus(db, demandId, opts = {}) {
  const demand = await readDemand(db, demandId);
  if (!demand) return { skipped: 'missing' };
  return applyStatus(db, demand, opts);
}

/** syncDemandStatus 的内核 —— 已经拿到需求文档时直接用它，省一次回读 */
async function applyStatus(db, demand, opts) {
  if (demand.status === '已关闭' && !opts.fromReopen) {
    return { status: '已关闭', changed: false };
  }

  const tasks = await tasksOfDemand(db, demand._id);
  const total = tasks.length;
  const allDone = total > 0 && tasks.every((t) => t.stage === '已完成');

  let next;
  if (total === 0) next = '待认领';
  else if (allDone) next = '已完成';
  else next = '已领走';

  const data = { status: next, updatedAt: db.serverDate() };

  // 任务被删光 → 需求回到池子里，让下一个人领，而不是卡在"已领走但没人办"
  if (next === '待认领') {
    data.claimedById = '';
    data.claimedByName = '';
    data.claimedAt = null;
  }
  // 重开：清掉关闭痕迹（在同一次 update 里，不留下中间态）
  if (opts.fromReopen) {
    data.closedByName = '';
    data.closedAt = null;
    data.closeReason = '';
  }

  const changed = demand.status !== next || !!opts.fromReopen;
  if (!changed) return { status: next, changed: false };

  await db.collection(DEMANDS).doc(String(demand._id)).update({ data });
  return { status: next, changed: true };
}

/**
 * 重算，但**绝不抛错**。任务保存 / 进展提交 / 删除任务都调它。
 *
 * ★ 失败隔离是硬要求：需求状态晚一步同步是小事，
 *   用户辛苦填的进展提交不上去是大事。漏掉的由每日巡检收敛。
 */
async function syncDemandQuietly(db, demandId) {
  if (!demandId) return null;
  try {
    return await syncDemandStatus(db, demandId);
  } catch (e) {
    console.error('[demandRepo] 需求状态重算失败', demandId, e);
    return null;
  }
}

/**
 * 每日巡检：把所有未关闭需求的状态收敛到真实状态。
 * 与 generatePeriodicTasks 同定位 —— "每天扫一遍库、把派生状态收敛到真实状态"。
 *
 * ★ 已关闭的直接过滤掉（它们本来就不该被自动改），也不为它们多查一次任务。
 * ★ 并发限 10：云开发对单函数的并发请求数有上限，无脑 Promise.all
 *   在需求多起来时容易被限流。
 */
async function syncAllDemands(db) {
  const demands = await fetchAll(db, DEMANDS);
  const open = demands.filter((d) => d.status !== '已关闭');
  let changed = 0;
  await runBatched(open, 10, async (d) => {
    const r = await applyStatus(db, d, {});
    if (r.changed) changed += 1;
  });
  return { scanned: demands.length, changed };
}

module.exports = {
  buildDemandDoc,
  readDemand,
  tasksOfDemand,
  listAllDemands,
  claimDemand,
  releaseDemand,
  syncDemandStatus,
  syncDemandQuietly,
  syncAllDemands,
};
