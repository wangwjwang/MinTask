#!/usr/bin/env node
/**
 * scripts/selfcheck.js
 * ---------------------------------------------------------------------------
 * 纯逻辑自检。覆盖那些「靠点界面验不出来」的部分：
 *   - 日期定长补零（写错会导致排序与范围查询静默错乱）
 *   - 周期任务名占位符替换与截止日计算（含 2 月/月末边界）
 *   - 幂等 _id 的确定性（写错会导致重复生成任务）
 *   - 权限矩阵（写错会导致越权）
 *   - 字段白名单（写错会导致前端能改 leaderId）
 *   - 数组更新指令的写法（写错会导致加入协办静默失效，见文件末尾那一节）
 *
 * 不依赖云环境，直接 `node scripts/selfcheck.js` 即可运行。
 * 建议改完 shared/ 后跑一次。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const S = (m) => require(path.join(__dirname, '..', 'shared', m));

const dates = S('dates');
const periodic = S('periodic');
const idem = S('idempotency');
const perm = S('perm');
const validate = S('validate');
const C = S('constants');
const { Codes, BizError, describeInfraError } = S('errors');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`);
  }
}

function checkThrows(label, fn, expectedCode) {
  try {
    fn();
    failed += 1;
    console.log(`  ✗ ${label}\n      期望抛出 ${expectedCode}，实际未抛出`);
  } catch (e) {
    if (e instanceof BizError && e.code === expectedCode) {
      passed += 1;
      console.log(`  ✓ ${label}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${label}\n      期望 ${expectedCode}，实际 ${e.code || e.message}`);
    }
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section('日期工具 — 定长补零是排序与范围查询的前提');

check('个位月/日补零', dates.formatDate(new Date(2026, 0, 5)), '2026-01-05');
check('两位月/日', dates.formatDate(new Date(2026, 9, 25)), '2026-10-25');
check('周期键定长', dates.periodKeyOf(new Date(2026, 0, 15)), '2026-01');
check('周期键定长（两位数月）', dates.periodKeyOf(new Date(2026, 11, 1)), '2026-12');

check('合法日期', dates.isValidDateStr('2026-10-25'), true);
check('拒绝非补零写法', dates.isValidDateStr('2026-9-5'), false);
check('拒绝不存在的日期 2/30', dates.isValidDateStr('2026-02-30'), false);
check('闰年 2/29 合法', dates.isValidDateStr('2028-02-29'), true);
check('平年 2/29 非法', dates.isValidDateStr('2026-02-29'), false);
check('拒绝 13 月', dates.isValidDateStr('2026-13-01'), false);

check('2 月天数（平年）', dates.daysInMonth(2026, 2), 28);
check('2 月天数（闰年）', dates.daysInMonth(2028, 2), 29);
check('4 月天数', dates.daysInMonth(2026, 4), 30);

// 定长补零后字典序必须等于时间序 —— 这是 range 查询正确性的根基
check(
  '定长补零后字典序 === 时间序',
  dates.compareDateStr('2026-09-05', '2026-10-01') < 0,
  true
);

// ---------------------------------------------------------------------------
section('周期任务名 — 占位符替换');

const pk = '2026-10';
check(
  '中文年月占位符',
  periodic.renderName('{{YYYY年MM月}}-XX检查', { periodKey: pk, deadline: '2026-10-25' }),
  '2026年10月-XX检查'
);
check(
  '数字年月占位符（月需补零）',
  periodic.renderName('{{YYYY}}-{{MM}} 报表', { periodKey: '2026-01', deadline: '' }),
  '2026-01 报表'
);
check('YYYYMM 占位符', periodic.renderName('{{YYYYMM}}', { periodKey: pk }), '2026-10');
check(
  'deadline 占位符',
  periodic.renderName('{{YYYY年MM月}}（截止{{deadline}}）', { periodKey: pk, deadline: '2026-10-25' }),
  '2026年10月（截止2026-10-25）'
);
check('未识别占位符原样保留', periodic.renderName('{{FOO}}', { periodKey: pk }), '{{FOO}}');
check('无占位符的模板原样返回', periodic.renderName('固定任务名', { periodKey: pk }), '固定任务名');

// ---------------------------------------------------------------------------
section('截止日计算 — 含月末与跨月边界');

check('当月 25 号', periodic.deadlineOf('当月 25 号', '2026-10'), '2026-10-25');
check('忽略时间部分', periodic.deadlineOf('当月25日23:59', '2026-10'), '2026-10-25');
check('超出当月天数取月末（2 月）', periodic.deadlineOf('当月 30 号', '2026-02'), '2026-02-28');
check('闰年 2 月月末', periodic.deadlineOf('当月 30 号', '2028-02'), '2028-02-29');
check('超出当月天数取月末（4 月）', periodic.deadlineOf('当月 31 号', '2026-04'), '2026-04-30');
check('次月', periodic.deadlineOf('次月 5 号', '2026-10'), '2026-11-05');
check('次月跨年', periodic.deadlineOf('次月 5 号', '2026-12'), '2027-01-05');
check('当月末（无数字）', periodic.deadlineOf('当月末', '2026-10'), '2026-10-31');
check('空规则取月末', periodic.deadlineOf('', '2026-02'), '2026-02-28');

// ---------------------------------------------------------------------------
section('周期计划 — 期内偏移算绝对日期');

check('月度：第 1 个月 5 号', periodic.dateInPeriod('2026-10', 1, 5), '2026-10-05');
check('季度：本季度第 3 个月 20 号', periodic.dateInPeriod('2026-07', 3, 20), '2026-09-20');
check('年度：本年度第 12 个月 25 号', periodic.dateInPeriod('2026-01', 12, 25), '2026-12-25');
check('超当月天数收敛到月末（2 月）', periodic.dateInPeriod('2026-02', 1, 30), '2026-02-28');
check('闰年 2 月', periodic.dateInPeriod('2028-02', 1, 30), '2028-02-29');
check('月份溢出到次年', periodic.dateInPeriod('2026-11', 3, 5), '2027-01-05');
check('Q4 第 3 个月不跨年', periodic.dateInPeriod('2026-10', 3, 20), '2026-12-20');

// ---------------------------------------------------------------------------
section('周期计划 — 今天属于哪一期（返回期首月）');

check('月度看当月', periodic.periodKeyFor('monthly', '2026-08-15'), '2026-08');
check('季度取季首月', periodic.periodKeyFor('quarterly', '2026-08-15'), '2026-07');
check('季末月仍算本季', periodic.periodKeyFor('quarterly', '2026-09-30'), '2026-07');
check('Q4 取 10 月', periodic.periodKeyFor('quarterly', '2026-12-31'), '2026-10');
check('年度取 1 月', periodic.periodKeyFor('yearly', '2026-08-15'), '2026-01');

// ---------------------------------------------------------------------------
/*
 * 核心规则：本期的**开始日到了**才生成，不是「每月 1 号」。
 * 用「≥ 开始日」而不是「== 开始日」，是为了容忍漏跑 ——
 * 5 号那天环境异常没跑成，6 号跑照样生成；重复生成由确定性 _id 拦下。
 *
 * ★ evaluate().due 的语义是「本期任务现在应该存在了」，
 *   不是「现在要插一条」。「是不是已经存在」由 runner 查库判断 ——
 *   evaluate 是纯函数，看不到库里有什么。
 */
section('周期计划 — 开始日到了才生成');

// 月度：每月 5 号开始、25 号截止
const mTpl = (over) => Object.assign({
  _id: 't1', name: 'T', enabled: true, periodType: 'monthly',
  startMonthIdx: 1, startDay: 5, endMonthIdx: 1, endDay: 25,
}, over);

check('4 号还没到开始日 → 不生成', periodic.evaluate(mTpl({}), '2026-10-04').due, false);
check('原因是 not_started', periodic.evaluate(mTpl({}), '2026-10-04').reason, 'not_started');
check('5 号当天 → 生成', periodic.evaluate(mTpl({}), '2026-10-05').due, true);
check('漏跑一天，6 号补上 → 生成', periodic.evaluate(mTpl({}), '2026-10-06').due, true);
check('25 号当天仍可补跑 → 生成', periodic.evaluate(mTpl({}), '2026-10-25').due, true);
check('26 号本期已过期 → 不生成', periodic.evaluate(mTpl({}), '2026-10-26').due, false);
check('原因是 period_expired', periodic.evaluate(mTpl({}), '2026-10-26').reason, 'period_expired');
check('进入下月开始日 → 恢复生成', periodic.evaluate(mTpl({}), '2026-11-05').due, true);
check('停用的计划不生成', periodic.evaluate(mTpl({ enabled: false }), '2026-10-05').due, false);
check('停用的原因是 disabled', periodic.evaluate(mTpl({ enabled: false }), '2026-10-05').reason, 'disabled');

