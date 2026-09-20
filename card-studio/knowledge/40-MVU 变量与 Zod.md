# MVU 变量与 Zod

| 适用版本 | 核对日期 | 核对方式 |
| --- | --- | --- |
| MVU-offline v1.0.1、Zod 4、酒馆助手 v4.x | 2026-09-17 | 对照参考卡的 MVU / ZOD 脚本原文与本地 ST 资料库 |
| MVU-offline v1.0.1 + 酒馆助手 4.9.5 + SillyTavern 1.19.0 | 2026-09-18 | 真实酒馆实测，见第 7 节 |

对应分区：脚本 · 变量结构、脚本 · 机制脚本、世界书 · 变量、正则 · 状态栏。

## 1. 三样东西各管什么

| 东西 | 谁写 | 管什么 |
| --- | --- | --- |
| MVU 脚本（固定件） | 原样引入 | 解析模型输出里的变量更新块，把变量存进聊天记录 |
| Zod 结构脚本 | 脚本 · 变量结构分区 | 声明变量长什么样、默认值、容错；注册给 MVU |
| `[initvar]` 条目 | 脚本 · 变量结构分区 | 这张卡的初始值，YAML 写法，默认关闭，顺序 1002 |
| 变量更新规则 / 输出格式 | 世界书 · 变量分区 | 告诉模型什么时候、按什么格式写更新块 |

变量的真正来源是模型的输出，MVU 只是解析与存储；Zod 负责在存进去之前把不合规的值夹回合法范围。

## 2. 固定件原文

**MVU 脚本**：脚本正文只有一行，不要改：

```js
import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.1/mvu_bundle_full.js'
```

按钮配置里六个按钮，只让「重新处理变量」和「重试额外模型解析」可见，其余 `visible: false`。

**Zod 注册的头尾**：

```js
import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

// …工具函数与结构…

export const Schema = z.object({ /* 顶层容器 */ });

$(() => { registerMvuSchema(Schema); });
```

`z`（Zod 4）和 `_`（lodash）由酒馆助手注入，不要自己 import。`registerMvuSchema` 内部会把结构包成 `{ stat_data: … }` 再注册，所以 `Schema` 直接写 `stat_data` 下面那一层。

## 3. 更新块的格式

模型按世界书里定的格式输出：

```xml
<UpdateVariable>
<Analysis>本回合哪些状态变了，每行至少对应一条路径</Analysis>
<JSONPatch>
[{"op":"replace","path":"/世界/时间","value":"14:25"}]
</JSONPatch>
</UpdateVariable>
```

- 路径是 JSON Pointer 风格的 `/顶层容器/键/子字段`，中文键名直接写，不转义。
- 数组末尾追加写 `/容器/-`。
- 让模型使用的 op 只有四个：`add`、`replace`、`remove`、`move`。`replace` 的路径必须已存在，新增一律用 `add`。
- MVU 另外支持 `delta`（数值增减）和 `insert`，但**不要**写进给模型的规则里——让模型算好结果再写值，出错时更容易看懂。
- 变量更新规则里要写明：只按本回合真实发生的事写；没变的不写；一次更新里同一路径只出现一次。

## 4. Zod 写法（Zod 4）

三个方法的区别，决定了字段的容错方式：

| 方法 | 什么时候生效 | 用在哪 |
| --- | --- | --- |
| `.prefault(v)` | 输入是 `undefined` | 缺字段时补默认值，并且默认值还会走一遍校验 |
| `.default(v)` | 输入是 `undefined` | 默认值已经是最终形态时 |
| `.catch(v)` | **任何校验失败** | 不可信输入的兜底，枚举字段必备 |

参考卡里成型的几个工具函数（写法可以借鉴，字段要按自己的卡定）：

- `percent(fallback)`：`z.coerce.number().catch(fallback).transform(v => _.clamp(v, 0, 100))`，把数值夹进范围。
- `text(fallback)`：空值兜底成空串或指定文案。
- `bool()`：容忍「是 / 否 / true / 1」这类写法。
- `enumOf(values, fallback)`：`z.enum(values).catch(fallback)`。
- `limitedRecord(schema, n)`：记录类容器只保留最近 n 条，防止越滚越大。
- 有不变量的容器用 `.superRefine()` 自己校验，并给出可读的报错。
- 顶层用 `.passthrough()`（Zod 4 里也可用 `z.looseObject`）保留未知字段，避免旧存档被清空。

## 5. 在脚本和前端里读变量

```js
await waitGlobalInitialized('Mvu');            // 必须先等，否则读到空
const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
render(data.stat_data);
```

要在每次更新后刷新界面，挂在 MVU 的更新结束事件上：

```js
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (after, before) => render(after.stat_data));
```

- `Mvu.parseMessage(text, old)` 在没有变量被更新时返回 `undefined`，一定要判空再 `replaceMvuData`。
- 作用域参数 `{ type: 'message' | 'chat' | 'global' | 'script' | 'character' | 'extension' }`；状态栏用 `message`。
- 事件名有两套：`tavern_events`（酒馆自身）和 `iframe_events`（带 `js_` 前缀），不要混用。
- 监听器在切换聊天时要能清理，`eventOn` 返回值带 `stop()`。

> 待真机验证：`getMvuData` 的同步性、`COMMAND_PARSED` 里必须原地 `splice` 修改命令数组这两条（2026-09-18 的冒烟没有测到）。

## 6. 制卡时的固定要求

- `[initvar]` 必须能通过这张卡自己的 Schema——制卡工坊的拼装检查会在独立进程里真的跑一遍 Zod，通不过就是错误。
- 变量规则、变量输出格式里出现的每条路径，都要在 Schema 里存在；拼装检查也会核对。
- 由脚本维护的字段，要在变量规则里标成「模型不得修改」。
- 状态栏只显示 Schema 里有的字段，缺失显示「未知」，不要报错也不要补造。
- 历史楼层的更新块会占满上下文：固定正则「只发送最新 3 楼的变量更新」用 `promptOnly: true` + `minDepth: 6` 把旧块从提示词里删掉，这条由拼装自动加入。

## 7. 真实酒馆里看到的

2026-09-18，SillyTavern 1.19.0 + 酒馆助手 4.9.5 + MVU-offline 1.0.1，验证卡由制卡工坊导出，本机假模型每轮回复一段正文加一个更新块。证据在 `artifacts/card-studio-0.8/stage-4/`。

- 第一次打开角色时选「确认」启用酒馆助手脚本后，MVU 和 ZOD 两个脚本都在运行，`waitGlobalInitialized('Mvu')` 能等到。
- 更新块被解析、按卡里的 Zod 校验后写进楼层变量：五轮后最新楼的 `stat_data` 是 `{ 世界: { 时间, 天气: '雨' }, 主角: { 体力: 60 } }`，和假模型最后一个补丁一致；补丁没提到的字段保持 `[initvar]` 的初值。
- **MVU 会在每条 AI 回复的末尾追加 `<StatusPlaceHolderImpl/>`**（开场白不追加）。所以状态栏正则不加限制时，每一楼都会画一个状态栏——这就是 Re0 长聊天变慢的原因，见 `60-状态栏与开局页.md`。
- MVU 固定件的按钮配置生效：输入框上方只出现「重新处理变量」「重试额外模型解析」两个按钮。
- 固定件「只发送最新 3 楼的变量更新」生效：第五轮请求里，最早一条回复的更新块已被去掉，最近三条保留。
- MVU 第一次运行时会弹出几条更新公告（绿色提示条，例如「已更新更多自定义 API 配置」）；有对话框开着时，酒馆会把提示条放进对话框里显示。
