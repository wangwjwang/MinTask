/**
 * custom-tab-bar —— 自定义 tabBar（app.json 里 tabBar.custom = true）
 * ---------------------------------------------------------------------------
 * ★ 为什么要自定义：原生 tabBar 无法把某一项单独变灰/禁用，而「管理者」
 *   （只读角色）不该进「报任务」「改任务」——那两个 tab 对他没有意义。
 *   原生方案只剩"整个 tabBar 换一套"，做不到按角色区分。
 *
 * ★ 它只是体验，不是安全边界：真正拦住管理者的是云函数的
 *   requireWriter()（shared/ctx.js）。前端把入口变灰的用意是
 *   别让人点了才发现不行。
 *
 * ★ 选中态由页面推过来（每个 Tab 页 onShow 调 sync），
 *   不在这里读 getCurrentPages()：那样在页面切换的瞬间会读到上一页。
 * ---------------------------------------------------------------------------
 */

const auth = require('../utils/auth');
const toast = require('../utils/toast');

/**
 * 五个页签。write 标记"这一页是在写业务数据"——
 * 只读角色点它没有意义，所以置灰。
 * ★ 顺序仍必须与 app.json 的 tabBar.list 一致（两处顺序不一致时，
 *   页签的展示顺序与微信路由器认的顺序会对不上）。
 *   但选中态已经不靠下标了：sync 按 pagePath 找，见下面的方法注释。
 */
const TABS = [
  /*
   * ★ write 的含义是「管理者能不能用这一格」——
   *   sync() 会把它翻译成 disabled，对管理者置灰。
   *   「领需求」是 write: false：管理者能看、也能新建需求。
   *   他领不走（领走 = 建任务，那条路仍走 requireWriter），
   *   但"进不去这一页"和"进去了有些事做不了"是两回事 ——
   *   前者会让整个需求池对他消失，那不是本次放开的宽度。
   */
  { pagePath: '/pages/demands/index', text: '领需求', icon: 'demand', write: false },
  { pagePath: '/pages/report/index', text: '报任务', icon: 'report', write: true },
  { pagePath: '/pages/update/index', text: '改任务', icon: 'update', write: true },
  { pagePath: '/pages/board/index', text: '任务看板', icon: 'board', write: false },
  { pagePath: '/pages/people/index', text: '人员看板', icon: 'people', write: false },
];

Component({
  data: {
    selected: 0,
    /** tabs 是算好的展示数据：disabled 已经按角色落到每一项上，WXML 不做判断 */
    tabs: [],
  },

  attached() {
    // 没有路径可传：这一趟只是把 tabs 渲染出来（含按下角色算好的 disabled），
    // 选中态等页面 onShow 推过来。首次落 0 是刻意的兜底。
    this.sync();
  },

  methods: {
    /**
     * 同步选中态。
     *
     * ★ 参数是**页面路径**，不是下标。
     *   过去四个 tab 页各自硬编码了自己的下标（0/1/2/3，共 8 处调用），
     *   在头部插入一格会让这 8 处全部错位 —— 而错位的表现是"点进 A 页面、
     *   B 页签亮着"：一个不报错、但一眼就能看出不对的 bug。
     *   改成按路径找下标之后，下次再加 tab 也不用再手改任何一个数字。
     *
     * ★ 路径记在实例上：Component 的 attached 早于任何页面调它，
     *   那一次没有路径可传，得沿用上一次（首次为空串 → findIndex 得 -1 → 0）。
     */
    sync(pagePath) {
      if (pagePath) this._pagePath = pagePath;
      const isViewer = auth.isViewer();
      const tabs = TABS.map((t) => Object.assign({}, t, { disabled: isViewer && t.write }));
      const i = TABS.findIndex((t) => t.pagePath === this._pagePath);
      this.setData({ selected: i < 0 ? 0 : i, tabs });
    },

    onTap(e) {
      const index = Number(e.currentTarget.dataset.index);
      const tab = TABS[index];
      if (!tab) return;

      // 只读角色点写业务的页签：不跳，但要说一句 ——
      // 变灰是"看起来不能点"，真点了还毫无反应会被当成卡住
      if (auth.isViewer() && tab.write) {
        toast.toast('管理者账号只有查看权限');
        return;
      }

      // 已经在这一栏上：switchTab 是空操作，但也别白跑一趟
      if (index === this.data.selected) return;

      wx.switchTab({ url: tab.pagePath });
    },
  },
});
