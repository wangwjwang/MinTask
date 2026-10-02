/**
 * cloudfunctions/progressService/index.js
 * ---------------------------------------------------------------------------
 * 进展服务：新增进展记录、标记卡壳已解决。
 *
 * ★ 权限边界（需求第 4 节权限表）：
 *   ┌──────────────────────┬────────┬────────┬────────┐
 *   │                      │ 主办人 │ 协办人 │ 其他人 │
 *   ├──────────────────────┼────────┼────────┼────────┤
 *   │ 写进展/卡壳/需支持    │   ✅   │   ✅   │   ❌   │
 *   │ 同步改进度%/状态/阶段 │   ✅   │   ❌   │   ❌   │
 *   └──────────────────────┴────────┴────────┴────────┘
 *
 *   协办人若在请求里携带 progress/status/stage，本函数返回 FORBIDDEN_FIELD。
 *   ★ 刻意选择"显式拒绝"而不是"静默丢弃"：静默丢弃会让越权尝试不留痕迹，
 *     且前端会误以为提交成功，产生"我改了但没生效"的困惑。
 *
 * action 一览：
 *   addRecord       新增进展记录（可附带主办人专属的进度/状态/阶段变更）
 *   resolveBlocker  标记某条卡壳已解决
 *   deleteRecord    删除错误进展（仅管理员）
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const { BizError, Codes } = require('./lib/shared/errors');
const { COLLECTIONS, STATUS, STAGE } = require('./lib/shared/constants');
const validate = require('./lib/shared/validate');
const perm = require('./lib/shared/perm');
const { addIdempotent, progressRecordId } = require('./lib/shared/idempotency');
const {
  buildProgressDoc,
  recomputeTaskBlockers,
  applyStageSideEffects,
} = require('./lib/shared/taskRepo');

const TASKS = COLLECTIONS.TASKS;
const RECORDS = COLLECTIONS.PROGRESS_RECORDS;

/** 单个字段的长度上限，防止超长文本撑爆文档 */
const TEXT_MAX = { description: 2000, blocker: 500, needSupport: 500 };

// ---------------------------------------------------------------------------

/**
 * 新增进展记录。
 *
 * payload:
 *   taskId       必填
 *   description  进展描述（三者至少填一个）
 *   blocker      卡壳原因
 *   needSupport  需要支持
 *   progress     ★仅主办人  0-100
 *   status       ★仅主办人  健康度
 *   stage        ★仅主办人  阶段
 *   clientToken  幂等令牌
 */
