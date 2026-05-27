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
