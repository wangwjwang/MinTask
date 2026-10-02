/**
 * shared/ctx.js
 * ---------------------------------------------------------------------------
 * 云函数执行上下文：身份解析 + 权限校验中间件。
 *
 * ⚠ 本文件依赖 wx-server-sdk，**只能被云函数引用**。
 *   小程序端虽然也会同步一份副本，但绝不可 require 本文件。
 *   （同步脚本会检查小程序端是否误引用，见 scripts/sync-shared.js）
 *
 * ★ 安全纪律：
 *   1. 身份只取自 cloud.getWXContext().OPENID。前端传的任何 openid /
 *      leaderId / collaboratorIds（作为"我是谁"用途）一律丢弃。
 *   2. 权限判定一律走 shared/perm.js 的纯函数，比对 openid，不比姓名。
 * ---------------------------------------------------------------------------
 */

const cloud = require('wx-server-sdk');
const { BizError, Codes, describeInfraError } = require('./errors');
const { QUERY_BATCH } = require('./constants');
const perm = require('./perm');

// 云函数 SDK 初始化。放在模块加载期执行，保证任何 import 了本文件的
// 云函数入口都能直接用 cloud.database() / cloud.getWXContext()，无需各自重复 init。
// DYNAMIC_CURRENT_ENV 表示"跟随当前部署环境"，避免把环境 ID 硬编码进代码。
// cloud.init 是幂等的，重复调用无副作用。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 解析调用者 openid。
 *
 * 本地调试 / 云端测试面板下 getWXContext().OPENID 为空，此时允许通过
 * __mockOpenid 旁路——但必须由环境变量 ALLOW_MOCK_OPENID=true 显式开启。
 * ★ 生产环境必须保持 ALLOW_MOCK_OPENID 未设置或为 false，
 *   否则任何人都能伪造身份。README 中已列为部署检查项。
 */
function resolveOpenid(event) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext && wxContext.OPENID;
  if (openid) return openid;

  if (process.env.ALLOW_MOCK_OPENID === 'true' && event && event.__mockOpenid) {
    console.warn('[ctx] 使用 __mockOpenid 旁路身份，仅限调试环境');
    return String(event.__mockOpenid);
  }

  throw new BizError(Codes.NO_IDENTITY);
}

/**
 * 执行一次数据库查询，出错时把集合名附到异常上。
 *
 * ★ 为什么需要它：
 *   微信对"集合不存在"的报错文本形如 `collection.get:fail ...`，
 *   **不含集合名** —— get 是方法名。而部署没做完时，使用者唯一想知道的
 *   就是"到底该建哪个集合"。错误文本里没有，就只能由发起查询的一方补上，
 *   因为它本来就知道。（errors.js 的 describeInfraError 会优先读这个字段。）
 *
 *   退路是从错误文本里正则提取，但那条路不可靠，只能算兜底。
 */
async function taggedQuery(collectionName, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && typeof e === 'object' && !e.collectionName) {
      e.collectionName = collectionName;
    }
    throw e;
  }
}

/**
 * 构建执行上下文。每次云函数调用构建一次。
 *
 * @param {object} event 云函数入参
 * @returns {object} ctx
 */
