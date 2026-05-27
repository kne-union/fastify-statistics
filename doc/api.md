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
| unit | string / object | 否 | - | 数据单位。字符串时所有属性共用同一单位；对象时按 attributeName 映射单位，如 `{temp: '℃', humidity: '%'}` |
| time | string | 否 | 当前时间 | 采集时间(ISO格式) |

**请求体（批量）**：以上对象的数组。

**通道展开规则**：`device:sensor1` 会展开为 `device:sensor1` 和 `device` 两个通道记录。

**数据展开规则**：`data` 为对象时，按属性名拆分为多条记录。例如 `data: {temp: 25, humidity: 60}` 拆分为两条：`{attributeName: 'temp', data: 25}` 和 `{attributeName: 'humidity', data: 60}`。

**单位展开规则**：`unit` 为字符串时，所有属性共用同一单位；`unit` 为对象时，以 attributeName 为 key 获取对应单位，未匹配到的属性不设置单位。例如 `data: {temp: 25, humidity: 60}`，`unit: {temp: '℃', humidity: '%'}` 展开后 temp 的单位为 `℃`，humidity 的单位为 `%`；若 `unit: '℃'`，则两者单位均为 `℃`。

**缓冲模式**：当配置 `cache` 时，采集数据先写入内存缓冲区，定时或缓冲区满时批量写入数据库；否则直接写入。

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

**通道匹配规则**：默认只精确匹配传入的 channels。当 `includeChildren=true` 时，传入 `sensor` 会匹配 `sensor` 和 `sensor:*` 的所有通道，返回树形结构。

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

`includeChildren=true` 时返回树形结构，子通道数据嵌套在 `children` 数组中：

```json
{
  "channelMetas": {
    "sensor": { "channel": "sensor", "title": "传感器", "description": "" }
  },
  "list": [
    {
      "channel": "sensor",
      "items": [
        {
          "period": "h",
          "time": "2026-05-22T08:00:00.000Z",
          "data": { "default": 100 },
          "unit": { "default": "℃" }
        }
      ],
      "children": [
        {
          "channel": "sensor:temp",
          "items": [
            {
              "period": "h",
              "time": "2026-05-22T08:00:00.000Z",
              "data": { "default": 25 },
              "unit": { "default": "℃" }
            }
          ]
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

`data` 字段格式始终为对象（按属性名映射），根据聚合方法数量决定层级：

| 条件 | data 格式 | 示例 |
|------|-----------|------|
| 单聚合 | object | `{"default": 100}` 或 `{"temperature": 25, "humidity": 60}` |
| 多聚合 | 嵌套object | `{"sum": {"default": 100}, "avg": {"default": 50}}` 或 `{"sum": {"temperature": 25}, "avg": {"temperature": 12.5}}` |

`unit` 字段为对象，按属性名映射单位：`{"default": "℃"}` 或 `{"temperature": "℃", "humidity": "%"}`

> **注意**：查询结果中 `aggregate` 不作为独立字段返回。聚合方法（如 sum、avg）被用作 `data` 对象的键名。例如多聚合时 `data` 为 `{"sum": {"default": 100}, "avg": {"default": 50}}`，而非 `[{aggregate: "sum", data: 100}, {aggregate: "avg", data: 50}]`。

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

插件启动时自动执行补偿聚合（可通过 `compensationEnabled: false` 关闭）。补偿逻辑基于 `aggregation-watermark` 表记录的各周期水位线（下一个待聚合时间），从水位线开始逐步向前聚合，直到追上当前时间。

- 每次补偿最多处理 `compensationBatchSize` 个时间窗口
- 上游周期未完成时，自动先补偿上游（如聚合 `d` 前先确保 `h` 已完成）
- 每个周期有独立的补偿锁，防止并发补偿
- 补偿聚合通过 Cron 定时触发，同时启动时也会执行一次

### 查询缓存

查询结果自动缓存，减少重复查询的数据库压力：

- **无外部缓存**：使用内存 LRU 缓存，最大条数由 `queryCacheMaxEntries` 控制
- **有外部缓存**（配置 `cache`）：查询结果存入外部缓存，支持 TTL 和版本校验
- **版本校验**：缓存条目记录写入时的通道版本号，读取时校验版本是否变化，版本不匹配则缓存失效
- **TTL 策略**：实时查询（endTime 在当前小时内）使用 `queryCacheTTL`（默认30秒），历史查询使用 `queryCacheHistoryTTL`（默认3600秒）
- **补偿期间**：正在执行补偿聚合时，查询不走缓存，确保数据实时性

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
| `services.sseStream.send(reply, config)` | 发送 SSE 实时数据流（详见下方） |

### SSE 实时推送

#### GET `{prefix}/sse`

基于 Server-Sent Events 的实时统计推送，自动查询最近一小时的统计数据并按指定间隔推送。

**查询参数**：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| channels | string | 是 | - | 数据通道(逗号分隔多个通道) |
| attributeNames | string | 否 | 全部 | 属性名列表(逗号分隔) |
| aggregates | string | 否 | 全部 | 聚合方法列表(逗号分隔): sum,avg,count,min,max |
| timezone | string | 否 | 服务器时区 | 客户端时区(IANA格式，如 Asia/Shanghai) |
| interval | number | 否 | `5` | 推送间隔秒数 |

**响应格式**：`Content-Type: text/event-stream`

```
data: {"channelMetas":{},"list":[{"channel":"sensor","items":[{"period":"h","time":"...","data":{"default":100}}],"children":[...]}]}

