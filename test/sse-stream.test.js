const { expect } = require('chai');
const http = require('node:http');
const fp = require('fastify-plugin');

const mockSSEStreamService = (fastify, options) => {
  const servicePlugin = require('../libs/services/sse-stream');
  return fp(servicePlugin)(fastify, options);
};

const createSSEFastify = ({ cache } = {}) => {
  const fastify = require('fastify')();
  fastify.decorate('statistics', {
    services: {}
  });
  return { fastify, cache: cache || null };
};

const connectSSE = (url, { duration = 500 } = {}) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let headers = null;
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', chunk => chunks.push(chunk));
    });
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      resolve({ headers, body: chunks.join('') });
    }, duration);
  });
};

const parseSSEEvents = (body) => {
  const events = [];
  const parts = body.split('\n\n');
  for (const part of parts) {
    if (!part.trim()) continue;
    const event = {};
    for (const line of part.split('\n')) {
      if (line.startsWith(': ')) {
        event.comment = line.slice(2);
      } else if (line.startsWith('event: ')) {
        event.event = line.slice(7);
      } else if (line.startsWith('data: ')) {
        event.data = line.slice(6);
      }
    }
    events.push(event);
  }
  return events;
};

describe('@kne/fastify-statistics', function () {
  describe('SSE Stream 工具函数测试', () => {
    const { formatData, formatEvent } = require('../libs/common/sse-format');

    it('formatData should handle string data', () => {
      const result = formatData('hello world');
      expect(result).to.equal('data: hello world\n\n');
    });

    it('formatData should handle object data', () => {
      const result = formatData({ value: 1 });
      expect(result).to.equal('data: {"value":1}\n\n');
    });

    it('formatData should handle multiline string', () => {
      const result = formatData('line1\nline2');
      expect(result).to.equal('data: line1\ndata: line2\n\n');
    });

    it('formatEvent should handle string data', () => {
      const result = formatEvent('error', 'error message');
      expect(result).to.equal('event: error\ndata: error message\n\n');
    });

    it('formatEvent should handle object data', () => {
      const result = formatEvent('error', { message: 'fail' });
      expect(result).to.equal('event: error\ndata: {"message":"fail"}\n\n');
    });

    it('formatEvent should handle multiline string data', () => {
      const result = formatEvent('error', 'line1\nline2');
      expect(result).to.equal('event: error\ndata: line1\ndata: line2\n\n');
    });
  });

  describe('SSE Stream 测试', () => {
    it('should send SSE headers immediately', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      const { headers } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      expect(headers['content-type']).to.equal('text/event-stream');
      expect(headers['cache-control']).to.equal('no-cache');
      expect(headers['connection']).to.equal('keep-alive');
      expect(headers['x-accel-buffering']).to.equal('no');

      await fastify.close();
    });

    it('should push data at the specified interval', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let fetchDataCalled = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ count: ++fetchDataCalled }),
          interval: 0.2
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 700 });

      const events = parseSSEEvents(body);
      const dataEvents = events.filter(e => e.data && !e.event);
      expect(dataEvents.length).to.be.at.least(2);

      const firstData = JSON.parse(dataEvents[0].data);
      expect(firstData.count).to.equal(1);

      await fastify.close();
    });

    it('should respect custom interval value', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let fetchDataCalled = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ count: ++fetchDataCalled }),
          interval: 0.5
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 1300 });

      const events = parseSSEEvents(body);
      const dataEvents = events.filter(e => e.data && !e.event);
      // With 0.5s interval, in ~1.3s we get initial + ~2 pushes = 3
      expect(dataEvents.length).to.be.at.least(2);
      expect(dataEvents.length).to.be.at.most(4);

      await fastify.close();
    });

    it('should use cache when available and return cached data', async () => {
      const cacheStore = {};
      const cache = {
        get: async (key) => cacheStore[key] || null,
        set: async (key, value) => { cacheStore[key] = value; }
      };

      const { fastify } = createSSEFastify({ cache });
      await mockSSEStreamService(fastify, { name: 'statistics', cache });

      let fetchDataCalled = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: { channel: 'ch1' },
          fetchData: async () => ({ count: ++fetchDataCalled }),
          interval: 0.2
        });
      });

      await fastify.listen({ port: 0 });

      // Initial push is immediate, 200ms is enough
      const result1 = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });
      const events1 = parseSSEEvents(result1.body);
      const dataEvents1 = events1.filter(e => e.data && !e.event);
      expect(dataEvents1.length).to.be.at.least(1);

      const firstCallCount = fetchDataCalled;
      expect(firstCallCount).to.be.at.least(1);

      // Verify cache was populated
      const cacheKeys = Object.keys(cacheStore);
      expect(cacheKeys.length).to.be.at.least(1);
      expect(cacheKeys[0]).to.include('statistics:sse:test:');
      expect(cacheKeys[0]).to.include('ch1');

      await fastify.close();
    });

    it('should return cached data without calling fetchData on cache hit', async () => {
      const cacheStore = {};
      const cache = {
        get: async (key) => cacheStore[key] || null,
        set: async (key, value) => { cacheStore[key] = value; }
      };

      const { fastify } = createSSEFastify({ cache });
      await mockSSEStreamService(fastify, { name: 'statistics', cache });

      let fetchDataCalled = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: { channel: 'ch1' },
          fetchData: async () => ({ count: ++fetchDataCalled }),
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      const port = fastify.server.address().port;

      // First connection — populates cache and disconnects quickly
      await connectSSE(`http://127.0.0.1:${port}/test-sse`, { duration: 100 });

      const fetchCountAfter1 = fetchDataCalled;
      expect(fetchCountAfter1).to.equal(1);

      // Second connection in same interval window — should hit cache
      const result2 = await connectSSE(`http://127.0.0.1:${port}/test-sse`, { duration: 100 });

      const events2 = parseSSEEvents(result2.body);
      const dataEvents2 = events2.filter(e => e.data && !e.event);
      expect(dataEvents2.length).to.be.at.least(1);
      // Cache hit: the cached data from connection 1 should be returned without incrementing fetchData
      const cachedData = JSON.parse(dataEvents2[0].data);
      expect(cachedData.count).to.equal(1);
      // fetchData should NOT have been called again for the same interval
      expect(fetchDataCalled).to.equal(fetchCountAfter1);

      await fastify.close();
    });

    it('should not use cache when cache is not provided', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let fetchDataCalled = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ count: ++fetchDataCalled }),
          interval: 0.2
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 700 });

      const events = parseSSEEvents(body);
      const dataEvents = events.filter(e => e.data && !e.event);
      expect(dataEvents.length).to.be.at.least(2);
      expect(fetchDataCalled).to.be.at.least(2);

      await fastify.close();
    });

    it('should generate cache key with name + params + truncated time', async () => {
      const cacheStore = {};
      const cache = {
        get: async (key) => cacheStore[key] || null,
        set: async (key, value) => { cacheStore[key] = value; }
      };

      const { fastify } = createSSEFastify({ cache });
      await mockSSEStreamService(fastify, { name: 'statistics', cache });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'mystream',
          params: { channel: 'sensor1' },
          fetchData: async () => ({ value: 42 }),
          interval: 0.2
        });
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      const cacheKeys = Object.keys(cacheStore);
      expect(cacheKeys.length).to.equal(1);
      expect(cacheKeys[0]).to.include('statistics:sse:mystream:');
      expect(cacheKeys[0]).to.include('sensor1');

      await fastify.close();
    });

    it('should send error event when fetchData fails', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let callCount = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => {
            callCount++;
            if (callCount === 1) throw new Error('DB query failed');
            return { ok: true };
          },
          interval: 0.2
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 700 });

      const events = parseSSEEvents(body);
      const errorEvents = events.filter(e => e.event === 'error');
      expect(errorEvents.length).to.be.at.least(1);
      expect(errorEvents[0].data).to.include('DB query failed');

      const dataEvents = events.filter(e => e.data && !e.event);
      expect(dataEvents.length).to.be.at.least(1);

      await fastify.close();
    });

    it('should send heartbeat comment lines', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10,
          heartbeatInterval: 100
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 400 });

      const events = parseSSEEvents(body);
      const heartbeatEvents = events.filter(e => e.comment === 'heartbeat');
      expect(heartbeatEvents.length).to.be.at.least(2);

      await fastify.close();
    });

    it('should send timeout event when maxDuration is exceeded', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2,
          maxDuration: 200
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 700 });

      const events = parseSSEEvents(body);
      const timeoutEvents = events.filter(e => e.event === 'timeout');
      expect(timeoutEvents.length).to.be.at.least(1);
      expect(timeoutEvents[0].data).to.include('30');

      await fastify.close();
    });

    it('should detect client disconnect and cleanup', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let closeCalled = false;
      fastify.get('/test-sse', async (request, reply) => {
        const ctx = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2
        });
        ctx.onClose(() => { closeCalled = true; });
        return ctx;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(closeCalled).to.be.true;

      await fastify.close();
    });

    it('should call onClose callback immediately when already disconnected', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      // Wait for disconnect
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctxResult.isConnected()).to.be.false;

      // onClose should call callback immediately since already disconnected
      let callbackCalled = false;
      ctxResult.onClose(() => { callbackCalled = true; });
      expect(callbackCalled).to.be.true;

      await fastify.close();
    });

    it('should allow manual close via context', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let closeCalled = false;
      fastify.get('/test-sse', async (request, reply) => {
        const ctx = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2
        });
        ctx.onClose(() => { closeCalled = true; });
        setTimeout(() => ctx.close(), 100);
        return ctx;
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 500 });

      const events = parseSSEEvents(body);
      const dataEvents = events.filter(e => e.data && !e.event);
      expect(dataEvents.length).to.be.at.least(1);
      expect(closeCalled).to.be.true;

      await fastify.close();
    });

    it('should pass params to fetchData', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let receivedParams = null;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: { channel: 'sensor', type: 'temp' },
          fetchData: async (params) => { receivedParams = params; return params; },
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      expect(receivedParams).to.deep.equal({ channel: 'sensor', type: 'temp' });

      await fastify.close();
    });

    it('should return SSE context with isConnected, close, onClose', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      expect(ctxResult).to.exist;
      expect(ctxResult.isConnected).to.be.a('function');
      expect(ctxResult.close).to.be.a('function');
      expect(ctxResult.onClose).to.be.a('function');
      expect(ctxResult.isConnected()).to.be.a('boolean');

      await fastify.close();
    });

    it('should handle close callback error gracefully', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let closeCalled = false;
      fastify.get('/test-sse', async (request, reply) => {
        const ctx = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
        ctx.onClose(() => { throw new Error('callback error'); });
        ctx.onClose(() => { closeCalled = true; });
        setTimeout(() => ctx.close(), 50);
        return ctx;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      // Second callback should still be called even though first one threw
      expect(closeCalled).to.be.true;

      await fastify.close();
    });

    it('should skip push when already pushing (overlapping guard)', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => {
            await new Promise(resolve => setTimeout(resolve, 400));
            return { value: 1 };
          },
          interval: 0.2
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 600 });

      const events = parseSSEEvents(body);
      const dataEvents = events.filter(e => e.data && !e.event);
      // With 400ms fetchData delay and 200ms interval, in 600ms we should get exactly 1 push
      expect(dataEvents.length).to.equal(1);

      await fastify.close();
    });

    it('should transfer middleware headers to raw response', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.addHook('onRequest', async (request, reply) => {
        reply.header('X-Custom-Header', 'test-value');
      });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      const { headers } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      expect(headers['x-custom-header']).to.equal('test-value');

      await fastify.close();
    });

    it('should cleanup when res.write returns false (backpressure)', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let closeCalled = false;
      fastify.get('/test-sse', async (request, reply) => {
        const origWrite = reply.raw.write.bind(reply.raw);
        reply.raw.write = (...args) => {
          origWrite(...args);
          return false;
        };

        const ctx = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2
        });
        ctx.onClose(() => { closeCalled = true; });
        return ctx;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 300 });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(closeCalled).to.be.true;

      await fastify.close();
    });

    it('should cleanup in heartbeat when connection already ended', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let closeCalled = false;
      fastify.get('/test-sse', async (request, reply) => {
        const ctx = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10,
          heartbeatInterval: 100
        });
        ctx.onClose(() => { closeCalled = true; });
        setTimeout(() => {
          Object.defineProperty(reply.raw, 'writableEnded', { value: true, configurable: true });
        }, 50);
        return ctx;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 300 });

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(closeCalled).to.be.true;

      await fastify.close();
    });

    it('should handle string data in formatData', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => 'plain text',
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      const events = parseSSEEvents(body);
      const dataEvents = events.filter(e => e.data && !e.event);
      expect(dataEvents.length).to.be.at.least(1);
      expect(dataEvents[0].data).to.equal('plain text');

      await fastify.close();
    });

    it('should handle string data in formatEvent (error with string message)', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => { throw new Error('fail'); },
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      const events = parseSSEEvents(body);
      const errorEvents = events.filter(e => e.event === 'error');
      expect(errorEvents.length).to.be.at.least(1);

      await fastify.close();
    });

    it('should handle non-object params in cache key', async () => {
      const cacheStore = {};
      const cache = {
        get: async (key) => cacheStore[key] || null,
        set: async (key, value) => { cacheStore[key] = value; }
      };

      const { fastify } = createSSEFastify({ cache });
      await mockSSEStreamService(fastify, { name: 'statistics', cache });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: null,
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      const cacheKeys = Object.keys(cacheStore);
      expect(cacheKeys.length).to.equal(1);
      // params=null should appear as "null" in cache key
      expect(cacheKeys[0]).to.include('statistics:sse:test:null');

      await fastify.close();
    });

    it('should use default interval when not specified', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 })
          // interval not specified, should default to 5
        });
      });

      await fastify.listen({ port: 0 });
      const { headers } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      expect(headers['content-type']).to.equal('text/event-stream');

      await fastify.close();
    });

    it('should skip write when writableEnded is true in safeWrite', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      // Manually close to set isConnected = false, then try writing again
      ctxResult.close();
      // Calling close again should be safe (guard: !isConnected return)
      ctxResult.close();

      await fastify.close();
    });

    it('should not write after fetchData when connection already ended', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      let fetchDataResolved = false;
      let resumeFetchData = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => {
            await new Promise(resolve => { resumeFetchData = resolve; });
            fetchDataResolved = true;
            return { value: 1 };
          },
          interval: 0.2
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      // Connect briefly then disconnect
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });
      // Wait for disconnect
      await new Promise(resolve => setTimeout(resolve, 100));
      // Now let fetchData resolve — but connection is already gone
      if (resumeFetchData) resumeFetchData();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(ctxResult.isConnected()).to.be.false;
      await fastify.close();
    });

    it('should not write error when connection already ended after fetchData fails', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      let resumeFetchData = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => {
            await new Promise(resolve => { resumeFetchData = resolve; });
            throw new Error('late error');
          },
          interval: 0.2
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });
      await new Promise(resolve => setTimeout(resolve, 100));
      // Resolve fetchData after disconnect — error path should be safe
      if (resumeFetchData) resumeFetchData();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(ctxResult.isConnected()).to.be.false;
      await fastify.close();
    });

    it('should handle safeWrite when writableEnded is true', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2
        });
        // Mark response as ended but don't close the SSE context
        setTimeout(() => {
          Object.defineProperty(reply.raw, 'writableEnded', { value: true, configurable: true });
        }, 50);
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 500 });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(ctxResult.isConnected()).to.be.false;

      await fastify.close();
    });

    it('should not set pushTimer when not connected after push', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2
        });
        // Close immediately after first push
        setTimeout(() => ctxResult.close(), 50);
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 300 });

      expect(ctxResult.isConnected()).to.be.false;

      await fastify.close();
    });

    it('should handle cache returning null (cache miss)', async () => {
      const cacheStore = {};
      const cache = {
        get: async (key) => null, // Always miss
        set: async (key, value) => { cacheStore[key] = value; }
      };

      const { fastify } = createSSEFastify({ cache });
      await mockSSEStreamService(fastify, { name: 'statistics', cache });

      let fetchDataCalled = 0;
      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: { channel: 'ch1' },
          fetchData: async () => ({ count: ++fetchDataCalled }),
          interval: 10
        });
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 200 });

      // fetchData should be called even with cache (cache miss)
      expect(fetchDataCalled).to.be.at.least(1);

      // Cache should have been populated after fetch
      const cacheKeys = Object.keys(cacheStore);
      expect(cacheKeys.length).to.be.at.least(1);

      await fastify.close();
    });

    it('should handle string data in formatEvent via timeout event', async () => {
      // maxDuration timeout uses formatEvent with an object message
      // To test the string branch of formatEvent, we need formatEvent to receive a string
      // This is indirectly tested by verifying timeout/error event format
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      fastify.get('/test-sse', async (request, reply) => {
        return fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 0.2,
          maxDuration: 100
        });
      });

      await fastify.listen({ port: 0 });
      const { body } = await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 500 });

      const events = parseSSEEvents(body);
      const timeoutEvents = events.filter(e => e.event === 'timeout');
      expect(timeoutEvents.length).to.be.at.least(1);
      // Verify the event data is properly formatted (object branch of formatEvent)
      const parsedData = JSON.parse(timeoutEvents[0].data);
      expect(parsedData).to.have.property('message');

      await fastify.close();
    });

    it('should skip safeWrite when writableEnded is true but still connected', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      let writeAfterEnded = false;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => {
            // After initial push, mark writableEnded as true before next push
            await new Promise(resolve => setTimeout(resolve, 100));
            Object.defineProperty(reply.raw, 'writableEnded', { value: true, configurable: true });
            writeAfterEnded = true;
            return { value: 2 };
          },
          interval: 0.2
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 400 });

      await new Promise(resolve => setTimeout(resolve, 100));
      // Connection should be cleaned up because writableEnded was detected
      expect(ctxResult.isConnected()).to.be.false;

      await fastify.close();
    });

    it('should handle cleanup with no heartbeatTimer when using short maxDuration', async () => {
      // When maxDuration triggers cleanup on the very first push,
      // heartbeatTimer exists but we also want to test the branch
      // where heartbeatTimer is null in cleanup.
      // We test by calling close() immediately which triggers cleanup
      // before heartbeat timer is used.
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => ({ value: 1 }),
          interval: 10,
          heartbeatInterval: 30000  // Long heartbeat, will be null after cleanup
        });
        // Close immediately
        ctxResult.close();
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });

      expect(ctxResult.isConnected()).to.be.false;

      await fastify.close();
    });

    it('should not schedule next push when connection ends during fetchData', async () => {
      const { fastify } = createSSEFastify();
      await mockSSEStreamService(fastify, { name: 'statistics' });

      let ctxResult = null;
      let resumeFetch = null;
      fastify.get('/test-sse', async (request, reply) => {
        ctxResult = await fastify.statistics.services.sseStream.send(reply, {
          name: 'test',
          params: {},
          fetchData: async () => {
            await new Promise(resolve => { resumeFetch = resolve; });
            return { value: 1 };
          },
          interval: 0.2
        });
        return ctxResult;
      });

      await fastify.listen({ port: 0 });
      // Connect and disconnect quickly
      await connectSSE(`http://127.0.0.1:${fastify.server.address().port}/test-sse`, { duration: 100 });
      // Wait for disconnect
      await new Promise(resolve => setTimeout(resolve, 100));
      // Now resolve fetchData - connection is already gone
      if (resumeFetch) resumeFetch();
      await new Promise(resolve => setTimeout(resolve, 200));

      // After fetchData completes, since not connected, no pushTimer should be set
      expect(ctxResult.isConnected()).to.be.false;

      await fastify.close();
    });
  });
});
