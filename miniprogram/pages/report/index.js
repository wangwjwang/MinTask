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

/**
 * 挑出「久无进展」的任务，给页顶提醒区用。
 *
 * ★ 跨「我主办 / 我协办」两组汇总去重
 *   一条任务可能既是我主办的、又把我列进了协办（两次独立查询没有互斥保证），
 *   同一个道理见 dedupeById。
 * ★ 按天数降序：最久没动的排最前 —— 提醒区的价值就在这一条排序上。
 * ★ 判据全在 format.idleInfo 里（含"排除周期性/已完成"），这里只做装配，
 *   不在这里重写一遍规则。
 */
function pickStale(lists) {
  const seen = {};
  const out = [];
  lists.forEach((list) => {
    list.forEach((t) => {
      if (!t._stale || seen[t._id]) return;
      seen[t._id] = 1;
      out.push(t);
    });
  });
  return out.sort((a, b) => b._idleDays - a._idleDays);
}

/**
 * 提醒区一次最多铺几条，超出的折起来。
 * ★ 判据是**名单条数**（超过就值得折），不是"当前有没有折起来" ——
 *   按后者的话，展开后条数掉回阈值时会剩下一个点了没反应的「收起」死按钮。
 * ★ 与 STALE_DAYS 放在两处是有意的：那个是"多久算忘事"的判断（在
 *   format.idleInfo 里参与计算），这个纯粹是本页的排版决定，服务端和
 *   别的页面都不需要知道。
 */
const STALE_COLLAPSE_AT = 5;

/**
 * 提醒区的展示切片。
 * ★ stale 永远是**完整名单**（判据的产物，测试与调试都按它核对），
 *   这里只决定模板铺几条 —— 折叠不改变数据，展开/收起也不重新拉取。
 */
