/**
 * cloudfunctions/generatePeriodicTasks/index.js
 * ---------------------------------------------------------------------------
 * 周期性任务生成 —— 定时触发器入口。
 *
 * ★ 触发策略（与需求原文的差异，已确认）：
 *   需求写的是「每月 1 日 0 点」，实际改为「每日 00:05 巡检」。
 *   原因：微信云开发的定时触发器**失败没有重试机制**。若每月 1 日那一刻
 *   环境异常或函数报错，会导致整整一个月没有任务，而且没有任何提示。
 *   改为每日巡检后，漏跑一天次日自动补上。
 *
 *   代价只是每天一次空读（读一次模板表），可忽略。
 *   配合确定性 _id（pt-{templateId}-{periodKey}），一个月跑 30 次
 *   也只会生成一份任务。
 *
 * Cron 格式为 7 位「秒 分 时 日 月 周 年」，见同目录 config.json。
 *
 * 本函数同时支持两种调用方式：
 *   1. 定时触发器 —— 无 openid，直接执行
 *   2. 管理员手动补跑 —— 经 callFunction 调用，需管理员身份
 *      payload: { periodKey?: '2026-11', dryRun?: boolean }
 * ---------------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk');
const { runGenerate } = require('./lib/shared/periodicRunner');
const { buildCtx } = require('./lib/shared/ctx');
const { BizError, Codes, describeInfraError } = require('./lib/shared/errors');

/**
 * 判断是否来自定时触发器。
 * 定时触发器传入的事件形如 { Type: 'Timer', TriggerName: 'xxx', Time: '...' }，
 * 与 callFunction 的 { action, payload } 结构明显不同。
 */
function isTimerEvent(event) {
  if (!event) return false;
  return event.Type === 'Timer' || !!event.TriggerName;
}

exports.main = async (event = {}) => {
  const db = cloud.database();

  // ── 路径一：定时触发 ────────────────────────────────────────────────
  if (isTimerEvent(event)) {
    console.log('[generatePeriodicTasks] 定时巡检开始', event.TriggerName || event.Type);
    try {
      const result = await runGenerate(db, { operator: 'timer' });
      console.log(
        `[generatePeriodicTasks] 完成 周期=${result.periodKey} 新建=${result.created.length} 跳过=${result.skipped.length} 失败=${result.failed.length}`
      );
      return { ok: true, data: result };
    } catch (e) {
      // 定时触发的返回值无人接收，只能靠日志排查。这里必须打全堆栈。
      console.error('[generatePeriodicTasks] 巡检异常', e);
      return { ok: false, code: Codes.INTERNAL, message: String(e.message || e) };
    }
  }

  // ── 路径二：管理员手动调用（补跑 / 预览）────────────────────────────
  try {
    const ctx = buildCtx(event);
    await ctx.requireAdmin();

    const result = await runGenerate(db, {
      periodKey: event.periodKey || event.payload && event.payload.periodKey,
      dryRun: !!(event.dryRun || (event.payload && event.payload.dryRun)),
      operator: ctx.openid,
    });
    return { ok: true, data: result };
  } catch (e) {
    if (e instanceof BizError) {
      return { ok: false, code: e.code, message: e.message };
    }
    console.error('[generatePeriodicTasks] 手动调用异常', e);
    // 与 router 一致：部署期错误单独翻译，别让它淹在"服务异常"里
    const infra = describeInfraError(e);
    if (infra) {
      return { ok: false, code: infra.code, message: infra.message };
    }
    return { ok: false, code: Codes.INTERNAL, message: '服务异常，请稍后重试' };
  }
};