// 季度：本季度第 1 个月 5 号开始、第 3 个月 20 号截止
const qTpl = (over) => Object.assign({
  _id: 'q1', name: 'Q', enabled: true, periodType: 'quarterly',
  startMonthIdx: 1, startDay: 5, endMonthIdx: 3, endDay: 20,
}, over);

check('Q3：7/4 不生成', periodic.evaluate(qTpl({}), '2026-07-04').due, false);
check('Q3：7/5 生成', periodic.evaluate(qTpl({}), '2026-07-05').due, true);
check('Q3：8 月仍是本期（已存在则由 _id 拦下）', periodic.evaluate(qTpl({}), '2026-08-15').due, true);
check('Q3：本期 periodKey 是季首月', periodic.evaluate(qTpl({}), '2026-09-01').periodKey, '2026-07');
check('Q3：9/21 过期', periodic.evaluate(qTpl({}), '2026-09-21').due, false);
check('Q4：10/5 生成', periodic.evaluate(qTpl({}), '2026-10-05').due, true);
check('Q4：10/4 不生成', periodic.evaluate(qTpl({}), '2026-10-04').due, false);

// 年度：4 月 5 号开始、12 月 25 号截止（不跟自然年走的年度计划）
const yTpl = (over) => Object.assign({
  _id: 'y1', name: 'Y', enabled: true, periodType: 'yearly',
  startMonthIdx: 4, startDay: 5, endMonthIdx: 12, endDay: 25,
}, over);

check('年度：4/4 不生成', periodic.evaluate(yTpl({}), '2026-04-04').due, false);
check('年度：4/5 生成', periodic.evaluate(yTpl({}), '2026-04-05').due, true);
check('年度：次年 1 月还没到开始日', periodic.evaluate(yTpl({}), '2027-01-10').due, false);
check('年度：12/26 过期', periodic.evaluate(yTpl({}), '2026-12-26').due, false);

// ---------------------------------------------------------------------------
section('周期计划 — 名字前缀与本期起止');

check(
  '月度：中文年月前缀',
  periodic.evaluate(mTpl({ taskNameTemplate: '{{YYYY年MM月}}写报告' }), '2026-10-05').taskName,
  '2026年10月写报告'
);
check('季度占位符 → 三季度', periodic.renderName('{{YYYY}}年{{季度}}检查', { periodKey: '2026-07' }), '2026年三季度检查');
check('Q4 → 四季度', periodic.renderName('{{季度}}', { periodKey: '2026-10' }), '四季度');
check('Q1 → 一季度', periodic.renderName('{{季度}}', { periodKey: '2026-01' }), '一季度');
check('月度模板里的季度 = 该月所属季度', periodic.renderName('{{季度}}', { periodKey: '2026-02' }), '一季度');
check('年度前缀不需要新占位符', periodic.renderName('{{YYYY}}年 写报告', { periodKey: '2026-01' }), '2026年 写报告');

// 前缀规则的真源：前端预览与服务端渲染必须走同一份
const withPrefix = (type, name, pk) =>
  periodic.renderName(periodic.NAME_PREFIX[type] + name, { periodKey: pk, deadline: '' });
check('月度前缀', withPrefix('monthly', '写报告', '2026-10'), '2026年10月写报告');
check('季度前缀', withPrefix('quarterly', '检查', '2026-07'), '2026年三季度检查');
check('年度前缀', withPrefix('yearly', '总结', '2026-01'), '2026年总结');
check('周期类型 → recur_freq（月）', periodic.RECUR_FREQ_OF.monthly, '每月');
check('周期类型 → recur_freq（季）', periodic.RECUR_FREQ_OF.quarterly, '每季');
check('周期类型 → recur_freq（年）', periodic.RECUR_FREQ_OF.yearly, '每年');

// ★ 派生的 recur_freq 必须是合法枚举值，否则云函数写库时会被校验挡下
check(
  '派生的 recur_freq 都在枚举内',
  Object.values(periodic.RECUR_FREQ_OF).every((v) => C.RECUR_FREQ.indexOf(v) !== -1),
  true
);
check(
  'NAME_PREFIX 覆盖全部周期类型',
  Object.keys(periodic.MONTHS_PER_PERIOD).every((k) => periodic.NAME_PREFIX[k] && periodic.RECUR_FREQ_OF[k]),
  true
);
check('月度计划开始日', periodic.evaluate(mTpl({}), '2026-10-05').startDate, '2026-10-05');
check('季度计划开始日', periodic.evaluate(qTpl({}), '2026-07-05').startDate, '2026-07-05');
check('季度计划截止日', periodic.evaluate(qTpl({}), '2026-07-05').dueDate, '2026-09-20');
check('年度计划截止日', periodic.evaluate(yTpl({}), '2026-04-05').dueDate, '2026-12-25');

// ---------------------------------------------------------------------------
/*
 * 老模板兼容：2026-10-03 之前建的模板只有 deadlineRule 这个字符串规则，
 * 没有 startMonthIdx/startDay 等字段。它们仍要能跑：
 * 开始日退回「当期 1 号」，截止日仍按字符串规则解析。
 */
section('周期计划 — 老模板（只有 deadlineRule 字符串）仍能跑');

const legacy = { _id: 'L', name: 'L', enabled: true, periodType: 'monthly', deadlineRule: '当月 25 号' };
check('开始日退回当月 1 号', periodic.evaluate(legacy, '2026-10-05').startDate, '2026-10-01');
check('截止日仍按字符串规则', periodic.evaluate(legacy, '2026-10-05').dueDate, '2026-10-25');
check('1 号就生成', periodic.evaluate(legacy, '2026-10-01').due, true);
check('上个月末不生成', periodic.evaluate(legacy, '2026-09-30').due, false);

// ---------------------------------------------------------------------------
section('周期计划 — 未识别的周期类型保守跳过');

check('weekly 不生成', periodic.evaluate(mTpl({ periodType: 'weekly' }), '2026-10-05').due, false);
check('原因是 bad_period_type', periodic.evaluate(mTpl({ periodType: 'weekly' }), '2026-10-05').reason, 'bad_period_type');

// ---------------------------------------------------------------------------
section('周期计划 — 一句话描述排期（recur_rule 的文案）');

check(
  '月度：每月几号到几号',
  periodic.describeOffsets(mTpl({ startDay: 5, endDay: 25 })),
  '每月5日—25日'
);
check(
  '季度：本季第几个月的几号',
  periodic.describeOffsets(qTpl({ startMonthIdx: 1, startDay: 5, endMonthIdx: 3, endDay: 20 })),
  '每季第1个月5日—第3个月20日'
);
check(
  '年度：本年度几月几号',
  periodic.describeOffsets(yTpl({ startMonthIdx: 4, startDay: 5, endMonthIdx: 12, endDay: 25 })),
  '每年4月5日—12月25日'
);
check('周期类型认不出就不编文案', periodic.describeOffsets({ periodType: 'weekly' }), '');
check('没填偏移时给可读的缺省', periodic.describeOffsets({ periodType: 'monthly' }), '每月1日—31日');
check('越界的偏移不编出错误日期', periodic.describeOffsets({ periodType: 'monthly', startDay: 99 }), '每月1日—31日');

// ---------------------------------------------------------------------------
section('周期计划 — buildPlan 汇总');

const bp = periodic.buildPlan(
  [mTpl({ taskNameTemplate: '{{YYYY年MM月}}写报告' }), qTpl({ enabled: false })],
  '2026-10-05'
);
check('只收集该生成的', bp.plan.length, 1);
check('plan 带渲染后的任务名', bp.plan[0].taskName, '2026年10月写报告');
check('plan 带确定性 _id', bp.plan[0].docId, 'pt-t1-2026-10');
check('plan 带本期开始日', bp.plan[0].startDate, '2026-10-05');
check('停用的进 skipped', bp.skipped.length, 1);
check('skipped 带原因', bp.skipped[0].reason, 'disabled');

// ---------------------------------------------------------------------------
section('幂等 _id — 确定性是防重复生成的根基');

