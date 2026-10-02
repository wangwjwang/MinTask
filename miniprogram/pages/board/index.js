/**
 * pages/board —— Tab3「任务看板」
 * ---------------------------------------------------------------------------
 * 任务角度的看板（需求第 5 节 Tab3）：
 *   - 按阶段分列展示（未开始 / 进行中 / 已完成）—— 用 stage 而不是 status，
 *     因为 status 是"健康度"语义（正常/有风险/受阻），不是阶段
 *   - 支持按任务分类（category）筛选视图
 *   - 卡壳任务高亮：直接读 tasks.hasOpenBlocker 冗余字段，
 *     不做"拉任务→拉进展→逐条比对"的关联查询
 *   - 点击卡片下钻到任务详情页
 *
 * ★ 卡壳高亮为什么靠冗余字段：
 *   若前端自己算，需要先拉任务列表、再拉这些任务的全部进展、
 *   再按 taskId 取最新一条 —— 任务一多就是 N+1 查询，
 *   而且第二次查询同样受 20 条分页限制，结果会被静默截断。
 *   hasOpenBlocker 由 progressService 在每次写进展后重算，一次查询搞定。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const C = require('../../shared/constants');

Page({
  data: {
    loading: true,
    /** 按阶段分好的三列：[{ stage, tasks: [] }] */
    columns: [],
    /** 全部任务的原始集合（筛选时从这里过滤，不重新查库） */
    allTasks: [],

    /** 分类筛选，空串表示全部 */
    filterCategory: '',
    categoryOptions: ['全部分类'].concat(C.CATEGORY),
    categoryValues: [''].concat(C.CATEGORY),

    /** 汇总统计 */
    stats: { total: 0, blocked: 0, overdue: 0 },
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
    try {
      await auth.requireClaimed();
    } catch (e) {
      return;
    }

    try {
      if (!this.data.allTasks.length) this.setData({ loading: true });

      const all = fmt.decorateTasks(await db.allTasks());

      this.setData({ allTasks: all, loading: false });
      this.applyFilter();
    } catch (e) {
      console.error('[board] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载看板失败，请下拉重试');
    }
  },

  /** 按分类筛选 + 按阶段分列 + 统计。全在前端做，切换筛选无需再查库。 */
  applyFilter() {
    const { allTasks, filterCategory } = this.data;

    const filtered = filterCategory
      ? allTasks.filter((t) => t.category === filterCategory)
      : allTasks;

    // 按 STAGE_COLUMNS 的顺序分列，保证列顺序与枚举定义一致
    const columns = C.STAGE_COLUMNS.map((stage) => ({
      stage,
      tasks: filtered.filter((t) => t.stage === stage),
    }));

    this.setData({
      columns,
      stats: {
        total: filtered.length,
        blocked: filtered.filter((t) => t._hasBlocker).length,
        overdue: filtered.filter((t) => t._overdue).length,
      },
    });
  },

  onFilterChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ filterCategory: this.data.categoryValues[idx] }, () => this.applyFilter());
  },

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-detail/index?taskId=${task._id}` });
  },

  /** 点统计里的"卡壳"，直接把筛选切到卡壳视图会更好用 —— 这里先做提示 */
  onBlockedTap() {
    if (!this.data.stats.blocked) {
      toast.toast('当前没有卡壳任务');
      return;
    }
    toast.toast(`有 ${this.data.stats.blocked} 项任务存在未解决的卡壳，卡片左侧有红条标记`);
  },
});