async function addRecord(payload, ctx) {
  const me = await ctx.requireMember();
  const taskId = validate.assertNonEmptyString(payload.taskId, '任务');
  const task = await ctx.getTaskOrThrow(taskId);
  await ctx.requireParticipantOf(task);

  const isLeader = perm.isLeader(task, ctx.openid);

  // ── 1. 越权字段拦截（协办人不得改进度/状态/阶段）─────────────────────
  const leaderOnlyTouched = validate.PROGRESS_LEADER_EXTRA_FIELDS.filter(
    (f) => payload[f] !== undefined && payload[f] !== '' && payload[f] !== null
  );
  if (leaderOnlyTouched.length && !isLeader) {
    throw new BizError(
      Codes.FORBIDDEN_FIELD,
      `协办人无权修改：${leaderOnlyTouched.join('、')}`
    );
  }

  // ── 2. 校验进展正文 ─────────────────────────────────────────────────
  const base = validate.pick(payload, validate.PROGRESS_BASE_FIELDS);
  const description = String(base.description || '').trim().slice(0, TEXT_MAX.description);
  const blocker = String(base.blocker || '').trim().slice(0, TEXT_MAX.blocker);
  const needSupport = String(base.needSupport || '').trim().slice(0, TEXT_MAX.needSupport);

  // 三个字段全空则拒绝：空进展记录没有意义，只会污染时间线
  if (!description && !blocker && !needSupport) {
    throw new BizError(Codes.INVALID_PARAM, '请填写进展描述、卡壳原因或需要支持');
  }

  // ── 3. 主办人可同步推进任务本身的进度/健康度/阶段 ────────────────────
  // ★ 先算 patch 再写记录：patch 要随记录一起存下来，
  //   否则详情页时间线只能显示任务"当前"的进度值，
  //   无法知道是哪一次上报把它推到该值的。
  const taskPatch = {};
  if (isLeader) {
    if (payload.progress !== undefined && payload.progress !== null && payload.progress !== '') {
      taskPatch.progress = validate.assertProgress(payload.progress);
    }
    if (payload.status) {
      taskPatch.status = validate.assertEnum(payload.status, STATUS, '任务状态');
    }
    if (payload.stage) {
      taskPatch.stage = validate.assertEnum(payload.stage, STAGE, '任务阶段');
    }
  }

  // ── 4. 写入进展记录（幂等）──────────────────────────────────────────
  const token = payload.clientToken ? String(payload.clientToken).slice(0, 64) : '';
  const _id = token ? progressRecordId(token) : undefined;

  const doc = buildProgressDoc({
    taskId,
    taskName: task.task_name,
    updaterId: ctx.openid, // 服务端确定，前端传值无效
    updaterName: me.name,
    fields: { description, blocker, needSupport },
    status: task.status,
    appliedChanges: taskPatch,
    db: ctx.db,
    _id,
  });

  if (_id) {
    const r = await addIdempotent(ctx.db, RECORDS, doc);
    if (!r.created) {
      // 重复提交：视为已成功，但仍需保证任务上的派生字段是最新的
      await recomputeTaskBlockers(ctx.db, taskId);
      return { _id, idempotent: true };
    }
  } else {
    const res = await ctx.db.collection(RECORDS).add({ data: doc });
    doc._id = res._id;
  }

  // ── 5. 把主办人改动的字段落到任务上 ──────────────────────────────────
  if (Object.keys(taskPatch).length) {
    // stage 变更时自动维护 actualCompleteTime
    applyStageSideEffects(taskPatch, task);
    taskPatch.updatedAt = ctx.db.serverDate();
    await ctx.db.collection(TASKS).doc(taskId).update({ data: taskPatch });
  }

  // ── 6. 重算卡壳冗余字段（看板靠它一次查询拿到高亮状态）────────────────
  const blockerState = await recomputeTaskBlockers(ctx.db, taskId);

  return {
    _id: doc._id,
    record: doc,
    taskPatch,
    ...blockerState,
  };
}

/**
 * 标记某条卡壳已解决。
 * 权限：任务主办人，或该条进展的提交人本人。
 */
async function resolveBlocker(payload, ctx) {
  await ctx.requireMember();
  const recordId = validate.assertNonEmptyString(payload.recordId, '进展记录');

  const recRes = await ctx.db.collection(RECORDS).doc(recordId).get().catch(() => null);
  if (!recRes || !recRes.data) throw new BizError(Codes.RECORD_NOT_FOUND);
  const record = recRes.data;

  if (!record.hasBlocker) {
    throw new BizError(Codes.INVALID_PARAM, '该条进展没有卡壳需要解决');
  }
  if (record.blockerResolved === true) {
    return { recordId, resolved: true, idempotent: true };
  }

  const task = await ctx.getTaskOrThrow(record.taskId);
  if (!perm.canResolveBlocker(task, record, ctx.openid)) {
    throw new BizError(Codes.FORBIDDEN_NOT_PARTICIPANT, '仅主办人或该条进展的提交人可标记解决');
  }

  await ctx.db.collection(RECORDS).doc(recordId).update({
    data: { blockerResolved: true, resolvedAt: ctx.db.serverDate() },
  });

  const blockerState = await recomputeTaskBlockers(ctx.db, record.taskId);
  return { recordId, resolved: true, ...blockerState };
}

/** 删除错误进展（仅管理员），随后重算卡壳状态 */
async function removeRecord(payload, ctx) {
  await ctx.requireAdmin();
  const recordId = validate.assertNonEmptyString(payload.recordId, '进展记录');

  const recRes = await ctx.db.collection(RECORDS).doc(recordId).get().catch(() => null);
  if (!recRes || !recRes.data) throw new BizError(Codes.RECORD_NOT_FOUND);

  await ctx.db.collection(RECORDS).doc(recordId).remove();
  const blockerState = await recomputeTaskBlockers(ctx.db, recRes.data.taskId);
  return { recordId, deleted: true, ...blockerState };
}

exports.main = createRouter({
  addRecord,
  resolveBlocker,
  deleteRecord: removeRecord,
});
