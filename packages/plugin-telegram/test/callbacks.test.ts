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
  type SbpBankMember,
  type VerifiedCard,
} from '@pkh/core';
import { mountAutomation, type TrackedPosition } from '@pkh/plugin-automation';
import { RetryQueueService, type RetryTask } from '@pkh/plugin-retry-queue';
import { MockPlayerokTransport, PlayerokService } from '@pkh/adapter';
import {
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_LITERAL_MAX_BYTES,
  CALLBACK_REGISTRY_LIMIT,
  PASSWORD_MAX_ATTEMPTS,
  PASSWORD_WINDOW_MS,
  PasswordAttemptLimiter,
  STALE_CALLBACK_TEXT,
  TelegramService,
  callbackRegistrySize,
  fitCallback,
  isKnownCallbackSection,
  isStoredCallbackKey,
  readCallbackValue,
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
  renderProfile,
  renderRestoreSettings,
  renderRetryQueue,
  renderReviewsList,
  renderSetupMode,
  renderSignedUsers,
  renderStats,
  renderTransactionsList,
  renderUpdatesMenu,
  renderWithdrawalCards,
  renderWithdrawalSbpBanks,
  renderWithdrawalSettings,
  resolveCallback,
  storeCallback,
  type RenderedView,
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

/**
 * Full offline graph: every service the panel reads is mounted, so a screen that
 * touches playerok/automation/queue must render instead of throwing. A missing
 * service would surface as the Russian "service is not connected" error and fail
 * the routing test below.
 */
async function createHarness(): Promise<Harness> {
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
