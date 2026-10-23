const { expect } = require('chai');
const fp = require('fastify-plugin');

describe('OpenAPI 文档完整性', function () {
  it('所有路由都有 tags、summary，参数都有用途说明，并声明 200 响应', async () => {
    const fastify = require('fastify')();
    const routes = [];
    fastify.addHook('onRoute', route => route.method !== 'HEAD' && routes.push(route));
    fastify.decorate('statistics', { services: {} });
    await fp(require('../libs/controllers/main'))(fastify, {
      name: 'statistics',
      prefix: '/api/statistics',
      getAuthenticate: () => []
    });
    await fastify.ready();

    const missing = [];
    const checkProps = (where, schema) => {
      if (!schema) return;
      [].concat(schema.oneOf || [], schema.anyOf || [], schema).forEach(item => {
        Object.entries(item.properties || {}).forEach(([key, prop]) => {
          if (!prop.description) missing.push(`${where}.${key}`);
          if (prop.type === 'object') checkProps(`${where}.${key}`, prop);
        });
        if (item.type === 'array' && item.items) checkProps(`${where}[]`, item.items);
      });
    };
    routes.forEach(route => {
      const { schema = {} } = route;
      const name = `${route.method} ${route.url}`;
      if (!(schema.tags && schema.tags.length)) missing.push(`${name} tags`);
      if (!schema.summary) missing.push(`${name} summary`);
      if (!(schema.response && schema.response[200] && schema.response[200].description)) missing.push(`${name} response`);
      checkProps(`${name} body`, schema.body);
      checkProps(`${name} query`, schema.querystring || schema.query);
      checkProps(`${name} params`, schema.params);
    });
    await fastify.close();
    expect(routes.length).to.equal(5);
    expect(missing).to.deep.equal([]);
  });
});
