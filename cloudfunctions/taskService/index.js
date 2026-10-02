/**
 * cloudfunctions/taskService/index.js
 * ---------------------------------------------------------------------------
 * 任务服务：新建、修改、加入协办、退出协办、移除协办、删除。
 *
 * ★ 本函数是权限矩阵的主要落点。三条铁律：
 *   1. leaderId 永远取自 ctx.openid，前端传什么都不看（管理员代建除外）。
 *   2. leader / collaborator 姓名字符串是**服务端快照**，由 openid 反查
 *      members 生成，前端无法写入。
 *   3. 改任务属性只认 leaderId === ctx.openid，绝不比对姓名。
 *
 * action 一览：
 *   create              新建任务（自己为主办人）
 *   update              修改任务属性（仅主办人）
 *   join                加入协办（自由加入，无需审批）
 *   leave               退出协办（仅本人）
 *   removeCollaborator  主办人移除协办人
 *   delete              删除任务（仅管理员）
 *   adminCreate         管理员代建（可指定他人为主办人）
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { ORIGIN, COLLECTIONS } = require('./lib/shared/constants');
const validate = require('./lib/shared/validate');
const perm = require('./lib/shared/perm');
const { addIdempotent, manualTaskId } = require('./lib/shared/idempotency');
const { buildTaskDoc, applyStageSideEffects } = require('./lib/shared/taskRepo');

const TASKS = COLLECTIONS.TASKS;
const MEMBERS = COLLECTIONS.MEMBERS;

// ---------------------------------------------------------------------------
// 内部助手
// ---------------------------------------------------------------------------

/**
 * 校验协办人 openid 是否都是真实成员，并生成姓名快照。
 * 返回 { ids, names }，两者由同一次解析产生，保证 id 与姓名严格对应。
 */
async function resolveCollaborators(ctx, rawIds, leaderId) {
  const ids = validate.normalizeIds(rawIds, leaderId);
  if (!ids.length) return { ids: [], names: '' };
  const names = await ctx.resolveNames(ids);
  if (names.length !== ids.length) {
    throw new BizError(Codes.INVALID_PARAM, '所选协办人中包含不存在的成员，请刷新后重试');
  }
  return { ids, names: names.join(';') };
}

/**
 * 由当前 collaboratorIds 重建 collaborator 姓名快照。
 * 加入/退出协办后调用 —— 先原子改 id 数组，再回读重建展示字符串。
 */
async function rebuildCollaboratorSnapshot(ctx, taskId) {
  const cur = await ctx.db.collection(TASKS).doc(taskId).get();
  const ids = (cur.data && cur.data.collaboratorIds) || [];
  const names = await ctx.resolveNames(ids);
  await ctx.db.collection(TASKS).doc(taskId).update({
    data: { collaborator: names.join(';'), updatedAt: ctx.db.serverDate() },
  });
  return { collaboratorIds: ids, collaborator: names.join(';') };
}

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

/**
 * 新建任务。创建者即主办人。
 * clientToken 提供幂等：网络重试/连点不会产生两条任务。
 */
async function create(payload, ctx) {
  const me = await ctx.requireMember();
  const fields = validate.validateTaskFields(payload.task || {}, { isCreate: true });
  validate.assertTaskRequiredForCreate(fields);

  const { ids, names } = await resolveCollaborators(
    ctx,
    fields.__rawCollaboratorIds,
    ctx.openid
  );

  return insertTask(ctx, {
    fields,
    leaderId: ctx.openid,
    leaderName: me.name,
    collaboratorIds: ids,
    collaboratorNames: names,
    creatorId: ctx.openid,
    token: payload.clientToken,
  });
}

/**
 * 管理员代建任务，可指定他人为主办人。
 * 用于"部领导交办"这类由他人代录的场景。
 */
async function adminCreate(payload, ctx) {
  const admin = await ctx.requireAdmin();
  const leaderId = validate.assertNonEmptyString(payload.leaderId, '主办人');
  const leaderMember = (await ctx.resolveNames([leaderId]))[0];
  if (!leaderMember) throw new BizError(Codes.MEMBER_NOT_FOUND, '指定的主办人不存在或尚未认领');

  const fields = validate.validateTaskFields(payload.task || {}, { isCreate: true });
  validate.assertTaskRequiredForCreate(fields);

  const { ids, names } = await resolveCollaborators(ctx, fields.__rawCollaboratorIds, leaderId);

  return insertTask(ctx, {
    fields,
    leaderId,
    leaderName: leaderMember,
    collaboratorIds: ids,
    collaboratorNames: names,
    creatorId: admin.openid,
    token: payload.clientToken,
  });
}

/** create / adminCreate 的公共落库逻辑 */
async function insertTask(ctx, opts) {
  const { fields, leaderId, leaderName, collaboratorIds, collaboratorNames, creatorId, token } = opts;

  const _id = token ? manualTaskId(String(token).slice(0, 64)) : undefined;
  const doc = buildTaskDoc({
    fields,
    leaderId,
    leaderName,
    collaboratorIds,
    collaboratorNames,
    creatorId,
    db: ctx.db,
    _id,
    origin: ORIGIN.MANUAL,
  });

  if (_id) {
    // 有 clientToken：走幂等插入，重复请求视为已成功
    const r = await addIdempotent(ctx.db, TASKS, doc);
    if (!r.created) {
      const existed = await ctx.db.collection(TASKS).doc(_id).get();
      return { _id, idempotent: true, task: existed.data };
    }
    return { _id, task: doc };
  }

  // 无 clientToken（如管理员在云函数测试面板直接调用）：普通插入
  const res = await ctx.db.collection(TASKS).add({ data: doc });
  return { _id: res._id, task: doc };
}