check('同模板同周期 → 同 _id', idem.periodicTaskId('abc', '2026-10'), 'pt-abc-2026-10');
check(
  '同模板不同周期 → 不同 _id',
  idem.periodicTaskId('abc', '2026-10') !== idem.periodicTaskId('abc', '2026-11'),
  true
);
check(
  '不同模板同周期 → 不同 _id',
  idem.periodicTaskId('a', '2026-10') !== idem.periodicTaskId('b', '2026-10'),
  true
);
check('自定义 _id 字符集合法（仅 a-z0-9-）', /^[a-z0-9-]+$/.test(idem.periodicTaskId('tpl123', '2026-10')), true);
check('clientToken 两次生成不同', idem.clientToken('t') !== idem.clientToken('t'), true);

// 重复键异常识别：不同 SDK 版本报错文案不一样，都要能认出来
check('识别 duplicate key 文案', idem.isDuplicateError({ errMsg: 'duplicate key error' }), true);
check('识别 E11000 文案', idem.isDuplicateError({ message: 'E11000 duplicate key' }), true);
check('普通错误不误判', idem.isDuplicateError({ errMsg: 'network timeout' }), false);
check('空错误不误判', idem.isDuplicateError(null), false);

// ---------------------------------------------------------------------------
section('权限矩阵 — 只认 openid，绝不比姓名');

// 张三是主办人(openid: ou_zhang)，李四是协办人(ou_li)，王五是外人(ou_wang)
const task = {
  leaderId: 'ou_zhang',
  leader: '张三',
  collaboratorIds: ['ou_li'],
  collaborator: '李四',
  stage: '进行中',
};

check('主办人是主办人', perm.isLeader(task, 'ou_zhang'), true);
check('协办人不是主办人', perm.isLeader(task, 'ou_li'), false);
check('外人不是主办人', perm.isLeader(task, 'ou_wang'), false);

check('主办人可改任务', perm.canEditTask(task, 'ou_zhang'), true);
check('协办人不可改任务', perm.canEditTask(task, 'ou_li'), false);
check('外人不可改任务', perm.canEditTask(task, 'ou_wang'), false);

check('主办人可写进展', perm.canAddProgress(task, 'ou_zhang'), true);
check('协办人可写进展', perm.canAddProgress(task, 'ou_li'), true);
check('外人不可写进展', perm.canAddProgress(task, 'ou_wang'), false);

check('主办人可改进度字段', perm.canEditProgressFields(task, 'ou_zhang'), true);
check('协办人不可改进度字段', perm.canEditProgressFields(task, 'ou_li'), false);

check('外人可自由加入协办', perm.canJoin(task, 'ou_wang'), true);
check('主办人无需加入协办', perm.canJoin(task, 'ou_zhang'), false);
check('协办人不能重复加入', perm.canJoin(task, 'ou_li'), false);
check('已完成任务不可加入', perm.canJoin(Object.assign({}, task, { stage: '已完成' }), 'ou_wang'), false);

check('协办人可退出', perm.canLeave(task, 'ou_li'), true);
check('主办人不能退出自己的任务', perm.canLeave(task, 'ou_zhang'), false);
check('外人无从退出', perm.canLeave(task, 'ou_wang'), false);

// 删除：主办人或管理员。
// ★ 管理员这一条不能省 —— 61 条历史导入的任务里 59 条没有 leaderId，
//   若只允许主办，那些任务会变成谁也删不掉。
check('主办人可删自己的任务', perm.canDeleteTask(task, 'ou_zhang', false), true);
check('主办人加管理员身份仍可删', perm.canDeleteTask(task, 'ou_zhang', true), true);
check('管理员可删他人的任务', perm.canDeleteTask(task, 'ou_wang', true), true);
check('协办人不可删', perm.canDeleteTask(task, 'ou_li', false), false);
check('外人不可删', perm.canDeleteTask(task, 'ou_wang', false), false);
check('协办人即便是管理员也可删', perm.canDeleteTask(task, 'ou_li', true), true);
// ★ 没有 leaderId 的历史任务：只有管理员删得掉
const orphan = { leaderId: '', leader: '李杨', collaboratorIds: [] };
check('无主办的任务管理员可删', perm.canDeleteTask(orphan, 'ou_wang', true), true);
check('无主办的任务非管理员不可删', perm.canDeleteTask(orphan, 'ou_wang', false), false);
check('openid 为空即便管理员也不放行', perm.canDeleteTask(task, '', true), false);

// ★ 关键：姓名相同但 openid 不同，绝不能通过权限
const impostor = { leaderId: 'ou_other', leader: '张三', collaboratorIds: [], stage: '进行中' };
check('同名不同 openid 拿不到主办权限', perm.canEditTask(impostor, 'ou_zhang'), false);

// ★ 关键：openid 为空时必须一律拒绝，否则未登录请求会拿到权限
check('openid 为空拒绝一切', perm.canEditTask(task, ''), false);
check('openid 为 undefined 拒绝一切', perm.canEditTask(task, undefined), false);
check('collaboratorIds 缺失不崩', perm.isParticipant({ leaderId: 'x' }, 'y'), false);
check('task 为 null 不崩', perm.isLeader(null, 'x'), false);

// ---------------------------------------------------------------------------
/*
 * 周期计划的归属判据。计划是「谁主办谁负责」的东西：
 * 主办人自己就能改自己的（包括普通成员建给自己用的月度计划）；
 * 管理员兜底 —— 成员离职/换岗后，那些计划会变成没人能改的僵尸，
 * 而它每个月还在自动往库里生成任务。
 */
section('周期计划归属 — 主办人或管理员');

const plan = { _id: 'p1', ownerId: 'ou_zhang', ownerName: '张三' };
check('主办人可管自己的计划', perm.canManageTemplate(plan, 'ou_zhang', false), true);
check('协办人不可管（不在 ownerId 里）', perm.canManageTemplate(plan, 'ou_li', false), false);
check('外人不可管', perm.canManageTemplate(plan, 'ou_wang', false), false);
check('管理员可管他人的计划', perm.canManageTemplate(plan, 'ou_wang', true), true);
check('openid 为空即便管理员也不放行', perm.canManageTemplate(plan, '', true), false);
check('计划为 null 不崩', perm.canManageTemplate(null, 'ou_zhang', true), false);
// ★ 姓名不参与判定：同名不同 openid 拿不到管理权
check('同名不同 openid 拿不到管理权', perm.canManageTemplate(plan, 'ou_other', false), false);

// ---------------------------------------------------------------------------
/*
 * 需求处置权。比任务宽一档：一条需求可能"跟我有关"的人有两个 ——
 * 提出它的人、和把它领走的人；管理员照例兜底。
 * 关闭与重开共用这一条判据（能关的人本来就该能改）。
 */
section('需求处置权 — 提出人、领走人、管理员');

/** 造一条需求：只给判据字段，快照字段刻意用不相干的姓名 */
const demand = { _id: 'd1', proposerId: 'ou_zhang', claimedById: 'ou_li', status: '已领走' };

check('提出人可改', perm.canEditDemand(demand, 'ou_zhang', false), true);
check('领走人可改', perm.canEditDemand(demand, 'ou_li', false), true);
check('管理员可改他人的需求', perm.canEditDemand(demand, 'ou_wang', true), true);
check('外人不可改', perm.canEditDemand(demand, 'ou_wang', false), false);
check('★ 同名不同 openid 拿不到处置权', perm.canEditDemand(demand, 'ou_zhang2', false), false);
check('openid 为空即便管理员也不放行', perm.canEditDemand(demand, '', true), false);
check('openid 为 undefined 拒绝一切', perm.canEditDemand(demand, undefined, false), false);
check('需求为空返回 false', perm.canEditDemand(null, 'ou_zhang', true), false);

// 还没人领走的需求：只有提出人与管理员能动它
const fresh = { _id: 'd2', proposerId: 'ou_zhang', claimedById: '', status: '待认领' };
check('待认领的需求：提出人可改', perm.canEditDemand(fresh, 'ou_zhang', false), true);
check('待认领的需求：没领过的人不可改', perm.canEditDemand(fresh, 'ou_li', false), false);
check('★ claimedById 为空串时不会被误判成"空 openid 匹配空 openid"', perm.canEditDemand(fresh, '', false), false);

// 关闭 / 重开共用同一个判据 —— 能关的人本来就该能改
check('已关闭的需求：提出人仍可改（用于重开）', perm.canEditDemand({ _id: 'd3', proposerId: 'ou_zhang', claimedById: '', status: '已关闭' }, 'ou_zhang', false), true);

// ---------------------------------------------------------------------------
section('卡壳解决权限');

