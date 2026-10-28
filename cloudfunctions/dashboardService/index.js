/**
 * cloudfunctions/dashboardService/index.js
 * ---------------------------------------------------------------------------
 * 看板只读聚合服务（云函数 Event 形态，供 Web SDK 通过 callFunction 调用）。
 *
 * 前端（Web SDK，匿名登录后）=>
 *   app.callFunction({ name: 'dashboardService', data: { passcode } })
 *   => event.passcode 校验 => 读取并聚合 => 返回 { code, data }
 *
 * 职责：
 *   1. 校验共享访问口令（环境变量 DASHBOARD_PASSCODE）。
 *   2. 从云数据库只读拉取 members / tasks / progress_records / periodic_templates。
 *   3. 把真实库文档映射成前端（mock 同构）期望的字段结构。
 *   4. 每个任务最近进展聚合成 timeline。
 *
 * 安全：本函数只读取与聚合，绝不写库；口令是第一道（唯一一道）访问控制。
 *       由云函数服务端身份读取，前端拿不到任何未经验证的数据。
 * ---------------------------------------------------------------------------
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = {
  MEMBERS: 'members',
  TASKS: 'tasks',
  PROGRESS: 'progress_records',
  TEMPLATES: 'periodic_templates',
  JOB_LOGS: 'job_logs',
};
const QUERY_BATCH = 100;

const ROLE_MAP = {
  normal: '普通', admin: '管理员', viewer: '管理者',
  NORMAL: '普通', ADMIN: '管理员', VIEWER: '管理者',
};

/** serverDate 序列化后可能是 { $date: 毫秒 } 或 { $date: { $numberLong } }，统一规范化为 ISO 字符串 */
function normalizeDate(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const d = v.$date;
    if (d != null) {
      const ms = typeof d === 'number' ? d : (d.$numberLong ? Number(d.$numberLong) : null);
      if (ms) return new Date(ms).toISOString();
    }
  }
  return null;
}

function mapMember(m) {
  if (!m) return null;
  return {
    _id: m._id,
    name: m.name || '',
    dept: m.dept || '',
    role: ROLE_MAP[m.role] || m.role || '普通',
    openid: m.openid || '',
    claimed: !!(m.openid && m.openid !== ''),
  };
}

function mapTask(t, progressByTask) {
  if (!t) return null;
  const recs = (progressByTask[t._id] || [])
    .slice()
    .sort((a, b) => new Date(normalizeDate(b.updatedAt) || 0) - new Date(normalizeDate(a.updatedAt) || 0))
    .slice(0, 20)
    .map((r) => {
      const blocker = String(r.blocker || '').trim();
      const desc = String(r.description || '').trim();
      const open = !!r.hasBlocker && !r.blockerResolved;
      const prog = (r.appliedChanges && typeof r.appliedChanges.progress === 'number')
        ? r.appliedChanges.progress
        : (t.progress || 0);
      return {
        text: open && blocker ? blocker : (desc || (open ? '卡壳' : '进展更新')),
        time: normalizeDate(r.updatedAt),
        hasBlocker: open,
        support: String(r.needSupport || '').trim(),
        progress: prog,
        updater: r.updaterName || '',
      };
    });

  return {
    _id: t._id,
    name: t.task_name || '',
    category: t.category || '',
    source: t.source || '',
    taskType: t.task_type || '临时性',
    recurFreq: t.recur_freq || '不适用',
    recurRule: t.recur_rule || '',
    status: t.status || '正常',
    stage: t.stage || '未开始',
    priority: t.priority || 'P2',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    dueDate: t.due_date || '',
    startDate: t.start_date || '',
    actualCompleteTime: t.actualCompleteTime || '',
    detail: t.detail || '',
    leaderName: t.leader || '',
    leaderId: t.leaderId || '',
    collaborator: t.collaborator || '',
    collaboratorIds: Array.isArray(t.collaboratorIds) ? t.collaboratorIds : [],
    hasOpenBlocker: !!t.hasOpenBlocker,
    openBlockerCount: t.openBlockerCount || 0,
    origin: t.origin || 'manual',
    latestProgressAt: normalizeDate(t.latestProgressAt),
    createdAt: normalizeDate(t.createdAt),
    updatedAt: normalizeDate(t.updatedAt),
    timeline: recs,
  };
}

/** 分页取全量（云函数端单页上限 100，超量必须循环） */
async function getAll(coll, where) {
  const out = [];
  let skip = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await db.collection(coll).where(where || {}).limit(QUERY_BATCH).skip(skip).get();
    out.push(...(r.data || []));
    if (!r.data || r.data.length < QUERY_BATCH) break;
    skip += QUERY_BATCH;
  }
  return out;
}

/**
 * 最近一次「每日巡检」记录 —— 看板据此展示巡检健康状态。
 *
 * ★ 与 templateService.list 的 lastPatrol 同一份语义：巡检失效是静默的，
 *   小程序计划页能看到，Web 看板也应该能看到 —— 否则管理者在两边的
 *   信息口径不一致。null 表示从未运行过（触发器未上线）。
 */
async function readLastPatrol() {
  const r = await db
    .collection(COLLECTIONS.JOB_LOGS)
    .where({ type: 'generatePeriodicTasks' })
    .orderBy('finishedAt', 'desc')
    .limit(1)
    .get();
  const doc = (r.data || [])[0];
  if (!doc) return null;
  return {
    finishedAt: normalizeDate(doc.finishedAt),
    today: doc.today || '',
    createdCount: (doc.created || []).length,
    failedCount: (doc.failed || []).length,
    failed: (doc.failed || []).map((f) => ({
      templateId: f.templateId || '',
      name: f.name || '',
      error: f.error || '',
    })),
    operator: doc.operator || '',
  };
}

/** 核心：校验口令并返回看板聚合数据 */
async function aggregate(passcode) {
  const envPass = process.env.DASHBOARD_PASSCODE || '';
  if (envPass && passcode !== envPass) {
    const e = new Error('口令错误');
    e.code = 401;
    throw e;
  }

  const membersRaw = await getAll(COLLECTIONS.MEMBERS, {});
  const tasksRaw = await getAll(COLLECTIONS.TASKS, {});
  const templates = await getAll(COLLECTIONS.TEMPLATES, {});
  const records = await getAll(COLLECTIONS.PROGRESS, {});
  const lastPatrol = await readLastPatrol().catch(() => null);

  const byTask = {};
  for (const r of records) {
    if (!r.taskId) continue;
    (byTask[r.taskId] = byTask[r.taskId] || []).push(r);
  }

  const members = membersRaw.map(mapMember).filter(Boolean);
  const tasks = tasksRaw.map((t) => mapTask(t, byTask)).filter(Boolean);

  return {
    generatedAt: new Date().toISOString(),
    members,
    tasks,
    periodicTemplates: templates,
    progressCount: records.length,
    lastPatrol,
  };
}

/**
 * Event 入口（callFunction 调用）。
 * event 即前端 data：{ passcode }
 * 兼容 HTTP 形态时 event.body 可能是字符串/对象。
 */
exports.main = async (event) => {
  let passcode = '';
  try {
    if (event && typeof event === 'object') {
      if (typeof event.passcode === 'string') passcode = event.passcode;
      else if (event.body) {
        const b = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        passcode = (b && b.passcode) || '';
      }
    }
  } catch (e) { /* ignore */ }

  try {
    const data = await aggregate(passcode);
    return { code: 0, data };
  } catch (e) {
    return { code: e.code === 401 ? 401 : 500, error: e.message || String(e) };
  }
};

module.exports = { aggregate, main: exports.main };
