/**
 * pages/demands —— Tab「领需求」
 * ---------------------------------------------------------------------------
 * 需求角度的列表。四个分段，各自问一个问题：
 *   待认领  谁该把这件事接过去（点卡片 = 直接去建任务，那就是"领走"）
 *   我领的  我手上还有哪些从池子里接过来的事
 *   我提的  我提的那些后来怎么样了
 *   已关闭  决定不做的事，留个记录
 *
 * ★ 一条需求可能同时出现在两个分段里（我提的、又是我领的），**这是对的**：
 *   两个分段问的是两个不同问题，不去重。
 *
 * ★ 「领走」不是一个按钮，而是"就这条需求建一个任务"这个动作本身。
 *   多一个"领走"按钮再接一层建任务表单，等于同一个意图点两次。
 *
 * ★ 管理者（只读）在这里能看、能新建，但**领不走** —— 领走 = 建任务，
 *   而 taskService.create 的第一步仍是 requireWriter()。所以对他把
 *   「待认领」的点击换成一个说明，而不是让他跳过去被云函数拒。
 *
 * ★ 视图计算与 setData 分离（viewFor 纯函数 + paint 单次写）：
 *   理由与 pages/board 完全一致，见那里的长篇注释（2026-10-03 那一帧错配）。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const swipe = require('../../utils/swipe');
const toast = require('../../utils/toast');

/** 本页在 custom-tab-bar 的 TABS 里的路径（不再传下标，见 custom-tab-bar/index.js） */
const TAB_PATH = '/pages/demands/index';

/** 默认落在哪个分段。「等着认领」是这个页面存在的理由 */
const DEFAULT_SEG = '待认领';

/** 分段列表，顺序即渲染顺序 */
const SEGMENTS = ['待认领', '我领的', '我提的', '已关闭'];

/**
 * 该需求是否属于某个分段。
 * ★ 四个分段各是一条独立判据（不是一个枚举字段的四个取值）——
 *   「我领的」与「我提的」可能同时为真，所以这里不能用 switch 式的互斥判断。
 */
function inSegment(d, seg, openid) {
  if (seg === '待认领') return d.status === '待认领';
  if (seg === '已关闭') return d.status === '已关闭';
  if (!openid) return false;
  if (seg === '我领的') return d.claimedById === openid;
  if (seg === '我提的') return d.proposerId === openid;
  return false;
}

/**
 * 算出「页面该长什么样」：分段计数、当前分段的内容、空态文案、信息块数字。
 *
 * ★ 纯函数：不碰 setData，也不读 this.data（全靠入参）。调用方必须把它的
 *   结果与触发它的那批状态**同一次 setData** 写下去 —— 见 Page.paint。
 */
function viewFor(allDemands, segmentTab, openid) {
  const tabs = SEGMENTS.map((seg) => ({
    seg,
    count: allDemands.filter((d) => inSegment(d, seg, openid)).length,
  }));

  // 排序沿用服务端给的 createdAt 倒序（listAllDemands 里排好的），
  // 不在前端重排：四个分段用同一个顺序，切来切去不会跳位置。
  const rows = allDemands.filter((d) => inSegment(d, segmentTab, openid));

  const EMPTY = {
    待认领: { title: '池子里没有等着认领的需求', hint: '点下面的「新建需求」把想法记下来' },
    我领的: { title: '你还没有从池子里领过需求', hint: '到「待认领」挑一条，点开就能建任务' },
    我提的: { title: '你还没有提过需求', hint: '点下面的「新建需求」把想法记下来' },
    已关闭: { title: '没有已关闭的需求', hint: '关闭表示「这件事先不做了」，随时可以重新打开' },
  };

  return {
    tabs,
    rows,
    empty: EMPTY[segmentTab] || { title: '这一段下没有需求', hint: '上方可以切换分段' },
    stats: {
      total: allDemands.length,
      pending: allDemands.filter((d) => d.status === '待认领').length,
      mine: allDemands.filter((d) => inSegment(d, '我领的', openid)).length,
      proposed: allDemands.filter((d) => inSegment(d, '我提的', openid)).length,
    },
  };
}

/**
 * 挑首次进入时落在哪个分段。
 * 优先「待认领」（这个页面存在的理由）；它空了就落到第一个有内容的分段。
 * 不这么做的话，池子清空的那段时间一进来就是一片空白。
 */
function pickInitialSegment(demands, openid) {
  const countOf = (seg) => demands.filter((d) => inSegment(d, seg, openid)).length;
  if (countOf(DEFAULT_SEG) > 0) return DEFAULT_SEG;
  const first = SEGMENTS.find((s) => countOf(s) > 0);
  return first || DEFAULT_SEG;
}

