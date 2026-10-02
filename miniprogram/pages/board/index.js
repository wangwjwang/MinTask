/**
 * pages/board —— Tab3「任务看板」
 * ---------------------------------------------------------------------------
 * 任务角度的看板（需求第 5 节 Tab3）：
 *   - 按阶段切换（未开始 / 进行中 / 已完成）—— 用 stage 而不是 status，
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
 *
 * ★ v2 重构：三列横向滚动 → 阶段分段切换 + 单一纵向列表。
 *   原来是「外层 scroll-x 包三个 72vw 的列，每列内部再 scroll-y」的嵌套滚动，
 *   在手机上是个已知难用的结构（横竖两个滚动方向互相抢手势）。
 *   现在一次只渲染一个阶段，页面只剩一层纵向滚动。
 *   代价是看不到"三列并排的全貌"，用分段上的计数补回来 ——
 *   一眼仍能看出每个阶段各有多少任务。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const theme = require('../../utils/theme');
const toast = require('../../utils/toast');
const C = require('../../shared/constants');

/** 默认落在哪个阶段。进行中是「现在在发生什么」，最常看 */
const DEFAULT_STAGE = '进行中';

Page({
  data: {
    loading: true,
    /** 当前查看的阶段 */
    stageTab: DEFAULT_STAGE,
    /**
     * 分段切换上的计数：[{ stage, count }]，顺序跟随 C.STAGE_COLUMNS。
     * 计数受分类筛选影响 —— 切了分类，各阶段的数字要跟着变。
     */
    tabs: [],
    /**
     * 当前阶段内的分类分组：
     *   [{ key, category, color, collapsed, tasks: [] }]
     */
    groups: [],
    /**
     * ★ 折叠状态独立于 groups 存放，key 是 `阶段|分类`。
     *   若把 collapsed 只挂在 groups 上，每次切换阶段/筛选重建 groups 时
     *   用户的展开状态就会被重置 —— 切一下回来全塌了。
     *   同时也让折叠状态在阶段之间各自独立保留。
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
    /** 首次拿到数据时挑一个合适的默认阶段，见 pickInitialStage */
    this.stageInitialized = false;
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

      // ★ 只在首次落数据时挑默认阶段。之后用户手动切过哪个阶段就停在哪个，
      //   不能每次下拉刷新都把他弹回"进行中"。
      if (!this.stageInitialized) {
        this.stageInitialized = true;
        this.setData({ stageTab: pickInitialStage(all) });
      }

      this.setData({ allTasks: all, loading: false });
      this.applyFilter();
    } catch (e) {
      console.error('[board] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载看板失败，请下拉重试');
    }
  },

  /**
   * 按分类筛选 + 算各阶段计数 + 给当前阶段分组建表 + 统计。
   * 全在前端做，切换筛选/阶段都无需再查库。
   */
  applyFilter() {
    const { allTasks, filterCategory, collapsedMap, stageTab } = this.data;

    const filtered = filterCategory
      ? allTasks.filter((t) => t.category === filterCategory)
      : allTasks;

    // 分段上的计数，顺序跟 C.STAGE_COLUMNS 的枚举定义走
    const tabs = C.STAGE_COLUMNS.map((stage) => ({
      stage,
      count: filtered.filter((t) => t.stage === stage).length,
    }));

    const inStage = filtered.filter((t) => t.stage === stageTab);

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
      const key = stageTab + '|' + category;
      return {
        key,
        category,
        /** 分类色由 JS 查表给出 —— WXML 不能调函数，只能内联 style */
        color: theme.categoryColor(category),
        tasks: inStage.filter((t) => t.category === category),
        // 用户没手动动过的分组用默认值：已完成默认收起，其余默认展开
        collapsed: key in collapsedMap ? collapsedMap[key] : stageTab === '已完成',
      };
    });

    this.setData({
      tabs,
      groups,
      stats: {
        total: filtered.length,
        blocked: filtered.filter((t) => t._hasBlocker).length,
        overdue: filtered.filter((t) => t._overdue).length,
      },
    });
  },

  /** 切换阶段 */
  onStageTap(e) {
    // 注意：dataset 的键名会被小程序转成小写，这里只传中文值（阶段名），不受影响
    const stage = e.currentTarget.dataset.stage;
    if (!stage || stage === this.data.stageTab) return;
    this.setData({ stageTab: stage }, () => this.applyFilter());
  },

  /**
   * 展开 / 收起当前阶段里的某个分类。
   * 只翻转 collapsedMap，再重跑 applyFilter 重建 groups —— 单一数据源，
   * 避免 groups 和折叠状态两处各存一份而走岔。
   */
  onToggleGroup(e) {
    const category = e.currentTarget.dataset.category;
    if (!category) return;

    const key = this.data.stageTab + '|' + category;
    const map = Object.assign({}, this.data.collapsedMap);
    const cur = key in map ? map[key] : this.data.stageTab === '已完成';
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

  /** 点统计里的"卡壳"，提示卡壳任务在卡片上的标记方式 */
  onBlockedTap() {
    if (!this.data.stats.blocked) {
      toast.toast('当前没有卡壳任务');
      return;
    }
    toast.toast(`有 ${this.data.stats.blocked} 项任务存在未解决的卡壳，卡片左侧有红条标记`);
  },
});

/**
 * 挑首次进入时落在哪个阶段。
 * 优先「进行中」；它空了就落到第一个有任务的阶段。
 * 不这么做的话，团队某段时间没有进行中的任务时，一进看板就是一片空白。
 */
function pickInitialStage(tasks) {
  const countOf = (stage) => tasks.filter((t) => t.stage === stage).length;
  if (countOf(DEFAULT_STAGE) > 0) return DEFAULT_STAGE;
  const firstWithTasks = C.STAGE_COLUMNS.find((s) => countOf(s) > 0);
  return firstWithTasks || DEFAULT_STAGE;
}
