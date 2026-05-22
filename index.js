const fp = require('fastify-plugin');
const path = require('node:path');

module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {},
      {
        prefix: '/api/statistics',
        dbTableNamePrefix: 't_',
        name: 'statistics',
        collectFlushInterval: 5000,
        collectMaxBufferSize: 1000,
        cache: null,
        getAuthenticate: () => {
          throw new Error('接口禁止访问');
        }
      },
      options
    );

    fastify.register(require('@kne/fastify-namespace'), {
      options,
      name: options.name,
      modules: [
        ['controllers', path.resolve(__dirname, './libs/controllers')],
        [
          'models',
          await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
            prefix: options.dbTableNamePrefix,
            modelPrefix: options.name
          })
        ],
        ['services', path.resolve(__dirname, './libs/services')]
      ]
    });
  },
  {
    name: 'fastify-statistics',
    dependencies: ['fastify-cron', 'fastify-sequelize']
  }
);
