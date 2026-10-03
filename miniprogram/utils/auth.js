/**
 * miniprogram/utils/auth.js
 * ---------------------------------------------------------------------------
 * 身份管理。openid 无法在小程序端直接获取，只能通过云函数返回并缓存。
 *
 * 用法：
 *   // 页面 onLoad
 *   const session = await auth.requireClaimed()   // 未认领会自动跳认领页并中断
 *   this.setData({ myOpenid: session.openid })
 * ---------------------------------------------------------------------------
 */

const api = require('./api');
const { ROLE } = require('../shared/constants');

/**
 * 云开发环境是否已就绪，由 app.js 在 onLaunch 里通过 setCloudReady() 设置。
 *
 * ★ 为什么用模块级变量而不是读 getApp().globalData.cloudReady：
 *   bootstrap() 是在 App.onLaunch **执行期间**被同步调用的，
 *   那个时刻 App 实例尚未注册完成，getApp() 会返回 undefined，
 *   读它的任何属性都会抛 "Cannot read property 'globalData' of undefined"。
 *   而本模块的这个变量在 require 时就已存在，与 App 生命周期无关。
 */
let cloudReady = true;

/** 由 app.js 告知云环境是否可用 */
function setCloudReady(flag) {
  cloudReady = !!flag;
}

/**
 * 启动时拉取身份。被 app.js 调用一次。
 * ★ 不抛错 —— 启动阶段的失败不应让小程序白屏，页面会各自兜底。
 */
async function bootstrap() {
  // 环境没配置时，任何云函数调用都必然返回 -601034 而失败。
  // 不去发那个注定失败的请求，直接返回一个标记了原因的会话 ——
  // 原因由 app.onLaunch 的弹窗统一解释，页面只需停在加载态，
  // 不要各自弹出"网络异常"把用户引向排查网络。
  // ★ 判定放在 bootstrap 内而不是各调用点：getSession / refresh 都经过这里。
  if (!cloudReady) {
    return { openid: '', needClaim: true, member: null, envMissing: true };
  }

  try {
    const data = await api.memberApi.getMe();
    // ★ 这里的 getApp() 在 await 之后才执行，此时 onLaunch 早已返回、
    //   App 实例已注册，可以安全访问。
    const app = getApp();
    app.globalData.openid = data.openid;
    app.globalData.member = data.member;
    return data;
  } catch (e) {
    console.error('[auth] 拉取身份失败', e);
    // 返回一个"未认领"的安全默认值，页面会跳到认领页重试
    return { openid: '', needClaim: true, member: null, error: e };
  }
}

/** 取当前会话（等 bootstrap 完成） */
async function getSession() {
  const app = getApp();
  if (!app.globalData.ready) {
    app.globalData.ready = bootstrap();
  }
  const session = await app.globalData.ready;
  return session;
}

/** 强制重新拉取身份（认领成功后调用，刷新缓存） */
async function refresh() {
  const app = getApp();
  app.globalData.ready = bootstrap();
  return app.globalData.ready;
}

/**
 * 要求已认领身份。未认领则跳转认领页并抛出中断信号。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.useReLaunch] 默认 false。Tab 页必须用 reLaunch
 *                                     （redirectTo 不能跳 Tab 页）。
 * @returns {Promise<{openid:string, member:object}>}
 */
async function requireClaimed(opts = {}) {
  const session = await getSession();

  if (!session || !session.member) {
    // 环境未配置时不要跳认领页 —— 认领页自己也要查 members 集合，
    // 跳过去只会让用户看到第二个报错页面，问题反而更难定位。
    if (session && session.envMissing) {
      const err = new Error('云开发环境未配置');
      err.code = 'ENV_MISSING';
      throw err;
    }

    gotoClaim(opts.useReLaunch !== false);
    const err = new Error('NEED_CLAIM');
    err.code = 'NEED_CLAIM';
    throw err;
  }
  return session;
}

/** 跳认领页。用 reLaunch 清空页面栈，避免用户返回到未授权的页面。 */
function gotoClaim(useReLaunch = true) {
  const url = '/pages/claim/index';
  if (useReLaunch) {
    wx.reLaunch({ url });
  } else {
    wx.redirectTo({ url });
  }
}

/** 取当前用户 openid（同步，需已在 globalData 中） */
function currentOpenid() {
  return (getApp().globalData && getApp().globalData.openid) || '';
}

/** 取当前成员档案（同步） */
function currentMember() {
  return (getApp().globalData && getApp().globalData.member) || null;
}

/** 是否管理员 */
function isAdmin() {
  const m = currentMember();
  return !!(m && m.role === '管理员');
}

/**
 * 是否只读角色「管理者」——不参与报任务 / 改任务，只有两个看板的查看权。
 *
 * ★ 和 isAdmin 是两回事，别合并成一个「有没有权限」的布尔量：
 *   管理员什么都能干，管理者什么都不能写。
 * ★ 这里只用来把入口变灰 / 藏掉，**不是安全边界** ——
 *   真正的闸门在云函数 shared/ctx.js 的 requireWriter()。
 */
function isViewer() {
  const m = currentMember();
  return !!(m && m.role === ROLE.VIEWER);
}

module.exports = {
  bootstrap,
  setCloudReady,
  getSession,
  refresh,
  requireClaimed,
  gotoClaim,
  currentOpenid,
  currentMember,
  isAdmin,
  isViewer,
};
