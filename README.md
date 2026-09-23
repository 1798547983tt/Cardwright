# Cardwright

[中文](#中文) · [English](#english)

---

## 中文

Cardwright 是面向 Windows 本地项目的 Agent 工作台：连接你自己的模型网关，让 Agent 完成任务，并在同一个界面里审阅修改、运行检查、管理小队。0.8 起另有独立的**制卡工坊**：跟着规划 AI 一步一步，把资料做成 SillyTavern 角色卡。

界面保持安静，确定性的规则由程序执行，技能和补充上下文按需提供给模型。所有模型请求都发往你自己配置的网关；密钥存在本机，由 Windows 凭据加密保护。

### 需要什么

- Windows 10 或 11（x64）。
- 一个你自己的模型网关：OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 协议都可以。
- 可选：Brave Search 或 SearXNG 的联网搜索凭据（与模型凭据分开保存）。

### 安装

从 [Releases](../../releases) 下载 `Cardwright-Setup-1.0.0.exe` 并安装。安装包没有代码签名，Windows 首次运行会提示「未知发布者」，可以选择「更多信息 → 仍要运行」。卸载时保留你的资料目录。

也可以自己构建：

```
npm install
npm run build
node scripts/package.mjs      # 便携版输出到 release/<版本>/Cardwright-win32-x64
```

### 第一次使用

1. 在「工作室设置 → Agent 与模型」添加网关，填写协议、Base URL 和密钥；从自动读取的列表里选择模型，或手动添加 ID。
2. 添加项目目录，在输入框里选网关、模型、上下文窗口与权限，然后发送任务。
3. 默认模式下，审阅实际路径和命令后再批准操作。受限命令默认不能联网，必要的本机命令需要另外批准。
4. 打开任务标题旁的侧栏面板，查看文件、改动、检查、终端、浏览器、计划和待办；面板可以拆成上下两块。
5. 在「工作台与验证」里配置项目检查命令。执行结束后，交付卡会分别显示文件修改和验证结果。

### 工作台

- **左栏**是会话列表：按项目分组，可以置顶、改名、归档、搜索；每条有状态点（运行中、待批准、已完成、失败、输出被截断）。
- **中间**是对话，保持阅读宽度。Agent 切换工作阶段时会标一条章节线，页边有圆点目录。回复或工具行里的 `路径:行号` 可以点开，右栏直接定位到那一行。
- **右栏**是可拆分的面板：文件、改动、检查、终端、浏览器、计划、待办。窗口窄于 960px 时左栏收成图标列，右栏变成覆盖在对话上的抽屉。
- **斜杠命令**：`/clear`、`/compact`、`/context`、`/cost`、`/model`、`/resume`、`/rewind`、`/init`、`/help`、`/plan`、`/todos`、`/memory`、`/dream`，以及你的技能。
- **Shift+Tab** 在默认审批 → 项目内自动编辑 → 计划 → 完全访问之间循环。
- **子代理**：除了自建的，还会读项目和用户的 `.claude/agents/*.md`，可以逐个停用。
- **钩子**：按 Claude Code 的 `settings.json` 格式配置 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStop、Notification，可以从 Claude Code 导入并逐条试跑。

### 内置浏览器

右栏的「浏览器」里有地址栏和多个标签页，登录数据与主程序分开保存。Agent 也能用它打开网页、读文字和元素、点击、输入、截图、查看控制台与网络请求，你可以随时【接手】，接手期间 Agent 在这个标签页上停手。

本机地址直接打开；其他网站第一次要你允许（允许一次 / 始终允许此网站 / 拒绝），被允许的站点里跳到别的站点同样要问。密码和支付输入一律不代填，提交表单要你确认，下载一律拒绝。

### 权限与命令

| 模式 | 项目内读取 | 项目内修改 | 命令与项目外访问 |
| --- | --- | --- | --- |
| 默认审批 | 自动 | 审批 | 审批 |
| 项目内自动编辑 | 自动 | 自动 | 审批 |
| 计划 | 自动 | 禁止 | 审批（只读） |
| 完全访问 | 自动 | 自动 | 自动 |

受限命令和终端使用原生 Windows AppContainer，**没有网络能力，包括 localhost TCP**。模型 API、联网搜索和 HTTP MCP 由独立的主机网络通道处理。隔离失败不会静默转成本机执行。

### 制卡工坊

从工作台左下角进入。卡项目是本地文件夹，只出现在卡库里。规划 AI 按轮提问、给推荐答案，写出设计书后派单；世界书条目、正则、脚本、开场白各是一个组件文件，由应用确定性地拼装成卡。导出整卡 JSON、PNG 卡、世界书和单件，每次导出附一份替换说明。本地预览在隔离的 iframe 里按酒馆的处理顺序渲染，不联网。

- 状态栏、正文美化、开局创角页这类前端，组件文件里只写 HTML 文档；拼装时应用自动包上 ```` ```html ```` 围栏，酒馆助手才会把它渲染成能交互的页面。拼装检查会核对围栏，并对每个前端做质量检查：手机宽度下横向滚动、没有任何交互反馈、正文对比度不足、用了 Google Fonts、塞了大图 base64 会禁止导出；设计令牌太少、没有 `@media`、循环动画不照顾「减少动画」、强调色用得太多会提醒。
- 前端有七套风格预设（战术档案、鎏金典狱、工业终端、复古电影、粉樱、和纸、霓虹夜）和一套按题材自定的写法，规划在设计书里选定。
- 说错了话可以撤回：AI 还在写时，撤回会停下这一轮、把这条消息收回，文字放回输入框，它发出的派单回到「未派」；已经写完的消息可以编辑后重新生成，产生新的对话版本。写进卡项目的文件不跟着回滚，要退文件用「本轮写入」里的【撤销本轮】。

### 主题与桌宠

- 「工作室设置 → 头像与外观」里可以选主题：跟随系统、深色、浅色、红粉白。主题只换颜色，布局和控件不变；制卡工坊保持自己的样子，只有金色和板块灯光会向主题色偏一点。
- 自己的主题包放在资料目录的 `themes/<id>/theme.json` 里，可以改颜色、背景图、登场动画和桌宠；读不了的主题包会列出原因。
- 桌宠默认关。打开后它在自己的小窗口里，浮在所有窗口最前面，Cardwright 最小化或收到托盘时也还在。它只报本机的状态：当前任务、审批、结果、一键制作的进度和今天的 Token 用量，不调用模型。单击它回到 Cardwright 并打开它正在报的任务；拖到屏幕上任何位置，下次还在那里；右键有菜单，点 × 收起；系统开了「减少动画」时它不动。宠物包用 Codex 桌宠包格式（`pet.json` 加 `spritesheet.webp`），可以从 ZIP 或文件夹安装。
- 内置的绘梨衣桌宠由顾清寒创作，是非官方同人作品，按 CC BY-NC 4.0（署名、非商业）授权；角色权利归原权利人，权利人要求即移除。详见 [assets/pets/erii/NOTICE.md](assets/pets/erii/NOTICE.md)。

### 本地模型与本地代理

添加网关时可以选两个预设，都是你自己在本机运行的服务，Cardwright 不附带、不安装、也不管理它们：

- **本地模型**：Ollama（`http://127.0.0.1:11434/v1`）、llama.cpp（`http://127.0.0.1:8080/v1`）、LM Studio（`http://127.0.0.1:1234/v1`）。本机地址可以不填密钥，应用会发送占位值 `local`。
- **本地代理网关**：你自己运行的 OpenAI 兼容代理，例如 CLIProxyAPI（`http://127.0.0.1:8317/v1`），密钥填你在它的配置里给客户端设的那一个。账号能不能这样用，请自行确认服务条款。

【一键自检】先读模型列表，再给默认模型发一次只生成一个 Token 的补全，两步分别报告结果。

### 数据

资料默认存在 `%APPDATA%\Cardwright`：设置、会话、检查点、附件和凭据。凭据用 Windows 的 `safeStorage` 加密。升级时如果数据结构变化，会先在 `backups/` 留一份原始备份。

界面某一页出错时，那一页换成错误卡片，可以一键复制诊断信息；同一条记录也写进 `logs/renderer.log`，不含卡和对话的内容。「工作室设置 → 数据与导出」里可以打开日志文件夹，反馈问题时附上它。

### 许可

MIT，见 [LICENSE](LICENSE)。`assets/` 下的素材不在 MIT 之内，各自的来源与条件见对应文件夹里的 `NOTICE.md`；内置桌宠只能非商业使用。第三方组件的许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 贡献者

- 顾清寒
- Claude（Anthropic，AI 结对）

---

## English

Cardwright is a local agent workbench for Windows projects: connect your own model gateway, let an agent do the work, and review the changes, run the checks and manage a squad in the same window. Since 0.8 it also has a separate **card studio**: a planning AI walks you through turning your material into a SillyTavern character card.

The interface stays quiet, deterministic rules are executed by the program, and skills and extra context are handed to the model only when needed. Every model request goes to the gateway you configured; keys stay on your machine, encrypted by Windows credential storage.

### Requirements

- Windows 10 or 11 (x64).
- Your own model gateway: OpenAI Chat Completions, OpenAI Responses or Anthropic Messages.
- Optional: Brave Search or SearXNG credentials for web search, kept apart from the model credentials.

### Install

Download `Cardwright-Setup-1.0.0.exe` from [Releases](../../releases). The installer is not code-signed, so Windows shows an "unknown publisher" warning the first time; choose "More info → Run anyway". Uninstalling keeps your data directory.

Or build it yourself:

```
npm install
npm run build
node scripts/package.mjs      # portable output in release/<version>/Cardwright-win32-x64
```

### First run

1. Add a gateway under Studio settings → Agents & models: protocol, base URL and key. Pick models from the list it reads, or add IDs by hand.
2. Add a project folder, choose gateway, model, context window and permission in the composer, then send a task.
3. In the default mode you approve each action after reading the actual paths and commands. Restricted commands have no network; host commands are approved separately.
4. Open the side panel beside the task title for files, changes, checks, terminal, browser, plan and todos. The panel splits into two.
5. Configure project check commands under Workbench & verification. When a run ends, the delivery card keeps file changes and verification apart.

### The desk

- **Left**: conversations grouped by project, with pin, rename, archive and search, and a status dot each (running, waiting for approval, finished, failed, output truncated).
- **Middle**: the conversation at reading width. The agent marks a chapter when the work changes phase; a rail of dots in the margin jumps between them. A `path:line` in a reply or a tool row opens that file in the side panel at that line.
- **Right**: a splittable panel — files, changes, checks, terminal, browser, plan, todos. Under 960px the sidebar becomes an icon column and the panel slides over the conversation.
- **Slash commands**: `/clear`, `/compact`, `/context`, `/cost`, `/model`, `/resume`, `/rewind`, `/init`, `/help`, `/plan`, `/todos`, `/memory`, `/dream`, and your skills.
- **Shift+Tab** cycles ask → auto-edit in project → plan → full access.
- **Subagents**: your own, plus whatever `.claude/agents/*.md` holds in the project and in your home directory; each can be switched off.
- **Hooks**: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop and Notification, configured in Claude Code's `settings.json` shape, importable from Claude Code and testable one by one.

### The built-in browser

The Browser tab in the side panel has an address bar and tabs, and keeps its logins apart from the rest of the application. The agent can open pages, read the text and the elements, click, type, take screenshots and read the console and network list. You can take a page over at any time; while you have it, the agent's tools stop on that tab.

Local addresses open straight away. Any other site asks you first (allow once / always allow this site / refuse), and a link that leaves an allowed site asks again. Password and payment fields are never typed into, submitting a form asks you, and downloads are refused.

### Permissions

| Mode | Read in project | Write in project | Commands and outside access |
| --- | --- | --- | --- |
| Ask | automatic | approval | approval |
| Auto-edit in project | automatic | automatic | approval |
| Plan | automatic | blocked | approval (read-only) |
| Full access | automatic | automatic | automatic |

Restricted commands and the terminal run in a native Windows AppContainer with **no network at all, including localhost TCP**. Model APIs, web search and HTTP MCP go through a separate host channel. A failed isolation never silently falls back to running on the host.

### Card studio

Enter from the bottom of the sidebar. A card project is a local folder and appears only in the card library. The planning AI asks one question at a time with a recommended answer, writes a design document and then dispatches the work. World-book entries, regexes, scripts and greetings are each a component file, and the application assembles the card deterministically. Export the whole card as JSON or PNG, the world book, or single pieces; every export comes with a note on how to replace it in SillyTavern. The local preview renders in an isolated iframe in SillyTavern's own order, offline.

- Front-ends such as the status bar, the body renderer and the start page are written as a plain HTML document; on assembly the application wraps it in the ```` ```html ```` fence the SillyTavern helper needs to render it as an interactive page. The assembly checks verify the fence and run quality checks on every front-end: horizontal scrolling at phone width, no interaction feedback at all, body text below 4.5:1, Google Fonts and big base64 images block the export; too few design tokens, no `@media`, looping motion that ignores reduced motion and an overused accent are warnings.
- Front-ends follow one of seven style presets (Tactical dossier, Gilded ward, Industrial terminal, Vintage cinema, Sakura, Washi and Neon night) or one derived from the card's subject, chosen in the design document.
- A message can be withdrawn: while the AI is still writing, withdrawing stops the turn, takes the message back, returns its text to the composer and puts a dispatch it sent back to not sent. A finished message can be edited and regenerated into a new conversation version. Files already written stay as they are; use Undo this turn in the turn's writes to take them back.

### Themes and the desk pet

- Studio settings → Profile & appearance offers Follow system, Dark, Light and Red, pink & white. A theme changes colours only; the card studio keeps its own look, with only its gold and board light leaning towards the theme.
- Your own theme packs go in `themes/<id>/theme.json` in the data directory and can change colours, a background picture, the entrance and the pet; a pack that cannot be read is listed with the reason.
- The desk pet is off by default. When on, it floats in its own small window above every other window, and stays there while Cardwright is minimized or in the tray. It only reports local state: the task at hand, approvals, results, one-click making's progress and today's tokens; it never calls a model. Click it to bring Cardwright back on the task it reports; drag it anywhere on the screen and it stays there next time; right-click for its menu, or close it with its ×. Under reduced motion it stands still. Pet packs use the Codex pet format (`pet.json` and `spritesheet.webp`) and install from a ZIP or a folder.
- The built-in Erii pet is unofficial fan art by 顾清寒, licensed CC BY-NC 4.0 (credit, non-commercial). The character belongs to its rights holders, and the pet is removed at a rights holder's request. See [assets/pets/erii/NOTICE.md](assets/pets/erii/NOTICE.md).

### Local models and a local proxy

When adding a gateway you can start from two presets. Both are services you run yourself on this computer; Cardwright does not ship, install or manage them:

- **Local model**: Ollama (`http://127.0.0.1:11434/v1`), llama.cpp (`http://127.0.0.1:8080/v1`) or LM Studio (`http://127.0.0.1:1234/v1`). On a local address the key may be left empty; the placeholder `local` is sent.
- **Local proxy gateway**: an OpenAI-compatible proxy you run yourself, such as CLIProxyAPI (`http://127.0.0.1:8317/v1`); enter the client key you set in its config. Whether your accounts may be used this way is for you to check.

Self-test lists the models, then sends one completion of a single token to the default model, and reports each step.

### Data

Everything lives in `%APPDATA%\Cardwright`: settings, sessions, checkpoints, attachments and credentials. Credentials are encrypted with Windows `safeStorage`. If the data shape changes across versions, the original file is copied into `backups/` first.

When a page of the interface fails, an error card takes its place and copies the diagnostics in one click; the same record goes into `logs/renderer.log`, without card or conversation content. Studio settings → Data & export opens the log folder; attach it when you report a problem.

### Licence

MIT, see [LICENSE](LICENSE). The files under `assets/` are not covered by the MIT License; each folder's `NOTICE.md` gives its source and terms, and the built-in desk pet is for non-commercial use only. Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Contributors

- 顾清寒
- Claude (Anthropic, AI pair)
