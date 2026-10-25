/**
 * mock.js — 演示数据生成器
 * 字段结构对齐真实云数据库（tasks / members / progress_records），
 * 以便部署后无缝切换到 dashboardService 的真实返回。
 * 注意：任务/人员均为演示用虚构数据，不含真实姓名。
 */

const NAMES = ['张明', '李华', '王芳', '刘洋', '陈静', '赵磊', '孙莉', '周强', '吴敏', '郑涛'];
const DEPTS = ['研发一组', '研发二组', '运维组', '数据组', '安全合规组', '综合管理'];
const CATEGORIES = ['系统研发', '系统运维', '信创改造', '数据应用', '数据治理', '智能体AI开发', '安全合规', '监管报送', '竞赛活动', '培训', '其他'];
const SOURCES = ['总行通知', '监管检查', '需求池', '部领导交办', '中心领导交办', '会议纪要', '考评落实', '自发创新'];
const PRIOS = ['P0', 'P1', 'P2', 'P3'];

const TASK_NAMES = [
  '核心交易系统升级', '生产环境巡检自动化', 'Oracle 信创迁移', '监管报表数据提取',
  '客户画像数据治理', '智能客服助手开发', '等保三级复测', '季度监管报送',
  '运维知识库竞赛', '新员工技术培训', '灾备演练方案', '网银性能优化',
  '数据脱敏平台建设', 'AI 风控模型迭代', '安全漏洞整改', '月度经营分析',
  'API 网关重构', '日志集中采集', '隐私计算试点', '信贷系统压测',
  '办公系统国产化', '数据标准宣贯', '反欺诈规则优化', '容器平台扩容',
  '监管沙盒申报', 'DevOps 流水线', '数据资产盘点', '合规自查',
];

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(base, off) { const d = new Date(base); d.setDate(d.getDate() + off); return d; }

// 简单可复现伪随机
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function buildTimeline(rng, base, stage, hasBlocker) {
  const n = 1 + Math.floor(rng() * 3);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const daysAgo = Math.floor(rng() * 40) + 1;
    const t = addDays(base, -daysAgo);
    const isBlock = hasBlocker && i === n - 1;
    out.push({
      text: isBlock
        ? '遇到阻塞，等待外部依赖，暂无法推进'
        : ['完成阶段性联调', '已提交评审', '进度更新，按计划推进', '补充材料已归档'][Math.floor(rng() * 4)],
      time: t.toISOString(),
      hasBlocker: isBlock,
      support: isBlock ? '需要协调测试环境资源' : '',
      progress: stage === '已完成' ? 100 : Math.floor(rng() * 90) + 5,
    });
  }
  out.sort((a, b) => new Date(b.time) - new Date(a.time));
  return out;
}

export function buildMock() {
  const base = new Date();
  const rng = makeRng(20261007);

  const members = NAMES.map((name, i) => ({
    _id: 'm' + (i + 1),
    name,
    dept: DEPTS[i % DEPTS.length],
    role: i === 0 ? '管理员' : (rng() < 0.15 ? '管理者' : '普通'),
    openid: 'wx_' + (i + 1),
    claimed: true,
  }));

  const tasks = [];
  const usedNames = new Set();
  TASK_NAMES.forEach((name, idx) => {
    const dueOff = [-12, -5, -2, 1, 2, 3, 7, 9, 15, 22, 35, 48][Math.floor(rng() * 12)];
    const stage = idx % 5 === 4 ? '已完成' : (idx % 4 === 0 ? '未开始' : '进行中');
    let status;
    if (stage === '已完成') status = '已完成';
    else if (dueOff < 0) status = rng() < 0.6 ? '受阻' : '有风险';
    else if (dueOff <= 3) status = rng() < 0.5 ? '有风险' : '正常';
    else status = '正常';

    const leader = members[Math.floor(rng() * members.length)];
    // 协办人
    const collab = [];
    const k = Math.floor(rng() * 3);
    for (let j = 0; j < k; j += 1) {
      const c = members[Math.floor(rng() * members.length)];
      if (c._id !== leader._id && !collab.find((x) => x._id === c._id)) collab.push(c);
    }
    const hasBlocker = status === '受阻' && rng() < 0.8;
    const openBlockerCount = hasBlocker ? 1 + Math.floor(rng() * 2) : 0;
    const progress = stage === '已完成' ? 100 : (status === '受阻' ? Math.floor(rng() * 40) : Math.floor(rng() * 70) + 20);

    const isPeriodic = idx % 7 === 3;
    tasks.push({
      _id: 't' + (idx + 1),
      name,
      category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)],
      source: SOURCES[Math.floor(rng() * SOURCES.length)],
      taskType: isPeriodic ? '周期性' : (idx % 3 === 0 ? '计划性' : '临时性'),
      recurFreq: isPeriodic ? (['每月', '每季', '每年'][Math.floor(rng() * 3)]) : '不适用',
      origin: isPeriodic ? 'periodic' : 'manual',
      status,
      stage,
      priority: PRIOS[Math.floor(rng() * PRIOS.length)],
      dueDate: fmt(addDays(base, dueOff)),
      progress,
      leaderId: leader.openid,
      leaderName: leader.name,
      collaborator: collab.map((c) => c.name).join(';'),
      collaboratorIds: collab.map((c) => c.openid),
      hasOpenBlocker: hasBlocker,
      openBlockerCount,
      latestProgressAt: addDays(base, -Math.floor(rng() * 14) - 1).toISOString(),
      actualCompleteTime: stage === '已完成' ? fmt(addDays(base, -Math.floor(rng() * 20))) : '',
      timeline: buildTimeline(rng, base, stage, hasBlocker),
    });
  });

  const periodicTemplates = [
    { _id: 'pt1', name: '月度监管报送', freq: '每月', startDay: 5, endDay: 25, category: '监管报送' },
    { _id: 'pt2', name: '季度安全自查', freq: '每季', startMonth: 1, category: '安全合规' },
    { _id: 'pt3', name: '年度数据治理复盘', freq: '每年', startMonth: 12, category: '数据治理' },
  ];

  return {
    generatedAt: new Date().toISOString(),
    members,
    tasks,
    periodicTemplates,
    progressCount: tasks.reduce((s, t) => s + (t.timeline ? t.timeline.length : 0), 0),
  };
}