const rec = { updaterId: 'ou_li', hasBlocker: true, blockerResolved: false };
check('主办人可解决卡壳', perm.canResolveBlocker(task, rec, 'ou_zhang'), true);
check('提交人可解决自己的卡壳', perm.canResolveBlocker(task, rec, 'ou_li'), true);
check('其他协办人不可解决', perm.canResolveBlocker(task, rec, 'ou_wang'), false);

// ---------------------------------------------------------------------------
section('字段白名单 — 服务端派生字段必须挡在门外');

const FORBIDDEN = ['leaderId', 'leader', 'creatorId', 'createdAt', 'hasOpenBlocker', 'openBlockers'];
for (const f of FORBIDDEN) {
  check(
    `${f} 不在创建白名单中`,
    validate.TASK_CREATE_FIELDS.includes(f),
    false
  );
  check(
    `${f} 不在主办人更新白名单中`,
    validate.TASK_LEADER_UPDATE_FIELDS.includes(f),
    false
  );
}
check('collaboratorIds 在白名单中（主办人可改协办人）', validate.TASK_LEADER_UPDATE_FIELDS.includes('collaboratorIds'), true);
check('status/stage 仅在主办人更新白名单',
  !validate.TASK_CREATE_FIELDS.includes('stage') && validate.TASK_LEADER_UPDATE_FIELDS.includes('stage'), true);
check('progress 不在协办人可提交字段中',
  !validate.PROGRESS_BASE_FIELDS.includes('progress') && validate.PROGRESS_LEADER_EXTRA_FIELDS.includes('progress'), true);

check('白名单过滤丢弃越权字段',
  validate.pick({ task_name: 'A', leaderId: 'hack' }, validate.TASK_CREATE_FIELDS),
  { task_name: 'A' });

// ---------------------------------------------------------------------------
section('参数校验');

checkThrows('枚举越界被拒', () => validate.assertEnum('瞎写的分类', C.CATEGORY, '任务分类'), Codes.INVALID_PARAM);
checkThrows('空字符串被拒', () => validate.assertNonEmptyString('   ', '任务名称'), Codes.INVALID_PARAM);
checkThrows('进度 >100 被拒', () => validate.assertProgress(101), Codes.INVALID_PARAM);
checkThrows('进度为负被拒', () => validate.assertProgress(-1), Codes.INVALID_PARAM);
checkThrows('非补零日期被拒', () => validate.assertDateRequired('2026-9-5', '截止时间'), Codes.INVALID_PARAM);

check('进度取整', validate.assertProgress(66.6), 67);
check('进度边界 0', validate.assertProgress(0), 0);
check('进度边界 100', validate.assertProgress(100), 100);
check('日期可空', validate.assertDateOrEmpty('', '截止时间'), '');

check('协办人去重', validate.normalizeIds(['a', 'a', 'b'], null), ['a', 'b']);
check('协办人剔除主办人自己', validate.normalizeIds(['a', 'b'], 'a'), ['b']);
check('协办人剔除空值', validate.normalizeIds(['a', '', null, 'b'], null), ['a', 'b']);
check('非数组输入返回空', validate.normalizeIds('a;b', null), []);

checkThrows(
  '创建任务缺必填项被拒',
  () => validate.assertTaskRequiredForCreate({ task_name: 'A' }),
  Codes.INVALID_PARAM
);

// ---------------------------------------------------------------------------
/*
 * 需求的白名单守的是需求池的权限根基：提出人与领走人若能被前端指定，
 * perm.canEditDemand 就形同虚设（谁把自己写成提出人，谁就能处置这条需求）。
 */
section('需求字段白名单 — 派生字段必须挡在门外');

check('需求创建白名单', validate.DEMAND_CREATE_FIELDS, ['title', 'detail', 'contactDept', 'contactName', 'expectDate']);
check('需求更新白名单与创建一致', validate.DEMAND_UPDATE_FIELDS, validate.DEMAND_CREATE_FIELDS);

const dv = validate.validateDemandFields(
  {
    title: '  和财富部聊权益  ',
    detail: 'D',
    contactDept: '财富部',
    contactName: '王主任',
    expectDate: '2026-10-31',
    // 下面这些全是服务端派生字段，必须被静默丢弃
    status: '已完成',
    proposerId: 'o-hacker',
    proposerName: '我不是张三',
    claimedById: 'o-hacker',
    closeReason: '我说了算',
    createdAt: 0,
  },
  { isCreate: true }
);
check('标题去空白', dv.title, '和财富部聊权益');
check('★ 服务端派生字段一个都进不来', Object.keys(dv).sort(), ['contactDept', 'contactName', 'detail', 'expectDate', 'title']);

checkThrows('标题不能为空', () => validate.validateDemandFields({ title: '   ' }, { isCreate: true }), Codes.INVALID_PARAM);
checkThrows('标题超长被拒', () => validate.validateDemandFields({ title: 'x'.repeat(101) }, { isCreate: true }), Codes.INVALID_PARAM);
checkThrows('期望时间格式必须补零', () => validate.validateDemandFields({ title: 'T', expectDate: '2026-9-5' }, { isCreate: true }), Codes.INVALID_PARAM);
check(
  '期望时间可以为空（选填）',
  validate.validateDemandFields({ title: 'T', expectDate: '' }, { isCreate: true }).expectDate,
  ''
);
check(
  '超长描述被截断而不是报错（与任务的 detail 同款）',
  validate.validateDemandFields({ title: 'T', detail: 'x'.repeat(2500) }, { isCreate: true }).detail.length,
  2000
);

checkThrows('创建时标题必填', () => validate.assertDemandRequiredForCreate({}), Codes.INVALID_PARAM);
check('标题在时放行', validate.assertDemandRequiredForCreate({ title: 'T' }).title, 'T');

// ★ 更新时只发改动过的字段：没传的字段不能出现在结果里（否则会把它们清空）
check(
  '★ 更新时没传的字段不出现（避免误清空）',
  Object.keys(validate.validateDemandFields({ detail: '只改这个' }, { isCreate: false })),
  ['detail']
);

// ---------------------------------------------------------------------------
section('枚举字典完整性');

check('任务分类 11 项', C.CATEGORY.length, 11);
check('任务来源 8 项', C.SOURCE.length, 8);
check('任务性质 3 项', C.TASK_TYPE.length, 3);
check('周期频率 5 项', C.RECUR_FREQ.length, 5);
check('健康度 4 项', C.STATUS.length, 4);
check('阶段 3 项', C.STAGE.length, 3);
check('优先级 4 项', C.PRIORITY.length, 4);
check('周期来源不含 business source（origin 与 source 正交）', C.SOURCE.includes('periodic'), false);
check('origin 有 manual/periodic 两值', [C.ORIGIN.MANUAL, C.ORIGIN.PERIODIC], ['manual', 'periodic']);
check('状态徽标配色齐全', C.STATUS.every((s) => !!C.STATUS_TONE[s]), true);
check('阶段徽标配色齐全', C.STAGE.every((s) => !!C.STAGE_TONE[s]), true);

// 需求池：四个状态必须与 spec 完全一致，且每个状态都有配色 key。
// ★ 这条断言是「不发明枚举值」的机器执行者 —— 少一个 / 多一个都会红。
check('需求状态字典', C.DEMAND_STATUS, ['待认领', '已领走', '已完成', '已关闭']);
check(
  '★ 每个需求状态都有配色 key（漏一个会拿到 undefined，徽标变成无色）',
  // ★ 写成 (… || {}) 而不是直接点：枚举还不存在时这里会抛 TypeError，
  //   脚本会当场崩在第一条断言上，后面几条谁对谁错就看不出来了。
  //   断言失败应该是"报红"，不是"炸掉"。
  (C.DEMAND_STATUS || []).map((s) => (C.DEMAND_STATUS_TONE || {})[s]),
  ['active', 'warn', 'done', 'idle']
);
check('需求集合名', C.COLLECTIONS.DEMANDS, 'demands');
check(
  '部署期错误提示的集合清单含 demands',
  S('errors').ALL_COLLECTIONS.indexOf('demands') !== -1,
  true
);

// ★ SOURCE 只改名、不动顺序 —— 顺序是 field-picker 的高亮下标依据。
//   改了顺序，所有历史任务的来源都会在界面上显示错位。
check('来源仍是 8 项', C.SOURCE.length, 8);
check('★ 第三项（下标 2）是「需求池」', C.SOURCE[2], '需求池');
check('旧名「业务部门提报」已不在枚举里', C.SOURCE.indexOf('业务部门提报'), -1);
check('其余七项一个没动', C.SOURCE.filter((s) => s !== '需求池'), [
  '总行通知',
  '监管检查',
  '部领导交办',
  '中心领导交办',
  '会议纪要',
  '考评落实',
  '自发创新',
]);

