/**
 * shared/taskRepo.js
 * ---------------------------------------------------------------------------
 * 任务领域仓储助手（云函数侧）。把"派生字段维护"集中在一处，
 * 避免 taskService / progressService / generatePeriodicTasks 各写一遍导致漂移。
 *
 * ⚠ 依赖 wx-server-sdk（db 实例由调用方传入），只能被云函数引用。
 *
 * 本文件负责三件容易写错的事：
 *   1. stage 与 actualCompleteTime 的服务端强制联动
 *   2. tasks.hasOpenBlocker / latestProgressAt 派生字段的重算
 *   3. 任务文档的完整构造（含姓名快照，禁止前端传入）
 * ---------------------------------------------------------------------------
 */

const { todayStr } = require('./dates');
const { ORIGIN, COLLECTIONS, QUERY_BATCH } = require('./constants');

/**
 * 由进展记录集合重算任务上的卡壳冗余字段。
 *
 * ★ 为什么要有冗余字段：看板若靠前端关联查询（先拉任务、再拉进展、再按
 *   taskId 取最新），会产生 N+1 查询，且第二次查询同样受 20 条分页限制，
 *   任务一多结果就被静默截断。冗余到 tasks 上一次查询搞定。
 *
 * ★ 为什么是「整体重算」而不是「增量更新」：增量在并发/失败重试下极易漂移，
 *   重算虽然多一次查询，但结果永远收敛到真实状态。
 *
 * ★ 判定口径：只要该任务存在**任意**一条「有 blocker 且未解决」的记录，
 *   就认为任务处于卡壳状态。不用"最新一条"是因为三周前未解决的卡壳
 *   依然是卡壳，不该因为后来有了一条普通进展就消失。
 *
 * @param {object} db     cloud.database()
 * @param {string} taskId
 */
async function recomputeTaskBlockers(db, taskId) {
  const _ = db.command;

  // 统计未解决卡壳数（hasBlocker=true 且 blockerResolved=false）
  const openCount = await db
    .collection('progress_records')
    .where({ taskId, hasBlocker: true, blockerResolved: false })
    .count();

  // 取最近一条进展时间用于列表展示排序
  const latestRes = await db
    .collection('progress_records')
    .where({ taskId })
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .field({ updatedAt: true })
    .get();

  const latest = (latestRes.data && latestRes.data[0]) || null;

  await db
    .collection('tasks')
    .doc(taskId)
    .update({
      data: {
        hasOpenBlocker: openCount.total > 0,
        openBlockerCount: openCount.total,
        latestProgressAt: latest ? latest.updatedAt : null,
      },
    });

  return { hasOpenBlocker: openCount.total > 0, openBlockerCount: openCount.total };
}

/**
 * stage 与 actualCompleteTime 的服务端强制联动。
 *
 * 规则：stage 改为「已完成」→ 写 actualCompleteTime = 今天（若前端未显式给值）；
 *      stage 从「已完成」退回 → 清空 actualCompleteTime。
 * 前端传的 actualCompleteTime 只在主办人显式修改时生效，且仍走这里归一化。
 *
 * @param {object} patch        即将写入的字段（会被就地修改）
 * @param {object} existingTask 变更前的任务文档
 * @returns {object} patch
 */
function applyStageSideEffects(patch, existingTask) {
  if (!('stage' in patch)) return patch;

  const prevStage = existingTask ? existingTask.stage : null;
  const nextStage = patch.stage;

  if (nextStage === '已完成') {
    // 只有从"非已完成"进入时才自动补时间，避免覆盖主办人手填的历史完成时间
    if (prevStage !== '已完成' && !patch.actualCompleteTime) {
      patch.actualCompleteTime = todayStr();
    }
  } else if (prevStage === '已完成') {
    // 从已完成退回，清空完成时间（除非本次显式传了值）
    if (!('actualCompleteTime' in patch)) {
      patch.actualCompleteTime = '';
    }
  }

  return patch;
}

