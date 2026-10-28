/**
 * scripts/check-periodic-plan.js
 * 一次性只读排查：为什么某条周期计划本期没生成任务。
 * 通过 dashboardService（与网页看板同一通道）拉取全量数据，只查询不写入。
 *
 *   node scripts/check-periodic-plan.js "数智化转型动态" <看板口令>
 */
'use strict';

const KEYWORD = process.argv[2] || '数智化转型动态';
const PASSCODE = process.argv[3];
const ENV_ID = 'cloudbase-d9gl0ogzkfd0d94f2';

if (!PASSCODE) {
  console.error('用法: node scripts/check-periodic-plan.js <计划名关键字> <看板口令>');
  process.exit(1);
}

async function main() {
  const tcb = (await import('@cloudbase/js-sdk')).default;
  const app = tcb.init({ env: ENV_ID });
  await app.auth({ persistence: 'memory' }).anonymousAuthProvider().signIn();
  const r = await app.callFunction({ name: 'dashboardService', data: { passcode: PASSCODE } });
  const d = r.result;
  if (!d || d.code !== 0) {
    console.error('dashboardService 调用失败:', JSON.stringify(d));
    process.exit(1);
  }
  const data = d.data;

  const templates = data.periodicTemplates || [];
  console.log('=== periodic_templates ===');
  console.log('模板总数:', templates.length);
  const matched = templates.filter((t) => String(t.name || '').includes(KEYWORD));
  for (const t of templates) {
    const flag = matched.includes(t) ? '  <<< 匹配' : '';
    console.log(JSON.stringify({
      _id: t._id, name: t.name, enabled: t.enabled, periodType: t.periodType,
      startMonthIdx: t.startMonthIdx, startDay: t.startDay,
      endMonthIdx: t.endMonthIdx, endDay: t.endDay,
      deadlineRule: t.deadlineRule, taskNameTemplate: t.taskNameTemplate,
      ownerName: t.ownerName,
    }) + flag);
  }

  const tasks = data.tasks || [];
  for (const t of matched) {
    const byTpl = tasks.filter((x) => x.templateId === t._id);
    console.log(`\n=== 该模板已生成的任务 === ${byTpl.length} 条`);
    byTpl.forEach((x) => console.log(JSON.stringify({
      name: x.name, start: x.startDate, due: x.dueDate,
      status: x.status, stage: x.stage, origin: x.origin, leader: x.leaderName,
    })));
    const byName = tasks.filter((x) => String(x.name || '').includes(KEYWORD));
    console.log(`\n=== 任务名含「${KEYWORD}」 === ${byName.length} 条`);
    byName.forEach((x) => console.log(JSON.stringify({
      name: x.name, start: x.startDate, due: x.dueDate, status: x.status, leader: x.leaderName,
    })));
  }
}

main().catch((e) => {
  console.error('查询失败:', e.message || e);
  process.exit(1);
});
