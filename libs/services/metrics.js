const fp = require('fastify-plugin');

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertName(name) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid metric name: ${name}`);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels) {
  const entries = Object.entries(labels || {}).filter(([, value]) => value != null && value !== '');
  if (!entries.length) return '';
  const body = entries
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => {
      if (!LABEL_RE.test(key)) throw new Error(`Invalid metric label: ${key}`);
      return `${key}="${escapeLabel(value)}"`;
    })
    .join(',');
  return `{${body}}`;
}

function seriesKey(name, labels) {
  return `${name}|${formatLabels(labels)}`;
}

function quantile(samples, ratio) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

module.exports = fp(async (fastify, options) => {
  const buckets = (options.metricsBuckets || DEFAULT_BUCKETS).map(Number).sort((a, b) => a - b);
  const maxSamples = options.metricsSampleSize || 500;
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();

  function withInstance(labels) {
    const next = { ...(labels || {}) };
    if (options.instanceId && next.instance == null) next.instance = options.instanceId;
    return next;
  }

  function counterName(name) {
    return name.endsWith('_total') ? name : `${name}_total`;
  }

  function inc(name, labels, by = 1) {
    assertName(name);
    const amount = Number(by);
    if (!Number.isFinite(amount)) throw new Error('metric increment must be a finite number');
    const exposed = counterName(name);
    const tagged = withInstance(labels);
    const key = seriesKey(exposed, tagged);
    const current = counters.get(key) || { name: exposed, labels: tagged, value: 0 };
    current.value += amount;
    counters.set(key, current);
  }

  function set(name, value, labels) {
    assertName(name);
    const next = Number(value);
    if (!Number.isFinite(next)) throw new Error('metric gauge must be a finite number');
    const tagged = withInstance(labels);
    gauges.set(seriesKey(name, tagged), { name, labels: tagged, value: next });
  }

  function observe(name, value, labels) {
    assertName(name);
    const sample = Number(value);
    if (!Number.isFinite(sample) || sample < 0) return;
    const tagged = withInstance(labels);
    const key = seriesKey(name, tagged);
    let hist = histograms.get(key);
    if (!hist) {
      hist = { name, labels: tagged, bucketCounts: buckets.map(() => 0), count: 0, sum: 0, samples: [] };
      histograms.set(key, hist);
    }
    hist.count += 1;
    hist.sum += sample;
    buckets.forEach((bound, index) => {
      if (sample <= bound) hist.bucketCounts[index] += 1;
    });
    hist.samples.push(sample);
    if (hist.samples.length > maxSamples) hist.samples.shift();
  }

  function render() {
    const output = ['# HELP statistics_info 当前进程', '# TYPE statistics_info gauge', `statistics_info${formatLabels(withInstance({}))} 1`];
    const counterLines = new Map();
    counters.forEach(series => {
      if (!counterLines.has(series.name)) counterLines.set(series.name, []);
      counterLines.get(series.name).push(`${series.name}${formatLabels(series.labels)} ${series.value}`);
    });
    counterLines.forEach((rows, name) => {
      output.push(`# TYPE ${name} counter`);
      output.push(...rows);
    });
    const gaugeLines = new Map();
    gauges.forEach(series => {
      if (!gaugeLines.has(series.name)) gaugeLines.set(series.name, []);
      gaugeLines.get(series.name).push(`${series.name}${formatLabels(series.labels)} ${series.value}`);
    });
    gaugeLines.forEach((rows, name) => {
      output.push(`# TYPE ${name} gauge`);
      output.push(...rows);
    });
    const histogramLines = new Map();
    histograms.forEach(series => {
      if (!histogramLines.has(series.name)) histogramLines.set(series.name, []);
      histogramLines.get(series.name).push(series);
    });
    histogramLines.forEach((seriesList, name) => {
      output.push(`# TYPE ${name} histogram`);
      seriesList.forEach(series => {
        buckets.forEach((bound, index) => {
          output.push(`${name}_bucket${formatLabels({ ...series.labels, le: String(bound) })} ${series.bucketCounts[index]}`);
        });
        output.push(`${name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
        output.push(`${name}_sum${formatLabels(series.labels)} ${series.sum}`);
        output.push(`${name}_count${formatLabels(series.labels)} ${series.count}`);
      });
      output.push(`# TYPE ${name}_quantile gauge`);
      seriesList.forEach(series => {
        [0.5, 0.95, 0.99].forEach(ratio => {
          output.push(`${name}_quantile${formatLabels({ ...series.labels, quantile: String(ratio) })} ${quantile(series.samples, ratio)}`);
        });
      });
    });
    return `${output.join('\n')}\n`;
  }

  Object.assign(fastify[options.name].services, {
    metrics: { inc, set, observe, render }
  });
});
