/**
 * cloudfunctions/notifyService/index.js
 * ---------------------------------------------------------------------------
 * 订阅消息服务 —— 本期为**空实现骨架**，不做真实推送。
 *
 * 保留这个云函数的理由：给未来接入留一个稳定的调用出口。届时实现
 * shared/notify.js 里的 send()，本函数与所有调用方都无需改动。
 *
 * 详见 shared/notify.js 顶部注释，其中说明了本期不做的三条硬性原因
 * （模板需审核、一次性订阅每次授权只能推一条、用户可拒绝授权）。
 *
 * action 一览：
 *   send         发送订阅消息（当前返回 skipped）
 *   status       查询当前推送开关状态，便于前端决定是否展示授权入口
 * ---------------------------------------------------------------------------
 */

const { createRouter } = require('./lib/shared/router');
const notify = require('./lib/shared/notify');

/**
 * 发送订阅消息。
 * 当前恒返回 { skipped: true, reason: 'NOTIFY_DISABLED' }，不产生任何副作用。
 */
async function send(payload, ctx) {
  await ctx.requireAdmin();
  return notify.send({
    to: payload.to || [],
    templateId: payload.templateId || '',
    data: payload.data || {},
    page: payload.page || '',
  });
}

/** 查询推送开关状态。前端据此决定是否渲染"订阅提醒"按钮。 */
async function status(payload, ctx) {
  return {
    enabled: notify.NOTIFY_ENABLED,
    // 未启用时前端应完全隐藏相关入口，避免用户点了没反应
    hint: notify.NOTIFY_ENABLED ? '' : '订阅消息功能尚未启用',
  };
}

exports.main = createRouter({ send, status });
