const fp = require('fastify-plugin');

const ITEM_PROPERTIES = {
  channel: { type: 'string', description: '数据通道' },
  title: { type: 'string', description: '标题' },
  description: { type: 'string', description: '描述' },
  attributeName: { type: 'string', description: '属性名' },
  data: {
    description: '数据值(数字或属性对象)',
    anyOf: [{ type: 'number' }, { type: 'object' }]
  },
  unit: { type: 'string', description: '数据单位' },
  time: { type: 'string', description: '采集时间(ISO格式)' }
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
        description: '采集数据',
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
        }
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
    `${options.prefix}/query`,
    {
      onRequest: options.getAuthenticate('read'),
      schema: {
        description: '获取统计结果',
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
            includeChildren: { type: 'boolean', description: '是否包含子通道数据(默认false)' }
          }
        }
      }
    },
    async request => {
      const { channels, startTime, endTime, attributeNames, aggregates, timezone, includeChildren } = request.query;
      return services.query({
        channels: parseCommaList(channels),
        startTime: parseDate(startTime),
        endTime: parseDate(endTime),
        attributeNames: parseCommaList(attributeNames),
        aggregates: parseCommaList(aggregates),
        timezone: timezone || undefined,
        includeChildren: parseBoolean(includeChildren)
      });
    }
  );

  fastify.get(
    `${options.prefix}/sse`,
    {
      onRequest: options.getAuthenticate('read'),
      schema: {
        description: 'SSE实时统计推送',
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
            interval: { type: 'number', description: '推送间隔秒数', default: 5 }
          }
        }
      }
    },
    async (request, reply) => {
      const { channels, attributeNames, aggregates, timezone, includeChildren, interval } = request.query;
      await services.sseStream.send(reply, {
        name: 'query',
        params: { channels, attributeNames, aggregates, timezone, includeChildren },
        fetchData: async params => {
          const now = new Date();
          const startTime = new Date(now.getTime() - 3600000);
          return services.query({
            channels: parseCommaList(params.channels),
            startTime,
            endTime: now,
            attributeNames: parseCommaList(params.attributeNames),
            aggregates: parseCommaList(params.aggregates),
            timezone: params.timezone || undefined,
            includeChildren: parseBoolean(params.includeChildren)
          });
        },
        interval: interval ?? 5
      });
    }
  );
});
