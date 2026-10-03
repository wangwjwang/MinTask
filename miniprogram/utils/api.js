/**
 * miniprogram/utils/api.js
 * ---------------------------------------------------------------------------
 * 云函数调用统一封装。
 *
 * 所有写操作都必须经由这里 —— 页面不要直接调 wx.cloud.callFunction，
 * 否则会绕过统一的错误处理（尤其是"未认领 → 跳认领页"这条全局逻辑）。
 *
 * 后端响应信封约定（见 shared/router.js）：
 *   成功 { ok: true,  data: any }
 *   失败 { ok: false, code: 'FORBIDDEN_NOT_LEADER', message: '仅主办人可执行此操作' }
 * ---------------------------------------------------------------------------
 */

const config = require('../config');
const errors = require('../shared/errors');
const toast = require('./toast');

/** 需要跳转到认领页的错误码 */
const REDIRECT_TO_CLAIM = [errors.Codes.NOT_CLAIMED, errors.Codes.NO_IDENTITY];

/** 需要静默刷新当前页的错误码（数据已过期，重拉即可） */
const REFRESH_ON_ERROR = [
  errors.Codes.TASK_NOT_FOUND,
  errors.Codes.MEMBER_TAKEN,
  errors.Codes.FORBIDDEN_NOT_LEADER,
  errors.Codes.FORBIDDEN_NOT_PARTICIPANT,
];

/** 页面可通过 api.setClaimHandler 注册自己的跳转逻辑（Tab 页不能用 redirectTo） */
let claimHandler = null;
function setClaimHandler(fn) {
  claimHandler = fn;
}

/**
 * 调用云函数。
 *
 * @param {string} fnName   云函数名（建议从 config.functions 取）
 * @param {string} action   action 名
 * @param {object} [payload] 业务参数
 * @param {object} [opts]
 * @param {string} [opts.clientToken] 幂等令牌，写操作用
 * @param {boolean} [opts.silent]     为 true 时不弹错误提示，由调用方自行处理
 * @returns {Promise<any>} 成功时返回 data
 * @throws {Error} 带 code / message 的错误
 */
async function call(fnName, action, payload, opts = {}) {
  let res;
  try {
    res = await wx.cloud.callFunction({
      name: fnName,
      data: {
        action,
        payload: payload || {},
        clientToken: opts.clientToken || '',
      },
    });
  } catch (e) {
    // 网络层失败（云函数不存在、超时、断网）
    console.error(`[api] 调用 ${fnName}.${action} 失败`, e);

    const err = new Error(describeNetworkError(e));
    err.code = 'NETWORK_ERROR';
    err.raw = e;
    if (!opts.silent) showError(err);
    throw err;
  }

  const result = res && res.result;
  if (!result || result.ok !== true) {
    const code = (result && result.code) || 'EMPTY_RESULT';
    const message = (result && result.message) || '操作失败';
    const err = new Error(message);
    err.code = code;
    console.warn(`[api] ${fnName}.${action} 返回错误`, code, message);

    if (!opts.silent) handleError(err, opts);
    throw err;
  }

  return result.data;
}

/**
 * 统一错误处理：
 *   - 未认领 → 跳认领页（用户没法做任何操作，必须先去认领）
 *   - 权限/数据过期 → 提示后刷新当前页
 *   - 其他 → 提示 message
 */
/**
 * 把云开发的底层错误翻成人能看懂的话。
 *
 * ★ 为什么值得单独做：
 *   -601034「没有权限，请先开通云开发或者云托管」这个错误码，从字面完全看不出
 *   真正原因（配置里的 envId 是占位符 / 环境没开通 / 环境 ID 写错 / 云函数没部署，
 *   都会指向它）。统一说成"网络异常"更糟 —— 用户会去检查 WiFi，
 *   而问题其实在配置里。这里按常见成因给出可执行的下一步。
 */
function describeNetworkError(e) {
  const msg = String((e && (e.errMsg || e.message)) || '');

  // 环境未配置 / 未开通，或 AppID 与云开发环境对不上
  if (msg.indexOf('-601034') !== -1 || msg.indexOf('没有权限，请先开通云开发') !== -1) {
    return '云开发环境不可用：请检查 config.js 的 envId 是否为真实环境 ID，并确认云开发已开通';
  }

  // 云函数不存在（名字写错或没上传部署）。
  // 微信在不同场景下给的码不一样（-501000 / -604100），文案也有出入，
  // 所以同时匹配错误码与关键字，避免漏判。
  if (
    msg.indexOf('-501000') !== -1 ||
    msg.indexOf('-604100') !== -1 ||
    msg.indexOf('FUNCTION_NOT_FOUND') !== -1 ||
    /could not be found/i.test(msg)
  ) {
    return '云函数不存在：请在开发者工具里右键 cloudfunctions 下的各函数，执行「上传并部署：云端安装依赖」';
  }

  // 云函数内部报错或超时
  if (msg.indexOf('-504002') !== -1 || msg.indexOf('timeout') !== -1) {
    return '云函数执行超时或被中断，请重试';
  }

  return '网络异常，请检查网络后重试';
}