// ---------------------------------------------------------------------------
section('进展记录构造（buildProgressDoc）');

const taskRepo = S('taskRepo');
/** 假的 db，只需要 serverDate 一个方法 */
const fakeDb = { serverDate: () => 'SERVER_DATE' };
const mkDoc = (over) =>
  taskRepo.buildProgressDoc(
    Object.assign(
      {
        taskId: 'tk-1',
        taskName: '月度报送',
        updaterId: 'oA',
        updaterName: '张三',
        fields: {},
        status: '正常',
        db: fakeDb,
      },
      over
    )
  );

// 卡壳三态：无卡壳 null / 有卡壳未解决 false / 已解决由 resolveBlocker 改写
check('无卡壳时 blockerResolved 为 null', mkDoc({ fields: { description: '推进中' } }).blockerResolved, null);
check('无卡壳时 hasBlocker 为 false', mkDoc({ fields: { description: '推进中' } }).hasBlocker, false);
check('有卡壳时 blockerResolved 为 false', mkDoc({ fields: { blocker: '等接口' } }).blockerResolved, false);
check('有卡壳时 hasBlocker 为 true', mkDoc({ fields: { blocker: '等接口' } }).hasBlocker, true);
check('只有空格的卡壳视为无卡壳', mkDoc({ fields: { blocker: '   ' } }).hasBlocker, false);

// updaterId 只由服务端传入，构造器不会去 payload 里找
check('updaterId 取自入参而非 fields', mkDoc({ fields: { updaterId: 'oHACK' } }).updaterId, 'oA');

// 无改动时 appliedChanges 为 null 而不是空对象，便于前端用 falsy 判断
check('无改动时 appliedChanges 为 null', mkDoc({}).appliedChanges, null);
check('空对象改动归一为 null', mkDoc({ appliedChanges: {} }).appliedChanges, null);
check(
  '改动被完整保留',
  mkDoc({ appliedChanges: { progress: 70, stage: '进行中' } }).appliedChanges,
  { progress: 70, stage: '进行中' }
);

// ★ 回归：appliedChanges 必须是拷贝。
//   progressService 在写记录之后还会往 taskPatch 上加 updatedAt 等服务端字段，
//   若这里是同一个对象引用，那些内部字段会一起被写进进展记录。
const patch = { progress: 70 };
const docWithPatch = mkDoc({ appliedChanges: patch });
patch.updatedAt = 'SERVER_DATE';
patch.actualCompleteTime = '2026-10-01';
check('appliedChanges 是拷贝，不受调用方后续修改影响', docWithPatch.appliedChanges, { progress: 70 });

check('幂等 _id 被写入文档', mkDoc({ _id: 'pr-tok' })._id, 'pr-tok');
check('无令牌时不写 _id（交由数据库生成）', 'pr-x' in mkDoc({}), false);

// ---------------------------------------------------------------------------
section('部署期错误翻译 — 别让"部署没做完"淹在"服务异常"里');

/**
 * 取翻译结果的文案，认不出时返回 ''。
 * ★ 返回 '' 而不是 null：断言里都要对它做 indexOf，
 *   返回 null 会让一个失败的用例直接抛异常中断整个自检，
 *   后面的用例全跑不到 —— 报错信息还不如断言失败有用。
 */
const infraMsg = (e) => {
  const r = describeInfraError(e);
  return r ? r.message : '';
};

// ① 集合不存在，且错误里带了集合名
const eNoCollection = { errCode: -502005, errMsg: 'collection.members not exists' };
check('集合缺失被识别（不返回 null）', infraMsg(eNoCollection) !== null, true);
check('集合名被提取进提示', infraMsg(eNoCollection).indexOf('members') !== -1, true);

// ★ 回归：微信有时给的形态不带集合名（`collection not exists`）。
//   若提取正则把空格也当分隔符，"not" 会被当成集合名报给用户 ——
//   那比不提名字更糟，用户会去建一个叫 not 的集合。
//   宁可提不出名字，也不能报一个错的。
const eNoName = { errCode: -502005, errMsg: 'collection not exists' };
check('无名字形态不误报集合名', infraMsg(eNoName).indexOf('「not」') === -1, true);
check('无名字形态改列全部集合', infraMsg(eNoName).indexOf('progress_records') !== -1, true);

// ★★ 回归（真实事故）：微信对"集合不存在"的报错文本是
//    `collection.get:fail ...` —— get 是**方法名**不是集合名。
//    第一版只取 `collection.` 后的第一个词，于是提示用户去建一个叫「get」的集合。
//    错的集合名比不提名字更糟：它会把人引到一个完全无关的方向，
//    而且看起来很像真的（用户真的会去找那个集合）。
const eMethodName = { errCode: -502005, errMsg: 'collection.get:fail database collection not exists' };
check('不把 SDK 方法名当集合名（get）', infraMsg(eMethodName).indexOf('「get」') === -1, true);
check('方法名形态仍能识别出是集合问题', infraMsg(eMethodName).indexOf('不存在') !== -1, true);

const eWhere = { errCode: -502005, errMsg: 'collection.where:fail database collection not exists' };
check('不把 SDK 方法名当集合名（where）', infraMsg(eWhere).indexOf('「where」') === -1, true);

// 混合形态：方法名在前、真名在后，扫描要跳过前者取到后者
const eMixed = { errCode: -502005, errMsg: 'collection.get:fail collection.tasks not exists' };
check('混合形态能跳过方法名取到真集合名', infraMsg(eMixed).indexOf('「tasks」') !== -1, true);

// 另一种真实写法：collection.<name> not exists（无 -502005、无 collection not exists）
check('collection.x not exists 形态也能识别', infraMsg({ errMsg: 'collection.tasks not exists' }).indexOf('「tasks」') !== -1, true);

// 调用方打的标记优先于文本提取 —— 这是能拿到确切名字的唯一可靠途径
const eTagged = { errCode: -502005, collectionName: 'progress_records' };
check('collectionName 标记优先于文本提取', infraMsg(eTagged).indexOf('「progress_records」') !== -1, true);

// 标记与文本冲突时以标记为准（标记来自发起查询的一方，比正则可靠）
const eTaggedWins = { errCode: -502005, collectionName: 'members', errMsg: 'collection.get:fail' };
check('标记与文本冲突时以标记为准', infraMsg(eTaggedWins).indexOf('「members」') !== -1, true);

// ★ 不能误判：普通业务异常不该被说成"集合不存在"
check('普通异常不误判为集合问题', describeInfraError(new Error('some random failure')), null);
check('超时异常不误判为集合问题', describeInfraError(new Error('timeout after 3000ms')), null);

// ② 依赖没装 —— 用了「上传并更新文件」而不是「云端安装依赖」
const eNoDep = new Error("Cannot find module 'wx-server-sdk'");
check('依赖缺失被识别', /云端安装依赖/.test(infraMsg(eNoDep) || ''), true);

// ③ 认不出的异常必须返回 null，交回 router 走 INTERNAL 兜底。
//    ★ 这条最关键：翻译层若能对任意异常返回兜底文案，
//      router 就会把本该只进日志的内部异常原样透给前端。
check('未知异常返回 null（不接管 INTERNAL 兜底）', describeInfraError(new Error('boom')), null);
check('空值返回 null', describeInfraError(null), null);

// ---------------------------------------------------------------------------
section('历史数据关联 — 只补空缺，不覆盖已有归属');

/**
 * 内存版 db，只实现 relinkMemberData 用到的方法。
 * 断言的是「最终文档长什么样」而不是「调了几次 update」——
 * 后者在覆盖了已有归属时照样能通过。
 */
function memDb(tasks, records) {
  const store = { tasks, progress_records: records };
  const writes = [];
  return {
    writes,
    store,
    collection(name) {
      return {
        skip: (n) => ({
          limit: (m) => ({ get: async () => ({ data: store[name].slice(n, n + m) }) }),
        }),
        doc: (id) => ({
          update: async ({ data }) => {
            const row = store[name].find((r) => r._id === id);
            if (!row) throw new Error(`不存在的文档 ${id}`);
            Object.assign(row, data);
            writes.push({ name, id, data });
            return { stats: { updated: 1 } };
          },
        }),
      };
    },
  };
}

