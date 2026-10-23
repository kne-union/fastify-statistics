const fp = require('fastify-plugin');
const { success, describeOnly, queryResult } = require('../schema/response');

const COLLECT_TAG = '统计-数据采集';
const QUERY_TAG = '统计-统计查询';
const OPS_TAG = '统计-运维';
const CHANNEL_SCOPE = '通道范围: exact(默认) | descendantsFlat(扁平叶子子通道) | descendantsTree(树形子通道)';

const ITEM_PROPERTIES = {
  channel: { type: 'string', description: '数据通道，用冒号分隔层级（如 order:paid），采集时会同时计入各级父通道' },
  title: { type: 'string', description: '标题，写入根通道元信息，不传使用 channel' },
  description: { type: 'string', description: '描述，写入根通道元信息' },
  attributeName: { type: 'string', description: '属性名，data 为数字时用于区分同一通道下的多个指标' },
  data: {
    description: '数据值：数字，或 { 属性名: 数字 } 形式的属性对象',
    anyOf: [{ type: 'number' }, { type: 'object' }]
  },
  unit: { type: 'string', description: '数据单位' },
  time: { type: 'string', description: '采集时间(ISO格式)，不传为当前时间；无法解析时报错' }
};

const parseCommaList = value => (value ? value.split(',') : undefined);

const parseBoolean = value => {
  if (value === true || value === 'true' || value === '1') return true;
  return false;
};

