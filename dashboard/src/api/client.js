/**
 * client.js — 数据源抽象（CloudBase Web SDK）
 *
 * 真线路径：Web SDK 匿名登录后，通过 callFunction('dashboardService') 调用
 * 云函数，云函数服务端校验共享访问口令并返回只读聚合数据。
 * 这样前端拿不到任何未经验证的数据，外人无口令即被服务端拦截（EXCEED_AUTHORITY / 401）。
 *
 * 本地预览：在 public/config.js 设置 window.__TP_USE_MOCK__ = true 可强制走内置演示数据。
 */
import tcb from '@cloudbase/js-sdk';
import { buildMock } from './mock';

const ENV_ID = 'cloudbase-d9gl0ogzkfd0d94f2';
let appPromise = null;

function getApp() {
  if (!appPromise) {
    const app = tcb.init({ env: ENV_ID });
    appPromise = app
      .auth({ persistence: 'local' })
      .signInAnonymously()
      .then(() => app)
      .catch((e) => {
        // 匿名登录异常时仍返回 app，交由 callFunction 暴露真实错误
        console.warn('[MinTask] 匿名登录异常：', e && e.message);
        return app;
      });
  }
  return appPromise;
}

export async function loadDashboard(passcode) {
  // 本地预览演示数据
  if (typeof window !== 'undefined' && window.__TP_USE_MOCK__) {
    await new Promise((r) => setTimeout(r, 200));
    return buildMock();
  }

  const app = await getApp();
  const r = await app.callFunction({ name: 'dashboardService', data: { passcode } });
  const res = (r && r.result) || {};

  // 服务端返回的明码错误（含口令错误 / 内部错误）
  if (res.code === 401) throw new Error(res.error || '口令错误');
  if (res.code && res.code !== 0) throw new Error(res.error || '数据加载失败');
  if (!res.data) throw new Error('未返回数据');

  return res.data;
}