const seedTasks = () => [
  // 导入来的：有姓名、没 openid
  { _id: 't1', leader: '王佳', leaderId: '', collaborator: '李杨;曾磊', collaboratorIds: [], creatorId: '' },
  // 小程序正常创建的：归属已确定，一个字段都不许动
  { _id: 't2', leader: '李杨', leaderId: 'o-ly', collaborator: '', collaboratorIds: [], creatorId: 'o-ly' },
  // leaderId 空但 creatorId 已有值 —— creatorId 不能被顺手覆盖
  { _id: 't3', leader: '滕达', leaderId: '', collaborator: '王佳', collaboratorIds: [], creatorId: 'o-other' },
  // 主办人也出现在协办列 —— 不该被算成协办人
  { _id: 't4', leader: '王佳', leaderId: '', collaborator: '王佳;李杨', collaboratorIds: [], creatorId: '' },
];

const seedRecords = () => [
  { _id: 'r1', updaterName: '王佳', updaterId: '' },
  { _id: 'r2', updaterName: '李杨', updaterId: 'o-ly' }, // 已关联，不许改
  { _id: 'r3', updaterName: '曾磊', updaterId: '' },
];

/**
 * 本段是异步的（relinkMemberData 要 await 数据库），
 * 而本文件其余部分全同步 —— 所以整段包起来，末尾统一收口。
 */
async function relinkChecks() {
const d1 = memDb(seedTasks(), seedRecords());
await taskRepo.relinkMemberData(d1, { 王佳: 'o-wj', 李杨: 'o-ly' });

check('补齐主办人归属', d1.store.tasks[0].leaderId, 'o-wj');
check('顺带补上创建人（原本为空）', d1.store.tasks[0].creatorId, 'o-wj');
check('协办人按 id 追加', d1.store.tasks[0].collaboratorIds, ['o-ly']);
check('还没认领的协办人先留空，等他自己认领时再补', d1.store.tasks[0].collaboratorIds.indexOf('o-zl'), -1);

// ★ 这条是整套逻辑里最要紧的一条：
//   已有归属的任务绝不能因为"姓名相同"被改写，否则重名会互相夺走任务。
check('★ 不覆盖已有的 leaderId', d1.store.tasks[1].leaderId, 'o-ly');
check('★ 不覆盖已有的 creatorId', d1.store.tasks[2].creatorId, 'o-other');
check('主办人不在名单里时只补协办', d1.store.tasks[2].leaderId, '');
check('协办人只追加已有归属的那部分', d1.store.tasks[2].collaboratorIds, ['o-wj']);
check('★ 主办人不重复计入协办人', d1.store.tasks[3].collaboratorIds, ['o-ly']);

check('进展记录补上上报人', d1.store.progress_records[0].updaterId, 'o-wj');
check('★ 不覆盖已有的 updaterId', d1.store.progress_records[1].updaterId, 'o-ly');
check('未认领的人先不动', d1.store.progress_records[2].updaterId, '');

// ② 幂等：同一份名单再跑一遍，一条都不该动
const before = JSON.stringify(d1.store);
d1.writes.length = 0;
const again = await taskRepo.relinkMemberData(d1, { 王佳: 'o-wj', 李杨: 'o-ly' });
check('★ 重复执行不产生任何写入', d1.writes.length, 0);
check('重复执行结果一致', JSON.stringify(d1.store), before);
check('重复执行报告 0 条', [again.tasks, again.records], [0, 0]);

// ③ 收敛：剩下的人陆续认领，最终补齐（不必一次到位）
await taskRepo.relinkMemberData(d1, { 曾磊: 'o-zl' });
check('后认领的协办人被追加到末尾', d1.store.tasks[0].collaboratorIds, ['o-ly', 'o-zl']);
check('后认领的上报人被补上', d1.store.progress_records[2].updaterId, 'o-zl');

// ④ 分隔符：历史表里混用过中英文顿号、逗号，都得分得开
const d2 = memDb(
  [{ _id: 'x', leader: '王佳', leaderId: '', collaborator: '李杨,曾磊、滕达；高鑫磊', collaboratorIds: [], creatorId: '' }],
  []
);
await taskRepo.relinkMemberData(d2, { 李杨: 'a', 曾磊: 'b', 滕达: 'c', 高鑫磊: 'd' });
check('中英文分隔符都认', d2.store.tasks[0].collaboratorIds, ['a', 'b', 'c', 'd']);

// ⑤ 分页：任务数超过云函数单次 100 条上限时不能漏
const many = [];
for (let i = 0; i < 150; i += 1) {
  many.push({ _id: `m${i}`, leader: '王佳', leaderId: '', collaborator: '', collaboratorIds: [], creatorId: '' });
}
const d3 = memDb(many, []);
const r3 = await taskRepo.relinkMemberData(d3, { 王佳: 'o-wj' });
check('★ 超过 100 条也不漏（分页生效）', r3.tasks, 150);
check('最后一条也被关联', d3.store.tasks[149].leaderId, 'o-wj');

// ⑥ 空名单 / 全是陌生人：不该产生写入
const d4 = memDb(seedTasks(), seedRecords());
check('空名单直接返回', await taskRepo.relinkMemberData(d4, {}), { tasks: 0, records: 0 });
await taskRepo.relinkMemberData(d4, { 查无此人: 'o-x' });
check('名单里没有的姓名不做任何事', d4.writes.length, 0);
}

/**
 * 内存版 db，只实现 demandRepo 用到的方法。
 *
 * ★ 断言的是「最终文档长什么样」与「stats.updated 是多少」，
 *   不是"调了几次 update"—— 后者在覆盖了不该覆盖的字段时照样能通过。
 * ★ where().update() 返回命中条数（而不是恒定 1），是这套测试的关键：
 *   claimDemand 的原子性就建立在 stats.updated === 1 这个判断上。
 *   真库靠单文档更新的原子性保证同一时刻只有一个人拿到 1，这里用内存模拟。
 */
function demandDb(seed) {
  const store = {
    demands: (seed && seed.demands) || [],
    tasks: (seed && seed.tasks) || [],
  };
  const writes = [];
  const match = (doc, where) => Object.keys(where).every((k) => doc[k] === where[k]);
  function query(name, ops) {
    const api = {
      where: (w) => query(name, Object.assign({}, ops, { where: w })),
      orderBy: () => api,
      field: () => api,
      skip: (n) => query(name, Object.assign({}, ops, { skip: n })),
      limit: (m) => query(name, Object.assign({}, ops, { limit: m })),
      get: async () => {
        let rows = store[name].slice();
        if (ops.where) rows = rows.filter((d) => match(d, ops.where));
        if (ops.skip) rows = rows.slice(ops.skip);
        if (ops.limit !== undefined) rows = rows.slice(0, ops.limit);
        return { data: rows };
      },
      update: async ({ data }) => {
        let rows = store[name];
        if (ops.where) rows = rows.filter((d) => match(d, ops.where));
        rows.forEach((d) => Object.assign(d, data));
        writes.push({ name, where: ops.where, data });
        return { stats: { updated: rows.length } };
      },
    };
    return api;
  }
  return {
    writes,
    store,
    serverDate: () => 'SERVER_DATE',
    collection(name) {
      const c = query(name, {});
      c.doc = (id) => ({
        get: async () => {
          const d = store[name].find((x) => x._id === id);
          // 与真库一致：文档不存在时抛错，由 readDemand 翻译成 null
          if (!d) throw Object.assign(new Error('document.get:fail not exist'), { errCode: -502002 });
          return { data: d };
        },
        update: async ({ data }) => {
          const d = store[name].find((x) => x._id === id);
          if (!d) return { stats: { updated: 0 } };
          Object.assign(d, data);
          writes.push({ name, id, data });
          return { stats: { updated: 1 } };
        },
        remove: async () => ({ stats: { removed: 1 } }),
      });
      c.add = async ({ data }) => {
        const _id = 'id-' + (store[name].length + 1);
        store[name].push(Object.assign({ _id }, data));
        return { _id };
      };
      return c;
    },
  };
}

