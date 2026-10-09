/**
 * pages/board —— Tab3「任务看板」
 * ---------------------------------------------------------------------------
 * 任务角度的看板（需求第 5 节 Tab3）：
 *   - 按分段切换（周期性 / 进行中 / 已完成）—— 后两段用 stage 而不是 status，
 *     因为 status 是"健康度"语义（正常/有风险/受阻），不是阶段
 *   - 分段内按任务分类（category）分组，组标题吸顶并带条数
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
 *   现在一次只渲染一个分段，页面只剩一层纵向滚动。
 *   代价是看不到"三列并排的全貌"，用分段上的计数补回来 ——
 *   一眼仍能看出每个分段各有多少任务。
 *
 * ★ v2.1：「未开始」段换成非阶段段（2026-10-03 与用户确认）。未开始是新建任务
 *   与周期生成器的默认阶段（taskRepo 的 `stage: fields.stage || '未开始'`），
 *   实际数据里没有存在感。代价：未开始且非周期性的任务（刚用报任务建出来、
 *   还没人动过阶段的）不再有任何分段收它，入口退回「报任务」页的提醒区。
 *
 * ★ v2.3（2026-10-03，用户原话「任务看板当中，最左侧原来的周期性这一栏，
 *   取消吧。改成周期性计划，列出之前所有人创建的周期性计划，而不是列计划
 *   产生的任务，这里只能计划，不能修改」）：
 *     v2.1 那一栏列的是**计划生成出来的任务**（按 task_type='周期性' 筛），
 *     这一版改成列**计划本身**（periodic_templates），全体成员的，只读。
 *   ★ 数据来源变了：计划不在 tasks 集合里，也不是阶段，所以这一段的计数与
 *     内容都来自 data.plans（templateService.listAll），而不是任务列表。
 *     连带修正了 v2.1 的一个别扭处 —— 那一栏和阶段段的计数会重复计同一批
 *     任务（周期任务同时属于两边，三段计数之和大于「共 N 项」）；
 *     现在各段的计数互斥，只有未开始的任务不在任何段内。
 *   ★ listAll 对管理者（只读）也开：任务看板正是他能看的两块看板之一，
 *     这一段对他空着是不对的。计划里没有任务里没有的东西。
 *
 * ★ v2.4（2026-10-03，用户原话「改成"能点进去看、只是不给改"」）：
 *     v2.3 把这一段做成了完全点不动。用户要的是**点得进去看**。
 *   点一行 → pages/plan-edit，那一页按 canManageTemplate 自己决定渲染
 *   表单还是只读摘要 —— "给不给改"的判据只在那一个地方，看板不复制一份。
 *   ★ 看板这一层不写任何修改入口：这里只跳转，写操作全在 plan-edit 里，
 *     而它进不去的写操作会被云函数 assertCanManage 再挡一道。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const swipe = require('../../utils/swipe');
const theme = require('../../utils/theme');
const toast = require('../../utils/toast');

/** 本页在 custom-tab-bar 的 TABS 里的路径（见 custom-tab-bar/index.js） */
const TAB_PATH = '/pages/board/index';
const C = require('../../shared/constants');

/** 默认落在哪个分段。进行中是「现在在发生什么」，最常看 */
const DEFAULT_SEG = '进行中';

/**
 * 计划分段 —— **不是阶段**，列的是计划本身（periodic_templates），不是任务。
 * ★ 它顶替了「未开始」段，也接过 v2.1「周期性」段的位置。
 * ★ 名字里的「计划」不能省：段上写「周期性」会被读成"周期性任务"，
 *   而这个段列的东西根本不是任务 —— 用户点进去找不到一条任务时会以为坏了。
 */
const PLAN_SEG = '周期性计划';

/**
 * 分段列表，顺序即渲染顺序。
 * ★ 不再等于 C.STAGE_COLUMNS：未开始被计划段顶替。STAGE 里将来若多出枚举值，
 *   会自动出现在分段里；但「未开始」是被明确去掉的，需要时得手工加回来。
 */
