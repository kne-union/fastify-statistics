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
        // 物理清理 data_record / period_stat 已软删（deleted_at）数据的 Cron，默认每天 02:00
        purgeDeletedCron: '0 2 * * *',
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
        },
        onRebuild: null
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

    // 水位线启动补偿可能很长（迁库/水位线过期时可达数十秒），不能 await，否则会触发
    // Fastify pluginTimeout（默认 10s）导致 FST_ERR_HOOK_TIMEOUT，服务起不来。
    fastify.addHook('onReady', () => {
      fastify[options.name].services.periodStat.init().catch(err => {
        fastify.log.error({ err }, 'Statistics periodStat.init failed');
      });
    });
  },
  {
    name: 'fastify-statistics',
    dependencies: ['fastify-cron', 'fastify-sequelize']
  }
);