async function demandRepoChecks(repo) {
  const NEW_DEMAND = () => ({
    _id: 'd1', title: '和财富部聊权益', detail: '', contactDept: '', contactName: '',
    expectDate: '', status: '待认领', proposerId: 'o-zhang', proposerName: '张三',
    claimedById: '', claimedByName: '', claimedAt: null,
    closedByName: '', closedAt: null, closeReason: '', createdAt: 'C', updatedAt: 'C',
  });
  const NEW_TASK = (id, stage) => ({ _id: id, demandId: 'd1', stage });

  // ① buildDemandDoc：新需求一律「待认领」，派生字段全部由服务端定
  const doc = repo.buildDemandDoc({
    fields: { title: '和财富部聊权益', detail: '', contactDept: '财富部', contactName: '王主任', expectDate: '2026-10-31' },
    proposerId: 'o-zhang', proposerName: '张三', db: { serverDate: () => 'SERVER_DATE' },
  });
  check('新建需求的状态固定为待认领', doc.status, '待认领');
  check('提出人 openid 由服务端写入', doc.proposerId, 'o-zhang');
  check('领走人字段初始为空', [doc.claimedById, doc.claimedByName, doc.claimedAt], ['', '', null]);
  check('关闭痕迹字段初始为空', [doc.closedByName, doc.closedAt, doc.closeReason], ['', null, '']);
  check('★ 前端字段之外的东西进不来', Object.keys(doc).sort(), [
    'claimedAt', 'claimedById', 'claimedByName', 'closeReason', 'closedAt', 'closedByName',
    'contactDept', 'contactName', 'createdAt', 'detail', 'expectDate', 'proposerId',
    'proposerName', 'status', 'title', 'updatedAt',
  ].sort());

  // ② claimDemand：条件里必须带 status，且以 stats.updated 为准
  const d1 = demandDb({ demands: [NEW_DEMAND()], tasks: [] });
  const ctxOf = (db, openid, members) => ({
    db, openid,
    resolveMembers: async (ids) => (members || []).filter((m) => ids.indexOf(m.openid) !== -1),
  });
  const ctx = ctxOf(d1, 'o-li', [{ openid: 'o-li', name: '李四', role: '普通' }]);

  check('无 demandId 时原样返回空串（不查库）', await repo.claimDemand(ctx, '', 'o-li'), '');
  check('领走后返回 demandId', await repo.claimDemand(ctx, 'd1', 'o-li'), 'd1');
  check('需求转为已领走', d1.store.demands[0].status, '已领走');
  check('★ 领走人存的是 openid（判据）', d1.store.demands[0].claimedById, 'o-li');
  check('领走人姓名是快照', d1.store.demands[0].claimedByName, '李四');
  check('领走时间被写上', d1.store.demands[0].claimedAt, 'SERVER_DATE');

  // ③ 第二次领走必须失败 —— 这就是并发场景下"只有一个人拿到 updated===1"
  let secondErr = null;
  try {
    await repo.claimDemand(ctxOf(d1, 'o-wang', [{ openid: 'o-wang', name: '王五', role: '普通' }]), 'd1', 'o-wang');
  } catch (e) { secondErr = e; }
  check('★ 已被领走的需求不能再被领走', secondErr && secondErr.code, 'INVALID_PARAM');
  check('★ 领走人没有被第二个人改写', d1.store.demands[0].claimedById, 'o-li');

  // ④ 领走不存在的需求：报的是"不存在"，不是"已被领走"
  let missingErr = null;
  try {
    await repo.claimDemand(ctxOf(demandDb({ demands: [] }), 'o-li', [{ openid: 'o-li', name: '李四', role: '普通' }]), 'd-nope', 'o-li');
  } catch (e) { missingErr = e; }
  check('★ 需求不存在说"不存在"，不笼统说"已被领走"', missingErr && missingErr.message.indexOf('不存在') !== -1, true);

  // ⑤ releaseDemand：只回滚自己占的那一条，且永不抛错
  const d2 = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已领走', claimedById: 'o-li', claimedByName: '李四' })], tasks: [] });
  await repo.releaseDemand(ctxOf(d2, 'o-li', []), 'd1', 'o-wang'); // 不是自己占的
  check('★ 不是自己占的，回滚不动它', d2.store.demands[0].status, '已领走');
  await repo.releaseDemand(ctxOf(d2, 'o-li', []), 'd1', 'o-li');
  check('自己占的回滚成待认领', d2.store.demands[0].status, '待认领');
  check('回滚时清空领走人', [d2.store.demands[0].claimedById, d2.store.demands[0].claimedByName], ['', '']);
  let releaseErr = null;
  try {
    const broken = demandDb({ demands: [NEW_DEMAND()], tasks: [] });
    broken.collection = () => { throw new Error('数据库炸了'); };
    await repo.releaseDemand(broken, 'd1', 'o-li');
  } catch (e) { releaseErr = e; }
  check('★ 回滚失败不抛错（不能盖掉原始错误）', releaseErr, null);

  // ⑥ syncDemandStatus 的四种输入
  const cases = [
    ['全部任务已完成 → 已完成', [NEW_TASK('t1', '已完成'), NEW_TASK('t2', '已完成')], '已领走', '已完成'],
    ['部分未完成 → 已领走', [NEW_TASK('t1', '已完成'), NEW_TASK('t2', '进行中')], '已完成', '已领走'],
    ['零任务 → 待认领', [], '已领走', '待认领'],
    ['★ 已关闭 → 原样不动', [NEW_TASK('t1', '已完成')], '已关闭', '已关闭'],
  ];
  for (const [label, tasks, from, want] of cases) {
    const db = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: from, claimedById: 'o-li', claimedByName: '李四' })], tasks });
    const r = await repo.syncDemandStatus(db, 'd1');
    check(label, [r.status, db.store.demands[0].status], [want, want]);
  }

  // ⑦ 零任务时还要清空领走人 —— 否则需求卡在"已领走但没人办"
  const dz = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已领走', claimedById: 'o-li', claimedByName: '李四' })], tasks: [] });
  await repo.syncDemandStatus(dz, 'd1');
  check('★ 任务被删光后清空领走人', [dz.store.demands[0].claimedById, dz.store.demands[0].claimedByName], ['', '']);

  // ⑦b 领走人缺失时要能从关联任务回填
  // 场景：占位成功后建任务的响应丢了 → 回滚清空领走人 → 用户拿同一令牌重试，
  // 幂等重放直接返回那条已建好的任务（不再占位）。需求就挂着任务却没有领走人，
  // 次日巡检把它推成「已领走」时若不回填，这条需求谁也改不了、关不掉 —— 僵死态。
  const dbf = demandDb({
    demands: [Object.assign(NEW_DEMAND(), { status: '待认领', claimedById: '', claimedByName: '', claimedAt: null })],
    tasks: [Object.assign(NEW_TASK('t1', '进行中'), { leaderId: 'o-li', leader: '李四' })],
  });
  const bf = await repo.syncDemandStatus(dbf, 'd1');
  check('★ 领走人缺失时从关联任务回填（openid 是判据）', [bf.status, dbf.store.demands[0].claimedById], ['已领走', 'o-li']);
  check('★ 回填的姓名是任务里的快照', dbf.store.demands[0].claimedByName, '李四');
  check('★ 回填时补上领走时间', dbf.store.demands[0].claimedAt, 'SERVER_DATE');

  // 已在「已领走」但领走人缺失（巡检上一轮漏了 / 老数据）也要补上 —— 否则永远补不回来
  const dbf2 = demandDb({
    demands: [Object.assign(NEW_DEMAND(), { status: '已领走', claimedById: '' })],
    tasks: [Object.assign(NEW_TASK('t1', '进行中'), { leaderId: 'o-li', leader: '李四' })],
  });
  const bf2 = await repo.syncDemandStatus(dbf2, 'd1');
  check('★ 状态已是已领走但没领走人，也回填', [bf2.changed, dbf2.store.demands[0].claimedById], [true, 'o-li']);

  // ⑧ 状态没变时不写库（每日巡检几百条，全写一遍是白费）
  const dsame = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已领走' })], tasks: [NEW_TASK('t1', '进行中')] });
  const same = await repo.syncDemandStatus(dsame, 'd1');
  check('状态没变时 changed=false', same.changed, false);
  check('★ 状态没变时一次 update 都不发', dsame.writes.length, 0);

  // ⑨ 重开：已关闭的需求要能被重算（其余情况下已关闭是纹丝不动的）
  const dre = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已关闭', closeReason: '不做了' })], tasks: [] });
  const re = await repo.syncDemandStatus(dre, 'd1', { fromReopen: true });
  check('★ 重开：零任务 → 回到待认领', [re.status, dre.store.demands[0].status], ['待认领', '待认领']);
  check('★ 重开：清掉关闭痕迹', [dre.store.demands[0].closeReason, dre.store.demands[0].closedAt], ['', null]);
  const dre2 = demandDb({ demands: [Object.assign(NEW_DEMAND(), { status: '已关闭', closeReason: '不做了', claimedById: 'o-li', claimedByName: '李四' })], tasks: [NEW_TASK('t1', '进行中')] });
  const re2 = await repo.syncDemandStatus(dre2, 'd1', { fromReopen: true });
  check('★ 重开：有未完成的任务 → 回已领走（不把领走事实抹掉）', re2.status, '已领走');
  check('★ 重开：不清空领走人', dre2.store.demands[0].claimedById, 'o-li');

  // ⑩ 不存在的需求：skipped，不抛错
  const dgone = demandDb({ demands: [], tasks: [] });
  check('需求不存在时返回 skipped', await repo.syncDemandStatus(dgone, 'd-x'), { skipped: 'missing' });

  // ⑪ 巡检：一次扫全量，已关闭的跳过，只报变化的条数
  const dall = demandDb({
    demands: [
      Object.assign(NEW_DEMAND(), { _id: 'a', status: '已领走' }),
      Object.assign(NEW_DEMAND(), { _id: 'b', status: '已关闭' }),
      Object.assign(NEW_DEMAND(), { _id: 'c', status: '待认领' }),
    ],
    tasks: [NEW_TASK('t1', '已完成')],
  });
  const all = await repo.syncAllDemands(dall);
  check('巡检扫描全部需求', all.scanned, 3);
  check('只有状态真的变了的才计数（a 零任务→待认领；c 本就待认领→不变）', all.changed, 1);
  check('★ 已关闭的那条不受巡检影响', dall.store.demands[1].status, '已关闭');
}