function handleError(err, opts = {}) {
  if (REDIRECT_TO_CLAIM.includes(err.code)) {
    if (claimHandler) {
      claimHandler();
    } else {
      wx.reLaunch({ url: '/pages/claim/index' });
    }
    return;
  }

  showError(err);

  if (REFRESH_ON_ERROR.includes(err.code) && opts.refreshPage !== false) {
    const pages = getCurrentPages();
    const cur = pages[pages.length - 1];
    // 刷新交给页面自己实现，避免这里硬编码各页面的数据加载方法名
    if (cur && typeof cur.refresh === 'function') {
      cur.refresh();
    }
  }
}

/**
 * 弹一个错误提示。云函数返回的中文文案可直接展示。
 * 走 toast.error 而非裸 showToast —— 长文案（部署类提示）要自动转弹窗，
 * 否则会被截断，且来不及读。
 */
function showError(err) {
  toast.error((err && err.message) || '操作失败');
}

// ---------------------------------------------------------------------------
// 各服务的语义化封装。页面用这些而不是拼字符串，避免函数名写错。
// ---------------------------------------------------------------------------

const memberApi = {
  getMe: () => call(config.functions.member, 'getMe'),
  claim: (memberId) => call(config.functions.member, 'claim', { memberId }),
  listClaimable: () => call(config.functions.member, 'listClaimable'),
  listMembers: () => call(config.functions.member, 'listMembers'),
  adminAddMember: (data) => call(config.functions.member, 'adminAddMember', data),
  adminBatchAddMembers: (members) => call(config.functions.member, 'adminBatchAddMembers', { members }),
  adminUpdateMember: (data) => call(config.functions.member, 'adminUpdateMember', data),
  adminResetBinding: (memberId) => call(config.functions.member, 'adminResetBinding', { memberId }),
  // 导入历史任务表后，把只有姓名、还没有 openid 的任务/进展补上归属。幂等，可反复调。
  adminRelinkMembers: () => call(config.functions.member, 'adminRelinkMembers'),
};

const taskApi = {
  create: (task, clientToken) => call(config.functions.task, 'create', { task }, { clientToken }),
  adminCreate: (leaderId, task, clientToken) =>
    call(config.functions.task, 'adminCreate', { leaderId, task }, { clientToken }),
  update: (taskId, patch) => call(config.functions.task, 'update', { taskId, patch }),
  join: (taskId) => call(config.functions.task, 'join', { taskId }),
  leave: (taskId) => call(config.functions.task, 'leave', { taskId }),
  removeCollaborator: (taskId, collaboratorOpenid) =>
    call(config.functions.task, 'removeCollaborator', { taskId, collaboratorOpenid }),
  remove: (taskId) => call(config.functions.task, 'delete', { taskId }),
};

const progressApi = {
  addRecord: (data, clientToken) =>
    call(config.functions.progress, 'addRecord', data, { clientToken }),
  resolveBlocker: (recordId) => call(config.functions.progress, 'resolveBlocker', { recordId }),
  deleteRecord: (recordId) => call(config.functions.progress, 'deleteRecord', { recordId }),
};

const aiApi = {
  /**
   * AI 精简。
   *
   * @param {string} text 用户口述/手录的原文
   * @param {object} [task] 当前任务（progress-add 页面上的 this.data.task）。
   *   ★ 必须带上：AI 看不到页面，不告诉它是哪件事，整理结果就只能泛泛而谈 ——
   *     原文里的"那个""对方""弄完了"它没法写具体。任务还没加载完时传空即可，
   *     云函数会退化成"盲整理"，不报错。
   * @returns {Promise<{text:string, aiApplied:boolean, reason?:string, fields?:object}>}
   */
  refine: (text, task) =>
    call(
      config.functions.ai,
      'refine',
      {
        text,
        // ★ 字段名必须与 callAI/index.js 里读的 payload.taskName / payload.taskDetail 一致。
        //   对不上不会报错，只会静默退化成盲整理 —— 测试脚本 tp-ai-context.js 锁住了这条。
        taskName: (task && task.task_name) || '',
        taskDetail: (task && task.detail) || '',
      },
      { silent: true }
    ),
};

/**
 * 周期计划（periodic_templates）。
 * ★ 这里的 template 就是用户看到的「计划」—— 建它的入口在新建任务页
 *   选「任务性质 = 周期性」时，不是另一套管理后台。
 */
const templateApi = {
  list: () => call(config.functions.template, 'list'),
  /** 全部人的计划（不看归属）—— 任务看板「周期性计划」段用，只读 */
  listAll: () => call(config.functions.template, 'listAll'),
  /**
   * 读一份计划（任何成员都能读）。不存在时 template 为 null，不抛错 ——
   * 看板上的名单是几秒前拉的，点开时那份可能刚被别人删掉。
   */
  get: (templateId) => call(config.functions.template, 'get', { templateId }),
  create: (data) => call(config.functions.template, 'create', data),
  update: (templateId, patch) => call(config.functions.template, 'update', { templateId, patch }),
  toggle: (templateId) => call(config.functions.template, 'toggle', { templateId }),
  remove: (templateId) => call(config.functions.template, 'delete', { templateId }),
  /** asOf 是「假装今天是哪天」，用于补跑历史周期；不传就按真实今天算 */
  generateNow: (asOf, dryRun) =>
    call(config.functions.template, 'generateNow', { asOf, dryRun }),
};

const notifyApi = {
  status: () => call(config.functions.notify, 'status'),
};

module.exports = {
  call,
  handleError,
  showError,
  setClaimHandler,
  memberApi,
  taskApi,
  progressApi,
  aiApi,
  templateApi,
  notifyApi,
};
