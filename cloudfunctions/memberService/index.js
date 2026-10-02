/**
 * cloudfunctions/memberService/index.js
 * ---------------------------------------------------------------------------
 * 成员身份服务：认领、查询、管理员维护。
 *
 * 本函数是整套权限体系的基石 —— 所有其他云函数判断"我是谁"都依赖
 * members 集合里 openid ↔ 姓名 的绑定关系。绑定不存在，写操作一律拒绝。
 *
 * action 一览：
 *   getMe               取当前身份（含是否已认领）
 *   claim               认领某个成员（CAS，防两人同时抢占）
 *   listClaimable       列出尚未被认领的成员
 *   listMembers         列出全部成员（供协办人选择器等使用）
 *   adminAddMember      管理员新增单个成员
 *   adminBatchAddMembers 管理员批量导入（首次部署用）
 *   adminUpdateMember   管理员改名/调角色/调部门
 *   adminResetBinding   管理员解绑（离职、换微信）
 *   adminRelinkMembers  管理员把历史数据按姓名重新挂到 openid 上（导入旧表后跑一次）
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { ROLE } = require('./lib/shared/constants');
const { assertNonEmptyString } = require('./lib/shared/validate');
const { relinkMemberData } = require('./lib/shared/taskRepo');

/** 姓名最大长度，防止误粘贴超长文本 */
const NAME_MAX = 20;

// ---------------------------------------------------------------------------
// 普通成员可用
// ---------------------------------------------------------------------------

/**
 * 取当前身份。小程序启动时第一个调用的接口。
 * 返回 needClaim=true 时前端跳认领页。
 */
async function getMe(payload, ctx) {
  const member = await ctx.findMember();
  return {
    openid: ctx.openid,
    needClaim: !member,
    member: member
      ? { _id: member._id, name: member.name, role: member.role, dept: member.dept || '' }
      : null,
  };
}

/**
 * 认领成员身份。
 *
 * ★ 并发安全：用 CAS（Compare-And-Set）而不是"先查后写"。
 *   两个用户同时认领同一人时，数据库层保证只有一次 update 命中
 *   （条件 openid:'' 在第二次执行时已不成立），另一个必然拿到 stats.updated=0。
 *   若改成"先查再写"，两者都会查到未认领，然后双双写入，后写覆盖先写。
 */
async function claim(payload, ctx) {
  const memberId = assertNonEmptyString(payload.memberId, '成员');

  // 1) 当前 openid 是否已绑定过
  const mine = await ctx.findMember();
  if (mine) {
    if (mine._id === memberId) {
      // 重复认领同一人：幂等成功
      return { member: toPublic(mine), idempotent: true };
    }
    throw new BizError(Codes.ALREADY_CLAIMED_OTHER);
  }

  // 2) CAS 抢占：只有 openid 仍为空串的记录才能被更新
  const res = await ctx.db
    .collection('members')
    .where({ _id: memberId, openid: '' })
    .update({
      data: {
        openid: ctx.openid,
        claimedAt: ctx.db.serverDate(),
      },
    });

  if (!res.stats || res.stats.updated !== 1) {
    // 抢占失败：要么成员不存在，要么已被他人认领
    const cur = await ctx.db.collection('members').doc(memberId).get().catch(() => null);
    if (!cur || !cur.data) throw new BizError(Codes.MEMBER_NOT_FOUND);
    if (cur.data.openid === ctx.openid) {
      return { member: toPublic(cur.data), idempotent: true };
    }
    throw new BizError(Codes.MEMBER_TAKEN);
  }

  // 3) 回读最新文档返回
  const after = await ctx.db.collection('members').doc(memberId).get();

  // 4) 顺手把历史数据挂到这个 openid 上。
  //    导入的旧任务只有姓名没有 openid，「我主办的」会是空的 —— 认领这一刻
  //    正是补上的最佳时机：本人就在眼前，失败了也还有 adminRelinkMembers 兜底。
  //
  //    ★ 必须 try/catch 且吞掉异常：认领本身已经成功了（CAS 改完了库），
  //      用户的名字已经占住。此时因关联失败而报错，会让用户以为没认领成功
  //      而反复重试，反而制造出真正的问题。
  let linked = null;
  try {
    linked = await relinkMemberData(ctx.db, { [after.data.name]: ctx.openid });
  } catch (e) {
    console.error('[memberService.claim] 历史数据关联失败（不影响认领结果）', e);
  }

  return { member: toPublic(after.data), linked };
}

