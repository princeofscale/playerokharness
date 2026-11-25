/**
 * Server-rendered HTML for the read-only dashboard.
 *
 * Pure functions only: no Cordis, no I/O. Every interpolated value goes through
 * escapeHtml, including attribute values, so a malicious buyer nickname or item
 * name can never break out of the markup.
 */

import {
  ANALYTICS_TOP_ITEMS,
  type AnalyticsItemView,
  type AnalyticsTotals,
  type AnalyticsView,
} from './analytics.js';

export interface AccountView {
  id: string;
  username: string;
  email: string | null;
  role: string | null;
  isBlocked: boolean;
}

export interface DealView {
  id: string;
  itemId: string;
  itemName: string;
  price: number;
  status: string;
  date: string;
}

export interface QueueStatsView {
  pending: number;
  dead: number;
  total: number;
}

export interface QueueTaskView {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRunAt: string;
}

export interface BootErrorView {
  module: string;
  stage: string;
  text: string;
}

export interface OverviewView {
  version: string;
  uptimeSeconds: number;
  host: string;
  port: number;
  account: AccountView | null;
  accountError: string | null;
  cachedOrders: number;
  queue: QueueStatsView | null;
  plugins: { enabled: number; total: number };
  bootErrors: BootErrorView[];
}

const NAV = [
  { href: '/', label: 'Обзор', key: 'overview' },
  { href: '/analytics', label: 'Аналитика', key: 'analytics' },
  { href: '/deals', label: 'Сделки', key: 'deals' },
  { href: '/queue', label: 'Очередь', key: 'queue' },
  { href: '/logs', label: 'Логи', key: 'logs' },
] as const;

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0f1115;
    color: #e6e6e6;
    font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 18px;
    padding: 16px 20px;
    border-bottom: 1px solid #262a33;
  }
  h1 { margin: 0; font-size: 16px; letter-spacing: 0.04em; }
  nav a { color: #9aa4b2; text-decoration: none; margin-right: 14px; }
  nav a:hover { color: #e6e6e6; }
  nav a.active { color: #7dd3fc; border-bottom: 2px solid #7dd3fc; padding-bottom: 2px; }
  main { padding: 20px; max-width: 1100px; }
  h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa4b2; }
  .muted { color: #9aa4b2; }
  .big { margin: 0; font-size: 26px; font-weight: 700; color: #7dd3fc; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 14px 0; }
  .card { background: #151922; border: 1px solid #262a33; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
  dt { color: #9aa4b2; }
  dd { margin: 0; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #262a33; vertical-align: top; }
  th { color: #9aa4b2; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; white-space: nowrap; }
  code { color: #7dd3fc; }
  pre { margin: 0; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  footer { padding: 10px 20px 24px; color: #6b7280; font-size: 12px; }
  ul { margin: 0; padding-left: 18px; }
  ul.bars { list-style: none; padding-left: 0; }
  ul.bars li {
    display: grid;
    grid-template-columns: minmax(140px, 1.4fr) minmax(90px, 2fr) max-content;
    gap: 10px;
    align-items: center;
    padding: 5px 0;
  }
  .bar-label { overflow-wrap: anywhere; }
  .bar-track { display: block; height: 9px; background: #1d2330; border-radius: 5px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: linear-gradient(90deg, #38bdf8, #7dd3fc); }
  .bar-value { color: #9aa4b2; white-space: nowrap; }
`;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, active: string, content: string): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}" class="${item.key === active ? 'active' : ''}">${item.label}</a>`,
  ).join(' ');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${escapeHtml(title)} · PlayerOK Harness</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>PlayerOK Harness</h1>
  <nav>${nav}</nav>
</header>
<main>
${content}
</main>
<footer>Режим только для чтения · страница обновляется автоматически</footer>
</body>
</html>`;
}

export function renderOverview(view: OverviewView): string {
  const account = renderAccount(view.account, view.accountError);

  const queue = view.queue
    ? `<p class="big">${view.queue.pending} / ${view.queue.dead}</p><p class="muted">pending / dead · всего ${view.queue.total}</p>`
    : '<p class="muted">Служба очереди повторов не подключена</p>';

  const errors =
    view.bootErrors.length === 0
      ? '<p class="muted">Ошибок при последнем запуске нет</p>'
      : `<table>
  <thead><tr><th>Модуль</th><th>Этап</th><th>Ошибка</th></tr></thead>
  <tbody>${view.bootErrors
    .map(
      (error) =>
        `<tr><td>${escapeHtml(error.module)}</td><td>${escapeHtml(error.stage)}</td><td>${escapeHtml(error.text)}</td></tr>`,
    )
    .join('')}</tbody>
</table>`;

  const cards = `<section class="grid">
  <div class="card"><h2>Аккаунт</h2>${account}</div>
  <div class="card"><h2>Кэш сделок</h2><p class="big">${view.cachedOrders}</p><p class="muted">записей в cached_orders</p></div>
  <div class="card"><h2>Очередь повторов</h2>${queue}</div>
  <div class="card"><h2>Плагины</h2><p class="big">${view.plugins.enabled} / ${view.plugins.total}</p><p class="muted">включено / всего</p></div>
</section>`;

  const meta = `Версия ${escapeHtml(view.version)} · uptime ${view.uptimeSeconds} с · http://${escapeHtml(view.host)}:${view.port}`;

  return layout(
    'Обзор',
    'overview',
    `<p class="muted">${meta}</p>
${cards}
<section class="card"><h2>Ошибки при запуске</h2>${errors}</section>
<section class="card"><h2>JSON API</h2><ul>
  <li><code>/api/status</code> — сводка</li>
  <li><code>/analytics</code> — аналитика выручки</li>
  <li><code>/api/analytics</code> — аналитика выручки в JSON</li>
  <li><code>/api/deals</code> — кэш сделок</li>
  <li><code>/api/queue</code> — очередь повторов</li>
  <li><code>/events</code> — поток Server-Sent Events</li>
</ul></section>`,
  );
}

function renderAccount(account: AccountView | null, error: string | null): string {
  if (!account) {
    return `<p class="muted">Аккаунт не подключён${error ? `: ${escapeHtml(error)}` : ''}</p>`;
  }

  return `<dl>
  <dt>ID</dt><dd>${escapeHtml(account.id)}</dd>
  <dt>Ник</dt><dd>${escapeHtml(account.username)}</dd>
  <dt>E-mail</dt><dd>${escapeHtml(account.email ?? '—')}</dd>
  <dt>Роль</dt><dd>${escapeHtml(account.role ?? '—')}</dd>
  <dt>Блокировка</dt><dd>${account.isBlocked ? 'да' : 'нет'}</dd>
</dl>`;
}

/** Money for the dashboard: two decimals, or "нет данных" when the value is missing. */
function formatMoney(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)} ₽` : 'нет данных';
}

function formatAverage(totals: AnalyticsTotals): string {
  return totals.averageOrderValue === null ? 'нет данных' : formatMoney(totals.averageOrderValue);
}

function renderTopItems(items: AnalyticsItemView[]): string {
  const peak = items.reduce(
    (max, item) => (Number.isFinite(item.revenue) ? Math.max(max, item.revenue) : max),
    0,
  );

  const rows = items
    .map((item) => {
      // The bar is a share of the revenue leader, clamped so the markup is always valid CSS.
      const ratio = peak > 0 && item.revenue > 0 ? Math.round((item.revenue / peak) * 100) : 0;
      const width = ratio > 0 ? Math.max(2, Math.min(100, ratio)) : 0;
      return `<li>
  <span class="bar-label">${escapeHtml(item.itemName)} <span class="muted">${escapeHtml(item.itemId)}</span></span>
  <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
  <span class="bar-value">${escapeHtml(formatMoney(item.revenue))} · ${escapeHtml(item.orders)}</span>
</li>`;
    })
    .join('');

  return `<ul class="bars">${rows}</ul>`;
}

export function renderAnalytics(view: AnalyticsView): string {
  const periods: Array<{ label: string; totals: AnalyticsTotals }> = [
    { label: 'Сегодня', totals: view.today },
    { label: 'Последние 7 дней', totals: view.last7Days },
    { label: 'Последние 30 дней', totals: view.last30Days },
    { label: 'Всё время', totals: view.allTime },
  ];

  const table = `<table>
  <thead><tr><th>Период</th><th class="num">Выручка, ₽</th><th class="num">Заказов</th><th class="num">Средний чек</th></tr></thead>
  <tbody>${periods
    .map(
      (period) => `<tr>
  <td>${escapeHtml(period.label)}</td>
  <td class="num">${escapeHtml(formatMoney(period.totals.revenue))}</td>
  <td class="num">${period.totals.orders}</td>
  <td class="num">${escapeHtml(formatAverage(period.totals))}</td>
</tr>`,
    )
    .join('')}</tbody>
</table>`;

  const emptyHint =
    view.cachedOrders === 0 ? '<p class="muted">Кэш сделок пуст — нет данных для аналитики</p>' : '';
  const bars =
    view.topItems.length === 0
      ? '<p class="muted">нет данных</p>'
      : renderTopItems(view.topItems);

  return layout(
    'Аналитика',
    'analytics',
    `<section class="card">
  <h2>Выручка по периодам</h2>
  ${emptyHint}
  ${table}
  <p class="muted">Записей в кэше сделок: ${view.cachedOrders} · снимок ${escapeHtml(view.generatedAt)}</p>
</section>
<section class="card">
  <h2>Топ-${ANALYTICS_TOP_ITEMS} товаров по выручке · всё время</h2>
  ${bars}
</section>`,
  );
}

export function renderDeals(data: { total: number; deals: DealView[] }): string {
  if (data.deals.length === 0) {
    return layout(
      'Сделки',
      'deals',
      '<section class="card"><h2>Сделки</h2><p class="muted">Кэш сделок пуст</p></section>',
    );
  }

  const rows = data.deals
    .map(
      (deal) => `<tr>
  <td>${escapeHtml(deal.date)}</td>
  <td>${escapeHtml(deal.itemName)}</td>
  <td>${escapeHtml(deal.id)}</td>
  <td>${escapeHtml(deal.status)}</td>
  <td class="num">${escapeHtml(deal.price)}</td>
</tr>`,
    )
    .join('');

  return layout(
    'Сделки',
    'deals',
    `<section class="card">
  <h2>Кэш сделок · ${data.deals.length} из ${data.total}</h2>
  <table>
    <thead><tr><th>Дата</th><th>Товар</th><th>ID сделки</th><th>Статус</th><th>Цена, ₽</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`,
  );
}

export function renderQueue(data: { stats: QueueStatsView | null; tasks: QueueTaskView[] }): string {
  if (!data.stats) {
    return layout(
      'Очередь',
      'queue',
      '<section class="card"><h2>Очередь повторов</h2><p class="muted">Служба очереди повторов не подключена</p></section>',
    );
  }

  const body =
    data.tasks.length === 0
      ? '<p class="muted">Задач нет</p>'
      : `<table>
  <thead><tr><th>Статус</th><th>Тип</th><th>Попытки</th><th>Следующий запуск</th><th>Ошибка</th><th>ID</th></tr></thead>
  <tbody>${data.tasks
    .map(
      (task) => `<tr>
  <td>${escapeHtml(task.status)}</td>
  <td>${escapeHtml(task.kind)}</td>
  <td class="num">${task.attempts} / ${task.maxAttempts}</td>
  <td>${escapeHtml(task.nextRunAt)}</td>
  <td>${escapeHtml(task.lastError ?? '—')}</td>
  <td>${escapeHtml(task.id)}</td>
</tr>`,
    )
    .join('')}</tbody>
</table>`;

  return layout(
    'Очередь',
    'queue',
    `<section class="card">
  <h2>Очередь повторов</h2>
  <p class="muted">pending: ${data.stats.pending} · dead: ${data.stats.dead} · всего: ${data.stats.total}</p>
  ${body}
</section>`,
  );
}

export function renderLogs(lines: string[]): string {
  const body =
    lines.length === 0
      ? '<p class="muted">Источник логов не подключён или пуст</p>'
      : `<pre>${escapeHtml(lines.join('\n'))}</pre>`;

  return layout('Логи', 'logs', `<section class="card"><h2>Последние 200 строк</h2>${body}</section>`);
}

export function renderUnauthorized(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>401 · PlayerOK Harness</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<section class="card">
  <h2>Требуется токен доступа</h2>
  <p class="muted">Панель доступна только с токеном. Передайте его один раз в адресе страницы:</p>
  <p><code>/?token=ВАШ_ТОКЕН</code></p>
  <p class="muted">Токен задаётся в конфиге плагина или переменной окружения PKH_WEB_TOKEN.</p>
</section>
</main>
</body>
</html>`;
}

export function renderNotFound(): string {
  return layout(
    '404',
    '',
    '<section class="card"><h2>404</h2><p class="muted">Страница не найдена</p></section>',
  );
}
