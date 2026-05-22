const fp = require('fastify-plugin');

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
              properties: {
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
              }
            },
            {
              type: 'array',
              items: {
                type: 'object',
                required: ['channel', 'data'],
                properties: {
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
                }
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
        const result = await services.collect({
          channel,
          title: title || channel,
          description,
          attributeName,
          data,
          unit,
          time: time ? new Date(time) : new Date()
        });
        results.push(result);
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
          required: ['channel', 'startTime', 'endTime'],
          properties: {
            channel: { type: 'string', description: '数据通道' },
            startTime: { type: 'string', description: '开始时间(ISO格式)' },
            endTime: { type: 'string', description: '结束时间(ISO格式)' },
            attributeNames: { type: 'string', description: '属性名列表(逗号分隔)' },
            aggregates: { type: 'string', description: '聚合方法列表(逗号分隔): sum,avg,count,min,max' },
            timezone: { type: 'string', description: '客户端时区(如 Asia/Shanghai)' }
          }
        }
      }
    },
    async request => {
      const { channel, startTime, endTime, attributeNames, aggregates, timezone } = request.query;
      return services.query({
        channel,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        attributeNames: attributeNames ? attributeNames.split(',') : undefined,
        aggregates: aggregates ? aggregates.split(',') : undefined,
        timezone: timezone || undefined
      });
    }
  );
});
