/**
 * pages/report —— Tab1「报任务」
 * ---------------------------------------------------------------------------
 * 自上而下四个区块（对应需求第 5 节 Tab1）：
 *   1. 我主办的任务      → 点击进语音上报页（主办视角，可改进度/状态）
 *   2. 我参与的协办任务  → 点击进语音上报页（协办视角，只能写进展+卡壳）
 *   3. 新加入协办入口    → 进加入协办页
 *   4. 新建任务（底部固定）→ 进新建任务页
 *
 * ★ 数据在 onShow 里拉取，而不是 onLoad。
 *   从语音上报页返回时 onLoad 不会重新触发，只有 onShow 会。
 *   用 onLoad 会导致"提交成功返回后列表还是旧的"。
 * ---------------------------------------------------------------------------
 */

const db = require('../../utils/db');
const fmt = require('../../utils/format');
const auth = require('../../utils/auth');
const api = require('../../utils/api');
const toast = require('../../utils/toast');

Page({
  data: {
    loading: true,
    /** 我主办的任务 */
    ledTasks: [],
    /** 我协办的任务 */
    joinedTasks: [],
    myOpenid: '',
  },

  onLoad() {
    api.setClaimHandler(() => auth.gotoClaim(true));
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  /** 拉取两个列表。api.js 的权限错误刷新也会调它。 */
  async refresh() {
    // 未认领用户会被 requireClaimed 拦截并跳转，这里直接中断
    let session;
    try {
      session = await auth.requireClaimed();
    } catch (e) {
      return;
    }

    this.setData({ myOpenid: session.openid });

    try {
      if (!this.data.ledTasks.length && !this.data.joinedTasks.length) {
        this.setData({ loading: true });
      }

      // 两个列表并发拉取，省一半等待时间
      const [led, joined] = await Promise.all([
        db.myLedTasks(session.openid),
        db.myJoinedTasks(session.openid),
      ]);

      this.setData({
        ledTasks: fmt.decorateTasks(led),
        joinedTasks: fmt.decorateTasks(joined),
        loading: false,
      });
    } catch (e) {
      console.error('[report] 拉取任务失败', e);
      this.setData({ loading: false });
      toast.error('加载任务失败，请下拉重试');
    }
  },

  /** 点击任务卡片 → 上报进展页 */
  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({
      url: `/pages/progress-add/index?taskId=${task._id}`,
    });
  },

  /** 进入「加入协办」页 */
  onJoinTap() {
    wx.navigateTo({ url: '/pages/join/index' });
  },

  /** 进入「新建任务」页 */
  onCreateTap() {
    wx.navigateTo({ url: '/pages/task-create/index' });
  },
});
