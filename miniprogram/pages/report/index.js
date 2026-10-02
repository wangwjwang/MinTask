/**
 * pages/report —— Tab1「报任务」
 * ---------------------------------------------------------------------------
 * 自上而下四个区块（对应需求第 5 节 Tab1）：
 *   1. 我主办的任务      → 点击进语音上报页（主办视角，可改进度/状态）
 *   2. 我参与的协办任务  → 点击进语音上报页（协办视角，只能写进展+卡壳）
 *   3. 已完成            → 上述两组里已完成的合并去重，默认收起
 *   4. 新加入协办入口    → 进加入协办页
 *   （新建任务按钮固定在页面底部）
 *
 * ★ 已完成为什么要单独成组：
 *   已完成的任务不需要再报进度，留在"我主办/我协办"里只会把在办任务挤下去。
 *   前两组只放 stage !== '已完成'，已完成统一沉到底部折叠起来。
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

/**
 * 按阶段把任务拆成「在办 / 已完成」两组。
 * 已完成的任务不需要再报进度，混在列表里只会干扰。
 */
function splitByStage(list) {
  const all = fmt.decorateTasks(list);
  return {
    open: all.filter((t) => t.stage !== '已完成'),
    done: all.filter((t) => t.stage === '已完成'),
  };
}

/**
 * 按 _id 去重。
 * ★ 一个任务可能既是我主办的、又把我列进了协办 —— myLedTasks / myJoinedTasks
 *   是两次互不相干的查询，没有互斥保证。合并两组已完成时必须去重，
 *   否则同一条任务会在「已完成」里出现两次。
 */
function dedupeById(list) {
  const seen = {};
  return list.filter((t) => {
    if (seen[t._id]) return false;
    seen[t._id] = 1;
    return true;
  });
}

Page({
  data: {
    loading: true,
    /**
     * 我主办 / 我协办的在办任务（stage !== 已完成）。
     * 命名沿用 person-detail 的 led / ledDone 约定，两个页面结构一致好对照。
     */
    led: [],
    joined: [],
    /** 我主办 / 我协办里已完成的（各自保留，用于算下面的 doneAll） */
    ledDone: [],
    joinedDone: [],
    /** 两组已完成合并去重后的列表，单独成组渲染在最下 */
    doneAll: [],
    /** 三个分组的折叠状态：主办/协办默认展开，已完成默认收起 */
    showLed: true,
    showJoined: true,
    showDone: false,
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
      if (!this.data.led.length && !this.data.joined.length && !this.data.doneAll.length) {
        this.setData({ loading: true });
      }

      // 两个列表并发拉取，省一半等待时间
      const [led, joined] = await Promise.all([
        db.myLedTasks(session.openid),
        db.myJoinedTasks(session.openid),
      ]);

      const l = splitByStage(led);
      const j = splitByStage(joined);

      this.setData({
        led: l.open,
        ledDone: l.done,
        joined: j.open,
        joinedDone: j.done,
        doneAll: dedupeById(l.done.concat(j.done)),
        loading: false,
      });
    } catch (e) {
      console.error('[report] 拉取任务失败', e);
      this.setData({ loading: false });
      toast.error('加载任务失败，请下拉重试');
    }
  },

  onToggleLed() {
    this.setData({ showLed: !this.data.showLed });
  },

  onToggleJoined() {
    this.setData({ showJoined: !this.data.showJoined });
  },

  onToggleDone() {
    this.setData({ showDone: !this.data.showDone });
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
