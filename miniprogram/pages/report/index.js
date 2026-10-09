/**
 * pages/report —— Tab1「报任务」
 * ---------------------------------------------------------------------------
 * 自上而下五个区块（对应需求第 5 节 Tab1）：
 *   1. 我主办的任务      → 点击进语音上报页（主办视角，可改进度/状态）
 *   2. 我参与的协办任务  → 点击进语音上报页（协办视角，只能写进展+卡壳）
 *   3. 已完成            → 上述两组里已完成的合并去重，默认收起
 *   4. 新建任务入口      → 进新建页（手工任务 / 周期性计划）
 *   5. 新加入协办入口    → 进加入协办页
 *   ★ 4 和 5 是页面最下方的两张同形入口卡。4 原来是固定在底部的按钮栏，
 *     2026-10-03 用户拍板改成入口行（理由见 index.wxml 区块 4 的注释）。
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

/** 本页在 custom-tab-bar 的 TABS 里的路径（见 custom-tab-bar/index.js） */
const TAB_PATH = '/pages/report/index';

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
 * 挑出「系统按计划生成、还没人碰过」的任务，给页顶的自动生成提醒区用。
 *
 * ★ 「碰过没有」一律看 task.latestProgressAt，不拿 progress/stage/status 三个字段猜。
 *   progressService.add 每写一条进展记录都会重算 latestProgressAt（见
 *   shared/taskRepo.recomputeTaskBlockers），而 progress/stage/status 只有
 *   主办人能改 —— 协办人报了进展，那三个字段一个都不会变。靠它们判断的话，
 *   协办报过进展的任务会一直挂在提醒区里，点进去才发现早就有人跟进了。
 *
 * ★ 另外三个字段是补 latestProgressAt 覆盖不到的路径：主办人直接改任务
 *   （改状态/阶段/进度）而不写进展记录，此时 latestProgressAt 仍是空。
 *
 * ★ 判据是 origin === 'periodic'，不是 task_type === '周期性'。
 *   后者是「这个任务按周期重复」的标注，手工建的任务也能填；前者才是
 *   「这是系统代我生成的」。混在一起会把主办人自己建的任务也提醒一遍。
 *
 * ★ 只从「我主办」里挑：生成出来的任务落在计划主办人头上，而这个提醒
 *   就是给他看的（"系统替我排了一件事，该动了"）。协办人是被拉来帮忙的，
 *   他的入口是「我协办」那组列表。
 *
 * ★ 不做时间上限。判据就是用户定的那条：「动过就消失」—— 加一条"过期就
 *   不提醒"会让任务在没人动的情况下自己溜走，与这条矛盾。逾期本身在卡片上
 *   有红标，看板也能看到。
 */
function pickFresh(lists) {
  const seen = {};
  const out = [];
  lists.forEach((list) => {
    (list || []).forEach((t) => {
      if (!t || t.origin !== 'periodic' || seen[t._id]) return;
      if (t.latestProgressAt) return;
      if (t.progress > 0) return;
      if (t.stage !== '未开始') return;
      if (t.status !== '正常') return;
      if (t.hasOpenBlocker) return;
      seen[t._id] = 1;
      out.push(t);
    });
  });
  // 先到期的排前面：提醒区的价值就在"下一个该交的是哪件"
  return out.sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));
}

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
     * 系统按计划自动生成、还没人碰过的任务（按截止日升序），渲染在**页顶最上面**。
     * ★ 与 stale 同样是跨组子集，同样不进 stats（那三个数字与下方分组标题同源）。
     * ★ 不做折叠：它在结构上就很短 —— 一个计划一期最多产生一条，而只要有人
     *   碰一下（哪怕只是写句进展）就消失。真长起来说明确实堆了事，那时候
     *   更需要全铺出来看。
     */
    fresh: [],
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
   * ★ 传的是本页**路径**，不是下标 —— tabBar 按路径找选中项，
   *   以后在头部插一格也不会让哪个页签亮错（见 custom-tab-bar/index.js 的 sync）。
   * ★ getTabBar() 在极早期可能还没有组件实例，所以要判空 ——
   *   漏了会在启动瞬间抛错，而页面本身是好的，那种错很难查。
   */
  syncTabBar() {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && bar.sync) bar.sync(TAB_PATH);
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

    this.syncTabBar();

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
    this.syncTabBar();

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

      // 自动生成的提醒只看我主办的在办任务（理由见 pickFresh）
      const fresh = pickFresh([l.open]);

      this.setData({
        led: l.open,
        ledDone: l.done,
        joined: j.open,
        joinedDone: j.done,
        doneAll,
        fresh,
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
   * 点自动生成提醒里的一条 → 进上报页。
   * 与 onStaleTap 一样，任务从 data-task 里取（提醒区的行不是 task-card 组件）。
   */
  onFreshTap(e) {
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
