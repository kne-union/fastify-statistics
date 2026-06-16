# fastify-statistics

### 描述

基于 Fastify 的数据采集与多周期聚合统计插件，支持缓冲写入、时区查询和自动 Cron 聚合

### 安装

```shell
npm i --save @kne/fastify-statistics
```

### 概述

### 项目概述

`@kne/fastify-statistics` 是一个基于 Fastify 的数据采集与多周期聚合统计插件。它提供从原始数据上报到多级周期聚合、灵活查询与实时推送的完整数据管道，适用于 IoT 传感器数据、业务指标监控、多通道多属性聚合等场景。

### 核心架构与数据流

插件的核心理念是**逐级聚合**——原始数据采集后，按 h→d→w/m→q→y 的依赖链自动滚动聚合，每一级只从其直接上游读取数据，形成清晰的数据流管道：

```
数据采集(collect) → data-record 表
                          ↓ h 周期聚合 (Cron: 每小时第1分钟)
                    period-stat (period=h)
                          ↓ d 周期聚合 (Cron: 每日0:01)
                    period-stat (period=d)
                       ↙        ↘
              w 聚合(周一0:01)   m 聚合(每月1日0:01)
                    ↓                ↓
              period-stat(w)   period-stat(m)
                                   ↓ q 聚合(每季首月1日0:01)
                              period-stat(q)
                                   ↓ y 聚合(每年1月1日0:01)
                              period-stat(y)
```

**聚合依赖关系**（`PERIOD_DEPENDENCY`）：

| 周期 | 数据来源 | 上游周期 |
|------|----------|----------|
| h | data-record | - |
| d | period-stat | h |
| w | period-stat | d |
| m | period-stat | d |
| q | period-stat | m |
| y | period-stat | q |

### 六种统计周期

| 周期 | key | Cron 表达式 | 时间截断规则 | 数据来源 |
|------|-----|-------------|-------------|----------|
| 时 | h | `1 * * * *` | `startOf('hour')` | data-record |
| 日 | d | `1 0 * * *` | `startOf('day')` | period-stat(h) |
| 周 | w | `1 0 * * 1` | `startOf('week')+1天` (周一) | period-stat(d) |
| 月 | m | `1 0 1 * *` | `startOf('month')` | period-stat(d) |
| 季 | q | `1 0 1 1,4,7,10 *` | `Math.floor(month/3)*3` 月首日 | period-stat(m) |
| 年 | y | `1 0 1 1 *` | `startOf('year')` | period-stat(q) |

### 聚合方法与级联计算

五种聚合方法在聚合过程中协同计算，确保高级别周期可以正确推导：

| 方法 | key | 从 data-record 聚合 | 从 period-stat 聚合 |
|------|-----|---------------------|---------------------|
| 合计 | sum | `SUM(data)` | 各子窗口 sum 求和 |
| 计数 | count | `COUNT(data)` | 各子窗口 count 求和 |
| 平均 | avg | `AVG(data)` | `sum总 / count总`（非 AVG(AVG)） |
| 最小 | min | `MIN(data)` | 各子窗口 min 取最小值 |
| 最大 | max | `MAX(data)` | 各子窗口 max 取最大值 |

**关键设计**：avg 不直接对上游 avg 取平均，而是用 sum/count 重新计算，避免二次平均偏差。

### 聚合区间语义

所有聚合使用**左闭右开区间** `[startTime, endTime)`：

- `startTime`：当前时间窗口的截断起始
- `endTime`：下一个时间窗口的起始（`getNextStart(startTime)`）
- 查询条件使用 `Op.gte(startTime)` + `Op.lt(endTime)`，确保 `endTime` 所在时刻的数据**不被包含**

> 这一设计修复了此前使用 `Op.between`（闭区间）导致边界数据被重复聚合到两个窗口的 bug。

### Channel 通道层级设计

**Channel（数据通道）** 采用冒号分隔的多级结构（`a:b:c`），核心思想是**从宏观到微观的层级划分**：

- 一级 channel（如 `sales`）是根通道，对应唯一的 `channel-meta` 记录
- 多级 channel（如 `sales:beijing`、`sales:beijing:team-a`）是更细粒度的子通道
- **采集时自动展开**：`company:sales:beijing` 展开为 `company`、`company:sales`、`company:sales:beijing` 三条记录
- **查询时**：默认精确匹配；`includeChildren=true` 时匹配通道及所有子通道，返回树形结构

**AttributeName（属性名）** 是同一 channel 下的第二级分类维度：

- 默认值 `default`，适用于单指标场景
- `data` 传入对象时自动展开（如 `{revenue: 10000, orders: 50}` → 两条记录）
- `unit` 支持字符串（所有属性共用）或对象（按 attributeName 映射不同单位）

### 通道统计设计案例

当一个业务希望统计“某类事件在不同来源、不同小时桶中的完成量”时，容易把 **统计周期**、**通道层级** 和 **查询返回结构** 混在一起。正确做法是先确定需要在查询结果中保留的维度，再把这些维度建模到 channel 或 attributeName 中。

#### 场景抽象

| 需求 | 推荐建模 | 说明 |
|------|----------|------|
| 查询总量 | `event` | 根通道自动汇总所有子通道 |
| 按来源查询 | `event:web`、`event:api` | 第二级通道表示来源 |
| 按小时桶查询 | `event:web:00`、`event:web:01` | 第三级通道表示固定小时桶 |
| 按指标类型查询 | attributeName | 同一通道下多个数值指标更适合放在 attributeName |

> **关键设计**：`period=h/d/m` 是系统内部按时间窗口聚合后的存储周期，不应承担业务维度拆分职责。业务需要稳定输出的维度，应在采集时进入 channel 或 attributeName。

#### 数据流

```
采集 event:web:13
        ↓ 自动展开
event:web:13 → event:web → event
        ↓ 聚合
period-stat(h/d/m/...)
        ↓ 查询
精确通道列表 或 includeChildren 树形结果
```

| 阶段 | 行为 | 注意事项 |
|------|------|----------|
| 采集 | 多级 channel 自动展开为自身及所有父级 | 父级已经包含子级汇总 |
| 聚合 | 每个展开后的 channel 独立生成周期统计 | 父级和子级不是互斥数据 |
| 查询 | 默认只匹配传入的精确 channel | 需要子树时才使用 `includeChildren=true` |
| 消费 | 根据返回结构选择汇总方式 | 不要把父级与子级再次相加 |

