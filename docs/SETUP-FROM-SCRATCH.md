# MinTask 从零搭建手册

> 这份手册覆盖**从一台空电脑到数据导完**的全过程，包括仓库之外的部分
> （装工具、配 AI 助手、注册小程序、开通云开发）。
>
> 项目本身的部署细节见 [README](../README.md) 第 3 章。本手册是"怎么操作"，
> README 是"为什么这么做"。

**环境选型**：IDE 用 **VS Code** · Agent 用 **Claude Code** ·
网关用 **CC Switch** · 大模型用 **DeepSeek**（详见 [0.1](#01-本手册使用的环境选型)）

**预计耗时**：装工具 30 分钟 → 注册小程序 1 天（等审核）→ 云开发与部署 40 分钟。

---

## 0. 总览

### 0.1 本手册使用的环境选型

写作时**确定使用**下面这套组合，四层各司其职，换掉任意一层都不影响另外三层：

| 层 | 选型 | 作用 | 装在哪 |
|---|---|---|---|
| **IDE** | **VS Code** | 看代码、改代码的编辑器 | [1.3](#13-vs-code) |
| **AI Agent** | **Claude Code** | 真正干活的编程助手，读写文件、执行命令 | [1.4](#14-claude-code) |
| **供应商网关** | **CC Switch** | 切换 / 管理 Agent 连哪个大模型，GUI 改配置 | [1.5](#15-接-deepseekcc-switch) |
| **大模型（LM）** | **DeepSeek** | 提供模型能力，按 token 计费 | [1.5](#15-接-deepseekcc-switch) |

为什么是这四层、而不是"装个 AI 编辑器就完事"：

```
   你在哪写代码        谁替你干活          走哪条线           谁在思考
   ────────────       ──────────         ──────────        ──────────
   VS Code     ──▶    Claude Code  ──▶   CC Switch  ──▶    DeepSeek
   （编辑器）          （Agent）          （网关）           （大模型）
```

拆开的好处是**可以单独换**：DeepSeek 出故障就切别的模型（网关那层换），
不想用命令行就换别的 Agent（Agent 那层换），编辑器更是随便换。
配置全在 CC Switch 一个界面里，不用去记环境变量。

> ★ 本手册其余部分默认你**用这套组合**。如果某一层换了别的产品，
> 对应的那一小节可以跳过，但**第 2、3 章（小程序、云开发、部署）完全不受影响** ——
> 那些是本项目的部署步骤，跟用什么 AI 工具无关。

### 0.2 三个阶段

```
①  装工具              ②  拿入场券            ③  把项目跑起来
─────────────────      ──────────────────    ──────────────────
Node.js                注册小程序             填 AppID / 环境 ID
Git for Windows        ↳ 拿到 AppID           部署 9 个云函数
VS Code                装开发者工具            建 6 个集合 + 索引
Claude Code            开通云开发              导成员名单
CC Switch ← DeepSeek   ↳ 拿到环境 ID          导历史任务表
```

**本文中 ★ 的条目是踩过坑的地方，跳过会出问题。**

---

## 1. 装开发工具

按顺序装。1.1 / 1.2 是**所有后续步骤的前提**，1.3–1.5 是 [0.1](#01-本手册使用的环境选型)
那四层工具链。

### 1.1 Node.js

到 <https://nodejs.org> 下载 **LTS 版本**（18 以上），一路下一步。

Windows 安装时**务必勾选 `Add to PATH`**，否则命令行里找不到 `node`。

装完开一个新的命令行窗口验证：

```bash
node -v      # 应显示 v18.x 或更高
npm -v
```

> 必须**新开窗口**。安装程序改的是系统环境变量，已经开着的窗口读不到。

### 1.2 Git for Windows

到 <https://git-scm.com/download/win> 下载安装，全部默认即可。

**这一步不能省** —— Claude Code 在 Windows 上要靠 Git 自带的 bash 执行命令，
没有它会在启动时报错。

### 1.3 VS Code

> **本层选型：IDE = VS Code**（[0.1](#01-本手册使用的环境选型)）

到 <https://code.visualstudio.com> 下载安装。

装完后建议装一个中文语言包：左侧扩展面板搜 `Chinese` → 安装 → 重启。

### 1.4 Claude Code

> **本层选型：AI Agent = Claude Code**

```bash
npm install -g @anthropic-ai/claude-code
```

验证：

```bash
claude --version
```

**两种用法，任选其一或都用**：

| 方式 | 怎么用 | 适合 |
|---|---|---|
| VS Code 扩展 | 扩展面板搜 `Claude Code` 安装，在编辑器里开面板 | **推荐**，接着 VS Code 用 |
| 命令行 | 在项目目录下敲 `claude` | 快速改点东西 |

装 VS Code 扩展的话，它会自动复用同一套 `settings.json` 配置，
所以**下一步配好的 DeepSeek 两种用法都生效**，不用配两遍。

### 1.5 接 DeepSeek（CC Switch）

> **本层选型：网关 = CC Switch，大模型 = DeepSeek**

Claude Code 默认连 Anthropic 官方。要让**它**（Agent）走 **DeepSeek**（大模型），
中间由 **CC Switch**（网关）来改配置 —— 这三层的关系见
[0.1](#01-本手册使用的环境选型)。

**① 装 CC Switch**

到 <https://github.com/farion1231/cc-switch> 的 **Releases** 页面，
Windows 下载 `.msi` 安装包（或 `-Portable.zip` 绿色版）。

**② 拿 DeepSeek API Key**

到 <https://platform.deepseek.com/api_keys> 注册并创建一个 Key，
形如 `sk-xxxxxxxx`。**创建后只显示一次，当场复制存好。**

> Key 是要花钱的凭证。别贴到聊天记录、issue、代码注释里。

**③ 在 CC Switch 里添加供应商**

打开 CC Switch → 添加供应商 → 填：

| 字段 | 值 |
|---|---|
| 名称 | `DeepSeek`（随便起） |
| Base URL | `https://api.deepseek.com/anthropic` |
| API Key | 上一步拿到的 `sk-xxxx` |
| 模型 | `deepseek-v4-flash`（主力）/ `deepseek-v4-pro`（重活） |

填完点「启用」，它会自动写进 `C:\Users\<你的用户名>\.claude\settings.json`。

**④ 验证配置**

配好之后这个文件应该长这样（Key 换成你自己的）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-你的DeepSeek密钥",
    "ANTHROPIC_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1M]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash[1M]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  },
  "includeCoAuthoredBy": false
}
```

> `[1M]` 是**上下文长度**标记（100 万 token），加上它才能一次读进整个项目。
> 加 `[1M]` 可能会被某些终端当成通配符，遇到报错就给模型名加引号。

**⑤ 试一下**

```bash
cd G:\TeamPulse
claude
```

能正常对话就成功了。第一次会问你是否信任这个目录，选是。

> **为什么用 CC Switch 而不是手改环境变量**：手改要同时维护五个环境变量，
> 换机器时容易漏；CC Switch 是图形界面，还能一键测试连通性、保留多套配置。

---

## 2. 拿微信小程序的入场券

### 2.1 注册小程序，拿到 AppID

1. 打开 <https://mp.weixin.qq.com> → 右上角 **「立即注册」** → 账号类型选 **「小程序」**

2. 填邮箱、密码，收激活邮件并点击链接

   > ★ **必须用没注册过微信公众平台/开放平台的邮箱**，否则会提示被占用。
   > 一个邮箱只能注册一个小程序。

3. 选择**主体类型**：

   | | 个人 | 企业 / 个体工商户 |
   |---|---|---|
   | 材料 | 身份证 + 人脸识别 | 营业执照、法人身份证、对公账户 |
   | 费用 | 免费 | 认证费约 **300 元/年** |
   | 耗时 | 几小时 | 1–5 个工作日 |
   | 限制 | 不能用微信支付、部分接口不可用 | 无 |

   > ★ **主体类型提交后无法修改。**
   >
   > 团队内部工具用**个人主体就够** —— 云开发、云数据库、云函数都能用，
   > 限制的那些（微信支付、部分定位接口）本项目一个都不涉及。

4. 审核通过后，登录 <https://mp.weixin.qq.com> → 左侧 **「开发」→「开发管理」→「开发设置」**，
   找到 **AppID（小程序 ID）**，形如 `wx9b44b7b4f10a5b32`。

   > 这个页面还能看到 **AppSecret**。本项目**用不到** AppSecret，
   > 不要把它写进代码 —— 云函数用的是微信自动注入的 OPENID，不需要密钥。

**关于备案**：2023 年 9 月起，小程序**上线发布前**必须完成 ICP 备案。
但**开发和内测阶段不需要** —— 只要不点「发布」，预览和体验版都能一直用。
内部工具可以不发布，就一直不用备案、云环境也一直免费。

### 2.2 装微信开发者工具

到 <https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html>
下载 **稳定版 Stable Build**，安装。

第一次打开会让你用微信扫码登录 —— **用注册小程序时绑定的那个微信**，
否则看不到你的小程序。

### 2.3 开通云开发，拿到环境 ID

1. 开发者工具 → 新建/打开项目后，点工具栏上的 **「云开发」** 按钮
2. 首次会提示开通 → 点 **「开通」**
3. 填**环境名称**（如 `teampulse-prod`）
4. 选**计费方式**

   > ★ 这里的计费选项和免费额度**经常调整**，网上各处的说法互相矛盾，
   > **以你控制台实际显示的为准**。
   >
   > 关键判断标准只有一条：**确认月费用是 0 元再提交**。
   > 通常选「按量付费」或「免费体验」，在额度内不会产生费用。
   > 如果控制台要求付费才能继续，先把金额记下来，别急着付。

5. 创建完成后，在 **云开发控制台 → 设置 → 环境 ID** 找到环境 ID，
   形如 `cloudbase-d4gvt9mox2e73b8fb` —— **记下来，第 3 章要用**。

> ★ **一个坑**：云函数跟随的是**部署时所在的环境**（代码里用的是
> `cloud.DYNAMIC_CURRENT_ENV`），不是 `config.js` 里写的 envId。
> 如果你开了多个环境，在 A 环境部署了云函数、`config.js` 却指向 B，
> 函数就会去 A 里找集合而集合建在 B 里，报「数据库集合不存在」。
> **本项目一个环境就够，别开多个。**

---

## 3. 把项目跑起来

### 3.1 打开项目

微信开发者工具 → **「导入项目」** → 目录选 `G:\TeamPulse` → 填 AppID → 导入。

导入后应该能直接编译通过，**没有任何构建步骤**（这是项目的硬性约束）。

### 3.2 填 AppID 和环境 ID

两处，都必须填对：

**① `project.config.json`**

```json
"appid": "wx9b44b7b4f10a5b32"
```

**② `miniprogram/config.js`** —— 这是**部署时唯一需要手改的文件**

```js
module.exports = {
  envId: 'cloudbase-d4gvt9mox2e73b8fb',
  ...
```

> ★ 填错或不填，小程序启动会报「云开发未初始化」。

### 3.3 部署云函数

开发者工具左侧展开 `cloudfunctions` 目录，**逐个**右键下面 8 个函数：

```
memberService   taskService   progressService   templateService
generatePeriodicTasks   callAI   notifyService   demandService
```

> `dashboardService` 不在这份清单里 —— 它是可选的电脑端看板云函数，
> 只 require `wx-server-sdk`、不使用 `shared/`，见 `dashboard/README.md`。

选择 **「上传并部署：云端安装依赖」**。

> ★ **不要选「上传并更新文件」**。那个选项跳过 `npm install`，
> 部署完调用时报 `Cannot find module 'wx-server-sdk'`。
> 这是最容易踩的坑，因为它看起来更"快"。

部署完到 **云开发控制台 → 云函数**，改四个函数的超时时间：

| 函数 | 超时 | 原因 |
|---|---|---|
| `generatePeriodicTasks` | **60 秒** | 默认 3 秒，批量生成模板会超时 |
| `templateService` | **60 秒** | 平时用不到，但手动补跑（`generateNow`）走同一套批量生成逻辑 |
| `callAI` | **20 秒** | 内部 HTTP 超时 8 秒，要留冷启动余量 |
| `memberService` | **20 秒** | 认领时要顺带关联历史数据，几百次写操作会超过 3 秒 |

> `templateService` 现在配上 60 秒是预防 —— 它的增删改都是单文档操作，
> 3 秒本来够用，但哪天给「手动补跑周期任务」加了按钮（见
> [7.6](#76-手动补跑周期任务)），忘了改超时就会生成到一半中断。

> ★ **`memberService` 也必须调**，别以为它只是"查个人"。
> 认领和历史任务关联都要全量扫描任务表再逐条回填，
> 任务一多，默认 3 秒就不够，表现是偶发超时报错。
>
> 控制台改完超时**需要重新部署一次**才生效，或改完回控制台确认已保存。

#### ★ 以后每次改了云函数代码，都要重新走一遍这一步

**这是最容易忘、且报错信息最难懂的一步。**

改完 `cloudfunctions/` 下的代码，微信云端跑的还是你上次部署的那份 ——
本地改了不等于线上生效，**没有热更新**。忘了部署的典型症状是：

```
未知操作：adminRelinkMembers
```

这句话的意思是"云函数的 action 路由表里没有这个名字"，
但你本地代码里明明写了。**它不是代码写错了，是云上还是旧版本。**

所以改完云函数代码的固定动作是：

| 改了什么 | 要不要重新部署 |
|---|---|
| `cloudfunctions/<某个函数>/` 下的任何文件 | ✅ 那个函数要重新部署 |
| `shared/` 下的文件 | ✅ 先跑 `sync-shared.js`，**再部署用到的函数** |
| `miniprogram/` 下的文件 | ❌ 不用，开发者工具自动编译 |

> ★ `shared/` 是最容易漏的：它改了之后要**两步** ——
> 先 `node scripts/sync-shared.js` 把副本写进各云函数目录，
> 再右键部署对应函数。少任何一步都不生效。
>
> 因为 `sync-shared.js` 会改 8 个云函数目录里的文件，
> 保险做法是全部重新部署一遍（8 个，一分钟的事），
> 而不是去猜"用到的是哪个"。

### 3.4 建集合、安全规则、索引

**① 建 6 个集合**

云开发控制台 → 数据库 → 「+ 新建集合」，名字必须完全一致（区分大小写）：

```
members    tasks    progress_records    periodic_templates    job_logs    demands
```

**② 配安全规则**

每个集合 → 「权限设置」→ 选**自定义安全规则**，按下面填：

| 集合 | 安全规则 |
|---|---|
| `members` / `tasks` / `progress_records` | `{"read": true, "write": false}` |
| `periodic_templates` / `job_logs` / `demands` | `{"read": false, "write": false}` |

> ★ **不要选「仅创建者可读写」**。云函数写入的记录不带 `_openid` 字段
> （那个字段只有小程序端 SDK 直接写入时才自动加），
> 任何基于 `_openid` 的规则在本架构下全部失效。
>
> 读直连数据库、写全部走云函数 —— 这是本项目的权限模型，
> `write: false` 是关键的那一半：它保证前端**没有任何**直接改数据的能力。

**③ 建索引**

数据库 → 选中集合 → 「索引管理」→ 新建。带 ★ 的是唯一索引，必须建。

| 集合 | 索引字段 | 唯一 |
|---|---|---|
| `members` | `openid` | ★ 是 |
| `members` | `name` | ★ 是 |
| `tasks` | `templateId` + `periodKey` | ★ 是（周期任务防重） |
| `tasks` | `leaderId` + `stage` | 否 |
| `tasks` | `collaboratorIds` + `stage` | 否 |
| `tasks` | `stage` + `category` | 否 |
| `progress_records` | `taskId` + `updatedAt`（降序） | 否 |
| `demands` | `status` | 否 |
| `demands` | `proposerId` | 否 |
| `demands` | `claimedById` | 否 |

> 两个 `members` 唯一索引**必须在导入名单前建好**，
> 否则重复姓名导进去之后清理起来很麻烦。

### 3.5 导入成员名单

在项目目录下：

```bash
node scripts/make-member-import.js
```

生成 `scripts/members.import.json`。

如果团队名单有变，先改 **`scripts/members.json`**（这个才是源文件）再跑脚本。

> ★ 脚本会校验重名、空名、有没有管理员，有问题会直接拒绝生成文件。
> **务必确保至少一个人是 `管理员`**，否则导完谁都管不了模板和删除。

导入：云开发控制台 → 数据库 → `members` 集合 → **「导入」** →
冲突处理方式选 **Insert** → 选 `scripts/members.import.json`。

> ★ **要导的是 `members.import.json`，不是 `members.json`。**
> 云开发要的是 **JSON Lines** 格式（每行一个独立文档，无外层 `[]`）。
> 直接导 `members.json` 会报
> `解析json文档错误 … invalid character ']' looking for beginning of value`。

导完**你自己先**在认领页选中你的名字完成认领 —— 认领之后你才真正拿到管理员权限。
再让每位同事各自认领。

> ★ **名单要加人时，不要整份重新导入。** 导入文件里没有 `_id`，
> 云开发每次导入都生成新 `_id`，所以"重导一遍"是**新增**不是覆盖，
> 撞上 `members.name` 唯一索引会直接失败。
> 加人：把导入文件里**已存在的行删掉**再导。改名/调角色：直接在控制台改那一条。

### 3.6 导入历史任务表（可选）

已有 Excel/CSV 历史任务表时，可一次性铺好初始数据。

1. 把历史表存成 CSV 放到 `scripts/tasks.source.csv`
2. `node scripts/make-task-import.js`
3. 按提示导入 `tasks` 和 `progress_records` **两个**集合

完整说明见 [README 3.9](../README.md#39-导入历史任务表可选)。

> ★ 导完后**「我主办的」会是空的、任务也点不动编辑** —— 这是**预期**的，不是 bug。
> 历史表里只有姓名，而权限只认 openid，openid 要等认领才产生。
> 每位同事认领时会自动补一次；全部认领完，管理员在「人员」Tab 点
> 「把历史任务关联到已认领的同事」收尾。

### 3.7 开启定时触发器（如果要用周期任务）

`generatePeriodicTasks/config.json` 已声明触发器，部署后到
**云开发控制台 → 云函数 → generatePeriodicTasks → 触发器** 确认已生效。

> 微信云函数的 Cron 是 **7 位**（秒 分 时 日 月 周 年），
> `0 5 0 * * * *` = 每天 00:05。与 Linux 的 5 位不同，别照抄网上的写法。

---

## 4. 验收清单

搭完后逐项打勾，全绿才算真的通了：

- [ ] 微信开发者工具里编译通过，4 个 Tab 都能切换
- [ ] 打开小程序能进认领页，下拉列表里有人名
- [ ] 认领后重新进入，直达「我主办的」
- [ ] **在开发者工具控制台执行 `db.collection('tasks').add({...})` 被拒绝** ← 证明 `write:false` 生效
- [ ] 能新建一个任务并看到它
- [ ] 导入的历史任务出现在看板上，且「我主办的」里也有（需先做过 3.6）
- [ ] 两个账号同时认领同一人，只有一个成功
- [ ] 协办人打开任务详情，**看不到**进度/状态的编辑入口

---

## 5. 出问题先看这里

完整排查见 [README 第 8 章](../README.md#8-常见问题)。最高频的几个：

| 现象 | 原因 |
|---|---|
| `Cannot find module 'wx-server-sdk'` | 云函数部署时选了「上传并更新文件」，要选「**上传并部署：云端安装依赖**」 |
| `数据库集合「xxx」不存在` | 集合没建，或云函数与小程序不在同一环境 |
| `没有权限，请先开通云开发`（-601034） | `config.js` 的 `envId` 没填或填错 |
| `invalid character ']' looking for...` | 导入的是标准 JSON 数组，要导脚本生成的 `.import.json` |
| 「服务异常，请稍后重试」 | 云函数内部错误，真实堆栈只写进**云函数日志**，去控制台看 |
| 认领页下拉是空的 | `members` 集合没导数据，或所有人都已认领 |

> ★ 看到「服务异常，请稍后重试」时，**这句话本身没有信息量**。
> 去 云开发控制台 → 云函数 → 选中函数 → **日志**，
> 找 `[router] 未捕获异常 action=xxx` 那一行，后面跟着完整原因。

---

## 6. 以后怎么用 AI 继续改这个项目

> 本节假定你用的是 [0.1](#01-本手册使用的环境选型) 那套：
> **VS Code + Claude Code + CC Switch + DeepSeek**。
> 在 VS Code 里打开 `G:\TeamPulse`，开 Claude Code 面板就能开始。

这个项目是**为持续用 AI 迭代而写**的，几个约定值得保持：

1. **改完 `shared/` 一定要跑同步脚本**

   ```bash
   node scripts/sync-shared.js
   ```

   `shared/` 是唯一源，两端用的是它的副本。忘了同步 → 改了没生效。

2. **改完逻辑跑一次自检**

   ```bash
   node scripts/selfcheck.js
   ```

   184 项纯逻辑断言，不连云环境，几秒钟出结果。覆盖日期计算、权限矩阵、
   幂等、字段白名单、协办名单合并这些"点界面验不出来"的部分。

3. **加新功能时先看 README 第 7 章**，那里写了加一个字段 / 加一个 action
   的完整步骤（要改哪几个文件、哪些地方容易漏）。

4. **别让 AI 自己发明枚举值和权限规则**。所有枚举都在
   `shared/constants.js`，权限判定都在 `shared/perm.js`，
   改之前先读这两个文件。

5. **Prompt 里带上约束**。"必须零构建步骤""身份只取自 OPENID"
   "前端隐藏不等于安全"这几条是硬约束，新开对话时提醒一下，
   否则很容易被"优化"掉。

6. **模型按活儿选**。CC Switch 里配了两个档：日常改动用
   `deepseek-v4-flash`（快、便宜），要一次读进整个项目做重构时切
   `deepseek-v4-pro[1M]`。切换就在 CC Switch 界面点一下，
   不用改任何代码或环境变量。

---

## 7. 日常运维

### 7.1 先搞清楚一件事：大部分管理操作目前要在控制台里做

云函数里实现了一批 `admin*` 操作（加人、改名、解绑等），但**大部分还没有对应的界面按钮**。
现状：

| 操作 | 怎么做 |
|---|---|
| 重新关联历史任务 | ✅ 小程序「人员」Tab 有按钮 |
| 以他人名义建任务 | ✅ 新建任务页，管理员可选主办人 |
| 删除任务 | ✅ 任务详情页，主办人或管理员可见 |
| 加人 / 改名 / 调角色 / 解绑 | ⚠️ **在控制台直接改数据库**（见下） |
| 手动补跑周期任务 | ⚠️ **暂无入口**，见 [7.6](#76-手动补跑周期任务) |

> ★ **为什么这些不能从云开发控制台的「云端测试」调**：
> 所有 `admin*` 操作都要先 `ctx.requireAdmin()`，而判断"你是不是管理员"
> 依赖调用者的 **OPENID**。控制台的云端测试没有微信身份，
> OPENID 是空的，必然报权限不足。
> 所以改数据只能走"控制台直接编辑文档"这条路。

### 7.2 加人

1. 云开发控制台 → 数据库 → **`members`** 集合 → 「+ 添加记录」
2. 按这个结构填：

```json
{
  "name": "新同事姓名",
  "dept": "创新研发中心",
  "role": "普通",
  "openid": "",
  "claimedAt": null
}
```

> ★ **`openid` 必须显式写成空串 `""`，不能省略这个字段。**
> 云开发是 MongoDB 语义，认领时用 `where({ openid: '' })` 找记录，
> **匹配不到"根本没有 openid 字段"的文档**。省略的后果是：
> 这个人不出现在认领页，而强行认领会报「该成员已被他人认领」——
> 明明没人认领却报已被认领，排查方向会被彻底带偏。

> `createdAt` 可加可不加（云函数创建时会带上，目前没有功能读它）。

填完让本人去认领页认领。认领后他名下的历史任务会自动关联。

### 7.3 同事改名字

**改 `members.name` 一个字段，会影响两处，都要处理：**

1. 控制台 → `members` 集合 → 找到那条 → 改 `name`
2. **历史快照不会自动跟着改**

第 2 点是个坑：`tasks` 里的 `leader` / `collaborator` 是**姓名快照**，
`progress_records` 里的 `updaterName` 同理 —— 它们是写入时按当时的姓名存下来的字符串，
**改 `members.name` 不会追溯修改它们**。

所以改完名字，界面上那些旧任务还会显示旧名字。要让快照也更新，
得在控制台里手工改 `tasks.leader` / `tasks.collaborator` / `progress_records.updaterName`。

> ★ 权限判定**不看姓名**，只看 `leaderId` / `collaboratorIds` / `updaterId`。
> 所以改名**不会**让人丢失任务权限 —— 受影响的是显示，不是权限。
> 这也是当初把权限和姓名分开的原因。

### 7.4 同事离职 / 换微信

在 `members` 集合里把那个人的：

| 字段 | 改成 |
|---|---|
| `openid` | `""` |
| `claimedAt` | `null` |

这样就解绑了，新来的人（或换微信的本人）可以重新认领这个姓名。

> ★ **他名下的任务不会自动转交，而且目前没有界面能转交。**
> `tasks.leaderId` 还指着旧 openid，那些任务会进入**没人能编辑**的状态
> —— 没有任何账号再持有那个 openid 了。
>
> 所以**解绑前先把他名下的任务列出来**，别先清空再想。
> 查的办法不用碰控制台：小程序「人员」Tab → 点他的名字 →
> 那一页按「主办 / 协办」两组列出了他的全部任务。
> 顺手把他的 openid 也从控制台复制下来备用（解绑后就查不到了）。
>
> 然后按情况处理：
>
> | 情况 | 怎么办 |
> |---|---|
> | 任务已完结 | 不用管，留在那儿当历史 |
> | 任务还在进行 | 控制台改 `tasks.leaderId` = 接手人的 openid（顺带改 `leader` 姓名快照） |
> | 只是换微信、人没走 | 让他用新微信认领同一个姓名，**然后把 `tasks.leaderId` 从旧 openid 改成新的** |
>
> ★ 最后那一行要特别注意：**重新认领不会自动接回旧任务**。
> 认领时自动跑的历史关联是"**只补空缺**"的 ——
> 它只填 `leaderId` 为空的记录，而这里 `leaderId` 是有值的（旧 openid），
> 所以关联会跳过它。这是有意的设计（否则重名的人会互相抢任务），
> 代价就是换微信这种场景得手工改一次。
>
> 接手人的 openid 从哪来：`members` 集合里他那一行的 `openid` 字段，复制即可。

### 7.5 新人认领后，历史任务没关联上

点「人员」Tab 的「把历史任务关联到已认领的同事」即可，它是幂等的，可以随时重跑。

如果补上的条数是 0，按顺序排查：

1. **姓名不完全一致** —— 最常见。历史表里写的名字和 `members.name` 对不上
   （多一个空格、用了简称），在控制台比对两个集合
2. **已经补过了** —— 幂等，重复点返回 0 是正常的
3. **任务表是空的** —— 见 [3.6](#36-导入历史任务表可选)

### 7.6 手动补跑周期任务

`generatePeriodicTasks` 每天 00:05 自动巡检，正常情况下不用管。
但如果连续几天环境异常导致没生成，或想提前生成下个月的，需要手动补跑。

**目前没有界面入口。** 原因是这个操作也要 `requireAdmin()`，
而控制台云端测试没有 OPENID，调不了。

- **在控制台手动建任务** —— 应急够用，但会丢周期任务的溯源字段。
  代价是：手工建的记录 `_id` 是随机的，和系统认的
  `pt-<templateId>-<periodKey>` 对不上，所以**那个月的模板一跑就会再生成一份**，
  变成两条。应急可以，记得下个月把手工那条删掉。
- **让 AI 加个按钮**（推荐）—— 说一句"给模板管理页加一个手动补跑按钮"即可。
  云函数侧的 `generateNow` 和 `api.js` 里的封装**都已经写好了**，
  只差一个页面按钮调它。顺便可以让 AI 把 `preview` 也接上 ——
  那是同一个功能的"只看不写"模式（dry run），
  补跑前先看看会生成什么，比直接跑稳妥。

> 加按钮时记得提醒 AI：`generatePeriodicTasks` 和 `templateService`
> 的超时要调成 **60 秒**，别按默认的 3 秒部署，否则会中途超时。

### 7.7 权限速查

界面上看不到的按钮，不代表后端没拦 —— **所有写操作都在云函数里强制校验**，
前端隐藏只是不让用户看到入口而已。真正的规则：

| 操作 | 主办人 | 协办人 | 其他人 | 管理员 |
|---|---|---|---|---|
| 改任务名称/分类/协办人/截止时间/进度/状态 | ✅ | ❌ | ❌ | ❌ |
| 新增进展记录 | ✅ | ✅ | ❌ | ❌ |
| 自由加入他人任务成为协办 | – | ✅ | ✅ | ✅ |
| 标记卡壳已解决 | ✅ | 仅限自己提交的 | ❌ | ❌ |
| 删除任务 | ✅ | ❌ | ❌ | ✅ |
| 周期模板管理 | ❌ | ❌ | ❌ | ✅ |

> ★ 删除任务的判据是 `shared/perm.js` 的 `canDeleteTask(task, openid, isAdmin)` ——
> 主办人或管理员。管理员这一条不能省：历史导入的任务里绝大多数没有 `leaderId`
> （本人还没认领），只允许主办的话那些任务会变成**谁都删不掉**。
>
> ★ 管理员**不能**改别人的任务内容 —— 这是有意的。
> 管理员管的是"结构"（成员、模板、删除），不是"业务数据"。
> 代价是**改派任务目前只能改库**（没有界面入口），办法见
> [7.4](#74-同事离职--换微信) —— 那也是离职/换微信时躲不掉的一步。
>
> 觉得这个限制碍事的话，可以让 AI 加一个「管理员改派任务」的 action +
> 按钮，是个小改动。

### 7.8 定时做的事

| 频率 | 事项 |
|---|---|
| 每次改完 `shared/` | `node scripts/sync-shared.js` → 重新部署云函数 |
| 每次改完逻辑 | `node scripts/selfcheck.js`（184 项，几秒） |
| 有改动想留痕时 | `git add -A && git commit -m "说明"` |
| 新人加入后 | 让他认领 → 点一次「关联历史任务」 |

---

## 附：本文涉及的外部地址

| 用途 | 地址 |
|---|---|
| Node.js | <https://nodejs.org> |
| Git for Windows | <https://git-scm.com/download/win> |
| VS Code | <https://code.visualstudio.com> |
| CC Switch | <https://github.com/farion1231/cc-switch> |
| DeepSeek API Key | <https://platform.deepseek.com/api_keys> |
| DeepSeek 接入 Claude Code 官方说明 | <https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code/> |
| 小程序注册 | <https://mp.weixin.qq.com> |
| 开发者工具下载 | <https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html> |
| 云开发计费说明 | <https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/billing/instruction.html> |

> 计费规则、模型名称这类信息调整频繁，本手册写于 2026-10。
> 对不上时以**官方控制台/文档的实际显示**为准。
