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

