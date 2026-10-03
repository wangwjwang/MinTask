/**
 * pages/person-detail —— 某人名下的任务（子页面）
 * ---------------------------------------------------------------------------
 * 从 Tab4 人员看板点进来，展示该成员「主办」「协办」两组任务，
 * 外加「近两周」——TA 最近在哪些任务上报了哪些进展（按本周/上周分组）。
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
const TABS = ['led', 'joined', 'activity'];

/** 近两周的分组标签，顺序即渲染顺序（本周在前） */
const WEEK_LABELS = ['本周', '上周'];

/**
 * 每组先露几条，超过就折起来。
 * ★ 折起是默认状态、每次进页面都重来（见 buildActivityGroups）——不记用户
 *   上次展开过哪些，那样"这次到底展没展"会变得不可预期。
 * ★ 5 是 2026-10-03 与用户定下的值（先试过 1，确认交互后再定回 5）。
 */
const WEEK_SHOW_MAX = 5;

/**
 * 给定分栏与两组数据，算出该铺哪一份到屏幕上。
 * ★ 纯函数，refresh 与 goTab 共用 —— 两处各写一遍迟早会走岔。
 * ★ 它和分栏状态必须**同一次 setData** 写下去（见 goTab）：分两次写会留下
 *   一帧「协办高亮 + 主办列表」，那一帧里的卡片点了没反应。看板那边的
 *   同一个毛病有详细注释（board/index.js 的 paint）。
 */
/**
 * 把本人的进展按周分组，算好每组的「铺哪几条、能不能折、折不折」。
 *
 * ★ 两组永远都在（本周、上周都要摆出来）：某一周没记录本身就是信息
 *   ——「上周没动静」和「上周那一组不见了」是两回事，后者会让人以为
 *   界面漏了。空组用 empty 标出来，WXML 铺一句「这一周没有进展」。
 * ★ 只有两周都空（一条记录都没有）时返回空数组，整段走空态。
 * ★ 纯函数，refresh 与展开/收起共用。
 */
function buildActivityGroups(mine) {
  if (!mine.length) return [];
  return WEEK_LABELS.map((label) => {
    const items = mine.filter((a) => a.week === label);
    const canCollapse = items.length > WEEK_SHOW_MAX;
    return {
      label,
      items,
      empty: !items.length,
      canCollapse,
      // 默认折起 —— 每次 refresh 都重新走这里，所以"每次进来都是折起的"
      collapsed: canCollapse,
      hiddenCount: canCollapse ? items.length - WEEK_SHOW_MAX : 0,
      shownItems: canCollapse ? items.slice(0, WEEK_SHOW_MAX) : items,
    };
  });
}

function tabView(tab, d) {
  // 「近两周」铺的是时间线（activityGroups），不是 主办/协办 的任务列表。
  // 两个数组清空 —— 否则切过去那一帧会把上一栏的卡片带过去（同一次 setData
  // 写下去所以看不到，但留着就是给以后埋雷）。
  if (tab === 'activity') return { shownOpen: [], shownDone: [] };
  return {
    shownOpen: tab === 'led' ? d.led : d.joined,
    shownDone: tab === 'led' ? d.ledDone : d.joinedDone,
  };
}

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

    /** 近两周动态：按周分组的时间线 */
    activityGroups: [],
    activityCount: 0,

    /** 分栏切换：'led' | 'joined' | 'activity' */
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

      // 三个查询并发：他主办/协办的、以及近两周的全部进展记录
      // （进展一次拉全量再在前端筛出本人的，理由见 db.progressSince）
      const win = fmt.twoWeekWindow();
      const [{ led, joined }, recent] = await Promise.all([
        db.tasksOfMember(openid),
        db.progressSince(win.since),
      ]);

      const split = (list) => {
        const all = fmt.decorateTasks(list);
        return {
          open: all.filter((t) => t.stage !== '已完成'),
          done: all.filter((t) => t.stage === '已完成'),
        };
      };

      const l = split(led);
      const j = split(joined);

      // ── 近两周动态 ──────────────────────────────────────────────────
      // 关系标注按 openid 归属算（姓名只是快照，见文件头），用主办/协办
      // 两份任务的 id 建映射，而不是按姓名匹配
      const relationOf = {};
      led.forEach((t) => { relationOf[t._id] = '主办'; });
      joined.forEach((t) => { relationOf[t._id] = '协办'; });

      const mine = recent
        .filter((r) => r.updaterId === openid)
        .map((r) => ({
          _id: r._id,
          taskId: r.taskId,
          taskName: r.task_name || '',
          relation: relationOf[r.taskId] || '',
          // 老记录可能没有 description，统一成字符串免得 WXML 里判空写法不一
          desc: String(r.description || '').trim(),
          whenText: fmt.weekdayTime(r.updatedAt),
          // 边界含等号：正好卡在周一 00:00 的记录算「本周」
          week: new Date(r.updatedAt) >= win.thisMonday ? '本周' : '上周',
        }));

      const activityGroups = buildActivityGroups(mine);

      // 数据与屏幕内容一次写完：分两次写会留下一帧「数据已换、屏幕还是旧的」
      const next = {
        led: l.open,
        ledDone: l.done,
        joined: j.open,
        joinedDone: j.done,
        activityGroups,
        activityCount: mine.length,
        loading: false,
      };
      this.setData(Object.assign({}, next, tabView(this.data.tab, next)));
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        console.error('[person-detail] 加载失败', e);
        this.setData({ loading: false });
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  /**
   * 切到某一栏。**点分栏与横滑两条路都走这里**（同看板的 goSegment）。
   * 假值、或已经在这一栏上时直接返回。
   * ★ 分栏状态与列表内容必须同一次 setData 写下去 —— 分两次写会在中间
   *   留下一帧「协办已高亮、列表还是主办」，那一帧里的卡片点了没反应。
   */
  goTab(tab) {
    if (!tab || tab === this.data.tab) return;
    this.setData(Object.assign({ tab }, tabView(tab, this.data)), () => {
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
    this.swipeAxis = '';
  },

  /** 横滑：定下方向。只认首动方向，理由同看板（board/index.js 的 onTouchMove） */
  onTouchMove(e) {
    if (!this.swipeStart || this.swipeAxis) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    this.swipeAxis = swipe.axisOf(this.swipeStart, { x: t.clientX, y: t.clientY });
  },

  /** 手势被系统打断 → 忘掉它 */
  onTouchCancel() {
    this.swipeStart = null;
    this.swipeAxis = '';
  },

  /** 横滑：判断这一次滑动是不是"切到相邻分栏" */
  onTouchEnd(e) {
    const start = this.swipeStart;
    const axis = this.swipeAxis;
    this.swipeStart = null;
    this.swipeAxis = '';
    if (!start) return;
    if (axis !== 'x') return;   // 起手是纵向/原地点击 → 这次是滚页面，不切栏
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

  /** 展开 / 收起某一周的动态（超过 WEEK_SHOW_MAX 条时才有这一行） */
  onActivityToggle(e) {
    const label = e.currentTarget.dataset.label;
    const activityGroups = this.data.activityGroups.map((g) => {
      if (g.label !== label || !g.canCollapse) return g;
      const collapsed = !g.collapsed;
      return Object.assign({}, g, {
        collapsed,
        shownItems: collapsed ? g.items.slice(0, WEEK_SHOW_MAX) : g.items,
      });
    });
    this.setData({ activityGroups });
  },

  /** 点近两周的条目 → 到对应任务详情看全貌 */
  onActivityTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/task-detail/index?taskId=${id}` });
  },
});
