/**
 * miniprogram/app.js
 * ---------------------------------------------------------------------------
 * 小程序入口。负责三件事：
 *   1. 初始化云开发环境
 *   2. 启动时拉取身份（openid + 成员档案），缓存到 globalData
 *   3. 提供全局的"身份就绪"Promise，页面 onLoad 时 await 它即可
 *
 * ★ 身份只在这里获取一次。页面不要各自调 getMe —— 那会在每次切 Tab 时
 *   产生一次云函数调用，白等 300ms。
 * ---------------------------------------------------------------------------
 */

const auth = require('./utils/auth');

/**
 * config.js 里 envId 的初始占位值。
 * 保持与 config.js 中的字符串一致 —— 改了那边记得同步这里。
 * （用常量而不是散落的字面量，是为了让"用户忘了配置"这件事只在一处判定。）
 */
const ENV_ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_ENV_ID';

App({
  globalData: {
    /**
     * 身份就绪 Promise。resolve 为 { openid, needClaim, member }。
     * 页面用 `await getApp().ready` 拿到身份，天然避免"拉取未完成就渲染"。
     */
    ready: null,
    openid: '',
    member: null,
    /** 环境 ID，在 config.js 里配置 */
    envId: '',
    /**
     * 云开发是否已正确配置。
     * 为 false 时页面应展示"环境未配置"的说明，而不是各自的业务错误 ——
     * 否则用户看到的是"网络异常""加载失败"，完全指不到真正的原因。
     */
    cloudReady: false,
  },

  onLaunch() {
    const config = require('./config');

    if (!wx.cloud) {
      wx.showModal({
        title: '版本过低',
        content: '当前微信版本不支持云开发，请升级微信后重试',
        showCancel: false,
      });
      return;
    }

    // ── 前置检查：envId 忘了改就没必要往下走 ────────────────────────────
    // 不改的话，wx.cloud.init 会成功但所有云函数调用都返回
    //   errCode: -601034 没有权限，请先开通云开发或者云托管
    // 这个错误码完全看不出真正原因，用户只会以为是网络问题。
    // 与其让他对着错误码猜，不如在启动时就把话说明白。
    if (!config.envId || config.envId === ENV_ID_PLACEHOLDER) {
      this.globalData.cloudReady = false;
      // ★ 同时告知 auth 模块。不能只靠 globalData —— bootstrap() 在 onLaunch
      //   期间被调用，那时 getApp() 还是 undefined，读不到这里。
      auth.setCloudReady(false);
      wx.showModal({
        title: '云开发环境未配置',
        content:
          '请打开 miniprogram/config.js，把 envId 改成你的云开发环境 ID。\n\n' +
          '获取方式：开发者工具顶部点「云开发」→ 设置 → 环境 ID。\n' +
          '若还没开通，先在「云开发」面板里创建一个环境（有免费额度）。',
        showCancel: false,
        confirmText: '知道了',
      });
      // 不 return：仍然 init 一次，让开发者能在控制台看到真实的请求失败，
      // 便于对照排查。但没有必要去拉身份 —— 那必然失败。
      wx.cloud.init({ env: config.envId, traceUser: true });
      this.globalData.envId = config.envId;
      return;
    }

    wx.cloud.init({
      env: config.envId,
      traceUser: true,
    });
    this.globalData.envId = config.envId;
    this.globalData.cloudReady = true;
    auth.setCloudReady(true);

    // 启动即拉身份。不 await —— 让页面自己决定何时等待，
    // 这样首屏骨架可以先渲染出来，不必卡在转圈上。
    this.globalData.ready = auth.bootstrap();
  },

  /**
   * 全局错误上报口。当前只打日志，未来接监控时改这里。
   */
  onError(err) {
    console.error('[app.onError]', err);
  },

  onUnhandledRejection(res) {
    console.error('[app.onUnhandledRejection]', res && res.reason);
  },
});
