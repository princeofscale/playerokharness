import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context, PriorityTypes, StorageService } from '@pkh/core';
import {
  GraphQLPlayerokTransport,
  MAX_CONTRACT_ISSUES,
  MockPlayerokTransport,
  PlayerokService,
} from '@pkh/adapter';

interface ContractServer {
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

/**
 * Minimal PlayerOK GraphQL stand-in: answers every HTTP request with
 * `{ data: <handlers[operationName]>() }` on 127.0.0.1 only.
 */
async function createContractServer(handlers: Record<string, () => unknown>): Promise<ContractServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      let op = urlObj.searchParams.get('operationName') || undefined;
      if (!op && bodyStr.startsWith('{')) {
        try {
          op = (JSON.parse(bodyStr) as { operationName?: string }).operationName;
        } catch {
          // ignore non-JSON bodies
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const handler = op ? handlers[op] : undefined;
      res.end(JSON.stringify({ data: handler ? handler() : {} }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind port');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/graphql`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const buyer = { id: 'buyer-1', username: 'LiveBuyer' };

const validItem = {
  id: 'it-1',
  slug: 'slug-1',
  name: 'Test Item',
  description: 'Описание товара',
  price: 300,
  rawPrice: 280,
  priority: 'PREMIUM',
  status: 'APPROVED',
  sequence: 3,
  mayBePublished: true,
  user: { id: 'acc-1', username: 'LiveSeller' },
  category: { id: 'cat-1', name: 'Steam', slug: 'steam' },
  obtainingType: { id: 'ot-1', name: 'Автовыдача' },
  attributes: { region: 'RU' },
  dataFields: [{ id: 'df-1', label: 'Логин', type: 'ITEM_DATA', value: 'login-1', hidden: false }],
  attachments: [{ id: 'att-1', url: 'https://playerok.com/att.png', filename: 'att.png', mime: 'image/png' }],
};

const validReview = {
  id: 'rev-1',
  status: 'APPROVED',
  rating: 5,
  text: 'Отлично!',
  createdAt: '2024-05-01T12:00:00.000Z',
  creator: buyer,
};

const validMessage = {
  id: 'msg-1',
  text: 'Здравствуйте!',
  createdAt: '2024-05-01T10:00:00.000Z',
  isRead: true,
  user: buyer,
  images: [{ id: 'img-1', url: 'https://playerok.com/1.jpg' }],
  deal: null,
};

const validDeal = {
  id: 'deal-1',
  status: 'PAID',
  direction: 'IN',
  createdAt: '2024-05-01T11:00:00.000Z',
  completedAt: null,
  hasProblem: false,
  commentFromBuyer: null,
  chat: { id: 'chat-1' },
  user: buyer,
  item: validItem,
  testimonial: validReview,
};

const validUser = {
  __typename: 'User',
  id: 'acc-1',
  username: 'LiveSeller',
  isOnline: true,
  isBlocked: false,
  rating: 4.9,
  testimonialCounter: 10,
  supportChatId: 'sup-1',
  systemChatId: 'sys-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  balance: { id: 'b-1', value: 2500, frozen: 0, available: 2000, withdrawable: 2000, pendingIncome: 500 },
  profile: { id: 'acc-1', avatarURL: 'https://playerok.com/a.png', rating: 4.9, testimonialCounter: 10 },
};

const validChat = {
  id: 'chat-1',
  type: 'PM',
  status: 'FINISHED',
  unreadMessagesCounter: 1,
  participants: [{ id: 'acc-1', username: 'LiveSeller' }, buyer],
  lastMessage: validMessage,
};

function fullHandlers(): Record<string, () => unknown> {
  return {
    viewer: () => ({
      viewer: {
        id: 'acc-1',
        username: 'LiveSeller',
        email: 'live@example.com',
        role: 'USER',
        supportChatId: 'sup-1',
        systemChatId: 'sys-1',
        unreadChatsCounter: 2,
        isBlocked: false,
        hasFrozenBalance: false,
        hasConfirmedPhoneNumber: true,
        canPublishItems: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        balance: { value: 2500 },
        profile: { id: 'acc-1', avatarURL: 'https://playerok.com/a.png', testimonialCounter: 10 },
      },
    }),
    user: () => ({ user: validUser }),
    userChats: () => ({
      chats: {
        edges: [{ node: validChat }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
    chat: () => ({ chat: validChat }),
    chatMessages: () => ({
      chatMessages: {
        edges: [{ node: validMessage }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
    items: () => ({
      items: {
        edges: [{ node: validItem }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
    item: () => ({ item: validItem }),
    itemPriorityStatuses: () => ({
      itemPriorityStatuses: [{ id: 'ps-1', name: 'Премиум', price: 50, type: 'PREMIUM', period: 7 }],
    }),
    deals: () => ({
      deals: {
        edges: [{ node: validDeal }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
    deal: () => ({ deal: validDeal }),
    testimonials: () => ({
      testimonials: {
        edges: [{ node: validReview }],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
    transactions: () => ({
      transactions: {
        edges: [
          {
            node: {
              id: 'trx-1',
              operation: 'SELL',
              direction: 'IN',
              providerId: 'LOCAL',
              status: 'CONFIRMED',
              value: 300,
              fee: 15,
              createdAt: '2024-05-01T13:00:00.000Z',
              props: { userData: { account: 'acc-1' } },
            },
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
  };
}

const tempDirs: string[] = [];
const activeServers: ContractServer[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkh-contract-'));
  tempDirs.push(dir);
  return dir;
}

function makeTransport(srv: ContractServer): GraphQLPlayerokTransport {
  return new GraphQLPlayerokTransport({
    baseUrl: srv.baseUrl,
    wsUrl: srv.wsUrl,
    cookies: 'token=secret; __ddg5_=abc',
    timeoutMs: 5_000,
  });
}

afterEach(async () => {
  for (const s of activeServers.splice(0)) {
    await s.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GraphQL response-contract guard', () => {
  it('maps a fully valid payload exactly as before and records no contract issue', async () => {
    const srv = await createContractServer(fullHandlers());
    activeServers.push(srv);
    const transport = makeTransport(srv);

    const account = await transport.getAccount();
    expect(account.username).toBe('LiveSeller');
    expect(account.email).toBe('live@example.com');
    expect(account.unreadChatsCounter).toBe(2);
    expect(account.profile.rating).toBe(4.9);
    expect(account.profile.reviewsCount).toBe(10);
    expect(account.profile.balance?.withdrawable).toBe(2000);

    const user = await transport.getUser('acc-1');
    expect(user.id).toBe('acc-1');
    expect(user.avatarUrl).toBe('https://playerok.com/a.png');
    expect(user.reviewsCount).toBe(10);

    const chats = await transport.getChats(24);
    expect(chats.items).toHaveLength(1);
    expect(chats.items[0].users).toHaveLength(2);
    expect(chats.items[0].type).toBe('PM');
    expect(chats.items[0].lastMessage?.text).toBe('Здравствуйте!');

    const chat = await transport.getChat('chat-1');
    expect(chat.id).toBe('chat-1');
    expect(chat.status).toBe('FINISHED');

    const messages = await transport.getChatMessages('chat-1', 24);
    expect(messages[0].images?.[0]?.url).toBe('https://playerok.com/1.jpg');

    const items = await transport.getMyItems({ count: 24 });
    expect(items.items[0].rawPrice).toBe(280);
    expect(items.items[0].sequence).toBe(3);
    expect(items.items[0].priority).toBe(PriorityTypes.PREMIUM);
    expect(items.items[0].category?.slug).toBe('steam');
    expect(items.items[0].obtainingType?.name).toBe('Автовыдача');
    expect(items.items[0].dataFields?.[0]?.value).toBe('login-1');
    expect(items.items[0].attachments?.[0]?.url).toBe('https://playerok.com/att.png');

    const item = await transport.getItem({ id: 'it-1' });
    expect(item.name).toBe('Test Item');

    const statuses = await transport.getItemPriorityStatuses('it-1', 280);
    expect(statuses[0].price).toBe(50);
    expect(statuses[0].type).toBe(PriorityTypes.PREMIUM);

    const deals = await transport.getDeals({ count: 24 });
    expect(deals.items[0].item.name).toBe('Test Item');
    expect(deals.items[0].user.username).toBe('LiveBuyer');
    expect(deals.items[0].chatId).toBe('chat-1');
    expect(deals.items[0].review?.rating).toBe(5);

    const deal = await transport.getDeal('deal-1');
    expect(deal.id).toBe('deal-1');

    const reviews = await transport.getReviews({ count: 24 });
    expect(reviews.items[0].rating).toBe(5);
    expect(reviews.items[0].creator.username).toBe('LiveBuyer');

    const transactions = await transport.getTransactions(24);
    expect(transactions.items[0].value).toBe(300);
    expect(transactions.items[0].fee).toBe(15);
    expect(transactions.items[0].account).toBe('acc-1');

    expect(transport.getContractIssues()).toEqual([]);
    await transport.close();
  });

  it('records one issue for a missing required field and still returns best-effort data', async () => {
    const handlers = fullHandlers();
    handlers.item = () => ({ item: { slug: 'slug-1', name: 'Test Item', price: 300, rawPrice: 280 } });
    handlers.userChats = () => ({ chatList: { edges: [] } });
    const srv = await createContractServer(handlers);
    activeServers.push(srv);
    const transport = makeTransport(srv);

    const item = await transport.getItem({ id: 'it-1' });
    expect(item.id).toBe('');
    expect(item.name).toBe('Test Item');
    expect(item.rawPrice).toBe(280);

    const issues = transport.getContractIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].op).toBe('item');
    expect(issues[0].paths).toContain('item.id');
    expect(issues[0].issueCount).toBeGreaterThanOrEqual(1);
    expect(issues[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A renamed top-level collection degrades to an empty page instead of throwing.
    const chats = await transport.getChats(24);
    expect(chats.items).toEqual([]);
    const afterRename = transport.getContractIssues();
    expect(afterRename).toHaveLength(2);
    expect(afterRename[1].op).toBe('userChats');
    expect(afterRename[1].paths).toContain('chats');

    await transport.close();
  });

  it('caps the issue ring buffer at MAX_CONTRACT_ISSUES, dropping the oldest first', async () => {
    const itemMissingId = { slug: 'slug-1', name: 'Test Item', price: 300, rawPrice: 280 };
    const itemMissingSlug = { id: 'it-1', name: 'Test Item', price: 300, rawPrice: 280 };
    let calls = 0;
    const srv = await createContractServer({
      item: () => ({ item: calls++ < 5 ? itemMissingId : itemMissingSlug }),
    });
    activeServers.push(srv);
    const transport = makeTransport(srv);

    for (let i = 0; i < MAX_CONTRACT_ISSUES + 10; i++) {
      await transport.getItem({ id: 'it-1' });
    }

    const issues = transport.getContractIssues();
    expect(MAX_CONTRACT_ISSUES).toBe(50);
    expect(issues).toHaveLength(MAX_CONTRACT_ISSUES);
    expect(issues.every((issue) => issue.op === 'item')).toBe(true);
    // The first 5 calls (missing id) were pushed out; only the newest 50 remain.
    expect(issues.every((issue) => !issue.paths.includes('item.id'))).toBe(true);
    expect(issues.every((issue) => issue.paths.includes('item.slug'))).toBe(true);

    await transport.close();
  });

  it('surfaces transport issues through PlayerokService.getContractIssues()', async () => {
    const dir = makeTempDir();
    const srv = await createContractServer({
      item: () => ({ item: { slug: 'slug-1', name: 'Test Item', price: 300, rawPrice: 280 } }),
    });
    activeServers.push(srv);
    const transport = makeTransport(srv);

    await transport.getItem({ id: 'it-1' });
    expect(transport.getContractIssues()).toHaveLength(1);

    const ctx = new Context();
    await ctx.use(StorageService, { baseDir: dir });
    await ctx.use(PlayerokService, { transport, enableMaintenanceLoops: false });

    const issues = ctx.playerok.getContractIssues();
    expect(issues).toEqual(transport.getContractIssues());
    expect(issues[0].op).toBe('item');
    expect(issues[0].paths).toContain('item.id');
    await ctx.fiber.dispose();

    // A transport without contract validation reports nothing instead of throwing.
    const mockCtx = new Context();
    await mockCtx.use(StorageService, { baseDir: makeTempDir() });
    await mockCtx.use(PlayerokService, {
      dryRun: true,
      transport: new MockPlayerokTransport(),
      enableMaintenanceLoops: false,
    });
    expect(mockCtx.playerok.getContractIssues()).toEqual([]);
    await mockCtx.fiber.dispose();

    await transport.close();
  });
});
