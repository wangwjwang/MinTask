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
 *
 * 不依赖云环境，直接 `node scripts/selfcheck.js` 即可运行。
 * 建议改完 shared/ 后跑一次。
 * ---------------------------------------------------------------------------
 */

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
section('周期类型过滤 — 季/年周期不该每月都生成');

const tpl = (over) => Object.assign({ _id: 't1', name: 'T', enabled: true, periodType: 'monthly' }, over);

check('月度：每月生成', periodic.shouldGenerate(tpl({}), '2026-10'), true);
check('停用的模板不生成', periodic.shouldGenerate(tpl({ enabled: false }), '2026-10'), false);
check('季度：1 月生成', periodic.shouldGenerate(tpl({ periodType: 'quarterly' }), '2026-01'), true);
check('季度：4 月生成', periodic.shouldGenerate(tpl({ periodType: 'quarterly' }), '2026-04'), true);
check('季度：5 月不生成', periodic.shouldGenerate(tpl({ periodType: 'quarterly' }), '2026-05'), false);
check('年度：1 月生成', periodic.shouldGenerate(tpl({ periodType: 'yearly' }), '2026-01'), true);
check('年度：2 月不生成', periodic.shouldGenerate(tpl({ periodType: 'yearly' }), '2026-02'), false);
check('未知周期类型：保守不生成', periodic.shouldGenerate(tpl({ periodType: 'weekly' }), '2026-10'), false);

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

relinkChecks().then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('\n✗ 自检未通过');
    process.exit(1);
  }
  console.log('\n✓ 全部通过');
});
