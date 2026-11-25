import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context as GrammyContext } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessService,
  BlacklistService,
  ChatTypes,
  Context,
  DEFAULT_CONFIG,
  ItemDealStatuses,
  ItemStatuses,
  PluginManagerService,
  Service,
  StorageService,
  type AutoDeliveryRule,
  type Chat,
  type ChatMessage,
  type CustomCommandsSettings,
  type DataReplacementRule,
  type FastReply,
  type ItemDeal,
  type ItemProfile,
  type LoadedPluginRecord,
  type MessagesSettings,
  type PluginIntegrityResult,
  type SbpBankMember,
  type VerifiedCard,
} from '@pkh/core';
import { mountAutomation, type TrackedPosition } from '@pkh/plugin-automation';
import { RetryQueueService, type RetryTask } from '@pkh/plugin-retry-queue';
import { WebDashboardService } from '@pkh/plugin-web';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  AUDIT_MAX_PAGE,
  AUDIT_PAGE_SIZE,
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_LITERAL_MAX_BYTES,
  CALLBACK_REGISTRY_LIMIT,
  CALLBACK_SECTIONS,
  PASSWORD_MAX_ATTEMPTS,
  PASSWORD_WINDOW_MS,
  PasswordAttemptLimiter,
  STALE_CALLBACK_TEXT,
  TelegramService,
  auditPageLimit,
  auditTotalOf,
  buildAuditPage,
  callbackRegistrySize,
  fitCallback,
  formatBytes,
  formatDuration,
  isKnownCallbackSection,
  isStoredCallbackKey,
  readCallbackValue,
  readPluginIntegrity,
  renderAuditClearConfirm,
  renderAuditLog,
  renderBindingsList,
  renderBlacklist,
  renderBumpPositions,
  renderBumpSettings,
  renderChatDetail,
  renderChatsList,
  renderCommandsList,
  renderCompleteSettings,
  renderConfigsMenu,
  renderConnectionSettings,
  renderDataReplacementDetail,
  renderDataReplacementList,
  renderDealDetail,
  renderDealsList,
  renderDeliveriesList,
  renderDeliveryDetail,
  renderFastRepliesList,
  renderItemDetail,
  renderItemsList,
  renderLogs,
  renderMainMenu,
  renderMessageDetail,
  renderMessagesList,
  renderModulesList,
  renderNotificationsSettings,
  renderOtherSettings,
  renderPluginIntegrity,
  renderProfile,
  renderRestoreSettings,
  renderRetryQueue,
  renderReviewsList,
  renderRuntimeHealth,
  renderSetupMode,
  renderSignedUsers,
  renderStats,
  renderSystemMenu,
  renderSystemNotice,
  renderTransactionsList,
  renderUpdatesMenu,
  renderWithdrawalCards,
  renderWithdrawalSbpBanks,
  renderWithdrawalSettings,
  resolveCallback,
  retryQueueHealth,
  storeCallback,
  type RenderedView,
  type RuntimeHealthSnapshot,
} from '@pkh/plugin-telegram';

/**
 * The known regression: this command used to be inlined as
 * 'cmd:del:!%D0%B0%D0%B2%D1%82%D0%BE%D0%B2%D1%8B%D0%B4%D0%B0%D1%87%D0%B0' (100+ bytes).
 */
const CYRILLIC_COMMAND = '!автовыдача';
/** A command long enough that even the raw (unencoded) value is over the limit. */
const LONG_CYRILLIC_COMMAND = '!' + 'я'.repeat(120);
/** Opaque identifiers (deals, items, chats, plugins, tasks) can be arbitrarily long. */
const LONG_ID = 'id-'.padEnd(120, 'x');
const LONG_USERNAME = 'user_'.padEnd(90, 'y');
const ISO = new Date('2026-01-01T00:00:00.000Z').toISOString();

const USER_ID = 555001;
const OTHER_USER_ID = 555002;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface CollectedCallback {
  data: string;
  source: string;
}

/** Fails with the offending screen and payload, so a too-long button is easy to locate. */
function assertCallbackFits(data: string, source = 'test'): void {
  const bytes = Buffer.byteLength(data, 'utf8');
  const detail = source + ': callback_data "' + data + '" is ' + bytes + ' bytes (limit ' + CALLBACK_DATA_MAX_BYTES + ')';
  expect(bytes, detail).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
}

function collectCallbacks(source: string, view: RenderedView): CollectedCallback[] {
  const collected: CollectedCallback[] = [];
  for (const row of view.keyboard.inline_keyboard) {
    for (const button of row) {
      if ('callback_data' in button && typeof button.callback_data === 'string') {
        collected.push({ data: button.callback_data, source });
      }
    }
  }
  return collected;
}

/** Splits a rendered payload back into prefix (everything before the last colon) and segment. */
function splitKey(data: string): { prefix: string; key: string } {
  const lastColon = data.lastIndexOf(':');
  return { prefix: data.slice(0, lastColon), key: data.slice(lastColon + 1) };
}