#### 常见错误

| 错误做法 | 问题 | 正确做法 |
|----------|------|----------|
| 长区间 Dashboard 直查 `period=h` | h 仅保留当月，历史会被清理 | 使用 `query()` / `queryFlat()` / `queryTotals()` |
| 查询根通道后再期望自动得到每个小时桶 | 默认查询只返回精确匹配通道 | 显式查询所有叶子通道，或使用 `channelScope: 'descendantsFlat'` |
| 对 `includeChildren=true` 的树形结果做扁平求和 | 父级已经包含子级汇总，容易重复计数 | 使用 `channelScope: 'descendantsFlat'` 只取叶子，或只查询叶子通道 |
| 依赖查询结果中的 `period=h` 构建长范围小时分布 | 查询会按对齐窗口选择较粗周期，长范围可能返回 d/m/y | 将小时桶作为 channel 维度，如 `event:web:13` |
| 用一个宽泛 channel 表达多个正交维度 | 后续筛选和拆桶需要猜测字符串含义 | 固定维度顺序，例如 `event:{source}:{hour}` |

#### 推荐查询

**channelScope**（比 `includeChildren` 更语义化）：

| channelScope | 行为 | 典型场景 |
|--------------|------|----------|
| `exact`（默认） | 仅精确匹配 channels | 已知叶子 channel |
| `descendantsFlat` | 匹配子通道，返回**扁平叶子 channel** | 按父 channel 查所有子项且避免重复计数 |
| `descendantsTree` | 匹配子通道，返回树形结构 | 等同 `includeChildren=true`，层级浏览 |

采集时 `expandChannel('a:b:c')` 会同时写入 `a`、`a:b`、`a:b:c`。`descendantsFlat` 默认只返回叶子 channel，避免父级与子级同时汇总导致重复计数。可选 `maxDepth` 限制冒号层级。

如果目标是得到每个来源在 24 个小时桶中的分布，可枚举叶子通道（`channelScope: 'exact'`），或使用 `descendantsFlat` 传入父 channel：

```js
// 方式一：显式枚举叶子通道
const sources = ['web', 'api'];
const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const channels = sources.flatMap(source => hours.map(hour => `event:${source}:${hour}`));

const result = await fastify.statistics.services.query({
  channels,
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum']
});

// 方式二：父 channel + descendantsFlat（无需手动枚举）
const flatResult = await fastify.statistics.services.periodStat.queryFlat({
  channels: ['event'],
  channelScope: 'descendantsFlat',
  maxDepth: 3,
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum']
});
```

返回结果是扁平列表，调用方可以直接按 channel 解析来源和小时桶：

```json
{
  "channelMetas": {
    "event": { "channel": "event", "title": "事件统计", "description": "事件完成量" }
  },
  "list": [
    {
      "channel": "event:web:13",
      "period": "m",
      "time": "2026-05-01T00:00:00.000Z",
      "data": { "default": 128 }
    }
  ]
}
```

#### 使用 includeChildren 的边界

`includeChildren=true` 适合展示通道树，或让使用方按层级浏览数据；它不适合直接作为“按叶子维度分桶”的扁平数据源。

| 查询方式 | 返回形态 | 适合场景 |
|----------|----------|----------|
| `channels=['event:web:13']` | 扁平列表 | 精确叶子桶统计 |
| `channels=['event:web']` | 扁平列表 | 来源汇总 |
| `channels=['event:web'], includeChildren=true` | 树形结构 | 展示来源及其小时子桶 |
| `channels=[所有叶子通道]` | 扁平列表 | 构建固定维度趋势图 |

> **经验教训**：通道层级查询的第一原则是先决定“结果要哪个层级”。如果结果要叶子桶，就枚举叶子桶；如果结果要父级汇总，就查父级；如果结果要层级浏览，再使用 `includeChildren=true`。

### 水位线机制与补偿聚合

**水位线（aggregation-watermark）** 记录每个周期下一次应聚合的起始时间，是补偿聚合的核心：

- 每个周期一条记录：`(period, nextTime)`
- 聚合完成后，`nextTime` 推进到下一窗口起始
- 补偿时从 `nextTime` 开始逐步向前，追上当前时间

**启动初始化流程**（`period-stat.init()`）：

1. 按 h→d→w→m→q→y 顺序依次处理
2. 对每个周期：
   - 若水位线存在且过期 → 从水位线开始补偿
   - 若水位线不存在 → 调用 `determineStartFromSource` 从源数据推断起始点
   - 若无任何源数据 → 水位线设为当前截断时间（全新系统）
3. 逐窗口执行聚合，每完成一个窗口就推进水位线
4. 上游未完成时自动先补偿上游（如聚合 d 前确保 h 已完成）

**`determineStartFromSource` 推断逻辑**：

- h 周期：从 `data-record` 的 `MIN(time)` 截断到小时
- 其他周期：从上游 `period-stat` 的 `MIN(time)` 截断到当前周期起始

> 早期版本使用 `MAX(time) + nextStart` 推断起始点，导致遗漏上游最早数据。现已改为 `MIN(time)` 截断，确保所有历史数据都被覆盖。

**运行时补偿**（Cron 触发）：

- 每个 Cron 周期调用 `compensate(period)`
- 每次最多处理 `compensationBatchSize` 个窗口（默认 24）
- 连续失败 `maxCompensationFailCount` 次（默认 3）后停止，下次 Cron 继续
- 每个周期有独立锁（`compensatingLocks`），防止并发补偿

### 数据保留策略

通过 Cron 定时清理过期数据，避免数据无限增长。可通过 `periodStat.getRetentionPolicy()` 读取当前策略。

| 数据类型 | 保留策略 | 清理时机 | 安全检查 |
|----------|----------|----------|----------|
| data-record | `dataRetentionDays` 天（默认 7 天） | 每天 02:00 | 不超过 h 周期水位线 |
| period-stat(h) | **当月** | 每天 03:00 | 不超过 d 周期水位线 |
| period-stat(d) | **当年** | 每天 03:00 | 不超过 w、m 周期水位线 |
| period-stat(w) | **当年** | 每天 03:00 | 无下游依赖 |
| period-stat(m/q/y) | **永久保留** | 不清理 | - |

**安全检查**：删除前检查下游水位线，确保尚未聚合的数据不会被提前删除。

#### 为什么不能只查 `period=h`

