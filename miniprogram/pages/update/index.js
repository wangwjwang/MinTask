/**
 * pages/update —— Tab2「改任务」
 * ---------------------------------------------------------------------------
 * 只列出**当前用户主办**的任务（需求第 5 节：只能改自己主办的任务）。
 *
 * 点击进入改任务编辑页。非主办人理论上不会看到这里的任何任务；
 * 即使有人手动构造 URL 进入编辑页，云函数 taskService.update 也会
 * 以 FORBIDDEN_NOT_LEADER 拒绝 —— 前端过滤只是减少困惑，不是安全边界。
 * ---------------------------------------------------------------------------
 */

const auth = require('../../utils/auth');
const api = require('../../utils/api');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const { STAGE } = require('../../shared/constants');

Page({
  data: {
    loading: true,
    /** 全量我主办的任务（未筛选） */
    tasks: [],
    /** 应用筛选后实际渲染的列表 */
    shownTasks: [],
    /** 当前筛选的阶段，空串表示全部 */
    filterStage: '',
    stageOptions: ['全部'].concat(STAGE),
    stageValues: [''].concat(STAGE),
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

  async refresh() {
    let session;
    try {
      session = await auth.requireClaimed();
    } catch (e) {
      return;
    }

    try {
      if (!this.data.tasks.length) this.setData({ loading: true });

      const led = await db.myLedTasks(session.openid);
      const all = fmt.decorateTasks(led);

      this.setData({ tasks: all, loading: false });
      // this.data 在 setData 后同步生效，这里能安全读到刚写入的 tasks
      this.applyFilter();
    } catch (e) {
      console.error('[update] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载失败，请下拉重试');
    }
  },

  /** 阶段筛选在前端做：任务量在团队规模下很小，没必要为筛选再查一次库 */
  applyFilter() {
    const { tasks, filterStage } = this.data;
    const filtered = filterStage ? tasks.filter((t) => t.stage === filterStage) : tasks;
    this.setData({ shownTasks: filtered });
  },

  onFilterChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ filterStage: this.data.stageValues[idx] }, () => this.applyFilter());
  },

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-edit/index?taskId=${task._id}` });
  },
});
