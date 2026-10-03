/**
 * pages/update —— Tab2「改任务」
 * ---------------------------------------------------------------------------
 * 只列出**当前用户主办**的任务（需求第 5 节：只能改自己主办的任务）。
 *
 * ★ 已完成的任务沉到最下单独成组、默认收起 —— 它们不再需要改动，
 *   混在 due_date 升序里会把在办任务挤下去。
 *
 * ★ 这一页原来还有个「全部/未开始/进行中/已完成」的阶段筛选（2026-10-03
 *   用户拍板删除）：这是"我一个人主办的任务"，本来就不长，在办全列出来、
 *   已完成沉在底部单独一组，三个选项没有一个是在看新东西
 *   （选全部＝已经看到的，选已完成＝跟底部那组重复，选阶段＝把一份十来条
 *   的列表切两半），反倒要维护一个看不见的页面状态。
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

Page({
  data: {
    loading: true,
    /** 全量我主办的任务 */
    tasks: [],
    /** 拆分结果：在办 / 已完成。已完成沉到最下单独成组 */
    openTasks: [],
    doneTasks: [],
    /** 底部「已完成」组是否展开 */
    showDone: false,

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

  /** 把选中态告诉自定义 tabBar（见 report/index.js 的同名方法） */
  syncTabBar(index) {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && bar.sync) bar.sync(index);
  },

  onShow() {
    // 管理者（只读角色）不参与改任务，送去任务看板（同 report/index.js）
    if (auth.isViewer()) {
      wx.switchTab({ url: '/pages/board/index' });
      return;
    }

    this.syncTabBar(1);
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

    // 身份到手后再同步一次：onShow 那刻 bootstrap 可能还没回来
    this.syncTabBar(1);

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
    } catch (e) {
      console.error('[update] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载失败，请下拉重试');
    }
  },

  onToggleDone() {
    this.setData({ showDone: !this.data.showDone });
  },

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-edit/index?taskId=${task._id}` });
  },

  /**
   * 管理我的计划入口。和「退出协办」并列放在本页底部：
   * 计划是"任务的来源"，对它做的增删改同样是管理动作，不该散到别处。
   */
  onPlansTap() {
    wx.navigateTo({ url: '/pages/plans/index' });
  },

  /**
   * 退出协办入口。放在本页而不是任务看板：
   * 退出协办本质是"改任务"，与删任务同属对任务的操作，归到这里。
   */
  onLeaveTap() {
    wx.navigateTo({ url: '/pages/leave/index' });
  },
});