`period=h` 会在每月初之后被清理，仅保留当月数据。若应用层直接 `findAll({ where: { period: 'h' } })` 做长区间 KPI，统计会在运行一段时间后「突然变少」——新增一条采集后可能只剩当月/当天少量数据。

**正确做法**：使用 `query()` / `queryFlat()` / `queryTotals()`，由 `buildQueryWindows` 按区间自动组合 `y → q → m → w → d → h`，并合并当前小时未聚合的 `data_record`。

### 缓冲写入模式

当配置 `cache` 实例时，采集数据先写入内存缓冲区，再定时批量持久化：

- 缓冲区达到 `collectMaxBufferSize`（默认 1000）时触发 flush
- 定时 `collectFlushInterval`（默认 5000ms）自动 flush
- 缓冲区溢出上限 `collectMaxBufferOverflow`（默认 `maxBufferSize * 2`），超出时丢弃最旧数据
- 进程关闭时（`onClose` hook）持久化缓冲区到 cache 并执行最终 flush
- 启动时从 cache 恢复缓冲区数据（`restoreBuffer`）

无 cache 时，每次采集直接写入数据库（`collectImmediate`）。

### 查询缓存

查询结果自动缓存，减少重复查询的数据库压力：

| 特性 | 说明 |
|------|------|
| 外部缓存 | 配置 `cache` 时使用，支持 TTL |
| 内存 LRU 缓存 | 无外部缓存时使用，最大 `queryCacheMaxEntries` 条 |
| 版本校验 | 缓存条目记录写入时的通道版本号，读取时校验版本是否变化 |
| TTL 策略 | 实时查询（endTime 在当前小时内）用 `queryCacheTTL`（30s），历史查询用 `queryCacheHistoryTTL`（3600s） |
| 补偿期间 | 正在补偿聚合时查询不走缓存，确保数据实时性 |

**缓存失效**：采集数据时自动调用 `invalidateQueryCache(affectedChannels)`，递增对应通道及其所有前缀的版本号。

### 查询辅助 API

在保留策略下做长区间统计时，优先使用以下 API，避免手写 period 组合与 flatten 逻辑：

| 场景 | API |
|------|-----|
| 需要原始扁平行 | `periodStat.queryFlat(params)` |
| 需要全局/按 channel 汇总 | `periodStat.queryTotals(params)` |
| 需要树形子通道 | `query({ channelScope: 'descendantsTree' })` |
| 需要扁平叶子子通道 | `query({ channelScope: 'descendantsFlat', maxDepth? })` |

`queryTotals` 返回 `totals`（全局 sum）、`totalsByChannel`、`maxByChannel`（对 max 取 `Math.max`，禁止对小时 max 求和）、`attrStats` 等。HTTP 查询支持 `format=flat|totals`。

```js
const result = await fastify.statistics.services.periodStat.queryTotals({
  channels: [`interview:${clientId}`],
  channelScope: 'descendantsFlat',
  maxDepth: 3,
  startTime,
  endTime,
  aggregates: ['sum', 'max']
});
// result.totals / result.totalsByChannel / result.maxByChannel
```

### SSE 实时推送

基于 Server-Sent Events 的实时统计推送：

- 按 `interval`（默认 5 秒）定时调用 `fetchData` 获取最新数据推送
- 心跳保活（默认 30 秒），防止连接被代理/负载均衡器断开
- 最大连接时长（默认 30 分钟），超时自动断开并推送 `timeout` 事件
- 防止推送重叠：当前推送未完成时跳过下一次
- 缓存复用：相同 `name`+`params`+`interval` 在同一时间窗口内命中缓存

**长任务进度 SSE**（`sseStream.runTask`）：用于聚合重建等耗时操作，推送 `progress` / `done` / `error` 事件，而非轮询 query。HTTP：`GET {prefix}/rebuild/sse`。

### 重置、重建与修复

提供 `resetPeriodStats` 方法用于修复错误的聚合数据：

- 删除指定周期和时间范围的 period-stat 记录
- 重置水位线到指定起始点
- 支持 `cascade=true` 级联重置下游周期（如重置 h 时同时重置依赖 h 的 d、w、m、q、y）

**聚合重建**（`periodStat.rebuild`）用于历史修复或初始化回填后的重聚合：

| mode | 行为 |
|------|------|
| `aggregate-only`（默认） | flush buffer → 从 `MIN(data_record.time)` 或 `startTime` 重聚合 h→y |
| `reset-and-aggregate` | 先 `clearAll` → 宿主 `beforeAggregate` hook 写入 data_record → 聚合 |
| `repair` | 指定 `[startTime, endTime)` 区间局部 `resetPeriodStats` + 重聚合 |

```js
await fastify.statistics.services.periodStat.rebuild({
  mode: 'reset-and-aggregate',
  onProgress: payload => { /* stage: start | flush | clear | aggregate | done */ },
  beforeAggregate: async () => { /* 宿主业务采集 */ },
  afterAggregate: async () => { /* 宿主一致性校验 */ }
});
```

宿主集成建议：

1. 禁止业务 Dashboard 直查 `period=h` 做全量 KPI
2. 按父 channel 查所有子项时，用 `channelScope: 'descendantsFlat'` 代替手动枚举
3. 回填脚本只保留领域 collect/verify 逻辑，聚合循环交给 `rebuild`

### 技术栈

- **Fastify** + fastify-plugin + fastify-namespace
- **Sequelize**（数据持久化，支持多种数据库）
- **fastify-cron**（定时聚合与清理任务）
- **dayjs**（时间处理，支持 UTC 和时区扩展）
- **lodash**（工具函数）

### 主要特性

- **数据采集**：支持单条和批量数据上报，自动展开多属性对象和多级通道
- **缓冲写入**：支持缓存缓冲模式，定时批量写入数据库，减少写入压力
- **多周期聚合**：h/d/w/m/q/y 六种统计周期，自动通过 Cron 定时聚合
- **聚合方法**：sum、avg、count、min、max 五种聚合计算
- **灵活查询**：按通道、时间范围、属性名、聚合方法查询统计结果，自动合并当前小时未聚合的原始数据；`queryFlat` / `queryTotals` 开箱即用
- **子通道查询**：`channelScope` 支持扁平叶子子通道（`descendantsFlat`）与树形（`descendantsTree`）
- **聚合重建**：`rebuild` + SSE 进度，宿主通过 hook 注入采集与校验
- **SSE 实时推送**：基于 Server-Sent Events 的实时数据推送
- **时区支持**：查询时支持传入客户端时区（IANA 格式）
- **事务安全**：所有数据库写操作使用事务保证原子性，聚合操作支持幂等（upsert）
- **查询缓存**：支持内存 LRU 或外部缓存，带版本校验和 TTL 策略

