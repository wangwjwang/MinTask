/**
 * shared/perm.js
 * ---------------------------------------------------------------------------
 * 权限纯函数 —— 全站唯一的权限判据来源，前端与云函数共用同一份文件。
 *
 * ★ 核心纪律（违反即产生安全漏洞）：
 *   1. 权限判定 **只比对 openid**（task.leaderId / task.collaboratorIds），
 *      绝不比对姓名字符串。姓名只是展示快照，会因改名/重名而失真。
 *   2. 前端用这些函数控制控件显隐（wx:if），只是体验优化；
 *      真正的安全边界是云函数调用同一份函数做强制校验。
 *      前端隐藏 ≠ 安全，任何绕过 UI 的请求都会被云函数拒绝。
 *
 * 本文件必须保持「双端安全」：只用 CommonJS，不依赖任何运行环境。
 * ---------------------------------------------------------------------------
 */

/**
 * 是否为主办人。
 * @param {object} task    tasks 集合文档
 * @param {string} openid  当前用户 openid
 */
function isLeader(task, openid) {
  return !!openid && !!task && task.leaderId === openid;
}

/**
 * 是否为主办人或协办人。
 * collaboratorIds 是 openid 数组；缺失时按空数组处理（历史数据兼容）。
 */
function isParticipant(task, openid) {
  if (!openid || !task) return false;
  if (isLeader(task, openid)) return true;
  const ids = task.collaboratorIds;
  return Array.isArray(ids) && ids.indexOf(openid) !== -1;
}

/**
 * 是否可编辑任务属性（名称/分类/协办人/截止时间/进度%/状态/stage）。
 * 仅主办人。协办人一律不可。
 */
function canEditTask(task, openid) {
  return isLeader(task, openid);
}

/**
 * 是否可新增进展记录（description / blocker / needSupport）。
 * 主办人与协办人均可。
 */
function canAddProgress(task, openid) {
  return isParticipant(task, openid);
}

/**
 * 是否可提交主办人专属字段（progress / status / stage）。
 * 语音上报页据此决定是否渲染"进度与状态"编辑区。
 */
function canEditProgressFields(task, openid) {
  return isLeader(task, openid);
}

/**
 * 是否可自由加入协办。
 * 规则：非主办人 + 尚未在协办名单中 + 任务未完成。
 */
function canJoin(task, openid) {
  if (!openid || !task) return false;
  if (isLeader(task, openid)) return false;
  if (isParticipant(task, openid)) return false;
  return task.stage !== '已完成';
}

/**
 * 是否可退出协办（仅本人退出自己，主办人不能"退出"自己的任务）。
 */
function canLeave(task, openid) {
  if (!openid || !task) return false;
  if (isLeader(task, openid)) return false;
  const ids = task.collaboratorIds;
  return Array.isArray(ids) && ids.indexOf(openid) !== -1;
}

/**
 * 是否可标记某条卡壳已解决。
 * 规则：任务主办人，或该条进展的提交人本人。
 */
function canResolveBlocker(task, record, openid) {
  if (!openid || !task || !record) return false;
  return isLeader(task, openid) || record.updaterId === openid;
}

/**
 * 是否可移除协办人（仅主办人）。
 */
function canRemoveCollaborator(task, openid) {
  return isLeader(task, openid);
}

/**
 * 是否可删除任务。
 * 规则：任务主办人，或管理员。
 *
 * ★ 为什么管理员这一条必须保留
 *   历史导入的 61 条任务里有 59 条 leaderId 是空的 —— 本人还没来认领。
 *   若把删除限定为"仅主办"，这 59 条会变成**谁都删不掉**（管理员也不行），
 *   只能去云控制台手工删，还得连带清理进展记录。
 *
 * ★ 为什么 isAdmin 当参数传进来，而不是在这里查
 *   本文件是纯函数、不依赖运行环境，拿不到 members 集合。
 *   管理员身份由调用方判定：前端 auth.isAdmin()，云函数 (await ctx.requireMember()).role。
 *   两边都必须把"当前用户是不是管理员"如实传进来 —— 传 true 就等于放弃这道校验。
 *
 * @param {boolean} isAdmin 当前用户是否管理员
 */
function canDeleteTask(task, openid, isAdmin) {
  if (!openid) return false;
  return isLeader(task, openid) || !!isAdmin;
}

/**
 * 是否可管理（修改 / 停用 / 删除）某个周期计划。
 * 规则：计划的主办人，或管理员。
 *
 * ★ 为什么是 ownerId 而不是"创建人"
 *   计划是「谁主办谁负责」的东西 —— 生成出来的任务也落在主办人头上。
 *   管理员替别人建一个计划（指派他人主办）之后，该由那个人自己维护，
 *   而不是永远只有管理员能改。
 *
 * ★ 为什么管理员这一条必须保留
 *   成员离职或换岗后，他名下那些计划会变成**没人能改的僵尸**，
 *   而它每个月还在自动往库里生成任务。跟 canDeleteTask 里
 *   "59 条无主办的历史任务"是同一类问题。
 *
 * ★ 管理者（只读角色）能不能管，不在本函数判定
 *   本文件是纯函数、不依赖运行环境，拿不到 role。角色闸门由云函数入口的
 *   ctx.requireWriter() 统一负责 —— 管理者在建/改计划的第一步就被挡下。
 *
 * @param {boolean} isAdmin 当前用户是否管理员
 */
function canManageTemplate(template, openid, isAdmin) {
  if (!openid || !template) return false;
  return template.ownerId === openid || !!isAdmin;
}

module.exports = {
  isLeader,
  isParticipant,
  canEditTask,
  canAddProgress,
  canEditProgressFields,
  canJoin,
  canLeave,
  canResolveBlocker,
  canRemoveCollaborator,
  canDeleteTask,
  canManageTemplate,
};