/**
 * 构造新建任务的完整文档。
 *
 * ★ leader 姓名快照由调用方（ctx.namesOf）解析后传入，本函数不接受前端姓名。
 *
 * @param {object} opts
 * @param {object} opts.fields       已通过 validate 的业务字段
 * @param {string} opts.leaderId     主办人 openid（服务端确定）
 * @param {string} opts.leaderName   主办人姓名快照
 * @param {string[]} opts.collaboratorIds
 * @param {string} opts.collaboratorNames  '张三;李四'
 * @param {string} opts.creatorId
 * @param {object} opts.db
 * @param {string} [opts._id]        确定性 _id（幂等用），不传则自动生成
 * @param {string} [opts.origin]     manual | periodic
 * @param {string} [opts.templateId] 周期生成时来源模板
 * @param {string} [opts.periodKey]  周期生成时所属周期
 */
function buildTaskDoc(opts) {
  const {
    fields,
    leaderId,
    leaderName,
    collaboratorIds,
    collaboratorNames,
    creatorId,
    db,
    _id,
    origin,
    templateId,
    periodKey,
  } = opts;

  const doc = {
    task_name: fields.task_name,
    category: fields.category,
    source: fields.source,
    leader: leaderName,
    leaderId,
    collaborator: collaboratorNames || '',
    collaboratorIds: collaboratorIds || [],
    task_type: fields.task_type,
    recur_freq: fields.recur_freq || '不适用',
    recur_rule: fields.recur_rule || '',
    status: fields.status || '正常',
    stage: fields.stage || '未开始',
    priority: fields.priority || 'P2',
    progress: typeof fields.progress === 'number' ? fields.progress : 0,
    start_date: fields.start_date || todayStr(),
    due_date: fields.due_date || '',
    actualCompleteTime: fields.actualCompleteTime || '',
    detail: fields.detail || '',

    // 服务端派生字段 —— 前端永远改不动
    origin: origin || ORIGIN.MANUAL,
    creatorId,
    hasOpenBlocker: false,
    openBlockerCount: 0,
    latestProgressAt: null,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  };

  // 周期任务溯源字段，同时作为幂等键（配合确定性 _id 双重保险）
  if (templateId) doc.templateId = templateId;
  if (periodKey) doc.periodKey = periodKey;

  if (_id) doc._id = _id;
  return doc;
}

/**
 * 构造进展记录文档。
 *
 * ★ updaterId / updaterName 由服务端确定，不接受前端传值。
 * ★ hasBlocker 是派生字段，让"未解决卡壳"可以被精确查询：
 *   若只用 blocker != '' 做条件，云数据库对缺失字段的比较语义不一致，
 *   容易漏查或错查。存一个显式布尔最稳。
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.taskName       快照
 * @param {string} opts.updaterId      ctx.openid
 * @param {string} opts.updaterName    服务端解析
 * @param {object} opts.fields         description / blocker / needSupport
 * @param {string} opts.status         任务当前状态快照
 * @param {object} [opts.appliedChanges] 本次提交同时改动了的任务字段
 *                                      （如 { progress: 70, stage: '进行中' }）。
 *                                      仅主办人提交时可能非空，用于在详情页
 *                                      时间线上标注"这次把进度推进到了多少"。
 *                                      没有它的话，时间线只能显示任务当前值，
 *                                      看不出是哪一次进展改的。
 */
function buildProgressDoc(opts) {
  const { taskId, taskName, updaterId, updaterName, fields, status, db, _id } = opts;
  const blocker = String(fields.blocker || '').trim();
  const hasBlocker = blocker.length > 0;

  // ★ 必须**拷贝**而不是直接引用：调用方（progressService）在写入记录之后
  //   还会继续往 taskPatch 上加 updatedAt / actualCompleteTime 等服务端字段。
  //   若这里存的是同一个对象引用，那些内部字段会一并被写进进展记录里。
  const applied =
    opts.appliedChanges && Object.keys(opts.appliedChanges).length
      ? Object.assign({}, opts.appliedChanges)
      : null;

  const doc = {
    taskId,
    task_name: taskName,
    updaterId,
    updaterName,
    description: String(fields.description || '').trim(),
    status: status || '正常',
    needSupport: String(fields.needSupport || '').trim(),
    blocker,
    hasBlocker,
    // 无卡壳时置 null，有卡壳未解决为 false，已解决为 true。
    // 这样 blockerResolved:false 精确等于"存在未解决卡壳"，查询语义干净。
    blockerResolved: hasBlocker ? false : null,
    appliedChanges: applied,
    updatedAt: db.serverDate(),
  };

  if (_id) doc._id = _id;
  return doc;
}

