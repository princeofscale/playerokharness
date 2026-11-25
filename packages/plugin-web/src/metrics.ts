/**
 * Prometheus text exposition (format version 0.0.4) for the dashboard.
 *
 * Pure functions only: no Cordis, no I/O, no dependency. The exposition is built
 * from a plain snapshot, so the whole wire format is unit-testable without a
 * server and without a scrape client.
 *
 * Two invariants matter for a scraper:
 *  - a sample value is never NaN or Infinity; non-finite input degrades to 0,
 *    because one malformed sample makes Prometheus reject the entire scrape;
 *  - every metric family carries exactly one HELP and one TYPE line, and HELP
 *    precedes TYPE, which is the order the text format expects.
 */

/** Retry-queue task counts, split by the `status` label. */
export interface RetryQueueMetricsView {
  pending: number;
  processing: number;
  dead: number;
}

/** One scrape worth of dashboard state. */
export interface MetricsView {
  /** Build version, exposed as the `version` label of `pkh_version`. */
  version: string;
  /** Seconds since the dashboard service was constructed. */
  uptimeSeconds: number;
  residentMemoryBytes: number;
  heapUsedBytes: number;
  /** Mean event loop delay, in seconds. */
  eventLoopLagSeconds: number;
  /**
   * null when @pkh/plugin-retry-queue is not mounted. The whole
   * `pkh_retry_queue_tasks` family is then omitted rather than reported as
   * zero, so a scrape cannot mistake "no queue" for "empty queue".
   */
  retryQueue: RetryQueueMetricsView | null;
  /** Records in the local `cached_orders` store. */
  cachedOrders: number;
  /** Sum of `price` over every cached order, in roubles. */
  dealsRevenueRub: number;
  pluginsEnabled: number;
  /** Currently attached Server-Sent Events clients. */
  sseClients: number;
  /** Minted, not yet consumed single-use dashboard tokens. */
  accessTokens: number;
}

/** Exposition format version written by this module. */
export const PROMETHEUS_FORMAT_VERSION = '0.0.4';

/** The only content type Prometheus accepts for the text exposition format. */
export const PROMETHEUS_CONTENT_TYPE = `text/plain; version=${PROMETHEUS_FORMAT_VERSION}; charset=utf-8`;

/** Any non-finite number becomes 0 so no line can ever contain NaN or Infinity. */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Renders one sample value. String() yields plain decimal or exponent notation,
 * both accepted by the text format's Go float parser; it never yields NaN
 * because the value is sanitised first.
 */
function formatValue(value: number): string {
  const finite = finiteOrZero(value);
  // Normalises -0 to "0" as well.
  return String(finite === 0 ? 0 : finite);
}

/** Escapes a label value: only backslash, double quote and newline are special. */
export function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Escapes HELP text: only backslash and newline are special there. */
export function escapePrometheusHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * One gauge family: HELP, TYPE, then every sample. A family is always emitted
 * whole, so HELP/TYPE can never be duplicated or split from its samples.
 */
function gaugeFamily(
  name: string,
  help: string,
  samples: Array<{ labels?: string; value: number }>,
): string[] {
  const lines = [`# HELP ${name} ${escapePrometheusHelp(help)}`, `# TYPE ${name} gauge`];
  for (const sample of samples) {
    lines.push(`${name}${sample.labels ?? ''} ${formatValue(sample.value)}`);
  }
  return lines;
}

/**
 * Renders the whole exposition for one scrape.
 *
 * The result always ends with a newline: the text format requires it and some
 * scrapers drop the last line without it.
 */
export function renderPrometheusMetrics(view: MetricsView): string {
  const lines: string[] = [];

  lines.push(
    ...gaugeFamily('pkh_up', '1 when the dashboard answered this scrape.', [{ value: 1 }]),
    ...gaugeFamily('pkh_uptime_seconds', 'Seconds since the dashboard service started.', [
      { value: view.uptimeSeconds },
    ]),
    ...gaugeFamily('pkh_version', 'Build version as a constant 1 sample.', [
      { labels: `{version="${escapePrometheusLabelValue(view.version)}"}`, value: 1 },
    ]),
    ...gaugeFamily(
      'pkh_process_resident_memory_bytes',
      'Resident set size of the Node.js process.',
      [{ value: view.residentMemoryBytes }],
    ),
    ...gaugeFamily('pkh_process_heap_used_bytes', 'V8 heap used by the Node.js process.', [
      { value: view.heapUsedBytes },
    ]),
    ...gaugeFamily(
      'pkh_nodejs_eventloop_lag_seconds',
      'Mean event loop delay observed since the sampler started.',
      [{ value: view.eventLoopLagSeconds }],
    ),
  );

  // Absent service -> absent family. Reporting three zeroes would be a lie: a
  // scraper could not tell "no queue mounted" from "queue drained".
  if (view.retryQueue) {
    lines.push(
      ...gaugeFamily('pkh_retry_queue_tasks', 'Retry-queue tasks by status.', [
        { labels: '{status="pending"}', value: view.retryQueue.pending },
        { labels: '{status="processing"}', value: view.retryQueue.processing },
        { labels: '{status="dead"}', value: view.retryQueue.dead },
      ]),
    );
  }

  lines.push(
    ...gaugeFamily('pkh_cached_orders_total', 'Orders in the local cached_orders store.', [
      { value: view.cachedOrders },
    ]),
    ...gaugeFamily('pkh_deals_revenue_rub', 'Sum of cached order prices, in roubles.', [
      { value: view.dealsRevenueRub },
    ]),
    ...gaugeFamily('pkh_plugins_enabled_total', 'External plugins currently enabled.', [
      { value: view.pluginsEnabled },
    ]),
    ...gaugeFamily('pkh_sse_clients', 'Attached Server-Sent Events clients.', [
      { value: view.sseClients },
    ]),
    ...gaugeFamily('pkh_access_tokens', 'Minted, unused single-use dashboard tokens.', [
      { value: view.accessTokens },
    ]),
  );

  return `${lines.join('\n')}\n`;
}