function firstCallbackWithPrefix(callbacks: CollectedCallback[], prefix: string): CollectedCallback {
  const found = callbacks.find((c) => c.data.startsWith(prefix + ':'));
  if (!found) throw new Error('no callback with prefix ' + prefix);
  return found;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const item: ItemProfile = {
  id: LONG_ID,
  slug: 'steam-account',
  name: 'Steam аккаунт',
  price: 1000,
  rawPrice: 900,
  status: ItemStatuses.APPROVED,
};

const deal: ItemDeal = {
  id: LONG_ID,
  status: ItemDealStatuses.SENT,
  user: { id: 'buyer', username: LONG_USERNAME },
  item,
  createdAt: ISO,
};

const chat: Chat = {
  id: LONG_ID,
  type: ChatTypes.PM,
  unreadMessagesCounter: 3,
  users: [
    { id: 'me', username: 'seller' },
    { id: 'buyer', username: LONG_USERNAME },
  ],
};

const chatMessage: ChatMessage = {
  id: 'm1',
  text: 'Привет',
  createdAt: ISO,
  user: { id: 'buyer', username: LONG_USERNAME },
};

const fastReplies: FastReply[] = [{ name: 'Приветствие', text: ['Здравствуйте!'] }];

const messages: MessagesSettings = {
  new_deal: { label: '📋 Новая сделка', enabled: true, text: ['Спасибо за покупку'] },
};

const commands: CustomCommandsSettings = {
  [CYRILLIC_COMMAND]: ['Ответ на команду'],
  [LONG_CYRILLIC_COMMAND]: ['Ответ на длинную команду'],
};

const deliveryRule: AutoDeliveryRule = { keyphrases: ['steam'], piece: true, goods: ['A1', 'A2'] };
const dataReplacement: DataReplacementRule = {
  keyphrases: ['steam'],
  enabled: true,
  separator: ':',
  data: ['user:pass'],
};

const cards: VerifiedCard[] = [
  { id: LONG_ID, cardFirstSix: '220070', cardLastFour: '1234', cardType: 'MIR' },
];
const sbpBanks: SbpBankMember[] = [{ id: LONG_ID, name: 'Сбербанк' }];
const trackedPositions: TrackedPosition[] = [
  { name: 'Steam аккаунт', slug: 'steam-account', position: 4, streak: 2, checkedAt: ISO },
];
const plugins: LoadedPluginRecord[] = [
  {
    id: LONG_ID,
    meta: { id: LONG_ID, name: 'Demo', version: '1.0.0' },
    enabled: true,
    sourcePath: 'plugins/demo.mjs',
  },
];
const retryTasks: RetryTask[] = [
  {
    id: LONG_ID,
    kind: 'send_message',
    payload: {},
    attempts: 5,
    maxAttempts: 5,
    nextRunAt: ISO,
    createdAt: ISO,
    lastError: 'HTTP 500',
    status: 'dead',
  },
];
const blacklistEntries = [{ username: LONG_USERNAME, reason: 'Спам', date: ISO, by: 'test' }];

// --- System panel fixtures -------------------------------------------------

/** Twelve audit records, oldest first, so ordering and pagination are both real. */
const auditRecords: Array<Record<string, unknown>> = Array.from({ length: 12 }, (_, index) => ({
  at: new Date(Date.UTC(2026, 0, 1, 9, index, 0)).toISOString(),
  action: index === 5 ? 'withdrawal.requested' : 'delivery.sent',
  actor: index % 2 === 0 ? 'auto' : 'telegram',
  outcome: index === 5 ? 'failed' : index === 7 ? 'skipped' : 'ok',
  title: 'Событие ' + String(index + 1),
}));

/** One plugin per integrity state, with digests long enough that a prefix is visible. */
const integrityResults: PluginIntegrityResult[] = [
  { id: 'demo', expected: 'aaaa11112233', actual: 'aaaa11112233', ok: true, state: 'ok' },
  { id: 'evil', expected: 'aaaa11112233', actual: 'ffee99887766', ok: false, state: 'mismatch' },
  { id: 'hand-made', expected: null, actual: '0123456789ab', ok: false, state: 'unknown' },
  { id: 'gone', expected: 'aaaa11112233', actual: null, ok: false, state: 'missing' },
];

const healthSnapshot: RuntimeHealthSnapshot = {
  uptimeSec: 7_385,
  rssBytes: 126_353_408,
  heapUsedBytes: 47_185_920,
  heapTotalBytes: 188_743_680,
  nodeVersion: 'v24.21.0',
  platform: 'linux/x64',
  pid: 4242,
  pluginsEnabled: 5,
  pluginsTotal: 7,
  retryQueue: { pending: 3, dead: 2, processing: 1 },
};

/**
 * One representative keyboard per render* screen. Free-form fields (commands, usernames,
 * ids, reply texts) are deliberately long and non-ASCII so the byte assertions are real.
 */
function buildAllKeyboards(): Array<{ name: string; view: RenderedView }> {
  const setupProblem = { code: 'missing_cookies' as const, text: 'Нужны куки PlayerOK', transient: false };
  return [
    { name: 'main menu', view: renderMainMenu(true) },
    { name: 'main menu (setup)', view: renderMainMenu(false, setupProblem) },
    { name: 'setup mode', view: renderSetupMode(setupProblem) },
    { name: 'notifications', view: renderNotificationsSettings(DEFAULT_CONFIG) },
    { name: 'restore', view: renderRestoreSettings(DEFAULT_CONFIG) },
    { name: 'complete', view: renderCompleteSettings(DEFAULT_CONFIG) },
    { name: 'bump', view: renderBumpSettings(DEFAULT_CONFIG, trackedPositions) },
    { name: 'bump positions', view: renderBumpPositions(trackedPositions) },
    {
      name: 'bindings',
      view: renderBindingsList('auto_bump_items', 'included', [{ keyphrases: ['steam'] }], 0),
    },
    { name: 'withdrawal', view: renderWithdrawalSettings(DEFAULT_CONFIG) },
    { name: 'withdrawal cards', view: renderWithdrawalCards(cards) },
    { name: 'withdrawal sbp', view: renderWithdrawalSbpBanks(sbpBanks) },
    { name: 'other', view: renderOtherSettings(DEFAULT_CONFIG) },
    { name: 'connection', view: renderConnectionSettings(DEFAULT_CONFIG, true) },
    { name: 'messages', view: renderMessagesList(messages) },
    { name: 'message detail', view: renderMessageDetail('new_deal', messages.new_deal) },
    { name: 'commands', view: renderCommandsList(commands) },
    { name: 'deliveries', view: renderDeliveriesList([deliveryRule], 0) },
    { name: 'delivery detail', view: renderDeliveryDetail(0, deliveryRule) },
    { name: 'data replacement', view: renderDataReplacementList([dataReplacement], 0) },
    { name: 'data replacement detail', view: renderDataReplacementDetail(0, dataReplacement) },
    { name: 'fast replies', view: renderFastRepliesList(fastReplies) },
    { name: 'blacklist', view: renderBlacklist(blacklistEntries, 0) },
    { name: 'profile', view: renderProfile(null) },
    { name: 'stats', view: renderStats({}, 'day') },
    { name: 'chats', view: renderChatsList([chat], 'me', 0) },
    { name: 'chat detail', view: renderChatDetail(chat, [chatMessage], fastReplies, 'me') },
    { name: 'deals', view: renderDealsList([deal], 'ALL', 0) },
    { name: 'deal detail', view: renderDealDetail(deal) },
    { name: 'items', view: renderItemsList([item], ItemStatuses.APPROVED, 0) },
    { name: 'item detail', view: renderItemDetail(item) },
    { name: 'transactions', view: renderTransactionsList([], 0) },
    { name: 'reviews', view: renderReviewsList([], 0, 0) },
    { name: 'modules', view: renderModulesList(plugins) },
    { name: 'updates', view: renderUpdatesMenu(DEFAULT_CONFIG, null, false) },
    { name: 'logs', view: renderLogs(['line']) },
    { name: 'signed users', view: renderSignedUsers([USER_ID, OTHER_USER_ID]) },
    { name: 'configs', view: renderConfigsMenu('/tmp/pkh') },
    { name: 'retry queue', view: renderRetryQueue(retryTasks) },
    { name: 'system menu', view: renderSystemMenu() },
    {
      name: 'system audit trail',
      view: renderAuditLog(buildAuditPage(auditRecords, 0).entries, 0, true, 30),
    },
    { name: 'system audit clear confirm', view: renderAuditClearConfirm(30) },
    { name: 'system plugin integrity', view: renderPluginIntegrity(integrityResults) },
    { name: 'system runtime health', view: renderRuntimeHealth(healthSnapshot) },
    {
      name: 'system notice',
      view: renderSystemNotice('Журнал аудита', 'Сервис аудита не подключён'),
    },
  ];
}

function allCallbacks(): CollectedCallback[] {
  return buildAllKeyboards().flatMap(({ name, view }) => collectCallbacks(name, view));
}

// ---------------------------------------------------------------------------
// 1. callback_data byte budget
// ---------------------------------------------------------------------------

describe('Telegram callback_data budget', () => {
  it('keeps every callback_data emitted by render* within the 64-byte Bot API limit', () => {
    const callbacks = allCallbacks();

    // Sanity: the collector must actually see buttons, otherwise the assertion is vacuous.
    expect(callbacks.length).toBeGreaterThan(150);

    for (const { data, source } of callbacks) assertCallbackFits(data, source);
  });

  it('proves the legacy inline encoding really overflowed for the known command', () => {
    const legacy = 'cmd:del:' + encodeURIComponent(CYRILLIC_COMMAND);
    expect(Buffer.byteLength(legacy, 'utf8')).toBeGreaterThan(CALLBACK_DATA_MAX_BYTES);
  });

  it('stores a token only for values that would overflow, keeping literals short', () => {
    const callbacks = allCallbacks();
    const prefixes = [
      'deal:view',
      'deal:confirm',
      'item:view',
      'item:bump',
      'chat:view',
      'chat:reply',
      'mod:toggle',
      'rq:del',
    ];
    for (const prefix of prefixes) {
      const { data } = firstCallbackWithPrefix(callbacks, prefix);
      assertCallbackFits(data, prefix);
      const { key } = splitKey(data);
      expect(isStoredCallbackKey(key), prefix + ' should be a stored token').toBe(true);
      expect(data.length).toBeLessThanOrEqual(prefix.length + 10);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Registry round-trip
// ---------------------------------------------------------------------------

describe('callback registry', () => {
  it('round-trips the known Cyrillic command and a 120-char reply', () => {
    const commandKey = storeCallback('cmd:del', CYRILLIC_COMMAND);
    expect(commandKey).toMatch(/^cmd:del:~[A-Za-z0-9_-]{8}$/);
    assertCallbackFits(commandKey, 'cmd:del');
    expect(resolveCallback('cmd:del', splitKey(commandKey).key)).toBe(CYRILLIC_COMMAND);

    const longReply = 'Ответ: ' + 'ы'.repeat(112);
    expect(longReply).toHaveLength(119);
    const replyKey = storeCallback('chat:reply', longReply);
    assertCallbackFits(replyKey, 'chat:reply');
    expect(resolveCallback('chat:reply', splitKey(replyKey).key)).toBe(longReply);

    // Stable: the same prefix+value always maps to the same payload.
    expect(storeCallback('cmd:del', CYRILLIC_COMMAND)).toBe(commandKey);
  });

  it('returns null (never throws) for unknown keys and for another prefix', () => {
    const commandKey = storeCallback('cmd:del', LONG_CYRILLIC_COMMAND);
    expect(resolveCallback('cmd:del', '~zzzzzzzz')).toBeNull();
    expect(resolveCallback('mod:del', splitKey(commandKey).key)).toBeNull();
    expect(resolveCallback('cmd:del', '')).toBeNull();
  });

  it('reads back every dynamic payload emitted by the keyboards', () => {
    const callbacks = allCallbacks();
    const read = (prefix: string): string | null => {
      const { key } = splitKey(firstCallbackWithPrefix(callbacks, prefix).data);
      return readCallbackValue(prefix, key);
    };

    // Short values stay human-readable literals; long ones decode from the registry.
    expect(read('cmd:del')).toBe(CYRILLIC_COMMAND);
    expect(read('mod:toggle')).toBe(LONG_ID);
    expect(read('mod:del')).toBe(LONG_ID);
    expect(read('deal:view')).toBe(LONG_ID);
    expect(read('deal:confirm')).toBe(LONG_ID);
    expect(read('deal:refund')).toBe(LONG_ID);
    expect(read('item:view')).toBe(LONG_ID);
    expect(read('item:bump')).toBe(LONG_ID);
    expect(read('item:restore')).toBe(LONG_ID);
    expect(read('chat:view')).toBe(LONG_ID);
    expect(read('chat:reply')).toBe(LONG_ID);
    expect(read('rq:retry')).toBe(LONG_ID);
    expect(read('rq:del')).toBe(LONG_ID);
    expect(read('withdraw:set_card')).toBe(LONG_ID);
    expect(read('withdraw:set_sbp')).toBe(LONG_ID);

    const blacklistTarget = read('bl:del');
    expect(blacklistTarget).toBe(LONG_USERNAME + ':0');
  });
});

// ---------------------------------------------------------------------------
// 3. fitCallback keeps readable literals whenever they fit
// ---------------------------------------------------------------------------

describe('fitCallback', () => {
  it('keeps short values readable and does not touch the registry', () => {
    const payload = fitCallback('rq:retry', 'task-2');
    expect(payload).toBe('rq:retry:task-2');
    expect(isStoredCallbackKey(splitKey(payload).key)).toBe(false);
    expect(readCallbackValue('rq:retry', splitKey(payload).key)).toBe('task-2');
  });

  it('keeps the reported Cyrillic command as a literal under the limit', () => {
    const payload = fitCallback('cmd:del', CYRILLIC_COMMAND);
    expect(payload).toBe('cmd:del:' + CYRILLIC_COMMAND);
    expect(isStoredCallbackKey(splitKey(payload).key)).toBe(false);
    assertCallbackFits(payload, 'cmd:del');
    expect(readCallbackValue('cmd:del', splitKey(payload).key)).toBe(CYRILLIC_COMMAND);
  });

  it('renders the literal retry-queue payloads the root suite asserts', () => {
    const shortTasks: RetryTask[] = [
      {
        id: 'task-1',
        kind: 'send_message',
        payload: {},
        attempts: 1,
        maxAttempts: 5,
        nextRunAt: ISO,
        createdAt: ISO,
        status: 'pending',
      },
      {
        id: 'task-2',
        kind: 'update_deal',
        payload: {},
        attempts: 5,
        maxAttempts: 5,
        nextRunAt: ISO,
        createdAt: ISO,
        status: 'dead',
      },
    ];
    const callbacks = collectCallbacks('retry queue (short ids)', renderRetryQueue(shortTasks)).map((c) => c.data);
    expect(callbacks).toContain('rq:retry:task-2');
    expect(callbacks).toContain('rq:del:task-1');
  });

  it('falls back to a stored token for long values and still resolves', () => {
    const payload = fitCallback('cmd:del', LONG_CYRILLIC_COMMAND);
    expect(payload).toMatch(/^cmd:del:~[A-Za-z0-9_-]{8}$/);
    expect(payload.length).toBeLessThanOrEqual(CALLBACK_LITERAL_MAX_BYTES);
    expect(readCallbackValue('cmd:del', splitKey(payload).key)).toBe(LONG_CYRILLIC_COMMAND);
  });
});

// ---------------------------------------------------------------------------
// 4. Static routability: every emitted section has a branch in the router
// ---------------------------------------------------------------------------

describe('callback routing table', () => {
  it('knows the section of every callback_data rendered by the keyboards', () => {
    const unknown = allCallbacks().filter(({ data }) => !isKnownCallbackSection(data));
    expect(unknown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Live routing through TelegramService.handleCallback
// ---------------------------------------------------------------------------

interface AnswerRecord {
  text?: string;
  show_alert?: boolean;
}

class FakeGrammyContext {
  public readonly from: { id: number };
  public readonly chat: { id: number };
  public readonly callbackQuery: { data: string };
  public readonly answers: AnswerRecord[] = [];
  public readonly replies: string[] = [];
  public readonly edits: string[] = [];

  constructor(userId: number, data: string) {
    this.from = { id: userId };
    this.chat = { id: userId };
    this.callbackQuery = { data };
  }

  public async answerCallbackQuery(options?: AnswerRecord): Promise<boolean> {
    this.answers.push(options ?? {});
    return true;
  }

  public async reply(text: string): Promise<{ message_id: number }> {
    this.replies.push(text);
    return { message_id: this.replies.length };
  }

  public async editMessageText(text: string): Promise<true> {
    this.edits.push(text);
    return true;
  }

  public async replyWithDocument(): Promise<{ message_id: number }> {
    return { message_id: 1 };
  }

  public get acted(): boolean {
    return this.answers.length > 0 || this.replies.length > 0 || this.edits.length > 0;
  }

  public get staleAnswers(): AnswerRecord[] {
    return this.answers.filter((a) => a.text === STALE_CALLBACK_TEXT);
  }
}

/**
 * Telegram rejects answerCallbackQuery for an already answered or expired query. A handler
 * that answers after mutating state must survive that rejection (defect: the panel stayed on
 * the old data because the edit was never reached).
 */
class RejectingAckGrammyContext extends FakeGrammyContext {
  public override async answerCallbackQuery(): Promise<boolean> {
    throw new Error('Bad Request: query is too old and response timeout expired');
  }
}

interface Router {
  handleCallback(gctx: GrammyContext, userId: number, data: string): Promise<void>;
}

interface Harness {
  ctx: Context;
  router: Router;
}

interface HarnessOptions {
  /** Mount the real dashboard so a minted one-time link can be checked end to end. */
  withDashboard?: boolean | 'disabled';
}

/** The dashboard binds its socket from a ctx.effect, so wait for the port before minting. */
async function waitForDashboard(ctx: Context): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (ctx.get('webDashboard', false)?.url) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Full offline graph: every service the panel reads is mounted, so a screen that
 * touches playerok/automation/queue must render instead of throwing. A missing
 * service would surface as the Russian "service is not connected" error and fail
 * the routing test below.
 */
async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-tg-cb-'));
  tempDirs.push(dir);
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(AccessService);
  await ctx.use(BlacklistService);
  await ctx.use(PluginManagerService);
  await ctx.use(PlayerokService, {
    transport: new MockPlayerokTransport(),
    enableMaintenanceLoops: false,
  });
  await ctx.use(RetryQueueService, { enableTimer: false });
  mountAutomation(ctx, { enableTimers: false });
  if (options.withDashboard) {
    // Real service, loopback-only, short-lived token auth: the same path production uses.
    const enabled = options.withDashboard !== 'disabled';
    await ctx.use(WebDashboardService, { enabled, port: 0, token: 'panel-test-token' });
    if (enabled) await waitForDashboard(ctx);
  }
  await ctx.use(TelegramService, { token: '' });
  ctx.access.addSignedUser(USER_ID);
  ctx.access.addSignedUser(OTHER_USER_ID);
  await settleAutomation(ctx);
  ctx.telegram.setSetupLauncher(async () => null);
  return { ctx, router: ctx.telegram as unknown as Router };
}

/**
 * mountAutomation() registers its plugins without awaiting them, and cordis activates a
 * fiber on the microtask queue. Waiting here makes the panels exercise the real automation
 * services instead of the "subsystem not mounted" fallback. Best effort by design: every
 * panel branch tolerates an absent optional service, so a timeout cannot fail the test.
 */
async function settleAutomation(ctx: Context): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const ready =
      Boolean(ctx.get('autoBump', false)) &&
      Boolean(ctx.get('autoRestore', false)) &&
      Boolean(ctx.get('autoWithdrawal', false));
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function dispatch(router: Router, data: string): Promise<FakeGrammyContext> {
  const gctx = new FakeGrammyContext(USER_ID, data);
  await router.handleCallback(gctx as unknown as GrammyContext, USER_ID, data);
  return gctx;
}

describe('handleCallback routing', () => {
  it('never leaves a rendered button as a silent no-op and never reports it as stale', async () => {
    const { ctx, router } = await createHarness();
    try {
      const seen = new Set<string>();
      const executed: string[] = [];
      const blockedByInject: string[] = [];

      for (const { data, source } of allCallbacks()) {
        // 'noop' is answered by the callback_query handler before handleCallback runs.
        if (data === 'noop') continue;
        // Identical payloads repeat across screens; one execution per payload is enough.
        if (seen.has(data)) continue;
        seen.add(data);

        try {
          const gctx = await dispatch(router, data);
          executed.push(data);

          const deadDetail = source + ': "' + data + '" was not answered and rendered nothing';
          expect(gctx.acted, deadDetail).toBe(true);
          const staleDetail = source + ': "' + data + '" answered as a stale button';
          expect(gctx.staleAnswers, staleDetail).toEqual([]);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // 1. Service wiring must be complete: no panel may fail because a service it
          //    reads is not mounted (that used to be the whole "without inject" class).
          expect(
            message,
            source + ' / ' + data + ' still blocked by a missing service',
          ).not.toMatch(/without inject|не подключён/);
          // 2. The remaining failures are fixture gaps: the rendered callback points at an
          //    entity id that this offline transport never seeded. Anything else is a bug.
          if (/not found/i.test(message)) {
            blockedByInject.push(data);
            continue;
          }
          throw err;
        }
      }

      // The router works end to end: almost every rendered button executed.
      expect(executed.length).toBeGreaterThan(80);
      // Every rendered button either executed or is a known fixture miss.
      expect(executed.length + blockedByInject.length).toBe(seen.size);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('dispatches a literal short payload verbatim', async () => {
    const { ctx, router } = await createHarness();
    try {
      ctx.storage.update<CustomCommandsSettings>('custom_commands', (c) => {
        c['!help'] = ['Справка'];
      });
      const gctx = await dispatch(router, 'cmd:del:!help');
      expect(gctx.staleAnswers).toEqual([]);
      expect(ctx.storage.getCustomCommands()).not.toHaveProperty('!help');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('cannot be aborted by a rejected answerCallbackQuery after a side effect', async () => {
    const { ctx, router } = await createHarness();
    try {
      ctx.storage.update<CustomCommandsSettings>('custom_commands', (c) => {
        c['!help'] = ['Справка'];
      });
      const commandsCtx = new RejectingAckGrammyContext(USER_ID, 'cmd:del:!help');
      await router.handleCallback(commandsCtx as unknown as GrammyContext, USER_ID, 'cmd:del:!help');
      // The deletion happened and the panel was re-rendered although the ack rejected.
      expect(ctx.storage.getCustomCommands()).not.toHaveProperty('!help');
      expect(commandsCtx.replies.length).toBeGreaterThan(0);

      ctx.blacklist.add('spammer', 'тест', 'test');
      const blacklistCtx = new RejectingAckGrammyContext(USER_ID, 'bl:del:spammer:0');
      await router.handleCallback(blacklistCtx as unknown as GrammyContext, USER_ID, 'bl:del:spammer:0');
      expect(ctx.blacklist.list().some((e) => e.username === 'spammer')).toBe(false);
      expect(blacklistCtx.replies.length).toBeGreaterThan(0);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('keeps pre-registry percent-encoded command buttons working', async () => {
    const { ctx, router } = await createHarness();
    try {
      ctx.storage.update<CustomCommandsSettings>('custom_commands', (c) => {
        c['!help'] = ['Справка'];
      });
      // Old builds stored encodeURIComponent('!help') === '%21help'.
      const gctx = await dispatch(router, 'cmd:del:%21help');
      expect(gctx.staleAnswers).toEqual([]);
      expect(ctx.storage.getCustomCommands()).not.toHaveProperty('!help');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('answers "кнопка устарела" for an unknown token instead of throwing', async () => {
    const { ctx, router } = await createHarness();
    try {
      const gctx = await dispatch(router, 'cmd:del:~AAAAAAAA');
      expect(gctx.staleAnswers).toHaveLength(1);
      expect(gctx.staleAnswers[0].text).toBe(STALE_CALLBACK_TEXT);
      expect(ctx.storage.getCustomCommands()).toEqual({});
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Bounded registry
// ---------------------------------------------------------------------------

describe('callback registry capacity', () => {
  it('never grows past CALLBACK_REGISTRY_LIMIT and forgets the oldest entries', () => {
    const prefix = 'test:capacity';
    const first = storeCallback(prefix, 'first-value');
    for (let i = 0; i < CALLBACK_REGISTRY_LIMIT + 20; i += 1) {
      storeCallback(prefix, 'value-' + i);
    }
    expect(callbackRegistrySize()).toBeLessThanOrEqual(CALLBACK_REGISTRY_LIMIT);
    // The oldest entry was evicted, which is exactly what the "stale button" answer covers.
    expect(resolveCallback(prefix, splitKey(first).key)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Legacy admin password rate limit
// ---------------------------------------------------------------------------

describe('legacy admin password rate limit', () => {
  it('blocks the 6th attempt inside the 10-minute window', () => {
    let now = 1_700_000_000_000;
    const limiter = new PasswordAttemptLimiter({ now: () => now });
    const userId = 42;

    for (let attempt = 1; attempt <= PASSWORD_MAX_ATTEMPTS; attempt += 1) {
      expect(limiter.isBlocked(userId)).toBe(false);
      expect(limiter.recordFailure(userId)).toBe(attempt);
    }

    // The 6th attempt is rejected before the password is compared at all.
    expect(limiter.isBlocked(userId)).toBe(true);
    expect(limiter.remainingAttempts(userId)).toBe(0);
    expect(limiter.retryAfterSec(userId)).toBe(PASSWORD_WINDOW_MS / 1000);

    // Once the window has slid past every failure the user may try again.
    now += PASSWORD_WINDOW_MS;
    expect(limiter.isBlocked(userId)).toBe(false);
  });

  it('keeps users independent and resets after a successful login', () => {
    const limiter = new PasswordAttemptLimiter();
    for (let i = 0; i < PASSWORD_MAX_ATTEMPTS; i += 1) limiter.recordFailure(1);
    expect(limiter.isBlocked(1)).toBe(true);
    expect(limiter.isBlocked(2)).toBe(false);
    limiter.reset(1);
    expect(limiter.isBlocked(1)).toBe(false);
    expect(limiter.failures(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Dashboard button and retry-queue delete guard
// ---------------------------------------------------------------------------

describe('dashboard access from the panel', () => {
  it('replies with a working one-time dashboard URL when the web panel is mounted', async () => {
    const { ctx, router } = await createHarness({ withDashboard: true });
    try {
      const baseUrl = ctx.get('webDashboard', false)?.url ?? '';
      expect(baseUrl).toContain('http://127.0.0.1:');

      const gctx = await dispatch(router, 'web:open');
      const reply = gctx.replies.join('\n');
      expect(gctx.staleAnswers).toEqual([]);
      expect(reply).toContain(baseUrl);
      expect(reply).toContain('/?token=');

      const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(reply)?.[1] ?? '';
      expect(token.length).toBeGreaterThan(20);

      // The minted link authenticates the real dashboard exactly once.
      expect((await fetch(`${baseUrl}/?token=${token}`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/?token=${token}`)).status).toBe(401);

      // A second press mints a different link instead of reusing the spent one.
      const again = await dispatch(router, 'web:open');
      expect(again.replies.join('\n')).not.toBe(reply);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('explains when the web panel is mounted but disabled', async () => {
    const { ctx, router } = await createHarness({ withDashboard: 'disabled' });
    try {
      const dashboard = ctx.get('webDashboard', false);
      expect(dashboard).toBeDefined();
      expect(dashboard?.address).toBeNull();

      const gctx = await dispatch(router, 'web:open');
      expect(gctx.staleAnswers).toEqual([]);
      expect(gctx.replies.join('\n')).toContain('Веб-панель отключена');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('explains instead of throwing when the web panel is absent', async () => {
    const { ctx, router } = await createHarness();
    try {
      expect(ctx.get('webDashboard', false)).toBeUndefined();

      const gctx = await dispatch(router, 'web:open');
      expect(gctx.staleAnswers).toEqual([]);
      expect(gctx.answers).toHaveLength(1);
      expect(gctx.replies.join('\n')).toContain('Веб-панель не подключена');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe('retry queue rendering', () => {
  it('counts a processing task and keeps the pending/DLQ counters intact', () => {
    const tasks: RetryTask[] = [
      {
        id: 'p-1',
        kind: 'send_message',
        payload: {},
        attempts: 1,
        maxAttempts: 5,
        nextRunAt: ISO,
        createdAt: ISO,
        status: 'processing',
      },
      {
        id: 'p-2',
        kind: 'bump_item',
        payload: {},
        attempts: 0,
        maxAttempts: 5,
        nextRunAt: ISO,
        createdAt: ISO,
        status: 'pending',
      },
      {
        id: 'p-3',
        kind: 'update_deal',
        payload: {},
        attempts: 5,
        maxAttempts: 5,
        nextRunAt: ISO,
        createdAt: ISO,
        status: 'dead',
      },
    ];

    const view = renderRetryQueue(tasks);
    // The substrings the root suite asserts must survive the processing polish.
    expect(view.text).toContain('В ожидании (pending): <b>1</b>');
    expect(view.text).toContain('Dead-Letter (DLQ): <b>1</b>');
    expect(view.text).toContain('выполняется: <b>1</b>');
    expect(view.text).toContain('⚙️');
  });
});

describe('retry queue delete guard', () => {
  it('refuses to delete a task that is processing right now', async () => {
    const { ctx, router } = await createHarness();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      ctx.retryQueue.registerHandler('slow_task', async () => {
        await gate;
      });
      const task = await ctx.retryQueue.enqueue({
        kind: 'slow_task',
        payload: {},
        initialDelayMs: 0,
      });

      // Claim the task without awaiting the pass: it stays 'processing' until released.
      let passError: unknown;
      const pass = ctx.retryQueue.processDue().catch((err: unknown) => {
        passError = err;
      });
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (ctx.retryQueue.list().some((t) => t.id === task.id && t.status === 'processing')) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(ctx.retryQueue.list().find((t) => t.id === task.id)?.status).toBe('processing');

      const gctx = await dispatch(router, `rq:del:${task.id}`);
      expect(gctx.answers[0]?.text ?? '').toContain('выполняется');
      // The task survived the refused delete and the panel was re-rendered.
      expect(ctx.retryQueue.list().some((t) => t.id === task.id)).toBe(true);
      expect(gctx.replies.join('\n')).toContain('Очередь повторов');

      release();
      await pass;
      expect(passError).toBeUndefined();
      // The attempt finished: the task is done and removed, not stuck in the queue.
      expect(ctx.retryQueue.list().some((t) => t.id === task.id)).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
describe('auto-delivery stock inventory', () => {
  it('reports the sellable pool and the in-flight reservations', () => {
    const reserved = [
      { good: 'KEY-BUSY-1', dealId: 'deal-1', at: ISO },
      { good: 'KEY-BUSY-2', dealId: 'deal-2', at: ISO },
    ];
    const rule: AutoDeliveryRule = {
      keyphrases: ['steam'],
      piece: true,
      goods: Array.from({ length: 20 }, (_, index) => 'KEY-' + String(index + 1)),
      reserved,
    };

    const list = renderDeliveriesList([rule], 0);
    expect(list.text).toContain('ост: 20');
    expect(list.text).toContain('в работе: 2');

    const detail = renderDeliveryDetail(0, rule);
    expect(detail.text).toContain('Поштучных товаров: <b>20</b>');
    expect(detail.text).toContain('в работе: <b>2</b>');

    // A rule without reservations keeps the compact pre-reserved-pool wording.
    const plain = renderDeliveryDetail(0, { keyphrases: ['steam'], piece: true, goods: ['A'] });
    expect(plain.text).toContain('Поштучных товаров: <b>1</b>');
    expect(plain.text).not.toContain('в работе');
  });

  it('clears the sellable pool and the reservations together', async () => {
    const { ctx, router } = await createHarness();
    try {
      ctx.storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
        list.push({
          keyphrases: ['steam'],
          piece: true,
          goods: ['KEY-A', 'KEY-B'],
          reserved: [{ good: 'KEY-BUSY', dealId: 'deal-busy', at: ISO }],
        });
      });

      const gctx = await dispatch(router, 'deliv:clear_goods:0');
      expect(gctx.answers[0]?.text ?? '').toContain('резерв');

      const rule = ctx.storage.getAutoDeliveries()[0];
      expect(rule?.goods).toEqual([]);
      expect(rule?.reserved).toEqual([]);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. System panel: audit trail, plugin integrity, runtime health
// ---------------------------------------------------------------------------

/**
 * Minimal service graph for the System screens: storage plus the three hard injects of
 * TelegramService. Neither PlayerOK nor the retry queue is mounted, which is exactly the
 * degraded deployment the screens have to survive.
 */
async function createSystemHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-tg-sys-'));
  tempDirs.push(dir);
  const ctx = new Context();
  await ctx.use(StorageService, { baseDir: dir });
  await ctx.use(AccessService);
  await ctx.use(BlacklistService);
  await ctx.use(PluginManagerService);
  await ctx.use(TelegramService, { token: '' });
  ctx.access.addSignedUser(USER_ID);
  return { ctx, router: ctx.telegram as unknown as Router };
}

/** Optional audit service stand-in: records what the panel asked it for. */
class StubAuditService extends Service {
  static provide = 'audit';

  public readonly calls: Array<{ limit?: number }> = [];
  public cleared = 0;
  private records: Array<Record<string, unknown>>;

  constructor(ctx: Context, records: Array<Record<string, unknown>>) {
    super(ctx, 'audit');
    this.records = records;
  }

  public list(options?: { limit?: number }): unknown[] {
    this.calls.push({ limit: options?.limit });
    const limit = options?.limit ?? this.records.length;
    return this.records.slice(-limit);
  }

  public stats(): { entries: number } {
    return { entries: this.records.length };
  }

  public clear(): void {
    this.cleared += 1;
    this.records = [];
  }
}

/** `list()` with a foreign signature: the panel must retry without an options object. */
class NoOptionsAuditService extends Service {
  static provide = 'audit';

  constructor(ctx: Context, private readonly records: Array<Record<string, unknown>>) {
    super(ctx, 'audit');
  }

  public list(...args: unknown[]): unknown[] {
    if (args.length > 0) throw new TypeError('unexpected options');
    return this.records;
  }
}

/** Present but unreadable: the screen must explain, not throw. */
class BrokenAuditService extends Service {
  static provide = 'audit';

  constructor(ctx: Context) {
    super(ctx, 'audit');
  }

  public list(): unknown[] {
    throw new Error('audit.jsonl повреждён');
  }

  public stats(): unknown {
    throw new Error('stats недоступны');
  }
}

describe('system panel: audit trail', () => {
  it('renders the newest ten records newest-first with escaped titles and an outcome icon', () => {
    const page = buildAuditPage(auditRecords, 0);
    expect(page.page).toBe(0);
    expect(page.entries).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    // Without a counter the window proves only that the log is longer than one page.
    expect(page.total).toBeNull();
    expect(page.entries[0]?.title).toBe('Событие 12');

    const view = renderAuditLog(page.entries, page.page, page.hasMore, 30);
    expect(view.text).toContain('Журнал аудита');
    expect(view.text).toContain('Всего записей: <b>30</b>');
    expect(view.text).toContain('Время указано в UTC');
    expect(view.text).toContain('Страница 1 из 3');
    expect(view.text).toContain('✅');
    expect(view.text).toContain('⏭️');
    expect(view.text).toContain('<code>2026-01-01 09:11:00</code>');

    // A failure bucket is unmissable, and the summary is markup, never HTML.
    const failed = renderAuditLog(
      buildAuditPage([auditRecords[5]], 0).entries,
      0,
      false,
      1,
    );
    expect(failed.text).toContain('❌');
    expect(failed.text).toContain('withdrawal.requested');

    const hostile = renderAuditLog(
      buildAuditPage(
        [{ at: ISO, action: 'deal.refund', outcome: 'failed', title: '<b>взлом</b>' }],
        0,
      ).entries,
      0,
      false,
      1,
    );
    expect(hostile.text).toContain('&lt;b&gt;взлом&lt;/b&gt;');
    expect(hostile.text).not.toContain('<b>взлом</b>');
    expect(hostile.text).toContain('❌');
  });

  it('pages through the trail and always offers a way back', () => {
    const first = buildAuditPage(auditRecords, 0);
    const second = buildAuditPage(auditRecords, 1);
    expect(second.entries).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(second.total).toBe(12);
    expect(second.entries[0]?.title).toBe('Событие 2');
    expect(first.entries[0]?.title).toBe('Событие 12');

    // Counters from stats() win over the window-derived total.
    expect(auditTotalOf({ entries: 42, bytes: 100 })).toBe(42);
    expect(auditTotalOf({ total: 7 })).toBe(7);
    expect(auditTotalOf('nope')).toBeNull();

    // callback_data is user-supplied: an absurd page must not ask the service for an
    // unbounded tail, and a negative one must fall back to the first page.
    expect(auditPageLimit(Number.MAX_SAFE_INTEGER)).toBe((AUDIT_MAX_PAGE + 1) * AUDIT_PAGE_SIZE + 1);
    expect(buildAuditPage(auditRecords, Number.MAX_SAFE_INTEGER).page).toBe(AUDIT_MAX_PAGE);
    expect(buildAuditPage(auditRecords, -5).page).toBe(0);

    const callbacks = collectCallbacks('audit page', renderAuditLog(first.entries, 0, true, 30)).map(
      (c) => c.data,
    );
    expect(callbacks).toEqual(expect.arrayContaining(['sys:audit:1', 'sys:audit_clear', 'sys:menu']));
    expect(callbacks).toContain('sys:audit:0');
  });

  it('reads the audit service by name and paginates with list({ limit })', async () => {
    const { ctx, router } = await createSystemHarness();
    try {
      await ctx.use(StubAuditService, auditRecords);
      const stub = ctx.get('audit', false) as StubAuditService;
      expect(stub).toBeInstanceOf(StubAuditService);

      const fresh = await dispatch(router, 'sys:audit:0');
      expect(fresh.staleAnswers).toEqual([]);
      const text = fresh.replies.join('\n');
      expect(text).toContain('Всего записей: <b>12</b>');
      expect(text).toContain('Событие 12');
      expect(text).toContain('Страница 1 из 2');

      const older = await dispatch(router, 'sys:audit:1');
      const olderText = older.replies.join('\n');
      expect(older.staleAnswers).toEqual([]);
      expect(olderText).toContain('Событие 2');
      expect(olderText).toContain('Страница 2 из 2');

      // Page N asks for every record up to that page, plus one to detect a next page.
      expect(stub.calls.map((call) => call.limit)).toEqual([11, 21]);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('never clears the trail without the confirmation button', async () => {
    const { ctx, router } = await createSystemHarness();
    try {
      await ctx.use(StubAuditService, auditRecords);
      const stub = ctx.get('audit', false) as StubAuditService;

      const ask = await dispatch(router, 'sys:audit_clear');
      expect(ask.staleAnswers).toEqual([]);
      expect(ask.replies.join('\n')).toContain('необратимо');
      expect(stub.cleared).toBe(0);
      const confirmButtons = collectCallbacks('audit clear', renderAuditClearConfirm(12)).map(
        (c) => c.data,
      );
      expect(confirmButtons).toEqual(expect.arrayContaining(['sys:audit_clear_yes', 'sys:audit:0']));

      const done = await dispatch(router, 'sys:audit_clear_yes');
      expect(stub.cleared).toBe(1);
      expect(done.answers.map((answer) => answer.text ?? '').join(' ')).toContain('очищен');
      expect(done.replies.join('\n')).toContain('Записей пока нет');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('explains instead of throwing when the audit service is absent', async () => {
    const { ctx, router } = await createSystemHarness();
    try {
      expect(ctx.get('audit', false)).toBeUndefined();

      const gctx = await dispatch(router, 'sys:audit:0');
      expect(gctx.staleAnswers).toEqual([]);
      expect(gctx.acted).toBe(true);
      expect(gctx.replies.join('\n')).toContain('Сервис аудита не подключён');

      // The clear action is not offered by a screen that has nothing to clear, but a
      // stale button from an older build must still answer.
      const clear = await dispatch(router, 'sys:audit_clear_yes');
      expect(clear.staleAnswers).toEqual([]);
      expect(clear.acted).toBe(true);
      expect(clear.replies.join('\n')).toContain('Сервис аудита не подключён');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('retries a bare list() when the service rejects the options object', async () => {
    const { ctx, router } = await createSystemHarness();
    try {
      await ctx.use(NoOptionsAuditService, auditRecords);
      const gctx = await dispatch(router, 'sys:audit:0');
      expect(gctx.staleAnswers).toEqual([]);
      const text = gctx.replies.join('\n');
      expect(text).toContain('Событие 12');
      expect(text).toContain('Журнал аудита');
      expect(text).not.toContain('Экран временно недоступен');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('explains instead of throwing when the audit service itself fails', async () => {
    const { ctx, router } = await createSystemHarness();
    try {
      await ctx.use(BrokenAuditService);
      const gctx = await dispatch(router, 'sys:audit:0');
      expect(gctx.staleAnswers).toEqual([]);
      expect(gctx.acted).toBe(true);
      expect(gctx.replies.join('\n')).toContain('Журнал аудита');
      expect(gctx.replies.join('\n')).toContain('audit.jsonl повреждён');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe('system panel: plugin integrity', () => {
  it('renders ok / mismatch / unknown / missing with a short hash prefix', () => {
    const view = renderPluginIntegrity(integrityResults);
    expect(view.text).toContain('Целостность плагинов');
    expect(view.text).toContain('🚨 <b>ОБНАРУЖЕНО НЕСОВПАДЕНИЕ ХЕША: 1</b>');
    expect(view.text).toContain('🟢 <b>demo</b> — ok');
    expect(view.text).toContain('🚨 <b>evil</b> — <b>MISMATCH</b>');
    expect(view.text).toContain('❔ <b>hand-made</b>');
    expect(view.text).toContain('⚠️ <b>gone</b>');
    expect(view.text).toContain('файл не найден');
    expect(view.text).toContain('нет эталона');
    // A 10-char prefix, never the whole digest: the screen has to stay readable.
    expect(view.text).toContain('<code>aaaa111122</code>');
    expect(view.text).not.toContain('aaaa11112233');
    // Loud means above the fold: the mismatch is listed before the healthy plugin.
    expect(view.text.indexOf('<b>evil</b>')).toBeLessThan(view.text.indexOf('<b>demo</b>'));
  });

  it('handles a plugin manager without verifyPluginIntegrity gracefully', () => {
    expect(readPluginIntegrity(null)).toBeNull();
    expect(readPluginIntegrity(undefined)).toBeNull();
    expect(readPluginIntegrity({})).toBeNull();
    expect(readPluginIntegrity({ verifyPluginIntegrity: () => integrityResults })).toHaveLength(4);
    // A manager that returns nothing still gets an honest, empty screen.
    expect(renderPluginIntegrity([]).text).toContain('Внешних плагинов нет');
    expect(renderSystemNotice('Целостность плагинов', 'метод отсутствует').text).toContain(
      'метод отсутствует',
    );
  });

  it('runs the real plugin-manager check from the panel', async () => {
    const { ctx, router } = await createSystemHarness();
    try {
      const gctx = await dispatch(router, 'sys:integrity');
      expect(gctx.staleAnswers).toEqual([]);
      const text = gctx.replies.join('\n');
      expect(text).toContain('Целостность плагинов');
      expect(text).toContain('Внешних плагинов нет');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe('system panel: runtime health', () => {
  it('renders uptime, memory, node version, plugin count and queue depth', () => {
    const view = renderRuntimeHealth(healthSnapshot);
    expect(view.text).toContain('Состояние среды');
    expect(view.text).toContain('Аптайм: <b>2ч 3м 5с</b>');
    expect(view.text).toContain('Node.js: <code>v24.21.0</code>');
    expect(view.text).toContain('linux/x64');
    expect(view.text).toContain('PID 4242');
    expect(view.text).toContain('RSS <b>120.5 МБ</b>');
    expect(view.text).toContain('heap <b>45.0 МБ</b> из <b>180.0 МБ</b>');
    expect(view.text).toContain('Плагины: <b>5/7</b> активно');
    expect(view.text).toContain('pending <b>3</b> (в работе <b>1</b>) · Dead-Letter <b>2</b>');
  });

  it('renders without a retry queue, both in the snapshot and in the service graph', async () => {
    // Renderer: the queue is absent from the counters it was handed.
    const offline = renderRuntimeHealth({ ...healthSnapshot, retryQueue: retryQueueHealth(undefined) });
    expect(offline.text).toContain('Сервис очереди повторов не подключён.');
    expect(retryQueueHealth({ nonsense: true })).toBeNull();
    expect(retryQueueHealth({ pending: 2, dead: 1 })).toEqual({ pending: 2, dead: 1, processing: 0 });

    // Service: the screen must not depend on the optional queue being mounted.
    const { ctx, router } = await createSystemHarness();
    try {
      expect(ctx.get('retryQueue', false)).toBeUndefined();
      const gctx = await dispatch(router, 'sys:health');
      expect(gctx.staleAnswers).toEqual([]);
      const text = gctx.replies.join('\n');
      expect(text).toContain('Состояние среды');
      expect(text).toContain('Node.js: <code>' + process.version + '</code>');
      expect(text).toContain('Сервис очереди повторов не подключён');
      expect(text).toContain('Плагины: <b>0/0</b> активно');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('counts the real retry queue when it is mounted', async () => {
    const { ctx, router } = await createHarness();
    try {
      await ctx.retryQueue.enqueue({ kind: 'send_message', payload: {}, initialDelayMs: 3_600_000 });
      const gctx = await dispatch(router, 'sys:health');
      expect(gctx.staleAnswers).toEqual([]);
      const text = gctx.replies.join('\n');
      expect(text).toContain('Очередь повторов');
      expect(text).toContain('pending <b>1</b>');
      expect(text).not.toContain('Сервис очереди повторов не подключён');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('formats bytes and durations the way an operator reads them', () => {
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(1536)).toBe('1.5 КБ');
    expect(formatBytes(1024 * 1024 * 120.4)).toBe('120.4 МБ');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatDuration(5)).toBe('5с');
    expect(formatDuration(305)).toBe('5м 5с');
    expect(formatDuration(90_000)).toBe('1д 1ч 0м');
  });
});

describe('system panel: menu wiring', () => {
  it('exposes the sys section and routes every button of every System screen', async () => {
    expect(CALLBACK_SECTIONS).toContain('sys');

    const { ctx, router } = await createSystemHarness();
    try {
      const menu = await dispatch(router, 'sys:menu');
      expect(menu.staleAnswers).toEqual([]);
      expect(menu.replies.join('\n')).toContain('Система');
      // The submenu itself carries the three screens, each behind a short payload.
      const menuButtons = collectCallbacks('system menu', renderSystemMenu()).map(
        (callback) => callback.data,
      );
      expect(menuButtons).toEqual(
        expect.arrayContaining(['sys:audit:0', 'sys:integrity', 'sys:health', 'menu:main']),
      );

      const screens = [
        ...collectCallbacks('system menu', renderSystemMenu()),
        ...collectCallbacks(
          'system audit',
          renderAuditLog(buildAuditPage(auditRecords, 0).entries, 0, true, 30),
        ),
        ...collectCallbacks('system audit clear confirm', renderAuditClearConfirm(30)),
        ...collectCallbacks('system plugin integrity', renderPluginIntegrity(integrityResults)),
        ...collectCallbacks('system runtime health', renderRuntimeHealth(healthSnapshot)),
        ...collectCallbacks(
          'system notice',
          renderSystemNotice('Журнал аудита', 'Сервис аудита не подключён'),
        ),
      ];
      expect(screens.length).toBeGreaterThan(8);

      for (const { data, source } of screens) {
        assertCallbackFits(data, source);
        // 'noop' is answered before handleCallback; 'menu:main' needs the PlayerOK
        // service, which this minimal graph deliberately does not mount (the full
        // routing test above already executes it).
        if (data === 'noop' || data === 'menu:main') continue;
        const gctx = await dispatch(router, data);
        expect(gctx.acted, source + ': "' + data + '" was not answered and rendered nothing').toBe(true);
        expect(gctx.staleAnswers, source + ': "' + data + '" answered as a stale button').toEqual([]);
      }

      // Every System screen can be left without a shell. The clear-confirm step is the
      // exception by design: it only offers Cancel/Confirm and returns to the audit list.
      const exits = (view: RenderedView): string[] =>
        collectCallbacks('exit', view).map((callback) => callback.data);
      expect(exits(renderSystemMenu())).toContain('menu:main');
      expect(exits(renderAuditLog([], 0, false, 0))).toContain('sys:menu');
      expect(exits(renderPluginIntegrity(integrityResults))).toContain('sys:menu');
      expect(exits(renderRuntimeHealth(healthSnapshot))).toContain('sys:menu');
      expect(exits(renderSystemNotice('Журнал аудита', 'нет сервиса'))).toContain('sys:menu');
      expect(exits(renderAuditClearConfirm(0))).toContain('sys:audit:0');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});