/**
 * 管理员：把历史数据全量重新关联一遍。
 *
 * 导入历史任务表之后跑一次，或有人刚认领完想立刻看到结果时手动触发。
 * 幂等，可反复执行 —— 已关联的不会被改动，只补空缺（详见 taskRepo.relinkMemberData）。
 *
 * 之所以做成显式 action 而不是让 claim 自动搞定：claim 只能补自己那一个人，
 * 且新人的历史数据要等他第一次打开小程序才补得上。
 * 这个 action 一次性把全部已认领成员的归属都补齐，不依赖"大家都来过一遍"。
 */
async function adminRelinkMembers(payload, ctx) {
  await ctx.requireAdmin();

  const r = await ctx.db
    .collection('members')
    .where({ openid: ctx._.neq('') })
    .field({ name: true, openid: true })
    .limit(100)
    .get();

  const map = {};
  (r.data || []).forEach((m) => { if (m.name && m.openid) map[m.name] = m.openid; });

  const claimed = Object.keys(map).length;
  if (!claimed) {
    return { claimed: 0, tasks: 0, records: 0, hint: '还没有人认领，先让同事在认领页认领自己。' };
  }

  const result = await relinkMemberData(ctx.db, map);
  return {
    claimed,
    tasks: result.tasks,
    records: result.records,
    hint: '只补空缺，不覆盖已有归属；可反复执行。',
  };
}

/**
 * 列出尚未被认领的成员（认领页下拉数据源）。
 *
 * ★ 本 action **必须**能被"尚未认领"的用户调用 —— 这正是它存在的意义。
 *   曾经这里有一句 `await ctx.requireMember()`，造成死锁：
 *   调用者按定义就是还没有成员档案的人，requireMember 必然抛 NOT_CLAIMED，
 *   于是认领页永远拉不到名单，也就永远认领不了。
 *
 *   仍然需要身份，但只是"你是通过小程序进来的真实微信用户"
 *   （buildCtx 里的 resolveOpenid 已经保证了这一点），
 *   而不是"你已经在 members 里有档案"。
 *
 * 暴露范围可控：只返回 openid 为空串的记录，且不下发 openid 字段本身，
 * 所以既看不到已认领的人，也拿不到任何人的身份标识。
 */
async function listClaimable(payload, ctx) {
  const r = await ctx.db
    .collection('members')
    .where({ openid: '' })
    .field({ name: true, dept: true, role: true })
    .limit(100)
    .get();
  return { list: r.data || [] };
}

/** 列出全部成员（协办人选择器 / 人员看板使用） */
async function listMembers(payload, ctx) {
  await ctx.requireMember();
  const r = await ctx.db
    .collection('members')
    .field({ name: true, dept: true, role: true, openid: true })
    .limit(100)
    .get();
  return {
    list: (r.data || []).map((m) => ({
      _id: m._id,
      name: m.name,
      dept: m.dept || '',
      role: m.role,
      // 已认领的成员才有 openid，前端用它做任务归属匹配
      openid: m.openid || '',
      claimed: !!m.openid,
    })),
  };
}

// ---------------------------------------------------------------------------
// 管理员可用
// ---------------------------------------------------------------------------

