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
- **SSE 实时推送**：基于 Server-Sent Events 的实时数据推送，支持自定义间隔、心跳保活、超时断开和缓存复用
- **时区支持**：查询时支持传入客户端时区（IANA 格式），解决客户端与服务器时区不一致问题
- **事务安全**：所有数据库写操作使用事务保证原子性，聚合操作支持幂等（upsert）
- **dayjs 时间处理**：所有时间操作统一使用 dayjs 处理，支持时区扩展

### 使用场景

- IoT 设备传感器数据采集与统计分析
- 业务指标实时监控与多周期报表
- 多通道多属性的数据聚合与趋势查询

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
  cache: redisCacheInstance,   // 传入缓存实例启用缓冲模式
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
