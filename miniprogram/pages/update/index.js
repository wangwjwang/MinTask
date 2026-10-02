/**
 * pages/update —— Tab2「改任务」
 * ---------------------------------------------------------------------------
 * 只列出**当前用户主办**的任务（需求第 5 节：只能改自己主办的任务）。
 *
 * ★ 已完成的任务沉到最下单独成组、默认收起 —— 它们不再需要改动，
 *   混在 due_date 升序里会把在办任务挤下去。
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
    /** 拆分结果：在办 / 已完成。已完成沉到最下单独成组 */
    openTasks: [],
    doneTasks: [],
    /** 应用筛选后实际渲染的在办列表 */
    shownOpen: [],
    /** 底部「已完成」组是否参与渲染 */
    showDoneGroup: false,
    /** 底部「已完成」组是否展开 */
    showDone: false,
    /** 当前筛选的阶段，空串表示全部 */
    filterStage: '',
    stageOptions: ['全部'].concat(STAGE),
    stageValues: [''].concat(STAGE),

    /** 页内信息块用的当前用户姓名。姓名是快照，不参与权限判断 */
    myName: '',
    /**
     * 信息块数字。
     * ★ 只数「在办」：已完成的任务不再需要改动，把逾期算进去会虚增待办量，
     *   让页顶的数字吓人却没意义。（format.dueInfo 对已完成本就强制 overdue=false，
     *   这里再限定一遍是双保险 —— 不依赖下游实现细节。）
     */
    stats: { open: 0, overdue: 0 },
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

      const openTasks = all.filter((t) => t.stage !== '已完成');

      this.setData({
        tasks: all,
        openTasks,
        doneTasks: all.filter((t) => t.stage === '已完成'),
        myName: (session.member && session.member.name) || '',
        stats: {
          open: openTasks.length,
          overdue: openTasks.filter((t) => t._overdue).length,
        },
        loading: false,
      });
      // this.data 在 setData 后同步生效，这里能安全读到刚写入的字段
      this.applyFilter();
    } catch (e) {
      console.error('[update] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载失败，请下拉重试');
    }
  },

  /**
   * 阶段筛选在前端做：任务量在团队规模下很小，没必要为筛选再查一次库。
   *
   * ★ 筛选只作用于「在办」列表，底部已完成组单独判断：
   *   - 选「全部」    → 在办全列 + 底部已完成组（收起）
   *   - 选在办某阶段  → 只列该阶段，底部已完成组**不显示**（筛选已限定阶段，再显示矛盾）
   *   - 选「已完成」  → 在办列表空，只剩下方的已完成组（onFilterChange 会顺带展开它）
   */
  applyFilter() {
    const { openTasks, filterStage } = this.data;

    const shownOpen = filterStage
      ? openTasks.filter((t) => t.stage === filterStage)
      : openTasks;

    this.setData({
      shownOpen,
      showDoneGroup: filterStage === '' || filterStage === '已完成',
    });
  },

  onFilterChange(e) {
    const idx = Number(e.detail.value);
    const filterStage = this.data.stageValues[idx];

    const patch = { filterStage };
    // 选「已完成」时自动展开 —— 否则列表一片空白，看起来像坏了
    if (filterStage === '已完成') patch.showDone = true;

    this.setData(patch, () => this.applyFilter());
  },

  onToggleDone() {
    this.setData({ showDone: !this.data.showDone });
  },

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-edit/index?taskId=${task._id}` });
  },
});