relinkChecks().then(async () => {
  section('协办人姓名快照重建 — 未认领的姓名不能被抹掉');

  /*
   * ★ 这一节守的是一次已经发生过的数据损坏。
   *
   *   join / leave / removeCollaborator 之后按 collaboratorIds 反查姓名重建
   *   显示串，而 resolveNames 只认**已认领**的 openid。历史导入的协办人只有
   *   姓名、没有 openid（本人还没来认领），于是任何人一加入或退出，那些人
   *   就从"协办"那行里消失了 —— 而 ids 数组里本来就没有他们，抹掉了再也回不来。
   *
   *   实际影响过 17/61 条任务，也是"我明明不是协办却能上报进展"这个反馈的根因：
   *   权限读 collaboratorIds（确实有我），显示读 collaborator（被抹成了别人）。
   *
   * 判据：旧串里的姓名，只要**库中查不到对应且有 openid 的成员**，就说明它
   * 从未被关联过，必须原样保留；反之说明这人已是系统用户，去留由 ids 说了算。
   */
  const mergeSnap = taskRepo.mergeCollaboratorSnapshot;

  // 历史导入的 3 个人都还没认领；我加入后，3 个姓名必须留着，我追加在末尾
  check(
    '加入协办：未认领的姓名保留，新加入的追加在末尾',
    mergeSnap('安浦聖;李杰锋;曾磊;', ['王佳'], []),
    '安浦聖;李杰锋;曾磊;王佳'
  );

  // 退出：我已是已认领成员，且不在 ids 里了 → 必须从显示里去掉
  check('退出协办：已认领的人退出后确实消失', mergeSnap('安浦聖;李杰锋;曾磊;王佳', [], ['王佳']), '安浦聖;李杰锋;曾磊');

  // 主办人移除协办人：同一条规则
  check('移除协办：被移除的人消失', mergeSnap('李桐;李娜;王佳', [], ['王佳']), '李桐;李娜');

  // ★ 最容易写错的一种：过滤条件写松一点，就会连带把未认领的人也删掉
  check('★ 移除一人不会连带抹掉同串里未认领的人', mergeSnap('安浦聖;王佳;李杰锋', [], ['王佳']), '安浦聖;李杰锋');

  // 顺序：旧串顺序优先，新关联上的才追加 —— 免得每次 join 都把名单重排一遍
  check(
    '新关联的人追加在末尾，不打乱原有顺序',
    mergeSnap('李杨;曾磊', ['曾磊', '王佳', '李杨'], ['李杨', '曾磊', '王佳']),
    '李杨;曾磊;王佳'
  );

  // 并发/重试下必须幂等：同一个人跑两遍结果一样
  check('幂等：重复执行结果不变', mergeSnap('安浦聖;王佳', ['王佳'], ['王佳']), '安浦聖;王佳');

  // 空串与残留分隔符
  check('两边都空 → 空串', mergeSnap('', [], []), '');
  check('★ 不留尾部分号', mergeSnap('安浦聖;', ['王佳'], []), '安浦聖;王佳');
  check('同名不重复', mergeSnap('王佳;王佳', ['王佳'], ['王佳']), '王佳');

  // 历史表里混用过逗号/顿号，重建时统一成分号
  check('逗号、顿号分隔的历史串同样认', mergeSnap('李桐、李娜', [], []), '李桐;李娜');

  // 全部已认领且都还在 → 原样
  check('都在且顺序不变', mergeSnap('王佳;李杨', ['王佳', '李杨'], ['王佳', '李杨']), '王佳;李杨');

  // 主办人从不进 collaboratorIds（relink 会跳过、join 会拒绝），所以历史脏数据里
  // 若把已认领的主办人也写进协办串，重建时会被去掉 —— 与旧实现一致，不是新行为
  check(
    '已认领的主办人不留在协办串里，未认领的姓名保留',
    mergeSnap('安浦聖;李杨', ['王佳'], ['李杨', '王佳']),
    '安浦聖;王佳'
  );

  // -------------------------------------------------------------------------
  section('数组更新指令 — 少写一个 $ 号会把整个对象当成一个元素写进库');

  /**
   * 扫源码盯住 { each: ... } 这个写法（2026-10-03 加的，起因是一次真实故障：
   * 用户点「加入协办」提示成功，协办名单里却始终没有他）。
   *
   * ★ 为什么要扫源码而不是跑一遍：这类错误在云函数侧**不报错**、前端还弹成功，
   *   只有把报文算出来才看得见：
   *     db.command.push({ each: [x] })      → SDK 帮忙翻成 { $each: [x] } ✓
   *     db.command.addToSet({ each: [x] })  → 原样透传 { each: [x] } ✗
   *     db.command.pull({ each: [x] })      → 原样透传，匹配不到任何元素 ✗
   *   结果是库里存成 collaboratorIds: [{each:["otw..."]}]（协办名单永远为空），
   *   或者「退出协办」静默不删（本人以为自己退了，其实还在名单里）。
   * ★ 正确写法：addToSet 用 { $each: [...] }，pull 传标量 openid。
   * ★ 这条只能保证「没写出这个已知的错误形态」，不构成语义正确性证明 ——
   *   真正的报文验证要靠仓库外的探针脚本（Node 里 require 真驱动 + UpdateSerializer）。
   */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  function walkJs(dir, out) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      // lib/ 是 sync-shared 往各云函数复制的生成副本，不是独立源码
      if (e.name === 'node_modules' || e.name === 'lib') return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkJs(full, out);
      else if (e.name.endsWith('.js')) out.push(full);
    });
    return out;
  }

  const ROOT = path.join(__dirname, '..');
  const scanned = walkJs(path.join(ROOT, 'cloudfunctions'), [])
    .concat(walkJs(path.join(ROOT, 'shared'), []));

  const offenders = [];
  scanned.forEach((file) => {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /\.(addToSet|pull|pullAll|push|unshift)\s*\(\s*\{\s*each\b/g;
    let m;
    while ((m = re.exec(code))) {
      // push / unshift 由 SDK 负责翻 each → $each，写 { each: ... } 是对的
      if (m[1] === 'push' || m[1] === 'unshift') continue;
      offenders.push(`${path.relative(ROOT, file)} 的 .${m[1]}({ each: ... })`);
    }
  });

  check('扫到的都是源码文件（防止 walk 写错导致这一节空跑）', scanned.length > 5, true);
  check('云函数与 shared 里没有 { each: ... } 形态的数组更新指令', offenders, []);

  // ── 需求仓储 ──────────────────────────────────────────────────────
  section('需求仓储 — 原子占位、回滚、状态重算');

  const demandRepo = require(path.join(__dirname, '..', 'shared', 'demandRepo'));
  await demandRepoChecks(demandRepo);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('\n✗ 自检未通过');
    process.exit(1);
  }
  console.log('\n✓ 全部通过');
});
