# 脚本样本 · MVU 与 ZOD

原文在 `参考资料/脚本部分/脚本的变量部分/`。MVU 是固定件，原样使用；ZOD 学的是写法，字段要按自己的卡推导。

## MVU（固定件）

| 项目 | 值 |
| --- | --- |
| 脚本名 | MVU |
| 正文 | 一行，89 字符 |
| 按钮 | 六个，只有「重新处理变量」「重试额外模型解析」可见 |

```js
import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.1/mvu_bundle_full.js'
```

按钮配置原样：

```json
{ "enabled": true, "buttons": [
  { "name": "重新处理变量", "visible": true },
  { "name": "重新读取初始变量", "visible": false },
  { "name": "快照楼层", "visible": false },
  { "name": "重演楼层", "visible": false },
  { "name": "重试额外模型解析", "visible": true },
  { "name": "清除旧楼层变量", "visible": false }
] }
```

## ZOD（9,174 字符 / 183 行）

### 结构

```
第 1 行      import registerMvuSchema（固定头）
第 3–20 行   工具函数：percent / signedPercent / nonNegative / text / bool / enumOf / strings / obj / record / limitedRecord
第 21–145 行 可复用的子结构：生死状态、伤势、异常、战力、能力、人物、死亡记录、战斗状态……
第 146 行起  export const Schema = z.object({ 世界, 主角档案, 关系, 轮回, 事件, 线索, 资产 }).passthrough()
最后一行     $(() => { registerMvuSchema(Schema); });（固定尾）
```

### 工具函数（原文）

```js
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const percent = (fallback = 0) => z.coerce.number().catch(fallback)
  .transform(v => _.clamp(finite(v, fallback), 0, 100)).prefault(fallback);
const nonNegative = (fallback = 0) => z.coerce.number().catch(fallback)
  .transform(v => Math.max(0, Math.floor(finite(v, fallback)))).prefault(fallback);
const text = (fallback = '未知') => z.preprocess(v => (v == null ? fallback : v), z.coerce.string())
  .catch(fallback).transform(v => (v.trim() === '' ? fallback : v)).prefault(fallback);
const bool = (fallback = false) => z.preprocess(v => {
  if (typeof v === 'string') return ['true', '是', '1', 'yes'].includes(v.trim().toLowerCase());
  if (typeof v === 'number') return v !== 0;
  return v;
}, z.boolean()).catch(fallback).prefault(fallback);
const enumOf = (values, fallback) => z.enum(values).catch(fallback).prefault(fallback);
const obj = shape => {
  const schema = z.object(shape).passthrough();
  return schema.catch(() => schema.parse({})).prefault({});
};
const record = item => z.record(z.string(), item).catch({}).prefault({});
const limitedRecord = (item, limit) => record(item)
  .transform(data => _(data).entries().takeRight(limit).fromPairs().value());
```

每个工具函数都是同一个套路：**先宽松地接住（`coerce` / `preprocess`）→ 失败时兜底（`catch`）→ 规范化（`transform`）→ 缺省时补默认值（`prefault`）**。这样模型写错一个字段，只会让那个字段回到默认值，不会让整份变量失效。

### Schema 片段

```js
export const Schema = z.object({
  世界: obj({
    当前时间: obj({
      规范日期: text(),
      时段: enumOf(['黎明', '清晨', '上午', '正午', '下午', '傍晚', '夜间', '深夜', '凌晨', '时段未详'], '时段未详'),
      时间层: enumOf(['主线', '轮回分支', '历史回溯', '试炼幻境'], '主线'),
    }),
    危机等级: enumOf(['无', '低', '中', '高', '灾难'], '无'),
    动向: limitedRecord(obj({ 标题: text('未命名事件'), 阶段: enumOf(['起', '承', '转', '合'], '起') }), 5),
  }),
  // 主角档案、关系、轮回、事件、线索、资产……
}).passthrough();
```

## 可以学的

- 工具函数先写好，Schema 里只组合，读起来像一张字段表。
- 枚举一定带兜底值（`时段未详`、`未知`），模型写出枚举外的值也不会报错。
- 记录类容器用 `limitedRecord` 限制条数（动向只留最近 5 条）。
- 键名用中文，和正文、变量规则、状态栏一致。
- 顶层 `.passthrough()`，旧存档里多出来的字段不会被清掉。

## 不要学的

- 照搬这些容器和字段：它们是 Re0 的世界观（轮回、死亡回归、加护）。新卡的容器按设计书推导。
