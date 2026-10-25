/**
 * pages/task-detail —— 任务详情（子页面）
 * ---------------------------------------------------------------------------
 * 两块内容：
 *   1. 任务信息卡（含卡壳高亮、来源、周期标识、截止时间、未解决卡壳数）
 *   2. 进展时间线（最新在前，卡壳条目红色标记 + "标记已解决"）
 *
 * ★ 本页纯只读 —— 不承载任何对**任务**的写操作。时间线上的「标记已解决」
 *   写的是进展记录本身，不是任务，所以随记录留下。
 *   任务看板与成员任务页都跳这里，两者都是「浏览别人的活」的场景，
 *   把改动入口放在这里会让所有任务看起来都能改。
 *   对任务的写操作统一归在：改任务（编辑 / 删除）、报任务（上报进展 /
 *   加入协办）、退出协办页。
 *
 * ★ 本页只剩一处权限判定：时间线上每条卡壳记录的「标记已解决」，
 *   由 decorateRecords 逐条调 perm.canResolveBlocker 算出。
 *   前端隐藏只是体验（不显示点了会被拒的按钮），真正的边界在云函数。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const perm = require('../../shared/perm');
const { COLLECTIONS } = require('../../shared/constants');

Page({
  data: {
    taskId: '',
    task: null,
    loading: true,
    /** 进展记录（已装饰，含 _canResolve / _timeText 等） */
    records: [],
    /** 未解决的卡壳记录条数，显示在任务信息卡里 */
    openBlockerCount: 0,
  },

  onLoad(query) {
    api.setClaimHandler(() => auth.gotoClaim(true));
    this.setData({ taskId: query.taskId || '' });
  },

  onShow() {
    // onShow 而非 onLoad：从编辑页/上报页返回时任务与进展都变了，必须重拉
    if (this.data.taskId) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  // ── 数据 ──────────────────────────────────────────────────────────

  async refresh() {
    try {
      const session = await auth.requireClaimed();
      const { taskId } = this.data;

      const task = await db.getDoc(COLLECTIONS.TASKS, taskId);
      if (!task) {
        toast.error('任务不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const raw = await db.progressOf(taskId);
      const decorated = fmt.decorateTask(task);
      const records = this.decorateRecords(raw, task, session.openid);

      this.setData({
        task: decorated,
        records,
        openBlockerCount: records.filter((r) => r.hasBlocker && !r.blockerResolved).length,
        loading: false,
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        console.error('[task-detail] 加载失败', e);
        this.setData({ loading: false });
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  /**
   * 装饰进展记录。
   * ★ 逐条调用 perm.canResolveBlocker —— "主办人 or 本条提交人"是每条记录
   *   各自不同，不能像任务级权限那样算一次就完事。
   */
  decorateRecords(records, task, openid) {
    return (records || []).map((r) => {
      const hasBlocker = !!r.hasBlocker;
      return Object.assign({}, r, {
        _timeText: fmt.timeAgo(r.updatedAt || r.createdAt),
        _fullTime: fmt.fullTime(r.updatedAt || r.createdAt),
        _hasBlocker: hasBlocker,
        _resolved: hasBlocker && r.blockerResolved === true,
        // 未解决的卡壳才显示"标记已解决"按钮
        _canResolve: hasBlocker && r.blockerResolved !== true && perm.canResolveBlocker(task, r, openid),
        _isMine: r.updaterId === openid,
      });
    });
  },

  // ── 操作 ──────────────────────────────────────────────────────────

  /** 跳转到该主办人的任务列表 */
  onLeaderTap() {
    const task = this.data.task;
    if (!task || !task.leaderId) return;
    wx.navigateTo({
      url: `/pages/person-detail/index?openid=${task.leaderId}&name=${encodeURIComponent(task.leader || '')}`,
    });
  },

  /** 标记某条卡壳为已解决 */
  onResolveBlocker(e) {
    const recordId = e.currentTarget.dataset.id;
    if (!recordId) return;

    toast.confirm('确认这个问题已经解决？', '标记卡壳已解决', '已解决').then(async (ok) => {
      if (!ok) return;
      try {
        await toast.withLoading(
          () => api.progressApi.resolveBlocker(recordId),
          '处理中'
        );
        toast.success('已标记解决');
        this.refresh();
      } catch (e) {
        /* api 层已提示 */
      }
    });
  },
});
