/**
 * miniprogram/utils/db.js
 * ---------------------------------------------------------------------------
 * 数据库直连读封装。
 *
 * ★ 为什么必须有 fetchAll：
 *   微信云数据库小程序端单次 get() **最多返回 20 条**，而且超出部分是
 *   **静默截断** —— 不报错、不警告，只是少给你数据。测试时只有三五条
 *   任务完全看不出来，上线后任务一多，看板就开始莫名其妙地少任务。
 *   所以任何"取全量"的查询都必须走 fetchAll 分页循环。
 *
 * ★ 写操作不走这里 —— 全部要经过云函数做权限校验，见 utils/api.js。
 * ---------------------------------------------------------------------------
 */

const config = require('../config');
const { CLIENT_QUERY_BATCH, COLLECTIONS } = require('../shared/constants');

/** 取数据库实例（每次调用都拿，避免模块加载期 cloud 尚未 init） */
function db() {
  return wx.cloud.database();
}

/** command 指令别名，简写方便 */
function cmd() {
  return db().command;
}

/**
 * 分页循环取全量。本文件所有列表查询都走它。
 *
 * @param {string} collection 集合名
 * @param {(query:any)=>any} buildQuery 接收链式 query 对象，返回加了
 *                                      where/orderBy 的 query。注意不要在
 *                                      里面调 limit/skip，那由本函数控制。
 * @param {object} [opts]
 * @param {number} [opts.max] 最大条数保护，默认 config.fetchMax
 * @returns {Promise<Array>} 文档数组
 *
 * @example
 *   const tasks = await fetchFrom('tasks', q => q.where({ stage: '进行中' }))
 */
async function fetchFrom(collection, buildQuery, opts = {}) {
  const max = (opts && opts.max) || config.fetchMax;
  const out = [];
  let skip = 0;

  while (out.length < max) {
    const base = db().collection(collection);
    const query = buildQuery ? buildQuery(base) : base;
    const res = await query.skip(skip).limit(CLIENT_QUERY_BATCH).get();
    const batch = res.data || [];
    out.push(...batch);
    if (batch.length < CLIENT_QUERY_BATCH) break;
    skip += CLIENT_QUERY_BATCH;
  }

  return out;
}

/** 取单个文档，不存在返回 null（不抛错） */
async function getDoc(collection, id) {
  if (!id) return null;
  try {
    const res = await db().collection(collection).doc(id).get();
    return res.data || null;
  } catch (e) {
    // doc 不存在时云数据库会抛错，这里统一转成 null
    return null;
  }
}

/** 统计条数 */
async function count(collection, where) {
  const res = await db().collection(collection).where(where || {}).count();
  return res.total || 0;
}

// ---------------------------------------------------------------------------
// 常用查询的语义化封装。页面用这些，避免每个页面各写一遍 where 条件写歪。
// ---------------------------------------------------------------------------

/** 我主办的任务 */
function myLedTasks(openid) {
  return fetchFrom(COLLECTIONS.TASKS, (q) =>
    q.where({ leaderId: openid }).orderBy('due_date', 'asc')
  );
}

/** 我协办的任务 */
function myJoinedTasks(openid) {
  return fetchFrom(COLLECTIONS.TASKS, (q) =>
    // ★ 数组字段的包含查询必须用 _.in，不能直接传裸数组 ——
    //   传裸数组会被当成"数组完全相等"，永远查不到结果。
    q.where({ collaboratorIds: cmd().in([openid]) }).orderBy('due_date', 'asc')
  );
}

/**
 * 我可以加入的任务：他人主办、且协办名单里没有我、且未完成。
 *
 * 注意这里无法在数据库层表达"数组不包含某值"，所以先拉全量再在前端筛。
 * 团队规模下（任务数百条）完全够用，且避免为此专门加云函数。
 */
async function joinableTasks(openid) {
  const all = await fetchFrom(COLLECTIONS.TASKS, (q) =>
    q.where({ stage: cmd().neq('已完成') }).orderBy('due_date', 'asc')
  );
  return all.filter((t) => {
    if (t.leaderId === openid) return false;
    const ids = t.collaboratorIds;
    return !(Array.isArray(ids) && ids.indexOf(openid) !== -1);
  });
}

/** 全部任务（看板用），按截止日排序 */
function allTasks(where) {
  return fetchFrom(COLLECTIONS.TASKS, (q) =>
    q.where(where || {}).orderBy('due_date', 'asc')
  );
}

/** 某任务的进展记录，最新的在前 */
function progressOf(taskId) {
  return fetchFrom(COLLECTIONS.PROGRESS_RECORDS, (q) =>
    q.where({ taskId }).orderBy('updatedAt', 'desc')
  );
}

/**
 * 某时刻之后的全部进展记录（近两周动态用），最新的在前。
 *
 * ★ 一次拉窗口内全量、在页面内存里按 updaterId 归并 —— 与人员看板
 *   「一次拉全量任务再归并」同一套路：不给每个成员各查一次（N+1），
 *   10 人规模下两周的记录量也远小于 fetchMax（500）。
 */
function progressSince(since) {
  return fetchFrom(COLLECTIONS.PROGRESS_RECORDS, (q) =>
    q.where({ updatedAt: cmd().gte(since) }).orderBy('updatedAt', 'desc')
  );
}

/** 全部成员 */
function allMembers() {
  return fetchFrom(COLLECTIONS.MEMBERS, (q) => q);
}

/** 我主办 + 我协办（人员看板下钻用） */
async function tasksOfMember(openid) {
  const led = await fetchFrom(COLLECTIONS.TASKS, (q) =>
    q.where({ leaderId: openid }).orderBy('due_date', 'asc')
  );
  const joined = await fetchFrom(COLLECTIONS.TASKS, (q) =>
    q.where({ collaboratorIds: cmd().in([openid]) }).orderBy('due_date', 'asc')
  );
  return { led, joined };
}

module.exports = {
  db,
  cmd,
  fetchFrom,
  getDoc,
  count,
  myLedTasks,
  myJoinedTasks,
  joinableTasks,
  allTasks,
  progressOf,
  progressSince,
  allMembers,
  tasksOfMember,
};
