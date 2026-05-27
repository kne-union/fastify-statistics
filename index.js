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
        compensationBatchSize: 24,
        compensationEnabled: true,
        dataRetentionDays: 7,
        queryCacheEnabled: true,
        queryCacheTTL: 30,
        queryCacheHistoryTTL: 3600,
        queryCacheMaxEntries: 100,
        getAuthenticate: () => {
          return [
            () => {
              throw new Error('接口禁止访问');
            }
          ];
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

    fastify.addHook('onReady', async () => {
      await fastify[options.name].services.periodStat.init();
    });
  },
  {
    name: 'fastify-statistics',
    dependencies: ['fastify-cron', 'fastify-sequelize']
  }
);