/** 新增单个成员 */
async function adminAddMember(payload, ctx) {
  await ctx.requireAdmin();
  const name = assertNonEmptyString(payload.name, '姓名', NAME_MAX);
  const dept = String(payload.dept || '').slice(0, 30);
  const role = payload.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.NORMAL;

  // 姓名唯一性由索引兜底，这里先查一次给出友好提示
  const dup = await ctx.db.collection('members').where({ name }).count();
  if (dup.total > 0) throw new BizError(Codes.INVALID_PARAM, `成员「${name}」已存在`);

  const res = await ctx.db.collection('members').add({
    data: {
      name,
      dept,
      role,
      // ★ 必须是空串而不是不写该字段：认领的 CAS 条件依赖 openid === ''
      openid: '',
      claimedAt: null,
      createdAt: ctx.db.serverDate(),
    },
  });
  return { _id: res._id, name };
}

/**
 * 批量导入成员（首次部署时用，避免管理员在控制台一条条敲）。
 * 已存在的姓名会被跳过而不是报错，便于重复执行。
 */
async function adminBatchAddMembers(payload, ctx) {
  await ctx.requireAdmin();
  const list = Array.isArray(payload.members) ? payload.members : [];
  if (!list.length) throw new BizError(Codes.INVALID_PARAM, '成员列表为空');

  const added = [];
  const skipped = [];

  for (const item of list) {
    const name = String((item && item.name) || '').trim();
    if (!name) continue;
    const dup = await ctx.db.collection('members').where({ name }).count();
    if (dup.total > 0) {
      skipped.push(name);
      continue;
    }
    await ctx.db.collection('members').add({
      data: {
        name,
        dept: String((item && item.dept) || '').slice(0, 30),
        role: item && item.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.NORMAL,
        openid: '',
        claimedAt: null,
        createdAt: ctx.db.serverDate(),
      },
    });
    added.push(name);
  }

  return { added, skipped };
}

/**
 * 修改成员信息（改名 / 调角色 / 调部门）。
 *
 * ★ 注意：改名**不会**追改历史任务的 leader/collaborator 快照。
 *   那些是写入时的展示快照，追改需要全表扫描且可能覆盖后续变更，
 *   收益不抵风险。如需修正历史展示，用 adminSyncTaskSnapshots。
 */
async function adminUpdateMember(payload, ctx) {
  await ctx.requireAdmin();
  const memberId = assertNonEmptyString(payload.memberId, '成员');
  const data = {};

  if (payload.name !== undefined) {
    const name = assertNonEmptyString(payload.name, '姓名', NAME_MAX);
    const dup = await ctx.db
      .collection('members')
      .where({ name, _id: ctx.db.command.neq(memberId) })
      .count();
    if (dup.total > 0) throw new BizError(Codes.INVALID_PARAM, `成员「${name}」已存在`);
    data.name = name;
  }
  if (payload.dept !== undefined) data.dept = String(payload.dept || '').slice(0, 30);
  if (payload.role !== undefined) {
    data.role = payload.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.NORMAL;
  }

  if (!Object.keys(data).length) throw new BizError(Codes.INVALID_PARAM, '没有需要更新的字段');

  await ctx.db.collection('members').doc(memberId).update({ data });
  return { updated: true, memberId };
}

/**
 * 解绑（离职 / 换微信）。
 * 解绑后该成员回到"未认领"状态，可被他人重新认领。
 */
async function adminResetBinding(payload, ctx) {
  await ctx.requireAdmin();
  const memberId = assertNonEmptyString(payload.memberId, '成员');
  await ctx.db.collection('members').doc(memberId).update({
    data: { openid: '', claimedAt: null },
  });
  return { updated: true, memberId };
}

// ---------------------------------------------------------------------------

/** 只暴露前端需要的字段 */
function toPublic(m) {
  return { _id: m._id, name: m.name, role: m.role, dept: m.dept || '' };
}

exports.main = createRouter({
  getMe,
  claim,
  listClaimable,
  listMembers,
  adminAddMember,
  adminBatchAddMembers,
  adminUpdateMember,
  adminResetBinding,
  adminRelinkMembers,
});
