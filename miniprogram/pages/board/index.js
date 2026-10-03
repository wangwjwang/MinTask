/**
 * pages/board —— Tab3「任务看板」
 * ---------------------------------------------------------------------------
 * 任务角度的看板（需求第 5 节 Tab3）：
 *   - 按分段切换（周期性 / 进行中 / 已完成）—— 后两段用 stage 而不是 status，
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
 *   现在一次只渲染一个分段，页面只剩一层纵向滚动。
 *   代价是看不到"三列并排的全貌"，用分段上的计数补回来 ——
 *   一眼仍能看出每个分段各有多少任务。
 *
 * ★ v2.1：「未开始」段换成「周期性」段（2026-10-03 与用户确认）。
 *   理由：未开始是新建任务与周期生成器的默认阶段（taskRepo 的
 *   `stage: fields.stage || '未开始'`），实际数据里没有存在感；而周期任务
 *   更需要按周期排开来看。周期段按 task_type 归类、平铺、按周期排序。
 *   ★ 由此产生两处**已确认的取舍**，不是 bug：
 *     1. 分段不再互斥。周期任务同时有自己的阶段，会既出现在「周期性」段、
 *        也出现在它所属的阶段段里。所以三段计数之和会大于顶部「共 N 项」。
 *     2. 未开始且非周期性的任务（刚用报任务建出来、还没人动过阶段的）
 *        不再有任何分段收它，只能从改任务页进。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const swipe = require('../../utils/swipe');
const theme = require('../../utils/theme');
const toast = require('../../utils/toast');
const C = require('../../shared/constants');

/** 默认落在哪个分段。进行中是「现在在发生什么」，最常看 */
const DEFAULT_SEG = '进行中';

/**
 * 周期性分段 —— **不是阶段**，按 task_type 归类。它顶替了「未开始」段。
 * ★ 判据取 task_type 而不是 recur_freq（2026-10-03 与用户确认）：
 *   「任务性质＝周期性」是业务上的归类，而 recur_freq 只是它的一个属性。
 *   代价是会出现「性质是周期性、但没填周期频率」的任务，它们排在最后。
 */
const PERIODIC_SEG = '周期性';

/**
 * 分段列表，顺序即渲染顺序。
 * ★ 不再等于 C.STAGE_COLUMNS：未开始被周期性顶替。STAGE 里将来若多出枚举值，
 *   会自动出现在分段里；但「未开始」是被明确去掉的，需要时得手工加回来。
 */
const SEGMENTS = [PERIODIC_SEG].concat(C.STAGE.filter((s) => s !== '未开始'));

/** 该任务是否属于某个分段。两种分段两种算法，只此一处 */
function inSegment(task, seg) {
  return seg === PERIODIC_SEG ? task.task_type === '周期性' : task.stage === seg;
}

/**
 * 周期排序名次：直接取 C.RECUR_FREQ 的数组下标（每周→每月→每季→每年→不适用）。
 * ★ 不在枚举里的值（有人在控制台直接改库就会出现，比如"每两周"）排到最后，
 *   但**不能让它从看板上消失** —— 同 viewFor 里的分类兜底，一个道理。
 */
function recurRank(task) {
  const i = C.RECUR_FREQ.indexOf(task.recur_freq);
  return i === -1 ? C.RECUR_FREQ.length : i;
}

/**
 * 算出「页面该长什么样」：分段计数、当前分段的内容、统计。
 *
 * ★ 纯函数：不碰 setData，也不读 this.data（全靠入参）。调用方必须把它的
 *   结果与触发它的那批状态**同一次 setData** 写下去 —— 见 Page.paint。
 * ★ 为什么不是「先 setData 状态、再在回调里重算列表」：那会留下一帧错配，
 *   见 paint 的注释（2026-10-03 实测的那个「看板错乱」）。
 */