const SEGMENTS = [PLAN_SEG].concat(C.STAGE.filter((s) => s !== '未开始'));

/**
 * 该**任务**是否属于某个分段。
 * ★ 计划段恒为 false —— 那一段装的是计划，任务一条都不进。
 *   它的计数与内容在 viewFor 里另算（来自 plans 入参）。
 *   让它返回 false 而不是在外面到处绕开，是为了「任务属于哪一段」这个问题
 *   只有一个出口，将来再加分段时不会漏掉某一处判断。
 */
function inSegment(task, seg) {
  return seg === PLAN_SEG ? false : task.stage === seg;
}

/**
 * 计划排序：同一主办人的排在一起，组内保持服务端给的顺序（新建的在前）。
 *
 * ★ 用 localeCompare 而不是 `<`：中文按拼音排，「李」「张」这样按姓氏归堆，
 *   比按 Unicode 码位排对人友好。
 * ★ Array.prototype.sort 自 ES2019 起保证稳定，小程序两端（iOS 的 JSC /
 *   Android 的 V8）都符合，所以组内那层不需要再加排序键。
 * ★ 排序纯粹是展示，不参与任何判定 —— 排错了最多是找起来费点劲，
 *   不会有计划因此生成或不生成。
 */
function byOwner(a, b) {
  return String(a.ownerName || '').localeCompare(String(b.ownerName || ''), 'zh');
}

/**
 * 算出「页面该长什么样」：分段计数、当前分段的内容、空态文案、统计。
 *
 * ★ 纯函数：不碰 setData，也不读 this.data（全靠入参）。调用方必须把它的
 *   结果与触发它的那批状态**同一次 setData** 写下去 —— 见 Page.paint。
 * ★ 为什么不是「先 setData 状态、再在回调里重算列表」：那会留下一帧错配，
 *   见 paint 的注释（2026-10-03 实测的那个「看板错乱」）。
 */
function viewFor(allTasks, allPlans, segmentTab, collapsedMap) {
  // ★ 这里原来有一层分类筛选（hitCat）：2026-10-03 用户拍板删掉了那个控件。
  //   看板本来就是按分类分组、组标题吸顶还带条数，筛选只是多造一个
  //   看不见的页面状态。删掉之后 allTasks / allPlans 就是渲染用的全部。
  const plans = allPlans;

  const isPlanSeg = segmentTab === PLAN_SEG;

  // 分段上的计数，顺序跟 SEGMENTS 走。★ 计划段的数来自计划条数，不是任务条数
  const tabs = SEGMENTS.map((seg) => ({
    seg,
    count: seg === PLAN_SEG ? plans.length : allTasks.filter((t) => inSegment(t, seg)).length,
  }));

  let rows = [];
  let groups = [];

  if (isPlanSeg) {
    // ── 计划段：平铺全体成员的计划，同一主办人的排在一起 ──────────────
    rows = plans.slice().sort(byOwner);
  } else {
    // ── 阶段段：按分类分组 ──────────────────────────────────────────
    const inSeg = allTasks.filter((t) => inSegment(t, segmentTab));

    // 分组顺序跟 C.CATEGORY 的枚举顺序走（而不是按任务数量排序），
    // 这样同一条任务每次渲染都落在同一位置，不会切个分段就跳位置。
    // 空分类不产生分组。
    const cats = C.CATEGORY.filter((c) => inSeg.some((t) => t.category === c));
    // ★ 兜底：万一库里有分类不在枚举内（有人直接在控制台改库就可能出现），
    //   追加到末尾，绝不能让它从看板上悄悄消失。
    inSeg.forEach((t) => {
      if (cats.indexOf(t.category) === -1) cats.push(t.category);
    });

    groups = cats.map((category) => {
      const key = segmentTab + '|' + category;
      return {
        key,
        category,
        /** 分类色由 JS 查表给出 —— WXML 不能调函数，只能内联 style */
        color: theme.categoryColor(category),
        tasks: inSeg.filter((t) => t.category === category),
        // 用户没手动动过的分组用默认值：已完成默认收起，其余默认展开
        collapsed: key in collapsedMap ? collapsedMap[key] : segmentTab === '已完成',
      };
    });
  }

  /*
   * 空态文案在 JS 里定，不在 WXML 里写三元。
   * ★ 计划段的空态说「这一段下没有任务」是错的 —— 它本来就没有任务，
   *   用户会一直等任务出现。两段的空态说的不是一回事，塞进模板属性里
   *   没法读也没法测。
   */
  const empty = isPlanSeg
    ? {
      title: '还没有人建过计划',
      hint: '到「报任务」页把任务性质选成「周期性」，就能建一份会自动生成任务的计划',
    }
    : { title: '这一段下没有任务', hint: '上方可以切换分段' };

  return {
    tabs,
    plans: rows,
    groups,
    empty,
    stats: {
      total: allTasks.length,
      blocked: allTasks.filter((t) => t._hasBlocker).length,
      overdue: allTasks.filter((t) => t._overdue).length,
    },
  };
}