// ---------------------------------------------------------------------------
// 历史数据关联（导入后的"补挂 openid"）
// ---------------------------------------------------------------------------

/**
 * 把分段字符串还原成姓名数组。与前端/CSV 侧的分隔口径保持一致。
 * 逗号也认，是因为历史表里混用过；多认一种不会出错，少认一种会漏人。
 */
function splitNames(s) {
  return String(s || '')
    .split(/[;；,，、]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * 合并协办人姓名快照 —— join / leave / removeCollaborator 后重建显示串。
 *
 * ★ 为什么不能直接 «resolveNames(collaboratorIds).join(';')»
 *   那正是这里曾经的做法，它会**静默销毁数据**。
 *   resolveNames 只认已认领的 openid；而历史导入的协办人只有姓名、没有 openid
 *   （本人还没来认领），ids 数组里从来没有他们。于是一旦有人加入或退出，
 *   这些人就从"协办"那行里消失了 —— 而 ids 里本来就没有他们，抹掉后再也回不来。
 *   实测影响过 17/61 条任务。
 *
 *   它同时是"我明明不是协办却能上报进展"这个反馈的根因：权限判定读
 *   collaboratorIds，界面显示读 collaborator，两边说的不是同一拨人。
 *
 * ★ 判据
 *   旧串里的姓名，只要**库里查不到一个同名且有 openid 的成员**，就说明它从未
 *   被关联过（导入遗留 / 预置但未认领），必须原样保留；反之说明这人已经是
 *   系统用户，去留在 ids 里说了算 —— 不能因为"名字还在旧串里"就赖着不走。
 *
 * ★ 所以调用方必须传 claimedNames
 *   只传 ids 反查出的姓名是不够的：那样无法区分"未认领所以查不到"和
 *   "已被移除所以查不到"，两者会一视同仁地留下来，被移除的人就删不掉了。
 *
 * ★ 顺序
 *   旧串顺序优先，新关联上的追加在末尾。这样 join 只是把人加到后面，
 *   不会把整份名单重排一遍；也让重复执行的结果稳定（幂等）。
 *
 * ★ 附带效果：主办人不会留在协办串里
 *   主办人从不进 collaboratorIds（relinkMemberData 跳过、join 直接拒绝），
 *   所以历史脏数据里若把主办人也写进了协办串，重建时会按"已认领但不在 ids 里"
 *   去掉。这与旧实现一致（旧实现按 ids 反查，本来就产出不了主办人的姓名），
 *   且主办人在「主办」那行仍有显示，信息没丢。未认领的主办人则会被保留 ——
 *   它和"导入遗留下来的人"在数据上无法区分。
 *
 * @param {string}   oldSnapshot  现有的 collaborator 显示串
 * @param {string[]} linkedNames  由 collaboratorIds 反查出的姓名（已认领的协办人）
 * @param {Iterable<string>} claimedNames 库中「有 openid」的成员姓名；可传数组或 Set
 * @returns {string} 分号分隔的新显示串
 */
function mergeCollaboratorSnapshot(oldSnapshot, linkedNames, claimedNames) {
  const linked = [...new Set((linkedNames || []).filter(Boolean))];
  const linkedSet = new Set(linked);
  const claimed = new Set(claimedNames || []);
  const out = [];
  const push = (n) => {
    if (!out.includes(n)) out.push(n);
  };

  for (const n of splitNames(oldSnapshot)) {
    if (linkedSet.has(n)) push(n); // 仍然关联着
    else if (!claimed.has(n)) push(n); // 从未关联上 —— 保留
    // 剩下那种「已认领、但已不在 ids 里」= 真的退出了或被移除了，丢掉
  }
  linked.forEach(push); // 新关联上的追加在末尾

  return out.join(';');
}

/**
 * 分页取全量。云函数端单次上限 100，不循环会被静默截断。
 * 导出的：demandRepo 的每日巡检与 readDemand 外的全量读共用。
 */
async function fetchAll(db, collectionName) {
  const out = [];
  for (let skip = 0; ; skip += QUERY_BATCH) {
    const r = await db.collection(collectionName).skip(skip).limit(QUERY_BATCH).get();
    const batch = r.data || [];
    out.push(...batch);
    if (batch.length < QUERY_BATCH) return out;
  }
}

/**
 * 受限并发批量执行。云开发对单函数的并发请求数有上限，
 * 无脑 Promise.all 几百条更新容易被限流；一次 20 条既快又稳。
 */
async function runBatched(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/**
 * 按姓名把历史数据挂到 openid 上。
 *
 * ★ 为什么需要它
 *   历史任务表里只有姓名，而权限判定只认 openid（见 shared/perm.js）。
 *   导入时 openid 还不存在 —— 要等本人来认领页认领才产生。
 *   于是导入出来的任务 leaderId / collaboratorIds、进展记录 updaterId 都是空的，
 *   「我主办的」列表为空、也没人能编辑。本函数就是补上这一段的。
 *
 * ★ 只填空，从不覆盖
 *   若某条任务的 leaderId 已有值，说明它由小程序正常创建、归属已经确定，
 *   绝不能凭"姓名相同"改写 —— 两个人重名时会互相夺走对方的任务。
 *   协办人同理，只往数组里追加，不重建、不重排。
 *
 * ★ 幂等
 *   重复执行结果相同：已填的跳过，没填的补上。可以随时重跑，也可以
 *   只传一个人（认领时）分多次跑 —— 最终收敛到同一个结果。
 *
 * ★ 关于开销
 *   本函数全量扫描 tasks 与 progress_records。当前规模（任务数十、进展数百）
 *   下每次只有几个查询，可以接受。若任务量涨到数千，应当改为只在管理员
 *   手动触发时全量跑，认领路径上则退回按姓名 where 定向更新。
 *
 * @param {object} db            wx-server-sdk 的 database 实例
 * @param {object} nameToOpenid  { 姓名: openid }，只含"本次已知"的人即可
 * @returns {{tasks: number, records: number}}  各自补齐的条数
 */
async function relinkMemberData(db, nameToOpenid) {
  const map = nameToOpenid || {};
  const names = Object.keys(map).filter((n) => n && map[n]);
  if (!names.length) return { tasks: 0, records: 0 };

  const known = new Set(names);
  const taskPatches = [];
  const recordPatches = [];

  // ── 任务 ──
  for (const t of await fetchAll(db, COLLECTIONS.TASKS)) {
    const patch = {};

    if (!t.leaderId && known.has(t.leader)) {
      patch.leaderId = map[t.leader];
      // 导入的任务没有创建人，主办人就是事实上的创建人。
      // 仍然只填空白 —— 已有 creatorId 说明它来自正常创建流程。
      if (!t.creatorId) patch.creatorId = map[t.leader];
    }

    // collaborator 是 ';' 分隔的展示字符串，不是数组，没法用 where 精确匹配，
    // 所以在这里按分隔符切开比对，不做字符串子串匹配
    //（子串会让「李娜」命中「李娜娜」这种条目）。
    const collabNames = splitNames(t.collaborator);
    if (collabNames.length) {
      const ids = Array.isArray(t.collaboratorIds) ? t.collaboratorIds.slice() : [];
      let added = false;
      collabNames.forEach((n) => {
        if (n === t.leader) return; // 主办人不重复计入协办
        const id = map[n];
        if (id && !ids.includes(id)) {
          ids.push(id);
          added = true;
        }
      });
      if (added) patch.collaboratorIds = ids;
    }

    if (Object.keys(patch).length) taskPatches.push({ _id: t._id, patch });
  }

  // ── 进展记录 ──
  for (const r of await fetchAll(db, COLLECTIONS.PROGRESS_RECORDS)) {
    if (r.updaterId || !known.has(r.updaterName)) continue;
    recordPatches.push({ _id: r._id, patch: { updaterId: map[r.updaterName] } });
  }

  await runBatched(taskPatches, 20, (x) =>
    db.collection(COLLECTIONS.TASKS).doc(x._id).update({ data: x.patch })
  );
  await runBatched(recordPatches, 20, (x) =>
    db.collection(COLLECTIONS.PROGRESS_RECORDS).doc(x._id).update({ data: x.patch })
  );

  return { tasks: taskPatches.length, records: recordPatches.length };
}

module.exports = {
  recomputeTaskBlockers,
  applyStageSideEffects,
  buildTaskDoc,
  buildProgressDoc,
  mergeCollaboratorSnapshot,
  splitNames,
  relinkMemberData,
  // 通用 db 助手（与任务领域无关，需求池的巡检复用）
  fetchAll,
  runBatched,
};
