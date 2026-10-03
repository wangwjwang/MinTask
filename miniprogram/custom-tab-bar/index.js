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
 * 四个页签。write 标记"这一页是在写业务数据"——
 * 只读角色点它没有意义，所以置灰。
 * ★ 顺序必须与 app.json 的 tabBar.list 完全一致（下标就是选中态）。
 */
const TABS = [
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
    this.sync(this.data.selected);
  },

  methods: {
    /**
     * 由页面调用：告诉 tabBar 当前在哪一栏。
     * ★ 角色可能比页面数据晚到（app.onLaunch 的 bootstrap 是异步的），
     *   所以页面在拿到身份后会再同步一次 —— 这里每次都重算 disabled。
     */
    sync(selected) {
      const isViewer = auth.isViewer();
      const tabs = TABS.map((t) => Object.assign({}, t, { disabled: isViewer && t.write }));
      this.setData({ selected: selected || 0, tabs });
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
