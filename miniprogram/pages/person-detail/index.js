/**
 * pages/person-detail —— 某人名下的任务（子页面）
 * ---------------------------------------------------------------------------
 * 从 Tab4 人员看板点进来，展示该成员「主办」与「协办」两组任务。
 *
 * ★ 入参是 openid 而不是姓名：
 *   姓名只是展示快照，可能重名、可能改名。任务归属一律按 leaderId /
 *   collaboratorIds 匹配 —— 否则两个"张伟"的任务会被混在一起展示。
 *   姓名只用来做标题显示。
 *
 * ★ 读走直连数据库（与全站读操作一致），无需云函数。
 * ---------------------------------------------------------------------------
 */

const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const swipe = require('../../utils/swipe');
const toast = require('../../utils/toast');
const { COLLECTIONS } = require('../../shared/constants');

/**
 * 分栏顺序表，顺序即渲染顺序，也是横滑的行走顺序。
 * ★ 单独列出来而不是在 goTab 里写死 if：横滑要按它算"相邻是哪一栏"，
 *   两个地方各写一份迟早会走岔。
 */
const TABS = ['led', 'joined'];

Page({
  data: {
    openid: '',
    name: '',
    loading: true,

    /** 主办任务：进行中 / 已完成 分开 */
    led: [],
    ledDone: [],
    /** 协办任务 */
    joined: [],
    joinedDone: [],

    /** 分栏切换：'led' | 'joined' */
    tab: 'led',
    showDone: false,

    /**
     * 当前分栏要显示的数组。
     * ★ WXML 无法用变量下标取 data 里的数组（{{this[tab]}} 不成立），
     *   所以在 JS 里把「当前分栏 + 是否展开已完成」的结果预先算好，
     *   每次切换只改这几个数组，WXML 保持无逻辑。
     */
    shownOpen: [],
    shownDone: [],
  },

  onLoad(query) {
    const openid = query.openid || '';
    const name = decodeURIComponent(query.name || '');
    this.setData({ openid, name });

    if (name) wx.setNavigationBarTitle({ title: name });

    if (!openid) {
      toast.error('缺少成员标识');
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }
    this.refresh();
  },

  onShow() {
    if (this.data.openid && !this.data.loading) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      await auth.requireClaimed();

      const { openid } = this.data;
      const { led, joined } = await db.tasksOfMember(openid);

      const split = (list) => {
        const all = fmt.decorateTasks(list);
        return {
          open: all.filter((t) => t.stage !== '已完成'),
          done: all.filter((t) => t.stage === '已完成'),
        };
      };

      const l = split(led);
      const j = split(joined);

      this.setData(
        {
          led: l.open,
          ledDone: l.done,
          joined: j.open,
          joinedDone: j.done,
          loading: false,
        },
        () => this.applyTab()
      );
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        console.error('[person-detail] 加载失败', e);
        this.setData({ loading: false });
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  /** 把「当前分栏」的结果铺到 shownOpen / shownDone，WXML 直接渲染 */
  applyTab() {
    const { tab } = this.data;
    const open = tab === 'led' ? this.data.led : this.data.joined;
    const done = tab === 'led' ? this.data.ledDone : this.data.joinedDone;
    this.setData({ shownOpen: open, shownDone: done });
  },

  /**
   * 切到某一栏。**点分栏与横滑两条路都走这里**（同看板的 goSegment）。
   * 假值、或已经在这一栏上时直接返回。
   */
  goTab(tab) {
    if (!tab || tab === this.data.tab) return;
    this.setData({ tab }, () => {
      this.applyTab();
      // 切栏后回到页面顶部：两栏长短不一，停在上一栏的滚动位置会像没切成功
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  },

  onTabChange(e) {
    this.goTab(e.currentTarget.dataset.tab);
  },

  /** 横滑：记住起点。绑在页面根节点上 */
  onTouchStart(e) {
    const t = e.touches && e.touches[0];
    // 实例属性，不进 data —— 它不参与渲染
    this.swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
  },

  /** 横滑：判断这一次滑动是不是"切到相邻分栏" */
  onTouchEnd(e) {
    const start = this.swipeStart;
    this.swipeStart = null;
    if (!start) return;
    // ★ touchend 时手指已经抬起，e.touches 是空的 —— 必须用 changedTouches
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const step = swipe.swipeStep(start, { x: t.clientX, y: t.clientY });
    if (!step) return;
    this.goTab(swipe.stepIn(TABS, this.data.tab, step));
  },

  onToggleDone() {
    this.setData({ showDone: !this.data.showDone });
  },

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-detail/index?taskId=${task._id}` });
  },
});
