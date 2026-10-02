/**
 * shared/periodicRunner.js
 * ---------------------------------------------------------------------------
 * 周期任务的「落库执行」核心。被两处共用：
 *   1. cloudfunctions/generatePeriodicTasks —— 每日定时巡检
 *   2. cloudfunctions/templateService 的 generateNow —— 管理员手动补跑
 *
 * ⚠ 依赖 wx-server-sdk（db 由调用方传入），只能被云函数引用。
 *
 * ★★ 幂等设计（本文件最重要的部分）★★
 *
 * 主手段是「确定性 _id」，不是「先查后写」：
 *   _id = `pt-${templateId}-${periodKey}`
 *   _id 是数据库主键，同一模板同一周期永远只可能有一个文档。
 *   重复触发时第二次插入必被数据库拒绝，这是并发下唯一可靠的保证。
 *
 *   为什么不靠"先查后写"：它存在 TOCTOU 竞态 —— 两个并发实例可能
 *   同时 count 到 0，然后双双写入，产生两条重复任务。
 *
 *   代码里确实还有一层 count 查重，但那只是「快速跳过」的优化：
 *   让正常路径不产生异常日志，正确性完全由确定性 _id 兜底。
 *
 * ★ 为什么不做「全局运行锁」：
 *   锁一旦因中途失败而未释放，会导致整个周期被永久跳过 —— 比重复生成
 *   危险得多。确定性 _id 已让重复运行完全无害，所以正确策略是
 *   「宁可多跑，不可少跑」。
 * ---------------------------------------------------------------------------
 */

const { COLLECTIONS, ORIGIN, QUERY_BATCH } = require('./constants');
const { periodKeyOf } = require('./dates');
const { isDuplicateError, periodicTaskId, jobLogId } = require('./idempotency');
const { buildPlan } = require('./periodic');
const { buildTaskDoc } = require('./taskRepo');

const TASKS = COLLECTIONS.TASKS;
const TEMPLATES = COLLECTIONS.PERIODIC_TEMPLATES;
const JOB_LOGS = COLLECTIONS.JOB_LOGS;

/**
 * 执行一次周期任务生成。
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.periodKey]  指定周期（如 '2026-11'），缺省取当前月。手动补跑用。
 * @param {boolean} [opts.dryRun]    只计算不写库，用于管理员预览
 * @param {string} [opts.operator]   触发者标识（openid 或 'timer'），写入日志便于追溯
 * @returns {Promise<object>} 执行结果与明细
 */
async function runGenerate(db, opts = {}) {
  const periodKey = opts.periodKey || periodKeyOf(new Date());
  const dryRun = !!opts.dryRun;
  const startedAt = Date.now();

  const created = [];
  const skipped = [];
  const failed = [];

  // ── 1. 取所有启用的模板（云函数端单次上限 100，足够团队规模）──────────
  const tplRes = await db
    .collection(TEMPLATES)
    .where({ enabled: true })
    .limit(QUERY_BATCH)
    .get();
  const templates = tplRes.data || [];

  // ── 2. 纯计算阶段：决定本月哪些模板该生成、任务名与截止日各是什么 ──────
  //      buildPlan 内部按 periodType 过滤（季/年周期不会每月都生成）
  const plan = buildPlan(templates, periodKey);

  // 未进入 plan 的启用模板，记录为"本周期无需生成"，便于排查模板配置
  const plannedIds = new Set(plan.map((p) => p.template._id));
  for (const t of templates) {
    if (!plannedIds.has(t._id)) {
      skipped.push({ templateId: t._id, name: t.name, reason: 'not_due_this_period' });
    }
  }

  if (dryRun) {
    return {
      periodKey,
      dryRun: true,
      wouldCreate: plan.map((p) => ({
        templateId: p.template._id,
        taskName: p.taskName,
        dueDate: p.dueDate,
        docId: p.docId,
      })),
      skipped,
      created: [],
      failed: [],
    };
  }

  // ── 3. 逐条落库 ─────────────────────────────────────────────────────
  for (const item of plan) {
    const t = item.template;
    const docId = periodicTaskId(t._id, periodKey);

    // 3a. 廉价查重：让"已存在"走正常分支，而不是靠捕获异常。
    //     这一层不承担正确性（并发下可能同时查到 0），只是减少日志噪音。
    const dup = await db
      .collection(TASKS)
      .where({ templateId: t._id, periodKey })
      .count();
    if (dup.total > 0) {
      skipped.push({ templateId: t._id, name: t.name, reason: 'exists' });
      continue;
    }

    // 3b. 组装任务文档。主办/协办姓名直接用模板里存好的快照，
    //     不再回查 members —— 模板配置时已校验过，且周期任务由系统生成，
    //     即使成员后来改名也应以模板语义为准。
    const doc = buildTaskDoc({
      fields: {
        task_name: item.taskName,
        category: t.category || '其他',
        source: t.source || '自发创新',
        task_type: t.taskType || '周期性',
        recur_freq: t.recurFreq || '每月',
        recur_rule: t.recurRule || t.deadlineRule || '',
        priority: t.priority || 'P2',
        progress: 0,
        start_date: item.startDate,
        due_date: item.dueDate,
        detail: t.detail || '',
        status: '正常',
        stage: '未开始',
      },
      leaderId: t.ownerId,
      leaderName: t.ownerName,
      collaboratorIds: t.collaboratorIds || [],
      collaboratorNames: (t.collaboratorNames || []).join(';'),
      creatorId: 'system',
      db,
      _id: docId,
      origin: ORIGIN.PERIODIC,
      templateId: t._id,
      periodKey,
    });

    try {
      await db.collection(TASKS).add({ data: doc });
      created.push({ templateId: t._id, name: t.name, taskId: docId, taskName: item.taskName });
    } catch (e) {
      if (isDuplicateError(e)) {
        // 并发窗口：两个实例同时通过了 3a 的查重，其中一个在这里被主键拦下。
        // 这不是错误，结果依然正确（只生成了一份）。
        skipped.push({ templateId: t._id, name: t.name, reason: 'duplicate_id' });
      } else {
        failed.push({ templateId: t._id, name: t.name, error: String(e.errMsg || e.message || e) });
        console.error('[periodicRunner] 生成失败', t._id, e);
      }
    }
  }

  // ── 4. 写审计日志 ───────────────────────────────────────────────────
  const summary = {
    periodKey,
    templateCount: templates.length,
    created,
    skipped,
    failed,
    operator: opts.operator || 'system',
    elapsedMs: Date.now() - startedAt,
    finishedAt: db.serverDate(),
  };

  try {
    await db.collection(JOB_LOGS).add({
      data: { ...summary, _id: jobLogId(periodKey, Date.now()), type: 'generatePeriodicTasks' },
    });
  } catch (e) {
    // 日志写入失败不应影响生成结果（任务已经正确落库了）
    console.error('[periodicRunner] 日志写入失败', e);
  }

  return summary;
}

module.exports = { runGenerate };