/**
 * 修改任务属性。
 * ★ 仅主办人。字段经白名单过滤，leaderId / leader / creatorId 等
 *   服务端派生字段不在白名单内，前端改不动。
 */
async function update(payload, ctx) {
  await ctx.requireMember();
  const taskId = validate.assertNonEmptyString(payload.taskId, '任务');
  const task = await ctx.getTaskOrThrow(taskId);
  await ctx.requireLeaderOf(task);

  const patch = validate.validateTaskFields(payload.patch || {}, { isCreate: false });
  if (!Object.keys(patch).length) {
    throw new BizError(Codes.INVALID_PARAM, '没有需要更新的字段');
  }

  // 协办人变更：需要重建姓名快照
  if ('__rawCollaboratorIds' in patch) {
    const { ids, names } = await resolveCollaborators(ctx, patch.__rawCollaboratorIds, task.leaderId);
    patch.collaboratorIds = ids;
    patch.collaborator = names;
  }
  delete patch.__rawCollaboratorIds;

  // stage 与 actualCompleteTime 的服务端强制联动
  applyStageSideEffects(patch, task);

  patch.updatedAt = ctx.db.serverDate();
  await ctx.db.collection(TASKS).doc(taskId).update({ data: patch });

  return { taskId, patch };
}

/**
 * 自由加入协办 —— 无需主办人审批。
 *
 * ★ 用 addToSet 而不是读改写：读改写在一人同时从两台设备加入、
 *   或多人并发加入时会丢更新。addToSet 是数据库层原子操作。
 */
async function join(payload, ctx) {
  await ctx.requireMember();
  const taskId = validate.assertNonEmptyString(payload.taskId, '任务');
  const task = await ctx.getTaskOrThrow(taskId);

  if (perm.isLeader(task, ctx.openid)) {
    throw new BizError(Codes.INVALID_PARAM, '你是该任务的主办人，无需加入协办');
  }
  if (perm.isParticipant(task, ctx.openid)) {
    // 重复加入：幂等成功，不报错
    return { taskId, joined: true, idempotent: true };
  }
  if (task.stage === '已完成') {
    throw new BizError(Codes.INVALID_PARAM, '该任务已完成，无法再加入协办');
  }

  await ctx.db
    .collection(TASKS)
    .doc(taskId)
    .update({
      data: {
        collaboratorIds: ctx._.addToSet({ each: [ctx.openid] }),
        updatedAt: ctx.db.serverDate(),
      },
    });

  // 回读重建姓名快照。并发下两次重建结果一致（幂等），允许极短窗口不一致。
  const snap = await rebuildCollaboratorSnapshot(ctx, taskId);
  return { taskId, joined: true, ...snap };
}

/** 退出协办（仅本人退出自己） */
async function leave(payload, ctx) {
  await ctx.requireMember();
  const taskId = validate.assertNonEmptyString(payload.taskId, '任务');
  const task = await ctx.getTaskOrThrow(taskId);

  if (!perm.canLeave(task, ctx.openid)) {
    throw new BizError(Codes.INVALID_PARAM, '你不在该任务的协办名单中');
  }

  await ctx.db
    .collection(TASKS)
    .doc(taskId)
    .update({
      data: {
        collaboratorIds: ctx._.pull({ each: [ctx.openid] }),
        updatedAt: ctx.db.serverDate(),
      },
    });

  const snap = await rebuildCollaboratorSnapshot(ctx, taskId);
  return { taskId, left: true, ...snap };
}

/** 主办人移除协办人 */
async function removeCollaborator(payload, ctx) {
  await ctx.requireMember();
  const taskId = validate.assertNonEmptyString(payload.taskId, '任务');
  const targetOpenid = validate.assertNonEmptyString(payload.collaboratorOpenid, '协办人');
  const task = await ctx.getTaskOrThrow(taskId);
  await ctx.requireLeaderOf(task);

  await ctx.db
    .collection(TASKS)
    .doc(taskId)
    .update({
      data: {
        collaboratorIds: ctx._.pull({ each: [targetOpenid] }),
        updatedAt: ctx.db.serverDate(),
      },
    });

  const snap = await rebuildCollaboratorSnapshot(ctx, taskId);
  return { taskId, removed: true, ...snap };
}

/**
 * 删除任务（仅管理员）。
 * 同时清理该任务下的进展记录，避免留下孤儿数据污染人员看板统计。
 */
async function remove(payload, ctx) {
  await ctx.requireAdmin();
  const taskId = validate.assertNonEmptyString(payload.taskId, '任务');
  await ctx.getTaskOrThrow(taskId);

  // 进展记录可能超过单次 100 条上限，循环删干净
  let removed = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = await ctx.db
      .collection(COLLECTIONS.PROGRESS_RECORDS)
      .where({ taskId })
      .limit(100)
      .get();
    if (!r.data || !r.data.length) break;
    for (const rec of r.data) {
      await ctx.db.collection(COLLECTIONS.PROGRESS_RECORDS).doc(rec._id).remove();
      removed += 1;
    }
    if (r.data.length < 100) break;
  }

  await ctx.db.collection(TASKS).doc(taskId).remove();
  return { taskId, deleted: true, removedRecords: removed };
}

exports.main = createRouter({
  create,
  adminCreate,
  update,
  join,
  leave,
  removeCollaborator,
  delete: remove,
});
