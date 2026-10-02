/**
 * shared/router.js
 * ---------------------------------------------------------------------------
 * 云函数 action 路由 + 统一响应信封。
 *
 * ⚠ 依赖 wx-server-sdk（经由 ctx.js），只能被云函数引用。
 *
 * 调用约定（前端统一走 miniprogram/utils/api.js）：
 *   wx.cloud.callFunction({
 *     name: 'taskService',
 *     data: { action: 'update', payload: {...}, clientToken: '...' }
 *   })
 *
 * 响应约定：
 *   成功 { ok: true,  data: any }
 *   失败 { ok: false, code: 'FORBIDDEN_NOT_LEADER', message: '仅主办人可执行此操作' }
 *
 * ★ 为什么不把所有 action 塞进一个云函数：
 *   权限域隔离（普通写 / 管理员 / 定时）比省一次冷启动重要得多。
 *   任一 action 崩溃不会波及其他域，日志也更容易定位。
 * ---------------------------------------------------------------------------
 */

const { BizError, Codes, describeInfraError } = require('./errors');
const { buildCtx } = require('./ctx');

/**
 * 创建云函数入口。
 *
 * @param {object} handlers  { [action]: async (payload, ctx) => data }
 * @param {object} [options]
 * @param {string} [options.defaultAction] 未传 action 时的默认值
 * @returns {Function} 可直接赋给 exports.main 的函数
 */
function createRouter(handlers, options = {}) {
  const defaultAction = options.defaultAction || 'default';

  return async function main(event = {}, context) {
    const action = event.action || defaultAction;
    let ctx;

    try {
      ctx = buildCtx(event);
    } catch (e) {
      // 身份解析失败（如非小程序环境调用）。此时没有 ctx，单独处理。
      if (e instanceof BizError) {
        return { ok: false, code: e.code, message: e.message };
      }
      console.error('[router] 构建上下文失败', action, e);
      const infra = describeInfraError(e);
      if (infra) {
        return { ok: false, code: infra.code, message: infra.message };
      }
      return { ok: false, code: Codes.INTERNAL, message: '服务异常，请稍后重试' };
    }

    try {
      const handler = handlers[action];
      if (typeof handler !== 'function') {
        throw new BizError(Codes.UNKNOWN_ACTION, `未知操作：${action}`);
      }
      const data = await handler(event.payload || {}, ctx);
      return { ok: true, data: data === undefined ? null : data };
    } catch (e) {
      if (e instanceof BizError) {
        // 业务异常：信息可安全返回前端
        return { ok: false, code: e.code, message: e.message };
      }

      // 未预期异常：完整堆栈进云函数日志（排查问题的正路）
      console.error(`[router] 未捕获异常 action=${action} openid=${ctx.openid}`, e);

      // 部署期错误（集合没建、依赖没装、函数在另一个环境）单独翻译：
      // 它们不是业务异常，但"服务异常，请稍后重试"对它们毫无指导意义。
      // 判定依据与理由见 errors.js 的 describeInfraError。
      const infra = describeInfraError(e);
      if (infra) {
        return { ok: false, code: infra.code, message: infra.message };
      }

      return { ok: false, code: Codes.INTERNAL, message: '服务异常，请稍后重试' };
    }
  };
}

/**
 * 无需身份校验的 action 包装（理论上用不到，保留给健康检查类接口）。
 * 注意：仍然会解析 openid，只是不强制要求已认领。
 */
function publicAction(fn) {
  return async (payload, ctx) => fn(payload, ctx);
}

module.exports = { createRouter, publicAction };
