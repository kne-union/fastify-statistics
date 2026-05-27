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

通过 Cron 定时清理过期数据，避免数据无限增长：

| 数据类型 | 保留策略 | 安全检查 |
|----------|----------|----------|
| data-record | `dataRetentionDays` 天（默认 7 天） | 不超过 h 周期水位线 |
| period-stat(h) | 当月 | 不超过 d 周期水位线 |
| period-stat(d) | 当年 | 不超过 w、m 周期水位线 |
| period-stat(w) | 当年 | 无下游依赖 |
| period-stat(m/q/y) | 永久保留 | - |

**安全检查**：删除前检查下游水位线，确保尚未聚合的数据不会被提前删除。

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

### SSE 实时推送

基于 Server-Sent Events 的实时统计推送：

- 按 `interval`（默认 5 秒）定时调用 `fetchData` 获取最新数据推送
- 心跳保活（默认 30 秒），防止连接被代理/负载均衡器断开
- 最大连接时长（默认 30 分钟），超时自动断开并推送 `timeout` 事件
- 防止推送重叠：当前推送未完成时跳过下一次
- 缓存复用：相同 `name`+`params`+`interval` 在同一时间窗口内命中缓存

### 重置与修复

提供 `resetPeriodStats` 方法用于修复错误的聚合数据：

- 删除指定周期和时间范围的 period-stat 记录
- 重置水位线到指定起始点
- 支持 `cascade=true` 级联重置下游周期（如重置 h 时同时重置依赖 h 的 d、w、m、q、y）

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
- **灵活查询**：按通道、时间范围、属性名、聚合方法查询统计结果，自动合并当前小时未聚合的原始数据
- **SSE 实时推送**：基于 Server-Sent Events 的实时数据推送
- **时区支持**：查询时支持传入客户端时区（IANA 格式）
- **事务安全**：所有数据库写操作使用事务保证原子性，聚合操作支持幂等（upsert）
- **查询缓存**：支持内存 LRU 或外部缓存，带版本校验和 TTL 策略


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
| getAuthenticate | function | 抛出异常 | 鉴权函数，参数为 `'read'` 或 `'write'` |

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
| includeChildren | boolean | 否 | false | 是否包含子通道数据 |

**通道匹配规则**：默认只精确匹配传入的 channels。`includeChildren=true` 时，传入 `sensor` 匹配 `sensor` 和 `sensor:*` 的所有通道，返回树形结构。

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

#### channelMeta 服务

| 方法 | 说明 |
|------|------|
| `services.channelMeta.detail({ channel })` | 查询通道元数据 |
| `services.channelMeta.list({ filter? })` | 列出元数据，`filter.channel` 可按通道筛选 |
| `services.channelMeta.save({ channel, title?, description? })` | 修改元数据 |

#### sseStream 服务

| 方法 | 说明 |
|------|------|
| `services.sseStream.send(reply, config)` | 发送 SSE 实时数据流 |

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