const parseDate = value => {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
};

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  fastify.post(
    `${options.prefix}/collect`,
    {
      onRequest: options.getAuthenticate('write'),
      schema: {
        tags: [COLLECT_TAG],
        description: '采集一条或多条数据（body 为对象或对象数组），写入原始数据并按周期聚合；配置了 cache 时先进入缓冲区定时批量写入',
        summary: '数据采集',
        body: {
          anyOf: [
            {
              type: 'object',
              required: ['channel', 'data'],
              properties: ITEM_PROPERTIES
            },
            {
              type: 'array',
              items: {
                type: 'object',
                required: ['channel', 'data'],
                properties: ITEM_PROPERTIES
              }
            }
          ]
        },
        response: describeOnly('采集成功：单条采集响应体为空；批量采集返回与输入等长、元素为 null 的数组')
      }
    },
    async request => {
      const items = Array.isArray(request.body) ? request.body : [request.body];
      const results = [];
      for (const item of items) {
        const { channel, title, description, attributeName, data, unit, time } = item;
        results.push(
          await services.collect({
            channel,
            title: title ?? channel,
            description,
            attributeName,
            data,
            unit,
            time: time ? parseDate(time) : new Date()
          })
        );
      }
      return Array.isArray(request.body) ? results : results[0];
    }
  );

  fastify.get(
    `${options.prefix}/metrics`,
    {
      onRequest: options.getAuthenticate('metrics'),
      schema: {
        tags: [OPS_TAG],
        description: '以 Prometheus 文本格式输出当前进程的计数、当前值和耗时分位数',
        summary: '进程指标',
        response: describeOnly('text/plain 格式的 Prometheus 指标文本')
      }
    },
    async (request, reply) => {
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return services.metrics.render();
    }
  );

  fastify.get(
    `${options.prefix}/query`,
    {
      onRequest: options.getAuthenticate('read'),
      schema: {
        tags: [QUERY_TAG],
        description: '查询指定通道在时间范围内的聚合统计结果，自动选择合适的统计周期并合并实时数据；format 决定返回结构；时间无法解析时报错',
        summary: '统计查询',
        query: {
          type: 'object',
          required: ['channels', 'startTime', 'endTime'],
          properties: {
            channels: { type: 'string', description: '数据通道(逗号分隔多个通道)' },
            startTime: { type: 'string', description: '开始时间(ISO格式)' },
            endTime: { type: 'string', description: '结束时间(ISO格式)' },
            attributeNames: { type: 'string', description: '属性名列表(逗号分隔)' },
            aggregates: { type: 'string', description: '聚合方法列表(逗号分隔): sum,avg,count,min,max' },
            timezone: { type: 'string', description: '客户端时区(如 Asia/Shanghai)' },
            includeChildren: { type: 'boolean', description: '是否包含子通道数据(默认false，等同 channelScope=descendantsTree)' },
            channelScope: {
              type: 'string',
              description: CHANNEL_SCOPE
            },
            maxDepth: { type: 'number', description: 'descendantsFlat 时限制 channel 冒号层级深度' },
            format: { type: 'string', description: '返回格式: default(按周期列表) | flat(扁平记录) | totals(汇总)，其他值按 default 处理' }
          }
        },
        response: success('统计结果，字段随 format 不同', queryResult)
      }
    },
    async request => {
      const { channels, startTime, endTime, attributeNames, aggregates, timezone, includeChildren, channelScope, maxDepth, format } = request.query;
      const queryParams = {
        channels: parseCommaList(channels),
        startTime: parseDate(startTime),
        endTime: parseDate(endTime),
        attributeNames: parseCommaList(attributeNames),
        aggregates: parseCommaList(aggregates),
        timezone: timezone || undefined,
        includeChildren: parseBoolean(includeChildren),
        channelScope: channelScope || undefined,
        maxDepth: maxDepth ? Number(maxDepth) : undefined
      };

      const periodStat = services.periodStat;
      if (format === 'flat') {
        return periodStat.queryFlat(queryParams);
      }
      if (format === 'totals') {
        return periodStat.queryTotals(queryParams);
      }
      return services.query(queryParams);
    }
  );

  fastify.get(
    `${options.prefix}/sse`,
    {
      onRequest: options.getAuthenticate('read'),
      schema: {
        tags: [QUERY_TAG],
        description: '以 text/event-stream 长连接按 interval 推送最近 1 小时的统计查询结果（结构同统计查询 format=default），客户端断开或超过最长连接时间后结束',
        summary: '实时统计SSE',
        query: {
          type: 'object',
          required: ['channels'],
          properties: {
            channels: { type: 'string', description: '数据通道(逗号分隔多个通道)' },
            attributeNames: { type: 'string', description: '属性名列表(逗号分隔)' },
            aggregates: { type: 'string', description: '聚合方法列表(逗号分隔): sum,avg,count,min,max' },
            timezone: { type: 'string', description: '客户端时区(如 Asia/Shanghai)' },
            includeChildren: { type: 'boolean', description: '是否包含子通道数据(默认false)' },
            channelScope: { description: CHANNEL_SCOPE },
            maxDepth: { description: 'descendantsFlat 时限制 channel 冒号层级深度' },
            interval: { type: 'number', description: '推送间隔秒数', default: 5 }
          }
        },
        response: describeOnly('text/event-stream 事件流，每条 data 为统计查询结果 JSON')
      }
    },
    async (request, reply) => {
      const { channels, attributeNames, aggregates, timezone, includeChildren, channelScope, maxDepth, interval } = request.query;
      await services.sseStream.send(reply, {
        name: 'query',
        params: { channels, attributeNames, aggregates, timezone, includeChildren, channelScope, maxDepth },
        fetchData: async params => {
          const now = new Date();
          const startTime = new Date(now.getTime() - 3600000);
          const queryParams = {
            channels: parseCommaList(params.channels),
            startTime,
            endTime: now,
            attributeNames: parseCommaList(params.attributeNames),
            aggregates: parseCommaList(params.aggregates),
            timezone: params.timezone || undefined,
            includeChildren: parseBoolean(params.includeChildren),
            channelScope: params.channelScope || undefined,
            maxDepth: params.maxDepth ? Number(params.maxDepth) : undefined
          };
          return services.query(queryParams);
        },
        interval: interval ?? 5
      });
    }
  );

  fastify.get(
    `${options.prefix}/rebuild/sse`,
    {
      onRequest: options.getAuthenticate('read'),
      schema: {
        tags: [OPS_TAG],
        description: '按模式重建统计聚合并以 text/event-stream 推送进度（progress 事件）和最终结果（done 事件）；已有重建在进行中时返回 409',
        summary: '聚合重建 SSE',
        query: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              description: '重建模式: aggregate-only | reset-and-aggregate | repair',
              default: 'aggregate-only'
            },
            channelFilter: { type: 'string', description: '推断起始时间的 channel LIKE 过滤，如 interview:%' },
            startTime: { type: 'string', description: 'repair 模式或显式起始时间(ISO)' },
            endTime: { type: 'string', description: 'repair 模式或显式结束时间(ISO)' },
            periods: { type: 'string', description: '聚合周期列表(逗号分隔)，默认 h,d,w,m,q,y' }
          }
        },
        response: describeOnly('text/event-stream 事件流：progress 事件推送阶段进度，done 事件推送重建结果，失败时推送 error 事件')
      }
    },
    async (request, reply) => {
      const { mode, channelFilter, startTime, endTime, periods } = request.query;
      const periodStat = services.periodStat;

      if (periodStat.isRebuildInProgress()) {
        reply.code(409);
        return { message: 'Rebuild already in progress' };
      }

      const onRebuild = options.onRebuild || {};

      await services.sseStream.runTask(reply, {
        name: 'rebuild',
        task: async ({ emit }) => {
          return periodStat.rebuild({
            mode: mode || 'aggregate-only',
            channelFilter: channelFilter || null,
            startTime: startTime ? parseDate(startTime) : null,
            endTime: endTime ? parseDate(endTime) : null,
            periods: periods ? parseCommaList(periods) : undefined,
            onProgress: payload => emit('progress', payload),
            beforeAggregate: onRebuild.beforeAggregate ? ctx => onRebuild.beforeAggregate(fastify, ctx) : undefined,
            afterAggregate: onRebuild.afterAggregate ? ctx => onRebuild.afterAggregate(fastify, ctx) : undefined
          });
        }
      });
    }
  );
});