function viewFor(allTasks, segmentTab, filterCategory, collapsedMap) {
  const filtered = filterCategory
    ? allTasks.filter((t) => t.category === filterCategory)
    : allTasks;

  // 分段上的计数，顺序跟 SEGMENTS 走
  const tabs = SEGMENTS.map((seg) => ({
    seg,
    count: filtered.filter((t) => inSegment(t, seg)).length,
  }));

  const inSeg = filtered.filter((t) => inSegment(t, segmentTab));

  // ── 周期性段：平铺，按周期排序 ────────────────────────────────────
  // ★ 名次相同时保持 allTasks 的原顺序：db.allTasks 已按 due_date 升序，
  //   于是同一周期内天然是「截止近的在前」。Array.prototype.sort 自
  //   ES2019 起保证稳定，小程序两端（iOS 的 JSC / Android 的 V8）都符合。
  //   所以这里不需要（也不应该）再加一条排序键 —— 那属于发明业务规则。
  const flat =
    segmentTab === PERIODIC_SEG
      ? inSeg.slice().sort((a, b) => recurRank(a) - recurRank(b))
      : [];

  // ── 阶段段：按分类分组 ────────────────────────────────────────────
  let groups = [];
  if (segmentTab !== PERIODIC_SEG) {
    // 分组顺序跟 C.CATEGORY 的枚举顺序走（而不是按任务数量排序），
    // 这样同一条任务每次渲染都落在同一位置，不会切个筛选就跳位置。
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

  return {
    tabs,
    flat,
    groups,
    stats: {
      total: filtered.length,
      blocked: filtered.filter((t) => t._hasBlocker).length,
      overdue: filtered.filter((t) => t._overdue).length,
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
     * 计数受分类筛选影响 —— 切了分类，各分段的数字要跟着变。
     * ★ 三段之和会大于顶部「共 N 项」：周期任务同时算在它所属的阶段段里，
     *   见文件头「分段不再互斥」。
     */
    tabs: [],
    /**
     * 当前分段内的分类分组：
     *   [{ key, category, color, collapsed, tasks: [] }]
     * ★ 只有阶段段用它；周期性段是平铺的，走 data.flat。
     */
    groups: [],
    /**
     * 周期性段的平铺任务（已按周期排序）。
     * ★ 单独一个字段而不是塞进 groups 里只放一组，是因为「不分组」和
     *   「分了一组」在 WXML 里要渲染成两种结构 —— 前者没有吸顶标题、
     *   没有计数、不能折叠。用同一个字段装两种语义，模板里就得靠
     *   条件去猜它到底是哪种。
     */
    flat: [],
    /**
     * ★ 折叠状态独立于 groups 存放，key 是 `分段|分类`。
     *   若把 collapsed 只挂在 groups 上，每次切换分段/筛选重建 groups 时
     *   用户的展开状态就会被重置 —— 切一下回来全塌了。
     *   同时也让折叠状态在分段之间各自独立保留。
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
    /** 首次拿到数据时挑一个合适的默认分段，见 pickInitialSegment */
    this.segmentInitialized = false;
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

      const patch = { allTasks: all, loading: false };
      // ★ 只在首次落数据时挑默认分段。之后用户手动切过哪个分段就停在哪个，
      //   不能每次下拉刷新都把他弹回"进行中"。
      if (!this.segmentInitialized) {
        this.segmentInitialized = true;
        patch.segmentTab = pickInitialSegment(all);
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
   * 切换分段 / 筛选 / 折叠，以及拉完数据，全都走这里 —— 全页只此一处写列表。
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
        viewFor(s.allTasks, s.segmentTab, s.filterCategory, s.collapsedMap)
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
   * ★ 只有阶段段有分组，周期性段走不到这里。
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

  onFilterChange(e) {
    const idx = Number(e.detail.value);
    this.paint({ filterCategory: this.data.categoryValues[idx] });
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
 * 挑首次进入时落在哪个分段。
 * 优先「进行中」；它空了就落到第一个有任务的分段。
 * 不这么做的话，团队某段时间没有进行中的任务时，一进看板就是一片空白。
 */
function pickInitialSegment(tasks) {
  const countOf = (seg) => tasks.filter((t) => inSegment(t, seg)).length;
  if (countOf(DEFAULT_SEG) > 0) return DEFAULT_SEG;
  const firstWithTasks = SEGMENTS.find((s) => countOf(s) > 0);
  return firstWithTasks || DEFAULT_SEG;
}
