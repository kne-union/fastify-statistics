const { expect } = require('chai');
const fp = require('fastify-plugin');

describe('进程指标', function () {
  async function createApp() {
    const fastify = require('fastify')();
    fastify.decorate('statistics', { services: {} });
    await fp(require('../libs/services/metrics'))(fastify, {
      name: 'statistics',
      prefix: '/api/statistics',
      instanceId: 'host:1',
      metricsBuckets: [10, 50, 100]
    });
    await fp(require('../libs/controllers/main'))(fastify, {
      name: 'statistics',
      prefix: '/api/statistics',
      getAuthenticate: () => []
    });
    return fastify;
  }

  it('should count, set the current value, and expose latency quantiles', async () => {
    const fastify = await createApp();
    const { metrics } = fastify.statistics.services;
    metrics.inc('http_requests', { route: '/order' });
    metrics.inc('http_requests', { route: '/order' }, 2);
    metrics.set('queue_depth', 4, { queue: 'mail' });
    metrics.set('queue_depth', 7, { queue: 'mail' });
    metrics.observe('http_request_ms', 8, { route: '/order' });
    metrics.observe('http_request_ms', 40, { route: '/order' });
    metrics.observe('http_request_ms', 80, { route: '/order' });

    const body = metrics.render();
    expect(body).to.contain('http_requests_total{instance="host:1",route="/order"} 3');
    expect(body).to.contain('queue_depth{instance="host:1",queue="mail"} 7');
    expect(body).to.contain('http_request_ms_bucket{instance="host:1",le="10",route="/order"} 1');
    expect(body).to.contain('http_request_ms_bucket{instance="host:1",le="+Inf",route="/order"} 3');
    expect(body).to.contain('http_request_ms_count{instance="host:1",route="/order"} 3');
    expect(body).to.contain('http_request_ms_quantile{instance="host:1",quantile="0.5",route="/order"} 40');
    await fastify.close();
  });

  it('should serve GET /metrics as prometheus text', async () => {
    const fastify = await createApp();
    fastify.statistics.services.metrics.set('online_connections', 2);
    const response = await fastify.inject({ method: 'GET', url: '/api/statistics/metrics' });
    expect(response.statusCode).to.equal(200);
    expect(response.headers['content-type']).to.contain('text/plain');
    expect(response.body).to.contain('online_connections{instance="host:1"} 2');
    expect(response.body).to.contain('statistics_info{instance="host:1"} 1');
    await fastify.close();
  });
});