function collapseStale(list, expanded) {
  const foldable = list.length > STALE_COLLAPSE_AT;
  const shown = foldable && !expanded ? list.slice(0, STALE_COLLAPSE_AT) : list;
  return { shown, foldable, more: list.length - shown.length };
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
    /**
     * 久无进展的提醒清单（跨主办/协办汇总去重，按天数降序），渲染在页顶。
     * ★ 它是**跨组的子集**，不是第四个分组：条数取自 led/joined，
     *   所以刻意不进 stats —— 那三个数字与下方三个分组标题同源，塞进来就破坏了不变式。
     * ★ 空数组时模板整块不渲染，不留空位。
     */
    stale: [],
    /**
     * 提醒区实际铺出来的那几条（折叠后），以及给模板用的两个判断位。
     * 由 collapseStale 一次算出，三者的关系不要在任何别处重写一遍。
     */
    staleShown: [],
    /** 折起来几条（0 = 全铺开了） */
    staleMore: 0,
    /** 名单长到值得折（条数 > STALE_COLLAPSE_AT）→ 模板据此决定要不要给折叠入口 */
    staleFoldable: false,
    /** 用户当前是否展开了。刻意不在 refresh 里重置：这些任务就是要一条条报掉的，
     *  报完一条返回时列表不该自己弹回去。 */
    staleExpanded: false,
    /** 提醒区标题上的天数阈值。WXML 不能调 JS，只能由页面带进去 */
    staleDays: fmt.STALE_DAYS,
    /** 三个分组的折叠状态：主办/协办默认展开，已完成默认收起 */
    showLed: true,
    showJoined: true,
    showDone: false,
    myOpenid: '',
    /** 页内信息块用的当前用户姓名。来自 session.member 的快照，不参与权限判断 */
    myName: '',
    /**
     * 信息块上的三个数字。
     * ★ 刻意与下方三个分组标题上的计数完全同源（led/joined/doneAll 的长度），
     *   这样页顶的数字在屏幕上一眼就能核对，不会出现"顶上写 5、底下写 4"。
     */
    stats: { led: 0, joined: 0, done: 0 },
  },

  onLoad() {
    api.setClaimHandler(() => auth.gotoClaim(true));
  },

  /**
   * 把选中态告诉自定义 tabBar（app.json 里 tabBar.custom = true）。
   * ★ getTabBar() 在极早期可能还没有组件实例，所以要判空 ——
   *   漏了会在启动瞬间抛错，而页面本身是好的，那种错很难查。
   */
  syncTabBar(index) {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && bar.sync) bar.sync(index);
  },

  onShow() {
    /*
     * ★ 管理者（只读角色）没有报任务的权限，直接送去任务看板。
     *   他的 tab 是灰的，点不进来 —— 但冷启动、reLaunch、以及从
     *   认领页回来时都可能落到这一页，所以这道门必须自己守着。
     */
    if (auth.isViewer()) {
      wx.switchTab({ url: '/pages/board/index' });
      return;
    }

    this.syncTabBar(0);

    /*
     * ★ 每次进入本页都让提醒区回到折起状态。
     *   展开是「我现在要顺着这几条报一遍」的**临时**状态，不该跨页面残留 ——
     *   否则切去改任务再切回来，它还占着那一大块，每次都得手工收一下。
     *   注意这也覆盖了「点进上报页再返回」：回来一样是折起的。
     *   下拉刷新（onPullDownRefresh）走的不是这里，展开态会保留 ——
     *   那是同一个页面上的「重新拉一遍」，不是重新进入。
     */
    this.applyStaleExpanded(false);
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

    // 身份到手后再同步一次 tabBar：onShow 那一刻 bootstrap 可能还没回来，
    // 角色读不到就会把两个只读页签画成可点的
    this.syncTabBar(0);

    this.setData({
      myOpenid: session.openid,
      // member 是姓名快照，仅用于展示；权限一律走 openid
      myName: (session.member && session.member.name) || '',
    });

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
      const doneAll = dedupeById(l.done.concat(j.done));

      // 只从**在办**两组里挑：已完成的不该被提醒（_stale 本身也排除了，这里是双保险）
      const stale = pickStale([l.open, j.open]);
      const sv = collapseStale(stale, this.data.staleExpanded);

      this.setData({
        led: l.open,
        ledDone: l.done,
        joined: j.open,
        joinedDone: j.done,
        doneAll,
        stale,
        staleShown: sv.shown,
        staleMore: sv.more,
        staleFoldable: sv.foldable,
        stats: {
          led: l.open.length,
          joined: j.open.length,
          done: doneAll.length,
        },
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

  /**
   * 点提醒区里的一条 → 直接进上报页（提醒的意义就是让你马上把它报掉）。
   * ★ 提醒区的行是普通 view 而不是 task-card 组件，所以任务是从
   *   data-task 里取的；卡片走的是组件的自定义事件（e.detail.task）。
   *   两条路都通到同一个页面，别把这两个事件对象搞混。
   */
  onStaleTap(e) {
    const task = e.currentTarget.dataset.task;
    if (!task || !task._id) return;
    wx.navigateTo({
      url: `/pages/progress-add/index?taskId=${task._id}`,
    });
  },

  /**
   * 改提醒区的展开态（onShow / onToggleStale 都走这里）。
   * ★ 展开态与它的展示切片（staleShown / staleMore）必须**一起**写，
   *   别在任何别处单独改其中一个 —— 分开写会出现"状态是折的、屏幕上还铺着
   *   全部行"或者反过来的中间态。
   */
  applyStaleExpanded(expanded) {
    const sv = collapseStale(this.data.stale, expanded);
    this.setData({
      staleExpanded: expanded,
      staleShown: sv.shown,
      staleMore: sv.more,
      staleFoldable: sv.foldable,
    });
  },

  /**
   * 展开 / 收起提醒区。
   * 只重算展示切片，不重新拉数据 —— 折叠是渲染问题，不是数据问题。
   */
  onToggleStale() {
    this.applyStaleExpanded(!this.data.staleExpanded);
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
