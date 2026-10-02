/**
 * shared/notify.js
 * ---------------------------------------------------------------------------
 * 订阅消息统一发送入口 —— 本期只交付骨架（stub），不做真实推送。
 *
 * ⚠ 依赖 wx-server-sdk，只能被云函数引用。
 *
 * 【为什么本期不做】
 *   微信订阅消息的硬性约束使得它不是"顺手加一下"的功能：
 *     1. 必须先在「微信公众平台 → 订阅消息」申请模板并拿到 templateId，
 *        模板字段组合需审核，不是代码能决定的；
 *     2. 属**一次性订阅**：用户每授权一次，服务端只能推一条。要持续提醒
 *        就必须在每次交互里反复引导授权，需要产品层面的入口设计；
 *     3. 用户拒绝授权后无法强推，需要有"未授权"的降级路径。
 *
 * 【本期预留了什么】
 *   所有推送需求都经由 send() 这一个函数出口，未来接入时只需在此实现，
 *   调用方（截止提醒 / 卡壳提醒）无需改动。参数已按真实 API 形状设计。
 * ---------------------------------------------------------------------------
 */

/** 是否启用推送。本期恒为 false；接入时改为读环境变量。 */
const NOTIFY_ENABLED = false;

/**
 * 发送订阅消息。
 *
 * @param {object} opts
 * @param {string[]} opts.to         接收者 openid 列表
 * @param {string}   opts.templateId 订阅消息模板 ID（需先在公众平台申请）
 * @param {object}   opts.data       模板字段，如 { thing1: {value:'...'} }
 * @param {string}   [opts.page]     点击消息跳转的小程序页面
 * @returns {Promise<{skipped:boolean, reason?:string, sent?:number, failed?:number}>}
 */
async function send(opts) {
  if (!NOTIFY_ENABLED) {
    // 本期走这里。打印日志便于验证调用时机是否正确，但不产生任何副作用。
    console.log('[notify] 订阅消息未启用，跳过发送', {
      to: (opts && opts.to) || [],
      templateId: (opts && opts.templateId) || '',
      page: (opts && opts.page) || '',
    });
    return { skipped: true, reason: 'NOTIFY_DISABLED' };
  }

  const cloud = require('wx-server-sdk');
  const openapi = cloud.openapi || (cloud.openapi = require('wx-server-sdk').openapi);
  const to = (opts && opts.to) || [];
  let sent = 0;
  let failed = 0;

  for (const openid of to) {
    try {
      await openapi.subscribeMessage.send({
        touser: openid,
        templateId: opts.templateId,
        data: opts.data,
        page: opts.page,
        miniprogramState: 'formal',
        lang: 'zh_CN',
      });
      sent += 1;
    } catch (e) {
      // 常见失败：用户未授权 / 授权次数已耗尽 / 模板被删。
      // 推送失败绝不应影响主业务，故只记录不抛出。
      failed += 1;
      console.error('[notify] 发送失败', openid, e && e.errCode, e && e.errMsg);
    }
  }

  return { skipped: false, sent, failed };
}

/**
 * 预留：任务截止前提醒。
 * 接入时的调用位置在 generatePeriodicTasks 同级的定时巡检里。
 */
async function sendDueSoon(/* task, openid */) {
  return { skipped: true, reason: 'NOT_IMPLEMENTED' };
}

/**
 * 预留：任务被标记卡壳时通知主办人。
 * 接入时的调用位置在 progressService.addRecord 之后。
 */
async function sendBlockerAlert(/* task, record */) {
  return { skipped: true, reason: 'NOT_IMPLEMENTED' };
}

module.exports = { send, sendDueSoon, sendBlockerAlert, NOTIFY_ENABLED };