### 使用方法

#### 快速开始

```js
const fastify = require('fastify')();

// 注册依赖插件
fastify.register(require('@kne/fastify-sequelize'), { /* sequelize 配置 */ });
fastify.register(require('@kne/fastify-cron'), { /* cron 配置 */ });

// 注册统计插件
fastify.register(require('@kne/fastify-statistics'), {
  prefix: '/api/statistics',
  cache: redisCacheInstance,   // 传入缓存实例启用缓冲模式和查询缓存
  compensationEnabled: true,   // 启动时自动补偿聚合
  compensationBatchSize: 24,   // 每次补偿最多24个时间窗口
  dataRetentionDays: 7,        // 原始数据保留7天
  queryCacheEnabled: true,     // 启用查询缓存
  queryCacheTTL: 30,           // 实时查询缓存30秒
  queryCacheHistoryTTL: 3600,  // 历史查询缓存1小时
  queryCacheMaxEntries: 100,    // 内存缓存最大100条（无外部缓存时生效）
  getAuthenticate: type => {
    // type 为 'read' 或 'write'，返回认证信息
  }
});

fastify.listen({ port: 3000 });
```

#### Channel 与 AttributeName 的设计理念

**Channel（数据通道）** 是数据的第一级分类维度，采用冒号分隔的多级结构（`a:b:c`）。它的核心思想是：**从宏观到微观的层级划分**。

- **一级 channel**（如 `sales`）是根通道，对应唯一的 `channel-meta` 记录（标题、描述）
- **多级 channel**（如 `sales:beijing`、`sales:beijing:team-a`）是更细粒度的子通道
- 查询时传入一级 channel 即可匹配所有子通道的数据
- 同一根通道下的所有子通道共享同一个 `channel-meta`

**AttributeName（属性名）** 是数据的第二级分类维度，用于在同一 channel 下区分不同的数据指标。

- 默认值为 `default`，适用于单一指标的场景
- 当 `data` 传入对象时自动展开为多属性（如 `{revenue: 10000, orders: 50}` 拆分为两条记录）

#### 实际场景：企业部门数据统计

假设一家公司要统计各部门的经营数据，我们可以这样设计 channel：

```
company                     ← 根通道：公司整体
company:sales               ← 子通道：销售部
company:sales:beijing       ← 子通道：销售部北京分部
company:sales:shanghai      ← 子通道：销售部上海分部
company:rd                  ← 子通道：研发部
company:rd:frontend          ← 子通道：研发部前端组
company:rd:backend           ← 子通道：研发部后端组
company:hr                  ← 子通道：人力资源部
```

对应的 `channel-meta` 只需为根通道 `company` 创建一条记录：

| channel | title | description |
|---------|-------|-------------|
| company | 公司经营数据 | 各部门经营数据统计 |

**采集数据**：

```js
// 1. 销售部北京分部上报单指标（默认 attributeName=default）
await fastify.statistics.services.collect({
  channel: 'company:sales:beijing',
  data: 58000,
  unit: '元',
  title: '公司',
  description: '各部门经营数据统计'
});

// 2. 销售部上海分部上报多指标，unit 为字符串时所有属性共用同一单位
await fastify.statistics.services.collect({
  channel: 'company:sales:shanghai',
  data: { revenue: 72000, orders: 150 },
  unit: '元',
  title: '公司',
  description: '各部门经营数据统计'
});

// 3. 研发部前端组上报，unit 为对象时按 attributeName 映射不同单位
await fastify.statistics.services.collect({
  channel: 'company:rd:frontend',
  data: { tasks: 12, bugs: 3 },
  unit: { tasks: '个', bugs: '个' },
  title: '公司',
  description: '各部门经营数据统计'
});
```

采集后数据会自动展开并入库：

| channel | attributeName | data | unit |
|---------|--------------|------|------|
| company | default | 58000 | 元 |
| company:sales | default | 58000 | 元 |
| company:sales:beijing | default | 58000 | 元 |
| company | revenue | 72000 | 元 |
| company | orders | 150 | 元 |
| company:sales | revenue | 72000 | 元 |
| company:sales | orders | 150 | 元 |
| company:sales:shanghai | revenue | 72000 | 元 |
| company:sales:shanghai | orders | 150 | 元 |
| ... | ... | ... | ... |

> 通道展开规则：`company:sales:beijing` 自动展开为 `company`、`company:sales`、`company:sales:beijing` 三条记录，确保每一级都能查到汇总数据。

**查询数据**：

```js
// 1. 查询销售部本月合计（仅自身）
const salesResult = await fastify.statistics.services.query({
  channels: ['company:sales'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum']
});

// 2. 查询公司所有部门的本月合计（传入一级 channel + includeChildren）
const companyResult = await fastify.statistics.services.query({
  channels: ['company'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum'],
  includeChildren: true
});

// 3. 同时查询多个通道（仅自身）
const multiResult = await fastify.statistics.services.query({
  channels: ['company:sales', 'company:rd'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  aggregates: ['sum']
});

// 4. 查询 revenue 和 orders 两个属性的合计与平均
const revenueResult = await fastify.statistics.services.query({
  channels: ['company'],
  startTime: '2026-05-01T00:00:00.000Z',
  endTime: '2026-06-01T00:00:00.000Z',
  attributeNames: ['revenue', 'orders'],
  aggregates: ['sum', 'avg']
});
```

**查询返回格式**：

> **注意**：默认（`includeChildren=false`）只返回精确匹配通道的扁平列表。`includeChildren=true` 时按通道构建树形结构，子通道数据嵌套在 `children` 数组中。`data` 字段始终为对象（按属性名映射），例如单聚合时 `data` 为 `{"default": 58000}`，多聚合时 `data` 为 `{"sum": {"default": 58000}, "avg": {"default": 29000}}`。

查询销售部（`channels=['company:sales']`，默认不包含子通道）返回：

