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
const { isDuplicateError, periodicTaskId } = require('./idempotency');
const { buildPlan, normalizeToday, normalizePeriodType, describeOffsets, RECUR_FREQ_OF } = require('./periodic');
const { buildTaskDoc } = require('./taskRepo');

const TASKS = COLLECTIONS.TASKS;
const TEMPLATES = COLLECTIONS.PERIODIC_TEMPLATES;
const JOB_LOGS = COLLECTIONS.JOB_LOGS;

/**
 * 执行一次周期任务生成。
 *
 * ★ 没有「本次的 periodKey」这个参数了。
 *   改造前周期只在月粒度上生成，一个批次共用一个 key；
 *   现在每期由模板自己的开始日决定，月/季/年三种模板在同一轮巡检里
 *   可能分别落在 2026-10 / 2026-07 / 2026-01 三个不同的期上。
 *   所以 periodKey 是**每个模板各自算出来的**（见 periodic.evaluate），
 *   汇总里只保留「以哪天为准」的 today。
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {Date|string} [opts.today]  假装今天是哪天（'YYYY-MM-DD'），缺省取真实今天。
 *                                    ★ 用途是补跑历史周期：传 '2026-09-05' 就等于
 *                                    「如果 9 月 5 日那天跑过，会生成什么」——
 *                                    过期判定、开始日判定都按那天算，语义自洽。
 * @param {boolean} [opts.dryRun]     只计算不写库，用于管理员预览
 * @param {string}  [opts.templateId] 只跑这一个模板（建完计划立即生成当期任务用）。
 *                                    缺省跑全部启用模板。
 * @param {string} [opts.operator]    触发者标识（openid 或 'timer'），写入日志便于追溯
 * @returns {Promise<object>} 执行结果与明细
 */
async function runGenerate(db, opts = {}) {
  const today = normalizeToday(opts.today);
  const dryRun = !!opts.dryRun;
  const startedAt = Date.now();

  const created = [];
  const skipped = [];
  const failed = [];

  // ── 1. 取要跑的模板（云函数端单次上限 100，足够团队规模）────────────
  //     ★ 指定 templateId 时不再加 enabled 条件：建完计划当场生成时，
  //       我们想跑的就是"刚建的那一条"，由 evaluate 统一判定 enabled，
  //       免得"建完立刻停用"这种组合在这里和 periodic.js 里给出两种答案。
  const filter = opts.templateId ? { _id: opts.templateId } : { enabled: true };
  const tplRes = await db.collection(TEMPLATES).where(filter).limit(QUERY_BATCH).get();
  const templates = tplRes.data || [];

  // ── 2. 纯计算阶段：决定今天哪些模板该生成、任务名与起止日各是什么 ─────
  //     buildPlan 内部判定「开始日到了没 / 本期过期没」
  const { plan, skipped: notDue } = buildPlan(templates, today);
  for (const s of notDue) skipped.push(s);

  if (dryRun) {
    return {
      today,
      dryRun: true,
      wouldCreate: plan.map((p) => ({
        templateId: p.template._id,
        taskName: p.taskName,
        periodKey: p.periodKey,
        startDate: p.startDate,
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
    const periodKey = item.periodKey;
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
        // ★ recur_freq 由 periodType 派生，不读模板上的 recurFreq 字段 ——
        //   两个字段表达同一件事时，迟早会配出"每月 vs 每年"这种自相矛盾的任务。
        recur_freq: RECUR_FREQ_OF[normalizePeriodType(t.periodType)] || '',
        recur_rule: describeOffsets(t),
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
      created.push({
        templateId: t._id,
        name: t.name,
        taskId: docId,
        taskName: item.taskName,
        periodKey,
        startDate: item.startDate,
        dueDate: item.dueDate,
      });
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
    today,
    templateCount: templates.length,
    created,
    skipped,
    failed,
    operator: opts.operator || 'system',
    elapsedMs: Date.now() - startedAt,
    finishedAt: db.serverDate(),
  };

  try {
    // 不指定 _id：审计日志每次运行都要留一条，用不着确定性主键，
    // 交给数据库生成反而不会因为同毫秒撞主键而丢记录。
    await db.collection(JOB_LOGS).add({
      data: { ...summary, type: 'generatePeriodicTasks' },
    });
  } catch (e) {
    // 日志写入失败不应影响生成结果（任务已经正确落库了）
    console.error('[periodicRunner] 日志写入失败', e);
  }

  return summary;
}

module.exports = { runGenerate };