Page({
  data: {
    loading: true,
    /** 当前分段 */
    segmentTab: DEFAULT_SEG,
    /** 分段上的计数：[{seg, count}]，顺序跟随 SEGMENTS */
    tabs: [],
    /** 当前分段要渲染的需求 */
    rows: [],
    /** 空态文案，由 viewFor 按当前分段算好 */
    empty: { title: '', hint: '' },
    /** 汇总数字，信息块用 */
    stats: { total: 0, pending: 0, mine: 0, proposed: 0 },
    /** 全部需求的原始集合，切分段从它重建，不重新查库 */
    allDemands: [],
  },

  onLoad() {
    api.setClaimHandler(() => auth.gotoClaim(true));
    this.segmentInitialized = false;
  },

  /** 把选中态告诉自定义 tabBar。★ 传的是路径，不是下标 —— 页签顺序变了也不会错 */
  syncTabBar() {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && bar.sync) bar.sync(TAB_PATH);
  },

  onShow() {
    this.syncTabBar();
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

    // 身份到手后再同步一次：onShow 那刻 bootstrap 可能还没回来
    this.syncTabBar();
    const openid = auth.currentOpenid();

    try {
      if (!this.data.allDemands.length) this.setData({ loading: true });

      const res = await api.demandApi.list();
      const all = fmt.decorateDemands(res.list || []);

      const patch = { allDemands: all, loading: false };
      // ★ 只在首次落数据时挑默认分段：之后用户手动切过哪个就停在哪个，
      //   不能每次下拉刷新都把他弹回去
      if (!this.segmentInitialized) {
        this.segmentInitialized = true;
        patch.segmentTab = pickInitialSegment(all, openid);
      }
      this.paint(patch);
    } catch (e) {
      console.error('[demands] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载需求池失败，请下拉重试');
    }
  },

  /**
   * 一次 setData 把「状态」和「由状态算出的视图」一起写下去。
   * ★ 为什么不能分两次写：两次之间会留下一帧「标签已是新分段、列表还是上一段」
   *   的错配 —— 2026-10-03 任务看板上实测过这个 bug，用户的原话是
   *   「看板整体错乱、点也点不开」。一次写下去就永远是自洽的。
   */
  paint(patch, cb) {
    const s = Object.assign({}, this.data, patch);
    this.setData(
      Object.assign({}, patch, viewFor(s.allDemands, s.segmentTab, auth.currentOpenid())),
      cb
    );
  },

  /** 切分段。点标签与横滑两条路都走这里，只有一个出口 */
  goSegment(seg) {
    if (!seg || seg === this.data.segmentTab) return;
    this.paint({ segmentTab: seg }, () => {
      // 各分段长短不一，停在上一段的滚动位置会一眼看到空白或半截列表
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  },

  onSegmentTap(e) {
    this.goSegment(e.currentTarget.dataset.segment);
  },

  // ── 横滑（与 pages/board 同一套，判据在 utils/swipe.js）────────────

  onTouchStart(e) {
    const t = e.touches && e.touches[0];
    this.swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    this.swipeAxis = '';
  },

  onTouchMove(e) {
    if (!this.swipeStart || this.swipeAxis) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    // ★ 只认**首动方向**，定下就锁定：终点坐标分不清"斜着横滑"和"斜着往下滚"
    this.swipeAxis = swipe.axisOf(this.swipeStart, { x: t.clientX, y: t.clientY });
  },

  onTouchCancel() {
    this.swipeStart = null;
    this.swipeAxis = '';
  },

  onTouchEnd(e) {
    const start = this.swipeStart;
    const axis = this.swipeAxis;
    this.swipeStart = null;
    this.swipeAxis = '';
    if (!start || axis !== 'x') return;
    // ★ touchend 时手指已经抬起，e.touches 是空的 —— 必须用 changedTouches
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const step = swipe.swipeStep(start, { x: t.clientX, y: t.clientY });
    if (!step) return;
    this.goSegment(swipe.stepIn(SEGMENTS, this.data.segmentTab, step));
  },

  // ── 点击 ────────────────────────────────────────────────────────────

  /**
   * 点一张需求卡。
   * ★ 「待认领」段点开的是**建任务页**（那一步就是领走）；
   *   其余三段点开的是需求详情（看改一体，由那一页自己判 canEdit）。
   * ★ 管理者在「待认领」段点不动：领走 = 建任务，而那条路对他关着。
   *   前端拦住只是体验，云函数那边由 taskService.create 的 requireWriter 兜住。
   */
  onCardTap(e) {
    const d = e.currentTarget.dataset.demand;
    if (!d || !d._id) return;

    if (this.data.segmentTab === '待认领') {
      if (auth.isViewer()) {
        toast.toast('管理者账号只有查看权限，领需求请联系同事');
        return;
      }
      wx.navigateTo({ url: `/pages/task-create/index?demandId=${d._id}` });
      return;
    }
    wx.navigateTo({ url: `/pages/demand-edit/index?id=${d._id}` });
  },

  /** 新建需求。不带 id 进 demand-edit，那一页落在"新建"态 */
  onNewTap() {
    wx.navigateTo({ url: '/pages/demand-edit/index' });
  },
});