```json
{
  "channelMetas": {
    "company": { "channel": "company", "title": "公司", "description": "各部门经营数据统计" }
  },
  "list": [
    {
      "channel": "company:sales",
      "period": "m",
      "time": "2026-05-01T00:00:00.000Z",
      "data": { "default": 130000, "revenue": 72000, "orders": 150 },
      "unit": { "default": "元", "revenue": "元", "orders": "元" }
    }
  ]
}
```

查询整个公司（`channels=['company'], includeChildren=true`）返回：

```json
{
  "channelMetas": {
    "company": { "channel": "company", "title": "公司", "description": "各部门经营数据统计" }
  },
  "list": [
    {
      "channel": "company",
      "items": [
        {
          "period": "m",
          "time": "2026-05-01T00:00:00.000Z",
          "data": { "default": 130000, "revenue": 72000, "orders": 150, "tasks": 12, "bugs": 3 },
          "unit": { "default": "元", "revenue": "元", "orders": "元", "tasks": "个", "bugs": "个" }
        }
      ],
      "children": [
        {
          "channel": "company:sales",
          "items": [
            {
              "period": "m",
              "time": "2026-05-01T00:00:00.000Z",
              "data": { "default": 130000, "revenue": 72000, "orders": 150 },
              "unit": { "default": "元", "revenue": "元", "orders": "元" }
            }
          ],
          "children": [
            {
              "channel": "company:sales:beijing",
              "items": [
                {
                  "period": "m",
                  "time": "2026-05-01T00:00:00.000Z",
                  "data": { "default": 58000 },
                  "unit": { "default": "元" }
                }
              ]
            },
            {
              "channel": "company:sales:shanghai",
              "items": [
                {
                  "period": "m",
                  "time": "2026-05-01T00:00:00.000Z",
                  "data": { "revenue": 72000, "orders": 150 },
                  "unit": { "revenue": "元", "orders": "元" }
                }
              ]
            }
          ]
        },
        {
          "channel": "company:rd",
          "items": [
            {
              "period": "m",
              "time": "2026-05-01T00:00:00.000Z",
              "data": { "tasks": 12, "bugs": 3 },
              "unit": { "tasks": "个", "bugs": "个" }
            }
          ],
          "children": [
            {
              "channel": "company:rd:frontend",
              "items": [
                {
                  "period": "m",
                  "time": "2026-05-01T00:00:00.000Z",
                  "data": { "tasks": 12, "bugs": 3 },
                  "unit": { "tasks": "个", "bugs": "个" }
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

查询多个通道（`channels=['company:sales','company:rd']`，默认不包含子通道）返回：

```json
{
  "channelMetas": {
    "company": { "channel": "company", "title": "公司", "description": "各部门经营数据统计" }
  },
  "list": [
    {
      "channel": "company:sales",
      "period": "m",
      "time": "2026-05-01T00:00:00.000Z",
      "data": { "default": 130000, "revenue": 72000, "orders": 150 },
      "unit": { "default": "元", "revenue": "元", "orders": "元" }
    },
    {
      "channel": "company:rd",
      "period": "m",
      "time": "2026-05-01T00:00:00.000Z",
      "data": { "tasks": 12, "bugs": 3 },
      "unit": { "tasks": "个", "bugs": "个" }
    }
  ]
}
```

查询 revenue 和 orders 两个属性的合计与平均（`channels=['company']`, `attributeNames=['revenue','orders']`, `aggregates=['sum','avg']`）返回：

```json
{
  "channelMetas": {
    "company": { "channel": "company", "title": "公司", "description": "各部门经营数据统计" }
  },
  "list": [
    {
      "channel": "company",
      "period": "m",
      "time": "2026-05-01T00:00:00.000Z",
      "data": { "sum": { "revenue": 72000, "orders": 150 }, "avg": { "revenue": 72000, "orders": 150 } },
      "unit": { "revenue": "元", "orders": "元" }
    }
  ]
}
```

> `channelMetas` 按 root channel 去重，所有子通道共享同一份元数据，避免数据冗余。

#### Channel Meta 管理

通道元数据在首次采集时自动创建，也可通过服务接口管理：

```js
// 查询通道元数据
const meta = await fastify.statistics.services.channelMeta.detail({
  channel: 'company'
});

// 列出所有元数据
const list = await fastify.statistics.services.channelMeta.list();

// 按通道筛选
const list = await fastify.statistics.services.channelMeta.list({
  filter: { channel: 'company' }
});

// 修改元数据
await fastify.statistics.services.channelMeta.save({
  channel: 'company',
  title: '企业经营数据总览',
  description: '全公司各部门经营指标汇总'
});
```

#### SSE 实时推送

通过 HTTP 接口或程序化 API 获取实时统计数据推送：

```js
// HTTP 接口：GET /api/statistics/sse?channel=company&aggregates=sum&interval=5
// 浏览器端使用 EventSource 接收
const eventSource = new EventSource('/api/statistics/sse?channel=company&aggregates=sum&interval=5');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data); // { channelMetas, list: [{ channel, items, children }] }
};

// 程序化调用（在 Fastify 路由中）
fastify.get('/my-sse', async (request, reply) => {
  const sseContext = await fastify.statistics.services.sseStream.send(reply, {
    name: 'my-sse-channel',
    params: {
      channel: ['company'],
      startTime: new Date(Date.now() - 3600000).toISOString(),
      endTime: new Date().toISOString(),
      aggregates: ['sum']
    },
    fetchData: async (params) => {
      return fastify.statistics.services.query(params);
    },
    interval: 5,
    heartbeatInterval: 30000,
    maxDuration: 1800000
  });

  // 可手动关闭
  // sseContext.close();

  // 监听关闭事件
  sseContext.onClose(() => {
    console.log('SSE 连接已关闭');
  });
});
```

**SSE 事件类型**：

| 事件 | 说明 |
|------|------|
| `data`（默认） | 正常数据推送，内容为查询结果 JSON |
| `timeout` | 连接超过 maxDuration 后自动断开通知 |
| `error` | fetchData 出错时的错误事件 |
| 心跳（`: heartbeat`） | 保活注释行 |

**SSE 上下文方法**：

| 方法 | 说明 |
|------|------|
| `isConnected()` | 返回当前连接状态 |
| `close()` | 手动关闭 SSE 连接 |
| `onClose(callback)` | 注册连接关闭回调，若已断开则立即执行 |

#### 手动触发聚合与重置

```js
// 手动触发指定周期的聚合
await fastify.statistics.services.periodStat.aggregate('h');
await fastify.statistics.services.periodStat.aggregate('d', {
  startTime: new Date('2026-05-01'),
  endTime: new Date('2026-05-02')
});

