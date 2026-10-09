# TeamPulse 团队看板（电脑端）

团队管理小程序的**电脑端可交互展示看板**。数据与小程序同源（同一 CloudBase 云数据库），天然同步、只读展示，支持筛选、钻取详情，并适配手机/平板/大屏。

> 本地 `npm run dev` 默认走内置演示数据（虚构、不含真实姓名）；部署后走真实云数据库，展示真实姓名（与小程序一致）。

## 视觉风格

仅保留 **冷静蓝 Relate** 单一风格：雪白背景 + 淡紫蓝洗 + 皇家蓝强调，Inter 字体、紧凑负字距、状态点（蓝/绿/红/橙映射任务状态）。主题令牌在 `src/themes/relate.css`，由 `:root` 注入，组件统一引用 CSS 变量，改样式不动逻辑。

## 技术栈

Vue 3 + Vite + Pinia + Vue Router + ECharts。

## 本地开发 / 预览

```bash
cd dashboard
npm install
npm run dev      # http://localhost:5173 ，自动走内置 mock 数据
```

构建静态产物：

```bash
npm run build    # 产物在 dist/
npm run preview  # 本地预览构建产物（仍走 mock）
```

## 目录结构

```
dashboard/
├── index.html
├── vite.config.js
└── src/
    ├── main.js
    ├── App.vue                 # 应用外壳 + 登录门 + 顶栏
    ├── router/                 # 路由（总览/任务/人员）
    ├── store/dashboard.js      # Pinia：聚合 KPI/看板/人员/风险 + 筛选
    ├── api/
    │   ├── mock.js            # 演示数据（结构与云库一致）
    │   └── client.js          # 数据源抽象：mock ↔ 真实云函数（含 CORS/集成响应兼容）
    ├── utils.js               # dueInfo 等（临期/逾期口径与小程序 format.js 一致）
    ├── themes/relate.css      # 唯一主题：冷静蓝
    ├── components/             # KPI/筛选/任务卡/看板/人员/抽屉/图表
    └── views/                  # Overview / Tasks / People / Login
```

## 数据同源与字段映射

小程序写入 `tasks / progress_records / members / periodic_templates`，看板新增的只读云函数 `dashboardService` 读同一批集合。**小程序改一条，看板刷新即见，无需任何同步任务。**

云函数已内置字段映射，把真实库结构转成前端期望结构（前端组件完全按这套结构写）：

| 集合 | 真实字段 → 前端字段 |
|------|---------------------|
| tasks | `task_name→name`、`leader→leaderName`、`task_type→taskType`、`recur_freq→recurFreq`、`due_date→dueDate` 等 |
| progress_records | `description/blocker→text`、`needSupport→support`、`updatedAt→time`、`appliedChanges.progress→progress` |
| members | 由 `openid` 推导 `claimed` |

时间字段（`serverDate` 序列化成的 `{ $date }`）统一规范化为 ISO 字符串，前端 `new Date()` 可直接解析，不会出现 `Invalid Date`。

`src/api/mock.js` 的演示数据严格按同一结构生成，因此本地 mock 与线上真实数据**展示完全一致**。

## 部署到 CloudBase（静态托管 + 只读云函数）

### 前置：腾讯云凭据（必须）

部署需要能操作你 CloudBase 环境 `cloudbase-d4gvt9mox2e73b8fb` 的权限，二选一：

- **API 密钥**：腾讯云控制台「访问管理 → API 密钥」创建 SecretId / SecretKey（建议用仅该环境权限的子账号密钥）；
- 或在本机安装 `@cloudbase/cli` 后 `tcb login`（浏览器扫码）。

> 本仓库**不含任何凭据**，部署命令需在你提供密钥（或你本机已登录）后执行，不会硬编码任何密钥到代码。

### 步骤

1. 构建前端：`cd dashboard && npm run build`（产物 `dist/`）。
2. 安装 CLI：`npm i -g @cloudbase/cli`（或 `npx @cloudbase/cli`）。
3. 登录 / 校验：`tcb login`，或 `tcb env:list --secretId=xxx --secretKey=xxx`。
4. 部署静态托管：`tcb hosting deploy dashboard/dist -e cloudbase-d4gvt9mox2e73b8fb`
5. 部署云函数：`tcb fn deploy dashboardService -e cloudbase-d4gvt9mox2e73b8fb`
   （函数目录含 `package.json`，云端自动安装 `wx-server-sdk`，无需本地 `npm install`）
6. 控制台「云函数 → dashboardService → 触发管理」**开启 HTTP 触发**，记下触发 URL
   （形如 `https://<env>.api.tcloudbase.com/release/dashboardService`）。
7. **开启跨域（CORS）**：HTTP 触发处默认通常已允许跨域；若浏览器报跨域，在触发配置中开启「响应跨域」。
   ⚠️ 因为前端**只通过 HTTP 触发地址调用云函数**（并非 Web SDK 直连数据库），所以**不需要配置 Web 安全域名白名单**——这是与直连方案最关键的区别。
8. 设置口令：云函数「环境变量」新增 `DASHBOARD_PASSCODE`，值自定（未设置则放行，仅联调用）。
   ★ **口令不要写进仓库**：它同时是部署凭据（`cloudbaserc.json`）与访问口令，
   两者都在 .gitignore 里。
9. 指定 API 地址（二选一）：
   - 构建时：`VITE_API_BASE=https://你的HTTP触发URL npm run build`，再重新执行第 4 步部署静态托管；
   - 运行时：在静态托管根目录放 `config.js`：`<script>window.__TP_API_BASE__ = 'https://你的HTTP触发URL';</script>`，前端 `client.js` 优先读取（免重新构建）。
10. 访问：打开静态托管地址，在登录页输入第 8 步设置的口令即可进入看板。

### 修改口令

只改云函数 `dashboardService` 的 `DASHBOARD_PASSCODE` 环境变量即可，前端无需改动。团队访问时在登录页输入该口令。

## 安全模型

- 看板**只读**：`dashboardService` 只 `get()` 不写库，无法改任何小程序数据。
- 口令是第一道访问控制：未通过校验直接返回错误，前端拿不到任何数据。
- 前端登录后口令存于 `localStorage`，便于刷新保持会话；退出即清除。
- 本次新增 `demandService`（需求池）后共 9 个云函数。电脑端看板**不展示需求池**。
- ★ `dashboardService` **本次不需要重新部署**：它只 require `wx-server-sdk`，
  完全不使用 `shared/`（有意做成自包含）。`sync-shared.js` 会照灌一份
  `lib/shared` 进去，但那是死副本，已在 `.gitignore` 里排除。

## 改动范围确认

- 仅**新增** `dashboard/` 前端项目（与 `miniprogram/` 平级）与 `cloudfunctions/dashboardService/`（只读）。
- 小程序源码、现有云函数、云数据库集合结构均**未改动**（2026-10-09 需求池那一次是另外一批改动，与看板无关）。
