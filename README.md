# TeamPulse · 团队任务管理系统（微信小程序端）

面向 10 余人内部团队的任务登记、进展上报与看板管理系统。
原生微信小程序 + 微信云开发（云数据库 / 云函数 / 定时触发器），**零构建步骤**，
用微信开发者工具导入即可编译运行。

> **本期范围**：只交付小程序端。Web 端为后续阶段。
> 但全部写操作已封装为带 `action` 路由的云函数，数据模型也已按"多端共用"设计，
> Web 端接入时复用同一批云函数即可，无需重写业务逻辑。

> 📖 **第一次搭这个项目？** 先看 [**从零搭建手册**](docs/SETUP-FROM-SCRATCH.md) ——
> 那份从装 VS Code / Node.js 开始讲，包含注册小程序、开通云开发等仓库之外的步骤，
> 以及 AI 工具链的配置（Claude Code 经 CC Switch 接 DeepSeek）。
> 本 README 第 3 章假定你已经有了 AppID 和云环境。

---

## 目录

1. [功能一览](#1-功能一览)
2. [目录结构](#2-目录结构)
3. [部署步骤](#3-部署步骤)
4. [数据模型](#4-数据模型)
5. [权限矩阵](#5-权限矩阵)
6. [周期任务模板](#6-周期任务模板)
7. [二次开发](#7-二次开发)
8. [常见问题](#8-常见问题)
9. [已知限制](#9-已知限制)

---

## 1. 功能一览

| 入口 | 页面 | 说明 |
|---|---|---|
| 启动页 | `pages/claim` | 首次进入从预置名单中**认领自己**，完成 openid ↔ 姓名绑定 |
| Tab1 | `pages/report` | 报任务：我主办的 / 我协办的 / 可加入的 |
| Tab2 | `pages/update` | 改任务：筛选 + 编辑入口 |
| Tab3 | `pages/board` | 任务看板：按阶段分三列、按分类筛选、卡壳高亮 |
| Tab4 | `pages/people` | 人员看板：全员负载一览，点击下钻某人任务 |
| 子页 | `pages/progress-add` | 上报进展（描述 / 卡壳 / 需要支持，主办人可同步改进度与状态） |
| 子页 | `pages/task-create` / `task-edit` | 新建 / 编辑任务（仅主办人） |
| 子页 | `pages/task-detail` | 任务详情 + 进展时间线 + 卡壳解决 |
| 子页 | `pages/person-detail` | 某成员名下的主办 / 协办任务 |
| 子页 | `pages/join` | 可加入的任务列表 |

**核心能力**

- 进展上报：手写描述 / 卡壳原因 / 需要支持。**想用语音就直接长按输入法的麦克风**，无需插件。
- 卡壳跟踪：进展可标记卡壳，看板与卡片红色高亮，问题解决后点"标记已解决"即回落。
- 周期任务：管理员配模板，定时函数每日巡检自动生成月度/季度/年度任务，**幂等，重复触发不产生重复任务**。
- AI 精简：`callAI` 云函数已完整实现（DeepSeek），但**默认关闭**。详见 [3.6](#36-可选开启-ai-精简)。

---

## 2. 目录结构

```
TeamPulse/
├── project.config.json          微信开发者工具项目配置
├── README.md                    本文件
├── .gitignore
│
├── shared/                      ★ 唯一源：双端共用的纯逻辑模块
│   ├── constants.js             全站枚举字典（11 分类 / 8 来源 / 状态 / 阶段 …）
│   ├── errors.js                错误码与 BizError
│   ├── perm.js                  ★ 权限纯函数，前端与云函数共用同一份
│   ├── validate.js              字段白名单与参数校验
│   ├── dates.js                 日期工具（本地时区、定长日期串）
│   ├── idempotency.js           确定性 _id 生成与重复键识别
│   ├── periodic.js              周期任务：占位符渲染、截止日推算
│   ├── taskRepo.js              任务文档构造、卡壳重算、阶段副作用
│   ├── periodicRunner.js        周期生成主流程（定时与手动补跑共用）
│   ├── ctx.js        ⚠ 云函数专属（含 wx-server-sdk）
│   ├── router.js     ⚠ 云函数专属
│   └── notify.js     ⚠ 云函数专属（订阅消息预留 stub）
│
├── docs/
│   └── SETUP-FROM-SCRATCH.md    ★ 从零搭建手册（装工具 → 注册 → 部署 → 导数据）
│
├── scripts/
│   ├── sync-shared.js           把 shared/ 分发到小程序端与各云函数
│   ├── selfcheck.js             163 项纯逻辑断言，改 shared/ 后必跑
│   ├── members.json             成员名单（★ 编辑这个）
│   ├── make-member-import.js    转成云数据库可导入的 JSON Lines 格式
│   ├── members.import.json      ↑ 的产物，导入控制台用这个（不提交）
│   ├── tasks.source.csv         历史任务表（★ 可选，见 3.9）
│   ├── make-task-import.js      转成 tasks / progress_records 两份导入文件
│   ├── tasks.import.json        ↑ 的产物（不提交）
│   └── progress_records.import.json  ↑ 的产物（不提交）
│
├── cloudfunctions/
│   ├── memberService/           身份认领、成员增删改（claim 用 CAS 抢占）
│   ├── taskService/             任务增删改、加入/退出协办
│   ├── progressService/         进展上报、卡壳解决
│   ├── templateService/         周期模板管理（仅管理员）
│   ├── generatePeriodicTasks/   ★ 含 config.json 定时触发器
│   ├── callAI/                  AI 精简（providers/deepseek.js）
│   └── notifyService/           订阅消息 stub
│
└── miniprogram/
    ├── app.js / app.json / app.wxss / sitemap.json
    ├── config.js                ★ 部署时唯一需要手改的文件
    ├── shared/                  （由 sync-shared.js 生成的副本，已提交进仓库）
    ├── utils/                   api / db / auth / format / toast
    ├── components/              task-card / empty-state / field-picker
    └── pages/                   11 个页面
```

### 为什么 `shared/` 要复制而不是引用

云函数与小程序是两套独立运行环境，三条常规方案都走不通：

| 方案 | 失败原因 |
|---|---|
| 云函数直接 require 小程序端代码 | 上传云函数时只打包函数目录，跨目录引用取不到文件 |
| npm `file:` 本地依赖 | 云端"安装依赖"时无法解析本地路径 |
| 小程序"构建 npm" | 违反"零构建步骤"约束 |

所以采用**单一源 + 脚本同步**：`shared/` 是唯一真源，`scripts/sync-shared.js` 把它复制到
`miniprogram/shared/`（仅双端安全模块）和各云函数的 `lib/shared/`（全量）。
副本提交进仓库，保证别人 clone 下来直接能编译。

> ⚠ **改了 `shared/` 之后必须跑 `node scripts/sync-shared.js`**，否则两端不一致。
> 脚本带 `--check` 模式可检测是否忘记同步。

---

## 3. 部署步骤

从零到可运行，按顺序做完以下 8 步。全程约 15 分钟。

### 3.1 准备账号与环境

1. 注册微信小程序账号，拿到 **AppID**（个人主体也可，无需企业认证）。
   测试号不行 —— 云开发和插件都需要真实 AppID。
2. 微信开发者工具 → **导入项目** → 选择本项目根目录 `TeamPulse/`。
3. 修改 `project.config.json` 的 `"appid": "touristappid"` 为你的 AppID。
4. 工具顶部 → **云开发** → 开通环境（新用户有免费额度）。
   记下**环境 ID**，形如 `cloud1-1g2h3i4j5k6l7m8n`。

### 3.2 填写环境 ID

编辑 [`miniprogram/config.js`](miniprogram/config.js)，把 `envId` 换成上一步的环境 ID：

```js
envId: 'cloud1-1g2h3i4j5k6l7m8n',   // ← 改这里，全项目只改这一处
```

> 这是**唯一**需要手改的代码文件。留空或填错会报「云开发未初始化」。

### 3.3 语音录入：本期不做（无需任何配置）

需求原方案是接入微信**同声传译插件**做语音转文字。**已决定不做**，理由：

> 手机自带输入法（微信输入法、搜狗、百度等）都内置了语音转文字，
> 用户在输入框里长按输入法的麦克风就能说话转字，效果等同，插件是多余的。

不做语音还顺带省掉两道部署工序：**插件授权**与**麦克风隐私声明**。
`app.json` 里既没有 `plugins` 声明，也没有 `scope.record` 权限声明，
因此不会出现下面这类"整个小程序打不开"的问题。

> ⚠ **不要重新引入 WechatSI 插件。** 两个坑：
> 1. 该插件**不支持个人主体**小程序添加，只有企业/个体户等非个人主体才能加；
> 2. 一旦 `app.json` 声明了账号未授权的插件，小程序会**整个无法预览**，
>    报错 `错误码：80082, get plugin(...) failed, permission deny` ——
>    这不是"语音不可用"，而是连看板、任务列表都打不开。
>
> 将来若确实需要语音，优先考虑自建录音 + 第三方 ASR，
> 或先确认主体类型支持添加该插件。

### 3.4 创建数据库集合

云开发控制台 → **数据库** → 新建以下 **5 个集合**：

| 集合 | 用途 | 安全规则 |
|---|---|---|
| `members` | 成员名单与 openid 绑定 | `{"read": true, "write": false}` |
| `tasks` | 任务 | `{"read": true, "write": false}` |
| `progress_records` | 进展记录 | `{"read": true, "write": false}` |
| `periodic_templates` | 周期模板 | `{"read": false, "write": false}` |
| `job_logs` | 定时任务审计日志 | `{"read": false, "write": false}` |

> **安全规则必须用 `{"read": true, "write": false}`，不要用"仅创建者可写"。**
> 原因：云函数写入的记录**不带 `_openid` 字段**（该字段只在客户端 SDK 写入时自动添加），
> 任何基于 `_openid` 的规则在本架构下都会失效。
> 本架构是「前端只读直连 + 全部写操作走云函数」，云函数以管理员身份运行，不受安全规则约束，
> 所以把客户端写权限整体关掉是最简单也最安全的做法。
>
> **验证方法**：在小程序里执行 `wx.cloud.database().collection('tasks').add({data:{}})`，
> 应当被明确拒绝。若成功了，说明规则没生效，请回控制台检查。

权限模式选「**自定义安全规则**」，逐条粘贴上面的 JSON。

### 3.5 配置数据库索引

控制台 → 数据库 → 选中集合 → **索引管理** → 新建。
索引是**性能保障**，不建也能跑，但数据一多会明显变慢。

| 集合 | 索引字段 | 类型 | 支撑场景 |
|---|---|---|---|
| `members` | `openid` | **唯一** | 每次云函数取身份（最高频调用） |
| `members` | `name` | **唯一** | 认领页去重、批量导入查重 |
| `tasks` | `leaderId` + `stage` | 复合 | Tab1「我主办的」 |
| `tasks` | `collaboratorIds` + `stage` | 复合 | Tab1「我协办的」 |
| `tasks` | `stage` + `category` | 复合 | Tab3 看板分列 + 筛选 |
| `tasks` | `templateId` + `periodKey` | **唯一** | 周期生成查重兜底 |
| `tasks` | `due_date` | 单字段 | 列表按截止日排序 |
| `tasks` | `hasOpenBlocker` | 单字段 | 看板卡壳统计 |
| `progress_records` | `taskId` + `updatedAt`（降序） | 复合 | 详情页时间线 |
| `progress_records` | `updaterId` | 单字段 | 按人查进展 |
| `periodic_templates` | `enabled` | 单字段 | 每日巡检扫描 |

> `members.openid` 建**唯一索引**有个额外好处：它从数据库层面兜住了
> "两个账号认领同一人"的并发漏洞（虽然 `claim` 云函数已用 CAS 抢占处理了）。

### 3.6 导入成员名单

**这一步不做，没人能登录** —— 认领页的名单就来自这个集合。

1. 编辑 [`members.json`](scripts/members.json)（模板见仓库 `scripts/` 目录），改为你们团队的真实名单。
   **务必包含你自己，并把你的 `role` 填成 `管理员`**，否则导入后没人能执行管理员操作：

```json
[
  { "name": "张三", "dept": "技术组", "role": "管理员" },
  { "name": "李四", "dept": "技术组" },
  { "name": "王五", "dept": "业务组" }
]
```

   字段说明：
   - `name` — **必填**，全团队唯一
   - `dept` — 选填，用于**区分重名**（两个"张伟"靠它辨认）
   - `role` — 选填，默认 `普通`；填 `管理员` 才有模板管理与删除权限
   - **不要写 `openid`** —— 脚本会自动补成 `""`（原因见下）

2. 转换成导入格式：

```bash
node scripts/make-member-import.js
```

   它会校验名单（重名、空名、超长、误填 openid、有没有管理员），
   然后生成 `scripts/members.import.json`。

3. 云开发控制台 → 数据库 → `members` 集合 → **导入** → 选择
   **`scripts/members.import.json`**（不是 `members.json`），冲突处理方式选 **Insert**。

> ⚠ **为什么不能直接把 `members.json` 拿去导入**
> 云开发数据库要的是 **JSON Lines** —— 每行一个独立的 JSON 文档，
> 没有外层 `[]`，对象之间也没有逗号。直接导入标准 JSON 数组会报
> `解析json文档错误 … invalid character ']' looking for beginning of value`。
> 源文件保持数组是因为它易读、能被编辑器校验，格式转换交给脚本。

> ⚠ **为什么 `openid` 必须显式写成 `""`，不能省略**
> 云开发是 MongoDB 语义，`where({ openid: '' })` **匹配不到"根本没有 openid 字段"
> 的文档**。省略这个字段会导致：认领页查不到这个人（`listClaimable` 不匹配），
> 而认领时 CAS 条件也不成立，最终报「该成员已被他人认领」——
> 明明没人认领却报已被认领，排查方向会被彻底带偏。脚本总是输出 `openid: ""`。
> 另外，若导入时**误填了真实 openid**，这条记录就永远无法被认领。

4. 导入完成后，**你自己先**打开小程序，在认领页选中你的名字完成认领 ——
   认领之后你才真正拿到管理员权限。然后再让每位同事各自认领自己的名字。

> ⚠ **名单变更后不要整份重新导入。** 导入文件里没有 `_id`，云开发每次导入都会
> 生成新的 `_id`，所以"重新导一遍"不是覆盖而是**新增** —— 而 `members.name`
> 有唯一索引，撞上已存在的人会直接冲突失败。
>
> - **加人** —— 重新跑脚本，把导入文件里**已存在的行删掉**再导
> - **改名 / 调角色 / 解绑** —— 直接在控制台改那一条记录，不要走导入

> 认领页只显示 `openid` 为空的成员，所以**已经被人认领的名字不会再出现**，
> 不会出现"两个人抢同一个名字"的情况（真要同时点，云函数用 CAS 保证只有一个成功）。

### 3.7 部署云函数

在开发者工具左侧 `cloudfunctions` 目录下，**逐个**右键以下 7 个函数 →
**上传并部署：云端安装依赖**：

```
memberService   taskService   progressService   templateService
generatePeriodicTasks   callAI   notifyService
```

上传完成后，在云开发控制台 → **云函数**，为以下函数调整配置：

| 函数 | 超时时间 | 内存 | 原因 |
|---|---|---|---|
| `generatePeriodicTasks` | **60 秒** | 256 MB | 默认 3 秒，批量生成多个模板会超时 |
| `callAI` | **20 秒** | 256 MB | 内部 HTTP 超时 8 秒，留出云函数冷启动余量 |
| `memberService` | **20 秒** | 256 MB | 见下：认领时要顺带关联历史数据，不是单文档操作 |
| `templateService` | **60 秒** | 256 MB | 单文档增删改 3 秒够用，但 `generateNow` / `preview` 会整批生成任务 |
| 其余函数 | 默认 3 秒 | 256 MB | 都是单文档操作，够用 |

> ★ **`templateService` 现在按 60 秒配，是给以后留的余量。**
> 它的 `generateNow`（手动补跑）和 `preview`（只看不写）会和定时任务跑同一套
> 生成逻辑，批量大的时候 3 秒必然不够。这两个 action 目前没有界面入口
> （见 `docs/SETUP-FROM-SCRATCH.md` 第 7.6 节），但只要哪天加了按钮，
> 忘了改超时就会**中途超时**、生成一半 —— 比直接报错更难查。
> 现在先配上，成本为零。

> ★ **`memberService` 必须调超时**。它除了认领还要跑「历史数据关联」：
> 要全量扫描 `tasks` 与 `progress_records`，再逐个 `update` 回填 `leaderId` /
> `collaboratorIds` / `updaterId`。任务表有几百条时，这些写操作累计起来
> 会超过默认的 3 秒 —— 表现是认领或关联时**偶发**超时失败。
> 关联是幂等的，重跑能补上，但用户看到的是莫名其妙的报错。

> 控制台改超时后**需要重新部署**才生效（或直接在云函数配置页保存，
> 部分版本的开发者工具会上传覆盖，改完回控制台确认一次）。

### 3.8 启用定时触发器

`generatePeriodicTasks/config.json` 已声明触发器：

```json
"triggers": [
  { "name": "periodicTaskDailyPatrol", "type": "timer", "config": "0 5 0 * * * *" }
]
```

**微信云函数的 Cron 是 7 位**（秒 分 时 日 月 周 年），与 Linux 的 5 位不同。
`0 5 0 * * * *` = **每天 00:05 巡检一次**。

> **为什么是"每日"而不是"每月 1 号"**：
> 微信云函数的定时触发器**没有重试机制**。若配成每月 1 号触发，一次失败
> 就意味着整个月一个周期任务都不会生成，而且**没有任何告警**。
> 改成每日巡检后，某天失败第二天会自动补上；配合确定性 `_id`，
> 一个月跑 30 次也只会生成一份任务（详见 [6.3](#63-幂等保证)）。

部署后到控制台 → 云函数 → `generatePeriodicTasks` → **触发器** 页确认触发器已生效。
可点「**测试**」手动触发一次验证（测试事件传 `{}` 即可）。

### 3.9 导入历史任务表（可选）

已有 Excel/CSV 历史任务表时，用它一次性铺好初始数据，不用手工建 70 个任务。

1. 把历史表存成 CSV，放到 `scripts/tasks.source.csv`（表头见仓库中同名文件）。
   必填列：`task_name` `category` `source` `task_type` `leader` `progress` `start_date` `due_date`。

2. 转换：

```bash
node scripts/make-task-import.js
```

   脚本会逐行校验，**单行有问题只跳过该行**，其余照常生成，并在结尾列出
   跳过的行缺了什么。要"一行都不许错"时加 `--strict`。

3. 按提示导入**两个**集合（云开发一次只能导一个集合）：

   | 文件 | 目标集合 |
   |---|---|
   | `scripts/tasks.import.json` | `tasks` |
   | `scripts/progress_records.import.json` | `progress_records` |

   冲突处理方式都选 **Insert**。

#### 导完之后为什么「我主办的」是空的

历史表里只有**姓名**，而权限判定只认 **openid**（见 [5. 权限](#5-权限矩阵)）。
openid 要等本人来认领才产生，所以导入时 `leaderId` / `collaboratorIds` /
`updaterId` 一律留空 —— 这不是漏做，是**故意的**：前端和离线脚本都不该有能力
指定"谁是主办人"，否则就绕过了"身份只取自 OPENID"这条底线。

补齐分两步，**都是幂等的，可以随时重跑**：

| 时机 | 动作 |
|---|---|
| 每人认领自己时 | 云函数自动补一次他名下的关联，无需干预 |
| 全部认领完 | 管理员打开小程序 → 底部「**人员**」Tab → 点「把历史任务关联到已认领的同事」 |

关联规则是**只补空缺，绝不覆盖**：已有 `leaderId` 的任务是正常流程创建的，
归属已确定，不会因为"姓名相同"被改写 —— 否则重名的两个人会互相夺走对方的任务。

> ⚠ 这一步**不能**从云开发控制台的「云端测试」跑 —— 那里没有微信身份，
> 而 `adminRelinkMembers` 需要 OPENID 才能判断你是不是管理员。必须在小程序里点。

> ⚠ **导入文件里的 `_id` 是按任务名算出来的稳定哈希**（不是行号）。
> 所以改了源表顺序不影响结果，重复导入同一份文件会因 `_id` 冲突而失败 ——
> 这正是想要的：把"手滑导了两遍"从数据事故降级成一次报错。
> 但**任务名改了就会生成新的 `_id`**，表现为"多了一个任务"而不是"改名了"。
> 已导入的任务要改名，请在界面上改，别改源表重导。

---

## 4. 数据模型

### 4.1 `members` 成员

```js
{
  name: '张三',              // 唯一
  dept: '技术组',            // 辅助区分重名
  openid: '',                // ★ 空串 = 未认领；认领后写入，CAS 条件依赖它
  role: '普通' | '管理员',
  claimedAt: Date | null,
  createdAt: Date
}
```

### 4.2 `tasks` 任务

```js
{
  task_name, category, source, taskType, recurFreq, priority, detail,
  due_date: '2026-10-25',        // ★ 定长 YYYY-MM-DD，字符串比较即时间比较
  actualCompleteTime: '',        // stage 置为"已完成"时由服务端自动写入

  // —— 权限字段（前端不可写，由云函数从 openid 带出）——
  leaderId: 'oXXXX',             // 主办人 openid
  collaboratorIds: ['oYYYY'],    // 协办人 openid 数组

  // —— 展示快照（由服务端按 id 解析姓名后写入，前端不可写）——
  leader: '张三',
  collaborator: '李四;王五',      // 分号分隔，与需求原文一致

  // —— 状态 ——
  stage: '未开始' | '进行中' | '已完成',   // 驱动看板分列
  status: '正常' | '有风险' | '受阻' | '已完成',  // 健康度徽标
  progress: 0-100,

  // —— 周期任务 ——
  origin: 'manual' | 'periodic',
  templateId: '',                // 周期生成时写入
  periodKey: '',                 // '2026-10'，幂等键的一部分
  recurRule: '',                 // 如 '每月 25 号'

  // —— 冗余派生字段（服务端维护，前端只读）——
  hasOpenBlocker: false,         // 看板卡壳高亮靠它，避免 N+1 查询
  openBlockerCount: 0,
  latestProgressAt: Date | null,

  creatorId, createdAt, updatedAt
}
```

> **`stage` 与 `status` 是两个正交字段，不要混用。**
> `stage` 是「阶段」（未开始/进行中/已完成），决定任务在 Tab3 看板的哪一列；
> `status` 是「健康度」（正常/有风险/受阻/已完成），是卡片上的彩色徽标。
> 需求原文里一个 `status` 字段同时承担了这两种语义，会导致"已完成的任务到底是哪一列"无法表达。

> **`leaderId` / `collaboratorIds` 与 `leader` / `collaborator` 的分工**：
> 前者是**权限判据**（openid，永不变），后者是**展示快照**（姓名，会因改名而过期）。
> 权限判定**只比对 openid，绝不比对姓名** —— 否则两个"张伟"会互相拿到对方的权限。

### 4.3 `progress_records` 进展记录

```js
{
  taskId, taskName,              // taskName 是快照，便于"我上报过的"列表免联表
  description,                   // 进展描述
  blocker: '',                   // 卡壳原因，空串=无
  blockerResolved: null,         // ★ 无卡壳时为 null，有卡壳时 false→true
  needSupport: '',               // 需要支持
  hasBlocker: false,             // 冗余：blocker 非空即 true，供云函数查询

  status: '正常',                 // 提交时的任务健康度快照
  appliedChanges: {              // ★ 本次提交同时改动的任务字段，仅主办人非空
    progress: 70,                //   没有它的话，详情页时间线只能看到任务"当前"
    stage: '进行中'               //   的值，无法知道是哪一次上报改的
  } | null,
  updaterId,                     // ★ 更新人 openid，云函数自动带出，禁止前端传入
  updaterName,                   // 姓名快照
  updatedAt
}
```

> `blockerResolved` 在**没有卡壳时是 `null` 而不是 `false`** ——
> 这样"没有卡壳"和"有卡壳但未解决"在查询层面就能区分开，
> 不需要再加一个 `hasBlocker` 字段参与查询条件（虽然为性能也冗余了一个）。

### 4.4 `periodic_templates` 周期模板

见 [第 6 节](#6-周期任务模板)。

### 4.5 `job_logs` 审计日志

```js
{
  type: 'generatePeriodic',
  periodKey: '2026-10',
  created: ['pt-tpl001-2026-10'],   // 本次新建的任务 _id
  skipped: ['pt-tpl002-2026-10'],   // 已存在被跳过（正常情况，非错误）
  failed: [{ templateId, error }],
  operator: 'oXXXX' | 'system',
  finishedAt: Date
}
```

---

## 5. 权限矩阵

**所有权限由云函数强制校验，前端隐藏按钮只是体验优化，不等于安全。**

| 操作 | 主办人 | 协办人 / 主动加入者 | 其他已认领成员 | 管理员 |
|---|:---:|:---:|:---:|:---:|
| 改任务名/分类/协办人/截止时间 | ✅ | ❌ | ❌ | ❌ |
| 进度% / 状态 / 阶段 | ✅ | ❌ | ❌ | ❌ |
| 新增进展记录 | ✅ | ✅ | ❌ | ❌ |
| 自由加入他人任务成为协办 | — | ✅ 无需审批 | ✅ | ✅ |
| 标记卡壳已解决 | ✅ 任意记录 | ✅ **仅自己提交的** | ❌ | ❌ |
| 删除任务 | ❌ | ❌ | ❌ | ✅ |
| 周期模板管理 | ❌ | ❌ | ❌ | ✅ |

**两条硬性约束**（需求第 6.6 节、第 4 节明确要求）：

1. **协办人界面与后端均禁止出现进度%和状态编辑入口。**
   前端用 `perm.canEditProgressFields()` 控制整个区块的 `wx:if` 不渲染；
   后端 `progressService.addRecord` 检查到协办人携带 `progress`/`status`/`stage`
   时返回 `FORBIDDEN_FIELD`。
   > 后端刻意选择**显式拒绝**而不是静默丢弃：静默丢弃会让越权尝试不留痕迹，
   > 且前端会误以为提交成功，产生"我改了但没生效"的困惑。
   > 非参与者则返回 `FORBIDDEN_NOT_PARTICIPANT`。

2. **`updaterId` 由云函数自动带出，禁止前端传入。**
   `updaterId` / `leaderId` / `creatorId` / `leader` / `collaborator` /
   `createdAt` / `updatedAt` / `hasOpenBlocker` / `latestProgressAt`
   **不在任何字段白名单内**，前端传了也不会被采纳（见 `shared/validate.js`）。

**错误码对照**（前端会直接展示 `message`）：

| 错误码 | 含义 | 前端行为 |
|---|---|---|
| `NO_IDENTITY` / `NOT_CLAIMED` | 身份缺失 / 未认领 | 自动跳认领页 |
| `FORBIDDEN_NOT_LEADER` | 不是主办人 | 提示 + 刷新当前页 |
| `FORBIDDEN_NOT_PARTICIPANT` | 不是参与者 | 提示 + 刷新当前页 |
| `FORBIDDEN_FIELD` | 携带了越权字段 | 提示"协办人无权修改：xxx" |
| `FORBIDDEN_ADMIN` | 非管理员 | 提示 |
| `MEMBER_TAKEN` | 该成员已被他人认领 | 提示 + 刷新认领列表 |
| `TASK_NOT_FOUND` | 任务已被删除 | 提示 + 刷新 |
| `INVALID_PARAM` | 参数校验失败 | 提示具体原因 |

---

## 6. 周期任务模板

### 6.1 模板字段

管理员在云开发控制台 → `periodic_templates` 集合直接维护，或调
`templateService` 的 `create` / `update` action（在云函数的测试面板里更方便）。

```js
{
  name: '月度监管报送',                     // 模板名（内部用，不出现在任务上）
  periodType: 'monthly',                   // monthly | quarterly | yearly
  triggerDate: '每月 1 日',                 // 说明性文字，实际由每日巡检生成
  taskNameTemplate: '{{YYYY年MM月}}监管报送', // ★ 支持占位符
  ownerId: 'oXXXX',                        // 主办人 openid（必填）
  ownerName: '张三',                        // 由服务端解析，不用手填
  collaboratorIds: ['oYYYY'],
  collaboratorNames: ['李四'],
  deadlineRule: '当月 25 号',               // ★ 截止日规则
  enabled: true,

  // 生成任务时的默认值
  category: '监管报送',
  source: '总行通知',
  taskType: '周期性',                       // 恒为此值，不可配
  recurFreq: '每月',
  priority: 'P2',
  detail: '按监管要求报送月度数据',

  createdAt, updatedAt
}
```

### 6.2 占位符与截止日规则

**任务名占位符**（`taskNameTemplate` 中可用）：

| 占位符 | 渲染结果（以 `2026-10` 为例） |
|---|---|
| `{{YYYY}}` | `2026` |
| `{{MM}}` | `10` |
| `{{YYYYMM}}` | `202610` |
| `{{YYYY年MM月}}` | `2026年10月` |
| `{{deadline}}` | `2026-10-25`（由 `deadlineRule` 算出） |

> 无法识别的占位符会**原样保留**在任务名里，不会被静默吞掉 —— 
> 写错时你能一眼看出来，而不是拿到一个少了半截的名字。

**截止日规则**（`deadlineRule`）：

| 写法 | 含义 |
|---|---|
| `当月 25 号` | 本周期第 25 天 |
| `次月 5 号` / `下月 5 号` | 下一周期第 5 天 |
| `当月末` | 本周期最后一天 |

> 边界已处理：2 月写 30 号会**收敛到 2 月最后一天**（28/29 号），
> 不会在 3 月 2 号生成一个"2 月 30 号到期"的任务。

### 6.3 幂等保证

**需求第 10.4 节要求「周期生成函数必须幂等（重复触发不产生重复任务）」。**

采用**确定性 `_id`** 实现，而不是"先查再写"：

```js
_id = `pt-${templateId}-${periodKey}`   // 如 pt-tpl001-2026-10
```

- 同一模板 + 同一周期 = 同一个 `_id`。
- 重复插入时数据库**主键冲突**直接拒绝，这是唯一并发安全的机制。
- 冲突被 `isDuplicateError()` 识别后记为 `skipped`（**正常路径，不是错误**）。

> **为什么不用"先查后写"**：查与写之间存在时间窗（TOCTOU 竞态），
> 两个实例同时执行时都会查到"不存在"，然后都去写，结果产生两条重复任务。
> 主键冲突没有这个窗口。

> **为什么不做全局运行锁**：锁一旦因中途失败没释放，会导致**整个月永久跳过**
> —— 这比偶尔重复生成危险得多。策略是"宁可多跑，不可少跑"。

**分层防护**：

| 层 | 机制 | 作用 |
|---|---|---|
| 第 1 层 | `count()` 预检 | 廉价快速跳过已生成的周期（纯优化，不是安全保证） |
| 第 2 层 | **确定性 `_id`** | **硬保证**：并发/重复触发都不会产生重复任务 |

### 6.4 手动补跑

万一某个周期漏生成（例如环境连续多日异常），管理员可以手动补：

在云开发控制台 → 云函数 `generatePeriodicTasks` → **测试**，
测试事件填：

```json
{ "action": "generateNow", "payload": { "periodKey": "2026-11" } }
```

`periodKey` 留空则生成**当前周期**。可加 `"dryRun": true` 预演，
只返回"会生成什么"而不写库。

> 该函数会自动识别调用来源：定时器触发的走定时分支；
> 手动调用的要求调用者是管理员。

---

## 7. 二次开发

### 7.1 改枚举值

所有枚举集中在 [`shared/constants.js`](shared/constants.js)。
加一个任务分类只需改 `CATEGORY` 数组，**前端筛选器、表单 picker、云函数校验会同时生效**。

改完必须执行：

```bash
node scripts/sync-shared.js     # 分发到两端
node scripts/selfcheck.js       # 125 项断言，改坏了立刻能发现
```

### 7.2 改权限规则

权限逻辑集中在 [`shared/perm.js`](shared/perm.js)，**前后端共用同一份文件**。
改一处，两端口径自动一致，不会漂移。

### 7.3 加一个写操作

1. 在对应云函数（如 `taskService/index.js`）里写一个 `async function xxx(payload, ctx)`
2. 用 `ctx.requireMember()` / `ctx.requireLeaderOf(task)` / `ctx.requireParticipantOf(task)`
   做权限校验 —— **不要自己写权限判断**，否则两端口径会漂移
3. 用 `validate.pick(payload, WHITELIST)` 过滤字段 —— 白名单外的一律丢弃
4. 注册到 `exports.main = createRouter({ ..., xxx })`
5. 在 [`miniprogram/utils/api.js`](miniprogram/utils/api.js) 加一行语义化封装

### 7.4 自检脚本

```bash
node scripts/selfcheck.js
```

125 项纯逻辑断言，覆盖**点击 UI 验证不到的部分**：

- 日期补零（`'2026-9-5'` 必须被拒绝，否则会破坏字符串排序）
- 截止日边界（2 月 30 号收敛、跨月、跨年）
- 占位符渲染（含未知占位符保留）
- 幂等键确定性（同一输入必须产出同一 `_id`）
- **权限矩阵**（含 `同名不同 openid 拿不到主办权限`、`openid 为空拒绝一切`）
- 字段白名单（`leaderId`/`updaterId` 必须不在任何白名单里）
- 进展记录构造（`blockerResolved` 三态、`appliedChanges` 必须是拷贝）
- 枚举完整性

**每次改 `shared/` 之后都要跑一遍。**

### 7.5 关闭 AI 精简

`callAI` 默认关闭，前端按钮会提示"AI 精简未启用（联系管理员配置）"，输入框照常可用。

开启步骤：

1. 云开发控制台 → 云函数 `callAI` → **配置** → 环境变量：
   - `AI_ENABLED` = `true`
   - `DEEPSEEK_API_KEY` = 你的密钥
   - （可选）`DEEPSEEK_MODEL` = `deepseek-chat`
2. 把 `callAI` 超时调到 **20 秒**
3. 重新部署

> ⚠ **密钥只通过环境变量注入，不要写进代码、不要提交到仓库。**
> `.gitignore` 已排除本地环境变量文件。

> **AI 失败绝不阻断录入**（需求第 10.3 节）：`callAI` 在任何异常下都返回
> `{ text: 原文, aiApplied: false, reason }`，**从不抛错**。
> 前端拿到 `aiApplied: false` 只提示一句原因，用户可继续手动编辑并提交。

### 7.6 开启订阅消息

本期未做，但入口已预留：[`shared/notify.js`](shared/notify.js) 的 `send()`
目前只打印日志并返回 `{skipped: true}`，`NOTIFY_ENABLED = false`。

接入时：在 `send()` 内调 `cloud.openapi.subscribeMessage.send()`，
并在小程序端补 `wx.requestSubscribeMessage` 的授权时机（建议在用户提交进展后）。

### 7.7 Web 端接入

全部写操作已在云函数中按 `action` 路由封装，数据结构也是端无关的。
Web 端接入时：

- 复用同一批云函数（HTTP 触发或云开发 Web SDK）
- 复用 `shared/` 里的 `constants.js` / `perm.js` / `validate.js`（纯 CommonJS，无平台依赖）
- 只需重写 UI 层与登录态获取（`ctx.js` 里 `resolveOpenid` 换成 Web 端的身份来源）

---

## 8. 常见问题

**Q：预览报 `错误码：80082, get plugin(...) failed, permission deny`**
说明 `app.json` 里声明了账号未授权的插件。本项目**不使用任何插件**，
所以正常情况不会出现这个错。若你手动加了插件声明，删掉即可 ——
详见 [3.3](#33-语音录入本期不做无需任何配置)。

**Q：输入框里为什么没有录音按钮？**
本期不做内置语音。想用语音就**长按手机输入法自带的麦克风**，效果一样。
见 [3.3](#33-语音录入本期不做无需任何配置)。

**Q：进入小程序一片空白 / 报「云开发未初始化」**
`miniprogram/config.js` 的 `envId` 没改，或与云开发控制台的环境 ID 不一致。

**Q：报「服务异常，请稍后重试」，怎么定位真实原因？**
这句话是云函数的兜底文案，真实堆栈**只写进云函数日志、不回传前端**（这是有意的，
避免把内部细节暴露给使用者）。查看方式：

> 云开发控制台 → 云函数 → 选中对应的函数 → **日志** → 看最近一次调用的
> `[router] 未捕获异常 action=xxx openid=xxx` 那一行，后面跟着完整堆栈。

常见的几种会被自动翻译成可读提示（不必查日志）：

| 日志里的错误 | 实际原因 |
|---|---|
| `-502005 collection not exists` | 集合没建，或云函数部署到了另一个环境 |
| `Cannot find module 'wx-server-sdk'` | 部署时选了「上传并更新文件」，应选「上传并部署：云端安装依赖」 |
| `-502001 permission denied` | 集合与云函数不在同一环境 |

**Q：报「数据库集合「xxx」不存在」**
两种情况，按顺序排查：

1. **集合还没建** —— 见 [3.4](#34-创建数据库集合)，5 个集合一个都不能少
2. **云函数和小程序不在同一个环境** —— 云函数用的是 `DYNAMIC_CURRENT_ENV`
   （跟随**部署时所在的环境**），不是 `config.js` 里的 `envId`。
   如果你有多个环境，在 A 环境部署了云函数、`config.js` 却指向 B 环境，
   函数就会去 A 里找集合，而集合建在 B 里。
   核对：云开发控制台左上角的环境名，应与 `config.js` 的 `envId` 对应。

**Q：认领页下拉列表是空的**
`members` 集合没导入数据，或所有成员都已被认领。

**Q：导入历史任务表后，任务都在看板上，但「我主办的」是空的、也点不动编辑**
这是**预期**的中间状态，不是 bug：历史表里只有姓名，权限判定只认 openid，
导入时 `leaderId` 还是空的。让本人认领一下，或由管理员在「人员」Tab 点
「把历史任务关联到已认领的同事」补上。详见 [3.9](#39-导入历史任务表可选)。

**Q：点了「把历史任务关联到已认领的同事」，补上的条数是 0**
按顺序排查：

1. **大家都还没认领** —— 认领之前没有 openid 可关联，按钮在这种情况下不显示
2. **姓名对不上** —— 历史表里写的名字和 `members` 名单里的**不完全一致**
   （最常见的是多一个空格、用了简称）。在控制台比对两个集合里的姓名
3. **已经补过了** —— 这个操作幂等，重复点会返回 0，是正常的

**Q：导入任务表时报 `invalid character ']' looking for beginning of value`**
导入文件必须是 **JSON Lines**（每行一个文档，无外层 `[]`）。
别手工改，重新跑 `node scripts/make-task-import.js` 生成即可。

**Q：改了任务名重新导入，结果多出来一个任务**
导入用的 `_id` 是按**任务名**算的稳定哈希，改名就等于换了一个 `_id`，
于是变成新增而不是覆盖。已导入的任务要改名请在界面上改，
不要改源 CSV 重导。详见 [3.9](#39-导入历史任务表可选)。
注意：**已被认领的成员不会出现在认领列表里**（避免重复认领）。

**Q：导入成员名单报 `解析json文档错误 … invalid character ']' looking for beginning of value`**
直接导入了 `members.json`。云开发要的是 JSON Lines（每行一个文档，无外层 `[]`），
先跑 `node scripts/make-member-import.js`，导入生成的 `members.import.json`。
详见 [3.6](#36-导入成员名单)。

**Q：认领页不显示某个人 / 认领时提示「该成员已被他人认领」，但明明没人认领**
该记录的 `openid` 字段**不存在**（而不是空串）。云开发是 MongoDB 语义，
`where({ openid: '' })` 匹配不到没有该字段的文档 —— 于是认领页查不到它，
认领的 CAS 条件也不成立，就会走到"抢占失败"分支报「已被他人认领」。
解决：重新跑 `node scripts/make-member-import.js`（它会补上 `openid: ""`），
或在控制台手动给这些记录加 `openid: ""`。

**Q：认领时提示「该成员已被其他账号认领」**
这条记录已绑定了别的 openid。若确认是误绑（例如同事点了别人的名字），
让管理员调 `memberService` 的 `adminResetBinding` 重置，或直接在控制台
把该记录的 `openid` 改回 `""` 并清空 `claimedAt`。

**Q：看板上的任务比实际少**
大概率是漏了分页。小程序端 `get()` **单次最多返回 20 条且静默截断**（不报错）。
本项目所有全量查询都走 `utils/db.js` 的 `fetchFrom()` 分页循环。
自己新增查询时**必须**用它，不要直接 `.get()` 当全量用。

**Q：卡壳标记没有消失**
卡壳高亮读的是 `tasks.hasOpenBlocker` 冗余字段，由云函数在每次写进展后
**整体重算**。若数据被手工改过（例如在控制台直接改 `progress_records`），
冗余字段不会自动更新 —— 此时对该任务任意上报一次进展即可触发重算。

**Q：本地调试时提示身份为空 / `OPENID` 取不到**
云函数在开发者工具本地调试时可能拿不到 `OPENID`。
可临时给云函数加环境变量 `ALLOW_MOCK_OPENID=true`，并在调用时传 `__mockOpenid`。
> ⚠ **生产环境必须为 `false` 或不设置。** 开启后任何人都能伪造身份。

**Q：周期任务某个月没生成**
1. 检查模板的 `enabled` 是否为 `true`
2. 检查 `generatePeriodicTasks` 的触发器是否还在（控制台 → 触发器）
3. 看 `job_logs` 集合里有没有当天的记录，以及 `failed` 数组内容
4. 确认无误后用 [6.4](#64-手动补跑) 的手动补跑补上

**Q：改了 `shared/` 但小程序端没生效**
忘了跑 `node scripts/sync-shared.js`。可用 `node scripts/sync-shared.js --check`
检测两端是否一致。

---

## 9. 已知限制

以下是**代码层面无法消除**的限制，需要使用者知情：

| 限制 | 说明 | 缓解措施 |
|---|---|---|
| **中文重名** | 两个"张伟"会在认领页和协办人选择器里混淆 | 已加 `dept` 字段辅助区分，但录入名单时仍需管理员注意 |
| **改名不追改历史** | `leader`/`collaborator`/`updaterName` 是写入时的快照，成员改名后旧记录仍显示旧名 | 这是**刻意的设计**——快照保证历史记录不会被后来的人事变动篡改。需要时可调管理员的批量修正 action |
| **微信昵称不参与逻辑** | 姓名完全以 `members` 集合为准，与微信昵称无关 | 无 |
| **无内置语音录入** | 本期不做语音插件（见 [3.3](#33-语音录入本期不做无需任何配置)），依赖手机输入法自带的语音转文字 | 输入法语音在任意 `textarea` 里都能用，效果等同插件。若将来要内置，需自建录音 + 第三方 ASR |
| **定时触发无重试** | 微信云函数的定时触发器失败后不会自动重试 | 已用「每日巡检 + 确定性 `_id`」规避；极端情况（连续多日环境异常）需管理员手动补跑 |
| **前端直连可读取全部数据** | `tasks`/`members`/`progress_records` 设为 `read: true`，任何登录用户可读全量 | 这是团队内部工具的合理取舍（10 余人、全部是同事）。若需按人隔离，改为走云函数读并在函数内做行级过滤 |
| **无操作审计** | 除周期生成外，其他写操作不留审计日志 | 如需要，可在 `shared/router.js` 的 `createRouter` 里统一追加写入 `job_logs` 或新建 `audit_logs` |
| **Web 端未实现** | 本期只交付小程序端 | 云函数与数据结构已按多端共用设计，见 [7.7](#77-web-端接入) |

---

## 附：部署检查清单

复制这份清单逐项打勾，避免漏步：

- [ ] `project.config.json` 的 `appid` 已改为真实 AppID
- [ ] 云开发环境已开通，`miniprogram/config.js` 的 `envId` 已填
- [ ] 5 个集合已创建，安全规则均为 `{"read": true/false, "write": false}`
- [ ] 索引已建（至少 `members.openid` 与 `tasks.templateId+periodKey` 两个唯一索引）
- [ ] 已跑 `node scripts/make-member-import.js`，并把生成的 `members.import.json`
      （**不是** `members.json`）导入 `members` 集合
- [ ] 导入的每条记录都**显式含** `openid: ""`（在控制台点开一条确认，不能是"无此字段"）
- [ ] 名单里至少有一个人 `role` 是 `管理员`
- [ ] 7 个云函数已上传部署
- [ ] `generatePeriodicTasks` 与 `templateService` 超时调至 60s，`callAI` 与 `memberService` 调至 20s
- [ ] `generatePeriodicTasks` 的定时触发器已生效
- [ ] 验证：小程序端直连 `tasks.add()` 被拒绝（证明安全规则生效）
- [ ] 验证：两个账号同时认领同一人，只有一个成功
- [ ] 验证：协办人界面看不到进度/状态编辑区
- [ ] 至少一个管理员账号已认领（否则无法管理模板）

想把已有任务表一次性导进来时，追加：

- [ ] 已把历史表存成 `scripts/tasks.source.csv`，跑通 `node scripts/make-task-import.js`
- [ ] 跳过的行已补全并单独重导（脚本结尾会列出）
- [ ] `tasks.import.json` 与 `progress_records.import.json` 分别导入对应集合
- [ ] 大家认领完，管理员在「人员」Tab 点「把历史任务关联到已认领的同事」
- [ ] 验证：点进某个任务，「我主办的」列表里出现该任务、主办人能编辑