event: timeout
data: {"message":"连接已超过30分钟，自动断开"}

: heartbeat

event: error
data: {"message":"错误信息"}
```

| 事件类型 | 说明 |
|----------|------|
| `data`（无 event 字段） | 正常数据推送，内容为查询结果的 JSON |
| `timeout` | 连接超过 maxDuration 后自动断开通知 |
| `error` | fetchData 出错时的错误事件 |
| 注释行（`: heartbeat`） | 心跳保活 |

**程序化调用**：`services.sseStream.send(reply, config)`

| config 属性 | 类型 | 必填 | 默认值 | 说明 |
|-------------|------|------|--------|------|
| name | string | 是 | - | 缓存键名称标识 |
| params | object | 是 | - | 传递给 fetchData 的参数 |
| fetchData | function | 是 | - | 异步函数 `(params) => data`，获取推送数据 |
| interval | number | 否 | `5` | 推送间隔秒数 |
| heartbeatInterval | number | 否 | `30000` | 心跳间隔(ms) |
| maxDuration | number | 否 | `1800000` | 最大连接时长(ms)，超时自动断开 |

**返回值**：SSE 上下文对象

| 方法 | 说明 |
|------|------|
| `isConnected()` | 返回当前连接状态 |
| `close()` | 手动关闭 SSE 连接 |
| `onClose(callback)` | 注册连接关闭回调，若已断开则立即执行 |

**缓存机制**：当插件配置了 `cache` 时，SSE 推送的数据会按时间窗口缓存，相同 `name`+`params`+`interval` 的请求在同一时间窗口内会命中缓存，避免重复调用 `fetchData`。

### 数据模型

#### data-record（数据采集记录）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道(必填) |
| attributeName | STRING | 属性名(默认 default) |
| data | DECIMAL(16,2) | 数据值(必填) |
| time | DATE | 采集时间(必填) |
| unit | STRING | 数据单位 |

> `title`、`description` 已移至 `channel-meta` 表，按 root channel 关联。

#### period-stat（周期统计）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期(必填) |
| time | DATE | 统计时间(必填) |
| channel | STRING | 数据通道(必填) |
| attributeName | STRING | 属性名(默认 default) |
| aggregate | ENUM | 聚合方法(必填): sum/avg/count/min/max |
| data | DECIMAL(16,2) | 统计数据值(必填) |
| unit | STRING | 数据单位 |

> `title`、`description` 已移至 `channel-meta` 表，按 root channel 关联。

**唯一约束**：`(period, channel, attributeName, aggregate, time)`

#### channel-meta（通道元数据）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| channel | STRING | 数据通道(唯一键) |
| title | STRING | 标题(必填) |
| description | TEXT | 描述 |

**唯一约束**：`channel`

**说明**：`channel-meta` 按 root channel（一级通道）唯一存储，一条元数据被所有以该 root channel 为前缀的子通道共享。首次采集某通道数据时，自动以其 root channel 创建元数据记录。`title` 和 `description` 从采集参数中提取，后续采集忽略（不更新）。`unit` 字段保留在 `data-record` 和 `period-stat` 表中。

#### aggregation-watermark（聚合水位线）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| period | STRING | 统计周期(唯一键): h/d/w/m/q/y |
| nextTime | DATE | 下一个待聚合时间 |

**唯一约束**：`period`

**说明**：水位线记录各周期下一次应聚合的时间起点，用于补偿聚合逻辑。首次聚合时，根据原始数据或上游周期统计的最早时间自动初始化。