function buildCtx(event) {
  const db = cloud.database();
  const _ = db.command;

  // 成员信息懒加载并缓存，避免一次调用内重复查询
  let memberCache = null;
  let memberLoaded = false;

  const ctx = {
    openid: resolveOpenid(event),
    db,
    _,
    event,
    /** 数据库指令别名，简写方便 */
    command: _,

    /**
     * 取当前调用者的成员档案。未认领则抛 NOT_CLAIMED。
     * 几乎所有写操作的第一步。
     */
    async requireMember() {
      if (memberLoaded) {
        if (!memberCache) throw new BizError(Codes.NOT_CLAIMED);
        return memberCache;
      }
      const r = await taggedQuery('members', () =>
        db.collection('members').where({ openid: ctx.openid }).limit(1).get()
      );
      memberCache = (r.data && r.data[0]) || null;
      memberLoaded = true;
      if (!memberCache) throw new BizError(Codes.NOT_CLAIMED);
      return memberCache;
    },

    /** 取成员档案，未认领返回 null（不抛错，供 getMe 之类使用） */
    async findMember() {
      if (memberLoaded) return memberCache;
      const r = await taggedQuery('members', () =>
        db.collection('members').where({ openid: ctx.openid }).limit(1).get()
      );
      memberCache = (r.data && r.data[0]) || null;
      memberLoaded = true;
      return memberCache;
    },

    /** 要求管理员权限 */
    async requireAdmin() {
      const m = await ctx.requireMember();
      if (m.role !== '管理员') throw new BizError(Codes.FORBIDDEN_ADMIN);
      return m;
    },

    /** 读取任务，不存在则抛 TASK_NOT_FOUND */
    async getTaskOrThrow(taskId) {
      if (!taskId) throw new BizError(Codes.INVALID_PARAM, '缺少任务 ID');
      let res;
      try {
        res = await taggedQuery('tasks', () =>
          db.collection('tasks').doc(String(taskId)).get()
        );
      } catch (e) {
        // ★ 不能一律吞掉。文档不存在会抛错（这是 catch 存在的原因），
        //   但集合不存在、权限被拒也会走到这里 —— 若一并转成"任务不存在"，
        //   部署问题就被伪装成了业务问题，排查方向会完全跑偏。
        const infra = describeInfraError(e);
        if (infra) throw infra;
        res = null;
      }
      if (!res || !res.data) throw new BizError(Codes.TASK_NOT_FOUND);
      return res.data;
    },

    /** 要求当前用户是该任务主办人 */
    async requireLeaderOf(task) {
      if (!perm.isLeader(task, ctx.openid)) {
        throw new BizError(Codes.FORBIDDEN_NOT_LEADER);
      }
      return task;
    },

    /** 要求当前用户是主办人或协办人 */
    async requireParticipantOf(task) {
      if (!perm.isParticipant(task, ctx.openid)) {
        throw new BizError(Codes.FORBIDDEN_NOT_PARTICIPANT);
      }
      return task;
    },

    /**
     * 由 openid 数组解析出姓名数组（分批查询，规避 100 条上限）。
     * 返回顺序与入参一致，找不到的 id 被跳过。
     */
    async resolveNames(ids) {
      const uniq = [...new Set((ids || []).filter(Boolean))];
      if (!uniq.length) return [];
      const map = {};
      for (let i = 0; i < uniq.length; i += QUERY_BATCH) {
        const batch = uniq.slice(i, i + QUERY_BATCH);
        const r = await taggedQuery('members', () =>
          db
            .collection('members')
            .where({ openid: _.in(batch) })
            .field({ openid: true, name: true })
            .limit(QUERY_BATCH)
            .get()
        );
        for (const m of r.data || []) map[m.openid] = m.name;
      }
      return uniq.map((id) => map[id]).filter(Boolean);
    },

    /**
     * ★ 姓名快照的唯一生成入口。
     * 由 openid 数组生成 '张三;李四' 形式的展示字符串。
     * 任何写 tasks 的地方都必须经由此方法，禁止前端传入姓名字符串。
     */
    async namesOf(ids) {
      const names = await ctx.resolveNames(ids);
      return names.join(';');
    },

    /** 按姓名批量查成员（用于管理员按姓名预置/匹配场景） */
    async findMembersByNames(names) {
      const uniq = [...new Set((names || []).filter(Boolean))];
      if (!uniq.length) return [];
      const map = {};
      for (let i = 0; i < uniq.length; i += QUERY_BATCH) {
        const batch = uniq.slice(i, i + QUERY_BATCH);
        const r = await taggedQuery('members', () =>
          db.collection('members').where({ name: _.in(batch) }).limit(QUERY_BATCH).get()
        );
        for (const m of r.data || []) map[m.name] = m;
      }
      return uniq.map((n) => map[n]).filter(Boolean);
    },
  };

  return ctx;
}

module.exports = { buildCtx, resolveOpenid, QUERY_BATCH };