// 重置 h 周期数据并级联重置所有下游
const result = await fastify.statistics.services.periodStat.resetPeriodStats('h', {
  startTime: new Date('2026-05-01'),
  endTime: new Date('2026-05-02'),
  cascade: true
});
// result: { period: 'h', deletedCount: 48, nextTime: '2026-05-01T00:00:00.000Z', cascade_d: {...}, cascade_w: {...}, ... }

// 刷新缓冲区
await fastify.statistics.services.dataRecord.flush();

// 清理过期数据
await fastify.statistics.services.dataRecord.cleanup();
await fastify.statistics.services.periodStat.cleanupOldPeriodStats();
```


### 示例

### API

### 插件配置

| 属性名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| prefix | string | `/api/statistics` | 路由前缀 |
| dbTableNamePrefix | string | `t_` | 数据库表名前缀 |
| name | string | `statistics` | 命名空间名称 |
| collectFlushInterval | number | `5000` | 缓冲刷新间隔(ms) |
| collectMaxBufferSize | number | `1000` | 缓冲区最大条数 |
| collectMaxBufferOverflow | number | `maxBufferSize * 2` | 缓冲区溢出上限 |
| cache | object | `null` | 缓存实例（提供时启用缓冲模式和查询缓存） |
| compensationEnabled | boolean | `true` | 是否启用启动时自动补偿聚合 |
| compensationBatchSize | number | `24` | 每次补偿聚合的最大窗口数 |
| dataRetentionDays | number | `7` | 原始数据保留天数 |
| queryCacheEnabled | boolean | `true` | 是否启用查询缓存 |
| queryCacheTTL | number | `30` | 实时查询缓存TTL(秒) |
| queryCacheHistoryTTL | number | `3600` | 历史查询缓存TTL(秒) |
| queryCacheMaxEntries | number | `100` | 内存查询缓存最大条数（仅无外部缓存时生效） |
| onRebuild | object | `null` | 重建 hook：`{ beforeAggregate, afterAggregate }`，参数为 `(fastify, ctx)` |

### 数据采集

#### POST `{prefix}/collect`

采集数据，支持单条或批量上报。

**请求体（单条）**：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channel | string | 是 | - | 数据通道，支持多级格式如 `device:sensor1` |
| data | number / object | 是 | - | 数据值。数字为单值，对象为多属性如 `{temp: 25, humidity: 60}` |
| title | string | 否 | channel | 标题 |
| description | string | 否 | - | 描述 |
| attributeName | string | 否 | `default` | 属性名 |
| unit | string / object | 否 | - | 数据单位。字符串时所有属性共用同一单位；对象时按 attributeName 映射单位 |
| time | string | 否 | 当前时间 | 采集时间(ISO格式) |

**请求体（批量）**：以上对象的数组。

**通道展开规则**：`device:sensor1` 展开为 `device` 和 `device:sensor1` 两个通道记录。

**数据展开规则**：`data` 为对象时按属性名拆分。如 `data: {temp: 25, humidity: 60}` 拆分为 `{attributeName: 'temp', data: 25}` 和 `{attributeName: 'humidity', data: 60}`。

**单位展开规则**：`unit` 为字符串时所有属性共用同一单位；为对象时按 attributeName 映射，未匹配到的不设置单位。

**缓冲模式**：配置 `cache` 时，采集数据先写入内存缓冲区，定时或缓冲区满时批量写入数据库；否则直接写入。

### 统计查询

#### GET `{prefix}/query`

获取统计结果，自动合并当前小时未聚合的原始数据。

**查询参数**：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channels | string | 是 | - | 数据通道(逗号分隔多个通道) |
| startTime | string | 是 | - | 开始时间(ISO格式) |
| endTime | string | 是 | - | 结束时间(ISO格式) |
| attributeNames | string | 否 | 全部 | 属性名列表(逗号分隔) |
| aggregates | string | 否 | 全部 | 聚合方法列表(逗号分隔): sum,avg,count,min,max |
| timezone | string | 否 | 服务器时区 | 客户端时区(IANA格式，如 Asia/Shanghai) |
| includeChildren | boolean | 否 | false | 是否包含子通道数据（等同 `channelScope=descendantsTree`） |
| channelScope | string | 否 | exact | `exact` / `descendantsFlat` / `descendantsTree` |
| maxDepth | number | 否 | - | `descendantsFlat` 时限制 channel 层级 |
| format | string | 否 | default | `default` / `flat` / `totals` |

**通道匹配规则**：

- `exact`（默认）：仅精确匹配 channels
- `descendantsTree` / `includeChildren=true`：匹配子通道，返回树形结构
- `descendantsFlat`：匹配子通道，返回**扁平叶子 channel** 列表（避免父级重复计数）

**返回格式**：

默认（`includeChildren=false`）返回扁平列表：

```json
{
  "channelMetas": {
    "sensor": { "channel": "sensor", "title": "传感器", "description": "" }
  },
  "list": [
    {
      "channel": "sensor",
      "period": "h",
      "time": "2026-05-22T08:00:00.000Z",
      "data": { "default": 100 },
      "unit": { "default": "℃" }
    }
  ]
}
```

`includeChildren=true` 时返回树形结构：

```json
{
  "channelMetas": {
    "sensor": { "channel": "sensor", "title": "传感器", "description": "" }
  },
  "list": [
    {
      "channel": "sensor",
      "items": [{ "period": "h", "time": "...", "data": {"default": 100}, "unit": {"default": "℃"} }],
      "children": [
        {
          "channel": "sensor:temp",
          "items": [{ "period": "h", "time": "...", "data": {"default": 25}, "unit": {"default": "℃"} }]
        }
      ]
    }
  ]
}
```

`includeChildren=true` 时 `list` 中每个节点包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| channel | string | 通道名称 |
| items | array | 该通道的统计结果数组（按时间排序），每项包含 `period`、`time`、`data`、`unit` |
| children | array | 子通道数组（递归结构，仅存在子通道时返回） |

`data` 字段格式：

| 条件 | data 格式 | 示例 |
|------|-----------|------|
| 单聚合 | object | `{"default": 100}` 或 `{"temperature": 25, "humidity": 60}` |
| 多聚合 | 嵌套object | `{"sum": {"default": 100}, "avg": {"default": 50}}` |

### SSE 实时推送

#### GET `{prefix}/sse`

基于 Server-Sent Events 的实时统计推送，自动查询最近一小时的统计数据并按指定间隔推送。

**查询参数**：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channels | string | 是 | - | 数据通道(逗号分隔多个通道) |
| attributeNames | string | 否 | 全部 | 属性名列表(逗号分隔) |
| aggregates | string | 否 | 全部 | 聚合方法列表(逗号分隔): sum,avg,count,min,max |
| timezone | string | 否 | 服务器时区 | 客户端时区(IANA格式) |
| includeChildren | boolean | 否 | false | 是否包含子通道数据 |
| interval | number | 否 | `5` | 推送间隔秒数 |

**响应格式**：`Content-Type: text/event-stream`

| 事件类型 | 说明 |
|----------|------|
| `data`（无 event 字段） | 正常数据推送，内容为查询结果的 JSON |
| `timeout` | 连接超过 maxDuration 后自动断开通知 |
| `error` | fetchData 出错时的错误事件 |
| 注释行（`: heartbeat`） | 心跳保活 |

#### GET `{prefix}/rebuild/sse`

聚合重建进度 SSE（长任务，非轮询 query）。

**查询参数**：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| mode | string | 否 | aggregate-only | `aggregate-only` / `reset-and-aggregate` / `repair` |
| channelFilter | string | 否 | - | 推断起始时间的 channel LIKE，如 `interview:%` |
| startTime | string | 否 | - | repair 或显式起始时间(ISO) |
| endTime | string | 否 | - | repair 或显式结束时间(ISO) |
| periods | string | 否 | h,d,w,m,q,y | 聚合周期列表(逗号分隔) |

**SSE 事件**：

| 事件 | 说明 |
|------|------|
| `progress` | `{ stage, message?, percent?, detail? }` |
| `done` | `{ success: true, mode, windowCounts, watermarks }` |
| `error` | `{ message, statusCode? }` |
| 注释行 | 心跳保活 |

宿主可通过插件选项 `onRebuild.beforeAggregate` / `onRebuild.afterAggregate` 注入采集与校验逻辑。

### 程序化 API

通过 `fastify.statistics.services` 访问：

#### 通用方法

| 方法 | 说明 |
|------|------|
| `services.collect(data)` | 采集数据，同 `/collect` 接口逻辑 |
| `services.query(params)` | 查询统计，同 `/query` 接口逻辑 |

#### dataRecord 服务

| 方法 | 说明 |
|------|------|
| `services.dataRecord.collect(data)` | 同 `services.collect` |
| `services.dataRecord.flush()` | 手动刷新缓冲区 |
| `services.dataRecord.cleanup()` | 清理过期的原始数据 |

#### periodStat 服务

| 方法 | 说明 |
|------|------|
| `services.periodStat.init()` | 初始化水位线并执行启动补偿（插件 onReady 自动调用） |
| `services.periodStat.aggregate(period, opts)` | 手动触发指定周期的聚合。`opts.startTime`/`opts.endTime` 可选，默认聚合上一个时间窗口 |
| `services.periodStat.query(params)` | 同 `services.query` |
| `services.periodStat.queryFlat(params)` | 保留策略感知查询 + 扁平 `records` |
| `services.periodStat.queryTotals(params)` | 在 `queryFlat` 之上汇总 `totals` / `totalsByChannel` / `maxByChannel` |
| `services.periodStat.rebuild(opts)` | 聚合重建（支持 `onProgress`） |
| `services.periodStat.clearAll(opts)` | 清空统计表（flush → destroy） |
| `services.periodStat.getRetentionPolicy()` | 读取保留策略 |
| `services.periodStat.getWatermark(period)` | 读取聚合水位线 |
| `services.periodStat.setWatermark(period, nextTime)` | 设置聚合水位线 |
| `services.periodStat.isRebuilding()` | 是否正在 rebuild |
| `services.periodStat.isRebuildInProgress()` | 是否有 rebuild 任务 Promise |
| `services.periodStat.isCompensating()` | 当前是否正在执行补偿聚合 |
| `services.periodStat.invalidateQueryCache(channels?)` | 使查询缓存失效。传入 channels 时只失效相关通道，不传则失效全部 |
| `services.periodStat.cleanupOldPeriodStats()` | 清理过期的周期统计数据 |
| `services.periodStat.resetPeriodStats(period, opts)` | 重置指定周期的数据和水位线，详见下方 |

#### resetPeriodStats 参数

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| period | string | 是 | - | 周期类型: h/d/w/m/q/y |
| opts.startTime | Date | 否 | 当前截断时间 | 重置起始时间（水位线将设为此值） |
| opts.endTime | Date | 否 | 全部 | 仅删除此时间范围内的 period-stat 数据 |
| opts.cascade | boolean | 否 | false | 是否级联重置下游周期 |

**返回值**：`{ period, deletedCount, nextTime, cascade_h?, cascade_d?, ... }`

#### queryFlat 参数

与 `query` 相同，另支持 `channelScope`、`maxDepth`。

**返回值**：`{ channelMetas, records: FlatRecord[], meta: { channelScope, isRealtime, windowsUsed } }`

#### queryTotals 参数

与 `queryFlat` 相同，另支持 `includeRecords`（默认 false）。

**返回值**：

```js
{
  meta: { retentionPolicy, windowsUsed, isRealtime, channelScope },
  totals: { [attributeName]: number },
  totalsByChannel: { [channel]: { [attributeName]: number } },
  maxByChannel: { [channel]: { [attributeName]: number } },
  attrStats: { [attributeName]: { sum, max, count } },
  channelMetas: {},
  records?: FlatRecord[]
}
```

#### rebuild 参数

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| mode | string | 否 | aggregate-only | `aggregate-only` / `reset-and-aggregate` / `repair` |
| startTime | Date | 否 | MIN(data_record.time) | 聚合起始（truncate 到 h） |
| endTime | Date | 否 | now | 聚合结束 |
| periods | string[] | 否 | h,d,w,m,q,y | 要重建的周期 |
| channelFilter | string | 否 | - | 推断 startTime 的 LIKE 过滤 |
| maxWindows | number | 否 | Infinity | 单周期最大窗口数 |
| onProgress | function | 否 | - | 进度回调 |
| beforeAggregate | function | 否 | - | 清库后、聚合前（宿主采集 hook） |
| afterAggregate | function | 否 | - | 聚合后（宿主校验 hook） |

**返回值**：`{ success, mode, windowCounts, watermarks, skipped? }`

并发：重复调用抛 `409 Rebuild already in progress`。

详见 [summary.md](./summary.md) 中「数据保留策略」「查询辅助 API」「重置、重建与修复」章节。

#### channelMeta 服务

| 方法 | 说明 |
|------|------|
| `services.channelMeta.detail({ channel })` | 查询通道元数据 |
| `services.channelMeta.list({ filter? })` | 列出元数据，`filter.channel` 可按通道筛选 |
| `services.channelMeta.save({ channel, title?, description? })` | 修改元数据 |

#### sseStream 服务

| 方法 | 说明 |
|------|------|
| `services.sseStream.send(reply, config)` | 发送 SSE 实时数据流（轮询 query） |
| `services.sseStream.runTask(reply, config)` | 发送 SSE 长任务进度流 |

**send 配置**：

| config 属性 | 类型 | 必填 | 默认值 | 说明 |
|-------------|------|------|--------|------|
| name | string | 是 | - | 缓存键名称标识 |
| params | object | 是 | - | 传递给 fetchData 的参数 |
| fetchData | function | 是 | - | 异步函数 `(params) => data` |
| interval | number | 否 | `5` | 推送间隔秒数 |
| heartbeatInterval | number | 否 | `30000` | 心跳间隔(ms) |
| maxDuration | number | 否 | `1800000` | 最大连接时长(ms) |

**返回值**：SSE 上下文对象

| 方法 | 说明 |
|------|------|
| `isConnected()` | 返回当前连接状态 |
| `close()` | 手动关闭 SSE 连接 |
| `onClose(callback)` | 注册连接关闭回调，若已断开则立即执行 |

**runTask 配置**：

| config 属性 | 类型 | 必填 | 默认值 | 说明 |
|-------------|------|------|--------|------|
| name | string | 是 | - | 任务名称（日志） |
| task | function | 是 | - | 异步 `({ emit }) => result`，`emit(event, data)` |
| heartbeatInterval | number | 否 | `15000` | 心跳间隔(ms) |
| maxDuration | number | 否 | `1800000` | 最大连接时长(ms) |

任务完成后自动发送 `done` 事件；异常时发送 `error` 事件。

### 数据模型

#### data-record（数据采集记录）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道(必填) |
| attributeName | STRING | 属性名(默认 default) |
| data | DECIMAL(16,2) | 数据值(必填) |
| time | DATE | 采集时间(必填) |
| unit | STRING | 数据单位 |

索引：`channel`、`time`、`[channel, time]`、`[channel, attributeName, time]`、`attributeName`

#### period-stat（周期统计）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期(必填): h/d/w/m/q/y |
| time | DATE | 统计时间(必填) |
| channel | STRING | 数据通道(必填) |
| attributeName | STRING | 属性名(默认 default) |
| aggregate | ENUM | 聚合方法(必填): sum/avg/count/min/max |
| data | DECIMAL(16,2) | 统计数据值(必填) |
| unit | STRING | 数据单位 |

唯一约束：`(period, channel, attributeName, aggregate, time)`

索引：`[channel, attributeName, time]`、`[period, time]`、`attributeName`

#### channel-meta（通道元数据）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道(唯一键) |
| title | STRING | 标题(必填) |
| description | TEXT | 描述 |

唯一约束：`channel`

说明：按 root channel（一级通道）唯一存储，所有子通道共享同一份元数据。

#### aggregation-watermark（聚合水位线）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期(唯一键): h/d/w/m/q/y |
| nextTime | DATE | 下一个待聚合时间 |

唯一约束：`period`

说明：水位线记录各周期下一次应聚合的时间起点，用于补偿聚合逻辑。首次聚合时，根据原始数据或上游周期统计的最早时间自动初始化。

### 统计周期

| 周期 | key | Cron 表达式 | 数据来源 |
|------|-----|-------------|----------|
| 时 | h | `1 * * * *` | 原始数据(data-record) |
| 日 | d | `1 0 * * *` | 小时统计(period-stat) |
| 周 | w | `1 0 * * 1` | 日统计(period-stat) |
| 月 | m | `1 0 1 * *` | 日统计(period-stat) |
| 季 | q | `1 0 1 1,4,7,10 *` | 月统计(period-stat) |
| 年 | y | `1 0 1 1 *` | 季统计(period-stat) |

### 聚合方法

| 方法 | key | 说明 |
|------|-----|------|
| 合计 | sum | 数值求和 |
| 平均 | avg | 数值平均(由sum/count计算) |
| 计数 | count | 记录计数 |
| 最小 | min | 最小值 |
| 最大 | max | 最大值 |

### 补偿聚合机制

插件启动时自动执行补偿聚合（可通过 `compensationEnabled: false` 关闭）：

- 水位线记录各周期下一次应聚合的时间起点
- 补偿时从水位线开始逐步向前聚合，直到追上当前时间
- 每次最多处理 `compensationBatchSize` 个时间窗口
- 上游周期未完成时自动先补偿上游
- 每个周期有独立的补偿锁，防止并发补偿
- 连续失败 `maxCompensationFailCount` 次（默认 3）后停止，下次 Cron 继续
- 补偿聚合通过 Cron 定时触发，启动时也会执行一次

### 查询缓存

| 特性 | 说明 |
|------|------|
| 无外部缓存 | 使用内存 LRU 缓存，最大 `queryCacheMaxEntries` 条 |
| 有外部缓存 | 查询结果存入外部缓存，支持 TTL 和版本校验 |
| 版本校验 | 缓存条目记录写入时的通道版本号，读取时校验版本是否变化 |
| TTL 策略 | 实时查询用 `queryCacheTTL`（30s），历史查询用 `queryCacheHistoryTTL`（3600s） |
| 补偿期间 | 正在执行补偿聚合时查询不走缓存 |

### 数据保留策略

| 数据类型 | 保留策略 | 安全检查 |
|----------|----------|----------|
| data-record | `dataRetentionDays` 天（默认 7 天） | 不超过 h 周期水位线 |
| period-stat(h) | 当月 | 不超过 d 水位线 |
| period-stat(d) | 当年 | 不超过 w、m 水位线 |
| period-stat(w) | 当年 | 无下游依赖 |
| period-stat(m/q/y) | 永久保留 | - |
