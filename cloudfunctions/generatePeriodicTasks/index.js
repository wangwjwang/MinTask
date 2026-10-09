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
 *      payload: { asOf?: '2026-09-05', dryRun?: boolean }
 *      asOf 表示"假装今天是哪天"，想补哪一期就传那一期的开始日。
 * ---------------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk');
const { runGenerate } = require('./lib/shared/periodicRunner');
const { buildCtx } = require('./lib/shared/ctx');
const { BizError, Codes, describeInfraError } = require('./lib/shared/errors');
const { isValidDateStr } = require('./lib/shared/dates');
const { syncAllDemands } = require('./lib/shared/demandRepo');

/** 把 asOf 读成 'YYYY-MM-DD'；没给返回 undefined（按真实今天算）。 */
function readAsOf(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (!isValidDateStr(s)) {
    throw new BizError(Codes.INVALID_PARAM, '日期格式应为 YYYY-MM-DD，如 2026-09-05');
  }
  return s;
}

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

      /*
       * ── 需求状态兜底重算 ────────────────────────────────────────────
       * 四个即时落点（建任务 / 改任务 / 报进展 / 删任务）都可能重算失败 ——
       * 它们一律被 syncDemandQuietly 吞掉以保证主流程不被带崩。这里就是
       * 那些漏网之鱼的收敛口：每天扫一遍，把派生状态拉回真实状态。
       * ★ 不新建一个云函数：一个每天只跑一次的巡检单独占一个函数名、
       *   一份部署、一份 lib/shared 副本，代价大于收益；而本函数本来就是
       *   "每天扫一遍库、把派生状态收敛到真实状态"的定位，加这一段是同性质的。
       */
      let demandSync = null;
      try {
        demandSync = await syncAllDemands(db);
        console.log(
          `[generatePeriodicTasks] 需求重算 扫描=${demandSync.scanned} 变化=${demandSync.changed}`
        );
      } catch (e) {
        // 需求重算失败不能影响周期任务生成的结果（它已经落库了），只记日志
        console.error('[generatePeriodicTasks] 需求重算失败', e);
      }

      console.log(
        `[generatePeriodicTasks] 完成 以 ${result.today} 为准 新建=${result.created.length} 跳过=${result.skipped.length} 失败=${result.failed.length}`
      );
      return { ok: true, data: Object.assign({ demandSync }, result) };
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

    const payload = event.payload || {};
    const result = await runGenerate(db, {
      today: readAsOf(event.asOf || payload.asOf),
      dryRun: !!(event.dryRun || payload.dryRun),
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
