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
    /**
     * 按阶段分好的三列，列内再按分类分组：
     *   [{ stage, total, groups: [{ key, category, collapsed, tasks: [] }] }]
     */
    columns: [],
    /**
     * ★ 折叠状态独立于 columns 存放，key 是 `阶段|分类`。
     *   若把 collapsed 只挂在 columns 上，每次筛选/刷新重建 columns 时
     *   用户的展开状态就会被重置 —— 切一下筛选回来全塌了。
     */
    collapsedMap: {},
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

  /** 按分类筛选 + 按阶段分列 + 列内按分类分组 + 统计。全在前端做，切换筛选无需再查库。 */
  applyFilter() {
    const { allTasks, filterCategory, collapsedMap } = this.data;

    const filtered = filterCategory
      ? allTasks.filter((t) => t.category === filterCategory)
      : allTasks;

    // 按 STAGE_COLUMNS 的顺序分列，保证列顺序与枚举定义一致
    const columns = C.STAGE_COLUMNS.map((stage) => {
      const inStage = filtered.filter((t) => t.stage === stage);

      // 分组顺序跟 C.CATEGORY 的枚举顺序走（而不是按任务数量排序），
      // 这样同一条任务每次渲染都落在同一位置，不会切个筛选就跳位置。
      // 空分类不产生分组。
      const cats = C.CATEGORY.filter((c) => inStage.some((t) => t.category === c));
      // ★ 兜底：万一库里有分类不在枚举内（有人直接在控制台改库就可能出现），
      //   追加到末尾，绝不能让它从看板上悄悄消失。
      inStage.forEach((t) => {
        if (cats.indexOf(t.category) === -1) cats.push(t.category);
      });

      const groups = cats.map((category) => {
        const key = stage + '|' + category;
        return {
          key,
          category,
          tasks: inStage.filter((t) => t.category === category),
          // 用户没手动动过的分组用默认值：已完成列默认收起，其余默认展开
          collapsed: key in collapsedMap ? collapsedMap[key] : stage === '已完成',
        };
      });

      return { stage, total: inStage.length, groups };
    });

    this.setData({
      columns,
      stats: {
        total: filtered.length,
        blocked: filtered.filter((t) => t._hasBlocker).length,
        overdue: filtered.filter((t) => t._overdue).length,
      },
    });
  },

  /**
   * 展开 / 收起某一列里的某个分类。
   * 只翻转 collapsedMap，再重跑 applyFilter 重建 columns —— 单一数据源，
   * 避免 columns 和折叠状态两处各存一份而走岔。
   */
  onToggleGroup(e) {
    // 注意：dataset 的键名会被小程序转成小写，这里只传中文值（阶段/分类名），不受影响
    const stage = e.currentTarget.dataset.stage;
    const category = e.currentTarget.dataset.category;
    if (!stage || !category) return;

    const key = stage + '|' + category;
    const map = Object.assign({}, this.data.collapsedMap);
    const cur = key in map ? map[key] : stage === '已完成';
    map[key] = !cur;

    this.setData({ collapsedMap: map }, () => this.applyFilter());
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