Page({
  data: {
    loading: true,
    /** 当前查看的分段 */
    segmentTab: DEFAULT_SEG,
    /**
     * 分段切换上的计数：[{ seg, count }]，顺序跟随 SEGMENTS。
     * 各段的数字由 viewFor 一次算好，与列表同一次 setData 写下去。
     * ★ 计划段那一格数的是**计划**，其余数的是任务。两者互不重复，
     *   加起来约等于顶部「共 N 项」加计划数（未开始的任务不在任何段内）。
     */
    tabs: [],
    /**
     * 当前分段内的分类分组：
     *   [{ key, category, color, collapsed, tasks: [] }]
     * ★ 只有阶段段用它；计划段是平铺的，走 data.plans。
     */
    groups: [],
    /**
     * 计划段的平铺计划（已按主办人排序，装饰过）。
     * ★ 单独一个字段而不是塞进 groups 里只放一组，是因为「不分组」和
     *   「分了一组」在 WXML 里要渲染成两种结构 —— 前者没有吸顶标题、
     *   没有计数、不能折叠。用同一个字段装两种语义，模板里就得靠
     *   条件去猜它到底是哪种。
     * ★ 与 data.allPlans 分开：allPlans 是原始集合（切分段时从这里重建），
     *   plans 是这一帧要渲染的那批。
     */
    plans: [],
    /**
     * 空态文案，由 viewFor 按当前分段算出：
     * 计划段的「还没有人建过计划」和阶段段的「这一段下没有任务」不是一回事。
     */
    empty: { title: '', hint: '' },
    /**
     * ★ 折叠状态独立于 groups 存放，key 是 `分段|分类`。
     *   若把 collapsed 只挂在 groups 上，每次切换分段重建 groups 时
     *   用户的展开状态就会被重置 —— 切一下回来全塌了。
     *   同时也让折叠状态在分段之间各自独立保留。
     */
    collapsedMap: {},
    /** 全部任务的原始集合。切分段/折叠都从它重建，不重新查库 */
    allTasks: [],
    /** 全部计划（全体成员的），同上 */
    allPlans: [],

    /** 汇总统计 */
    stats: { total: 0, blocked: 0, overdue: 0 },
  },

  onLoad() {
    api.setClaimHandler(() => auth.gotoClaim(true));
    /** 首次拿到数据时挑一个合适的默认分段，见 pickInitialSegment */
    this.segmentInitialized = false;
  },

  /** 把选中态告诉自定义 tabBar（传路径，不传下标 —— 见 custom-tab-bar/index.js 的 sync） */
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

    try {
      if (!this.data.allTasks.length) this.setData({ loading: true });

      /*
       * 任务与计划一起取，任何一边失败都走下面的统一报错。
       * ★ 不做"任务拿到就算成功、计划失败留空"的部分成功：计划段空着会被
       *   读成"没人建过计划"，而它其实只是没拉到 —— 用假前提指路，
       *   和「列表页加载失败不能装作没有计划」是同一个道理。
       */
      const [rawTasks, rawPlans] = await Promise.all([
        db.allTasks(),
        api.templateApi.listAll().then((r) => r.list || []),
      ]);

      const all = fmt.decorateTasks(rawTasks);
      // 「今天」由 format 自己取（dates.todayStr），与计划列表页同一条路径
      const plans = fmt.decoratePlans(rawPlans);

      const patch = { allTasks: all, allPlans: plans, loading: false };
      // ★ 只在首次落数据时挑默认分段。之后用户手动切过哪个分段就停在哪个，
      //   不能每次下拉刷新都把他弹回"进行中"。
      if (!this.segmentInitialized) {
        this.segmentInitialized = true;
        patch.segmentTab = pickInitialSegment(all, plans);
      }
      this.paint(patch);
    } catch (e) {
      console.error('[board] 拉取失败', e);
      this.setData({ loading: false });
      toast.error('加载看板失败，请下拉重试');
    }
  },

  /**
   * 一次 setData 把「状态」和「由状态算出的视图」一起写下去。
   * 切换分段 / 折叠，以及拉完数据，全都走这里 —— 全页只此一处写列表。
   *
   * ★ 为什么不能分两次写（先 setData 状态、再在回调里重算列表）：
   *   两次之间会留下一帧「标签已是新分段、列表还是上一段的」错配。
   *   2026-10-03 实测反馈的就是这一帧：切到「周期性」时，WXML 的
   *   wx:if="{{segmentTab === '周期性' && flat.length}}" 因为 flat 还是空的
   *   而落到了 wx:elif 上，于是「周期性」标签底下渲染出**上一段的分类分组**
   *   （用户看到的「系统研发、系统运维」）；若上一段是「已完成」（分组默认
   *   收起），屏幕上只剩分类标题、没有卡片，点标题只会折叠/展开 ——
   *   用户的原话是「看板整体错乱、点也点不开」。
   * ★ 这一帧不止一帧长：setData 的回调要等渲染完成才触发，中间隔着一次
   *   逻辑层↔渲染层的往返，列表长的时候肉眼可见，还来得及去点一下。
   * ★ 反过来，一次写下去就永远是自洽的 —— 这是这个方法的全部意义。
   */
  paint(patch, cb) {
    const s = Object.assign({}, this.data, patch);
    this.setData(
      Object.assign(
        {},
        patch,
        viewFor(s.allTasks, s.allPlans, s.segmentTab, s.collapsedMap)
      ),
      cb
    );
  },

  /**
   * 切到某个分段。**点分段与横滑两条路都走这里** ——
   * 切换要做的事（重建列表、滚动归位）只有一个出口，不会出现"点能滚到顶、
   * 滑不滚"这种两套逻辑各差一点的情况。
   * 参数为假值、或已经在这个分段上时直接返回（免得白重建一次、白滚一次）。
   */
  goSegment(seg) {
    if (!seg || seg === this.data.segmentTab) return;
    this.paint({ segmentTab: seg }, () => {
      // ★ 切段后回到页面顶部：各分段长短不一，停在上一段的滚动位置会
      //   一眼看到空白或者半截列表，像是没切成功。
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  },

  /** 点分段标签切换 */
  onSegmentTap(e) {
    // 注意：dataset 的键名会被小程序转成小写，这里只传中文值（分段名），不受影响
    this.goSegment(e.currentTarget.dataset.segment);
  },

  /** 横滑：记住起点。绑在页面根节点上，页面内任何位置起手都算 */
  onTouchStart(e) {
    const t = e.touches && e.touches[0];
    // 实例属性，不进 data —— 它不参与渲染，每帧写进 data 是白费 setData
    this.swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    this.swipeAxis = '';   // 这次手势的方向还没定
  },

  /**
   * 横滑：定下这次手势的方向（横向 = 想切段，纵向 = 想滚页面）。
   * ★ 只认**首动方向**，定下就锁定，后面再偏也不改判：
   *   终点坐标分不清「斜着横滑」和「斜着往下滚」—— 起手那一下才说得清。
   *   2026-10-03 实测：想往下翻页，却被切到了相邻分段。
   * ★ 只读坐标、不 setData，所以触摸期间触发得再频繁也没有渲染开销。
   */
  onTouchMove(e) {
    if (!this.swipeStart || this.swipeAxis) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    this.swipeAxis = swipe.axisOf(this.swipeStart, { x: t.clientX, y: t.clientY });
  },

  /** 手势被系统打断（来电、侧滑返回…）→ 忘掉它，别让后面那次抬手误判 */
  onTouchCancel() {
    this.swipeStart = null;
    this.swipeAxis = '';
  },

  /** 横滑：判断这一次滑动是不是"切到相邻分段" */
  onTouchEnd(e) {
    const start = this.swipeStart;
    const axis = this.swipeAxis;
    this.swipeStart = null;
    this.swipeAxis = '';
    if (!start) return;
    // 起手是纵向、或全程没怎么动（原地点击）→ 这次是滚页面/点击，不切段
    if (axis !== 'x') return;
    // ★ touchend 时手指已经抬起，e.touches 是空的 —— 必须用 changedTouches，
    //   写 e.touches[0] 在这里取到的是 undefined。
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const step = swipe.swipeStep(start, { x: t.clientX, y: t.clientY });
    if (!step) return;
    this.goSegment(swipe.stepIn(SEGMENTS, this.data.segmentTab, step));
  },

  /**
   * 展开 / 收起当前分段里的某个分类。
   * 只翻转 collapsedMap，再由 paint 重建 groups —— 单一数据源，
   * 避免 groups 和折叠状态两处各存一份而走岔。
   * ★ 只有阶段段有分组，计划段走不到这里。
   */
  onToggleGroup(e) {
    const category = e.currentTarget.dataset.category;
    if (!category) return;

    const key = this.data.segmentTab + '|' + category;
    const map = Object.assign({}, this.data.collapsedMap);
    const cur = key in map ? map[key] : this.data.segmentTab === '已完成';
    map[key] = !cur;

    this.paint({ collapsedMap: map });
  },

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-detail/index?taskId=${task._id}` });
  },

  /**
   * 点一行计划 → 去看那一份。
   *
   * ★ 跳的是 plan-edit，而那一页自己判 canEdit：
   *   自己建的计划（或管理员）落进表单，别人的落进只读摘要。
   *   看板不重复这套判断 —— 权限判据只有 shared/perm 一处，
   *   在这里再写一遍就是给"两处不一致"留口子。
   * ★ data-id 取的是 dataset（不是 task-card 的 e.detail）：计划行是普通
   *   view，没有组件事件。
   */
  onPlanTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/plan-edit/index?id=${id}` });
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
 * 挑首次进入时落在哪个分段。
 * 优先「进行中」；它空了就落到第一个有内容的分段 —— 计划段也算有内容。
 * 不这么做的话，团队某段时间没有进行中的任务时，一进看板就是一片空白。
 */
function pickInitialSegment(tasks, plans) {
  const countOf = (seg) => (seg === PLAN_SEG ? plans.length : tasks.filter((t) => inSegment(t, seg)).length);
  if (countOf(DEFAULT_SEG) > 0) return DEFAULT_SEG;
  const firstWithContent = SEGMENTS.find((s) => countOf(s) > 0);
  return firstWithContent || DEFAULT_SEG;
}
