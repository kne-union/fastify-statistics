# fastify-statistics

### 描述

基于 Fastify 的数据采集与多周期聚合统计插件，支持缓冲写入、时区查询和自动 Cron 聚合

### 安装

```shell
npm i --save @kne/fastify-statistics
```

### 概述

### 项目概述

`@kne/fastify-statistics` 是一个基于 Fastify 的数据采集与周期统计插件，提供数据采集、多周期聚合统计和灵活查询功能。

### 主要特性

- **数据采集**：支持单条和批量数据上报，自动展开多属性对象和多级通道
- **缓冲写入**：支持缓存缓冲模式，定时批量写入数据库，减少写入压力
- **多周期聚合**：支持时(h)、日(d)、周(w)、月(m)、季(q)、年(y) 六种统计周期，自动通过 Cron 定时聚合
- **聚合方法**：支持 sum、avg、count、min、max 五种聚合计算
- **灵活查询**：按通道、时间范围、属性名、聚合方法查询统计结果，自动合并当前小时未聚合的原始数据
- **时区支持**：查询时支持传入客户端时区（IANA 格式），解决客户端与服务器时区不一致问题
- **事务安全**：所有数据库写操作使用事务保证原子性，聚合操作支持幂等（upsert）
- **dayjs 时间处理**：所有时间操作统一使用 dayjs 处理，支持时区扩展

### 使用场景

- IoT 设备传感器数据采集与统计分析
- 业务指标实时监控与多周期报表
- 多通道多属性的数据聚合与趋势查询


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
| cache | object | `null` | 缓存实例（提供时启用缓冲模式） |
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
| unit | string | 否 | - | 数据单位 |
| time | string | 否 | 当前时间 | 采集时间(ISO格式) |

**请求体（批量）**：以上对象的数组。

**通道展开规则**：`device:sensor1` 会展开为 `device:sensor1` 和 `device` 两个通道记录。

**数据展开规则**：`data` 为对象时，按属性名拆分为多条记录。例如 `data: {temp: 25, humidity: 60}` 拆分为两条：`{attributeName: 'temp', data: 25}` 和 `{attributeName: 'humidity', data: 60}`。

**缓冲模式**：当配置 `cache` 时，采集数据先写入内存缓冲区，定时或缓冲区满时批量写入数据库；否则直接写入。

### 统计查询

#### GET `{prefix}/query`

获取统计结果，自动合并当前小时未聚合的原始数据。

**查询参数**：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channel | string | 是 | - | 数据通道，支持前缀匹配 |
| startTime | string | 是 | - | 开始时间(ISO格式) |
| endTime | string | 是 | - | 结束时间(ISO格式) |
| attributeNames | string | 否 | 全部 | 属性名列表(逗号分隔) |
| aggregates | string | 否 | 全部 | 聚合方法列表(逗号分隔): sum,avg,count,min,max |
| timezone | string | 否 | 服务器时区 | 客户端时区(IANA格式，如 Asia/Shanghai) |

**通道匹配规则**：传入 `sensor` 会匹配 `sensor` 和 `sensor:*` 的所有通道。

**返回格式**：

```json
[
  {
    "channel": "sensor",
    "period": "h",
    "time": "2026-05-22T08:00:00.000Z",
    "data": 100
  }
]
```

`data` 字段格式根据查询条件动态决定：

| 条件 | data 格式 | 示例 |
|------|-----------|------|
| 单属性 + 单聚合 | number | `100` |
| 单属性 + 多聚合 | object | `{"sum": 100, "avg": 50}` |
| 多属性 + 单聚合 | object | `{"temperature": 25, "humidity": 60}` |
| 多属性 + 多聚合 | 嵌套object | `{"sum": {"temperature": 25}, "avg": {"temperature": 12.5}}` |

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

### 程序化 API

通过 `fastify.statistics.services` 访问：

| 方法 | 说明 |
|------|------|
| `services.collect(data)` | 采集数据，同 `/collect` 接口逻辑 |
| `services.query(params)` | 查询统计，同 `/query` 接口逻辑 |
| `services.periodStat.aggregate(period, opts)` | 手动触发指定周期的聚合 |
| `services.periodStat.query(params)` | 同 `services.query` |
| `services.dataRecord.collect(data)` | 同 `services.collect` |
| `services.dataRecord.flush()` | 手动刷新缓冲区 |

### 数据模型

#### data-record（数据采集记录）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道(必填) |
| title | STRING | 标题(必填) |
| description | TEXT | 描述 |
| attributeName | STRING | 属性名(默认 default) |
| data | DECIMAL(16,2) | 数据值(必填) |
| unit | STRING | 数据单位 |
| time | DATE | 采集时间(必填) |

#### period-stat（周期统计）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期(必填) |
| time | DATE | 统计时间(必填) |
| channel | STRING | 数据通道(必填) |
| title | STRING | 标题(必填) |
| description | TEXT | 描述 |
| attributeName | STRING | 属性名(默认 default) |
| aggregate | ENUM | 聚合方法(必填): sum/avg/count/min/max |
| data | DECIMAL(16,2) | 统计数据值(必填) |
| unit | STRING | 数据单位 |

**唯一约束**：`(period, channel, attributeName, aggregate, time)`
