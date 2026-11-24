import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { EventTypes, type PlayerokEvent } from '@pkh/core';
import {
  BotCheckDetectedError,
  GraphQLPlayerokTransport,
  UnauthorizedError,
} from '@pkh/adapter';

interface TestServer {
  baseUrl: string;
  wsUrl: string;
  wss: WebSocketServer;
  requests: Array<{ method: string; url: string; op?: string; body?: string }>;
  setMode: (mode: 'ok' | 'cf' | 'unauth') => void;
  setReviewReady: (ready: boolean) => void;
  close: () => Promise<void>;
}

async function createMockPlayerokServer(): Promise<TestServer> {
  let mode: 'ok' | 'cf' | 'unauth' = 'ok';
  let reviewReady = false;
  const requests: TestServer['requests'] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      let op = urlObj.searchParams.get('operationName') || undefined;
      if (!op && bodyStr.startsWith('{')) {
        try {
          op = JSON.parse(bodyStr).operationName;
        } catch {
          // ignore
        }
      }
      if (!op && bodyStr.includes('uploadChatImageIntoTemporaryStore')) {
        op = 'uploadChatImageIntoTemporaryStore';
      }
      requests.push({ method: req.method || 'GET', url: req.url || '/', op, body: bodyStr });

      if (mode === 'cf') {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html><title>Just a moment...</title>Cloudflare Ray ID</html>');
        return;
      }
      if (mode === 'unauth') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });

      if (op === 'viewer') {
        res.end(
          JSON.stringify({
            data: {
              viewer: {
                id: 'acc-1',
                username: 'LiveSeller',
                email: 'live@example.com',
                role: 'USER',
                isBlocked: false,
                supportChatId: 'sup-1',
                systemChatId: 'sys-1',
                balance: { value: 2500 },
                profile: { id: 'acc-1', testimonialCounter: 10 },
              },
            },
          }),
        );
        return;
      }
      if (op === 'user') {
        res.end(
          JSON.stringify({
            data: {
              user: {
                __typename: 'User',
                id: 'acc-1',
                username: 'LiveSeller',
                isOnline: true,
                balance: { id: 'b1', value: 2500, available: 2000, withdrawable: 2000, frozen: 0, pendingIncome: 500 },
                profile: { id: 'acc-1', rating: 4.9, testimonialCounter: 10 },
              },
            },
          }),
        );
        return;
      }
      if (op === 'userChats') {
        res.end(
          JSON.stringify({
            data: {
              chats: {
                edges: [
                  {
                    node: {
                      id: 'chat-1',
                      type: 'PM',
                      status: 'FINISHED',
                      unreadMessagesCounter: 1,
                      participants: [
                        { id: 'acc-1', username: 'LiveSeller' },
                        { id: 'buyer-1', username: 'LiveBuyer' },
                      ],
                    },
                  },
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          }),
        );
        return;
      }
      if (op === 'chatMessages') {
        res.end(
          JSON.stringify({
            data: {
              chatMessages: {
                edges: [
                  {
                    node: {
                      id: 'catchup-msg-1',
                      text: 'Сообщение во время обрыва WS',
                      createdAt: new Date().toISOString(),
                      user: { id: 'buyer-1', username: 'LiveBuyer' },
                    },
                  },
                ],
              },
            },
          }),
        );
        return;
      }
      if (op === 'markChatAsRead') {
        res.end(JSON.stringify({ data: { markChatAsRead: { id: 'chat-1' } } }));
        return;
      }
      if (op === 'uploadChatImageIntoTemporaryStore') {
        res.end(
          JSON.stringify({
            data: {
              uploadChatImageIntoTemporaryStore: {
                id: 'tmp-img-1',
                url: 'https://playerok.com/tmp/1.jpg',
                chatId: 'chat-1',
              },
            },
          }),
        );
        return;
      }
      if (op === 'createChatMessage') {
        res.end(
          JSON.stringify({
            data: {
              createChatMessage: {
                id: 'sent-1',
                text: 'Ответ с картинкой',
                createdAt: new Date().toISOString(),
                user: { id: 'acc-1', username: 'LiveSeller' },
                images: [{ id: 'tmp-img-1', url: 'https://playerok.com/tmp/1.jpg' }],
              },
            },
          }),
        );
        return;
      }
      if (op === 'SbpBankMembers') {
        res.end(JSON.stringify({ data: { sbpBankMembers: [{ id: 'bank-1', name: 'Т-Банк' }] } }));
        return;
      }
      if (op === 'verifiedCards') {
        res.end(
          JSON.stringify({
            data: {
              verifiedCards: {
                edges: [{ node: { id: 'card-1', cardFirstSix: '220070', cardLastFour: '9999', cardType: 'MIR' } }],
              },
            },
          }),
        );
        return;
      }
      if (op === 'deal') {
        res.end(
          JSON.stringify({
            data: {
              deal: {
                id: 'deal-ws-1',
                status: 'PAID',
                chat: { id: 'chat-1' },
                user: { id: 'buyer-1', username: 'LiveBuyer' },
                item: { id: 'it-1', slug: 'slug-1', name: 'Test Item', price: 300, rawPrice: 280 },
                testimonial: reviewReady
                  ? {
                      id: 'rev-1',
                      rating: 5,
                      text: 'Супер!',
                      createdAt: new Date().toISOString(),
                      creator: { id: 'buyer-1', username: 'LiveBuyer' },
                    }
                  : null,
              },
            },
          }),
        );
        return;
      }

      res.end(JSON.stringify({ data: {} }));
    });
  });

  const wss = new WebSocketServer({ server, path: '/graphql' });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind port');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/graphql`,
    wss,
    requests,
    setMode: (m) => {
      mode = m;
    },
    setReviewReady: (r) => {
      reviewReady = r;
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  for (const s of activeServers.splice(0)) {
    await s.close();
  }
});

describe('GraphQLPlayerokTransport (HTTP persisted queries + multipart + WS + catch-up)', () => {
  it('fetches account via POST viewer + persisted GET user, uploads images, and fetches SBP/cards', async () => {
    const srv = await createMockPlayerokServer();
    activeServers.push(srv);

    const transport = new GraphQLPlayerokTransport({
      baseUrl: srv.baseUrl,
      wsUrl: srv.wsUrl,
      cookies: 'token=secret; __ddg5_=abc',
    });

    const acc = await transport.getAccount();
    expect(acc.username).toBe('LiveSeller');
    expect(acc.profile.balance?.withdrawable).toBe(2000);
    expect(srv.requests.some((r) => r.method === 'POST' && r.op === 'viewer')).toBe(true);
    expect(srv.requests.some((r) => r.method === 'GET' && r.url.includes('persistedQuery'))).toBe(true);

    const msg = await transport.sendMessage({
      chatId: 'chat-1',
      text: 'Ответ с картинкой',
      markChatAsRead: true,
      images: [{ filename: 'pic.jpg', data: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' }],
    });
    expect(msg.id).toBe('sent-1');
    expect(srv.requests.some((r) => r.op === 'markChatAsRead')).toBe(true);
    expect(srv.requests.some((r) => r.op === 'uploadChatImageIntoTemporaryStore')).toBe(true);

    const banks = await transport.getSbpBankMembers();
    expect(banks[0].name).toBe('Т-Банк');

    const cards = await transport.getVerifiedCards();
    expect(cards[0].cardLastFour).toBe('9999');

    await transport.close();
  });

  it('throws BotCheckDetectedError on anti-bot challenge and UnauthorizedError on 401', async () => {
    const srv = await createMockPlayerokServer();
    activeServers.push(srv);

    const transport = new GraphQLPlayerokTransport({
      baseUrl: srv.baseUrl,
      wsUrl: srv.wsUrl,
      cookies: 'token=secret',
    });

    srv.setMode('cf');
    await expect(transport.getAccount()).rejects.toBeInstanceOf(BotCheckDetectedError);

    srv.setMode('unauth');
    await expect(transport.getAccount()).rejects.toBeInstanceOf(UnauthorizedError);

    await transport.close();
  });

  it('handles WS chatMessageCreated, deduplicates messages, catches up missed messages, and polls reviews', async () => {
    const srv = await createMockPlayerokServer();
    activeServers.push(srv);

    const events: PlayerokEvent[] = [];
    const transport = new GraphQLPlayerokTransport({
      baseUrl: srv.baseUrl,
      wsUrl: srv.wsUrl,
      cookies: 'token=secret',
      reviewPollIntervalMs: 50,
      newDealsPollIntervalMs: 60_000,
    });

    await transport.getAccount();

    // Wire WS server to acknowledge init and push a duplicate message + ITEM_PAID
    srv.wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as { id?: string; type: string; payload?: { operationName?: string } };
        if (parsed.type === 'connection_init') {
          socket.send(JSON.stringify({ type: 'connection_ack' }));
        } else if (parsed.type === 'subscribe' && parsed.payload?.operationName === 'chatMessageCreated') {
          const msgPayload = {
            id: 'ws-msg-1',
            text: 'Привет через WS',
            createdAt: new Date().toISOString(),
            user: { id: 'buyer-1', username: 'LiveBuyer' },
          };
          // Send twice to test deduplication
          socket.send(JSON.stringify({ id: parsed.id, type: 'next', payload: { data: { chatMessageCreated: msgPayload } } }));
          socket.send(JSON.stringify({ id: parsed.id, type: 'next', payload: { data: { chatMessageCreated: msgPayload } } }));

          // Send ITEM_PAID to register deal for review checking
          socket.send(
            JSON.stringify({
              id: parsed.id,
              type: 'next',
              payload: {
                data: {
                  chatMessageCreated: {
                    id: 'ws-msg-paid',
                    text: '{{ITEM_PAID}}',
                    createdAt: new Date().toISOString(),
                    user: { id: 'buyer-1', username: 'LiveBuyer' },
                    deal: { id: 'deal-ws-1', status: 'PAID' },
                  },
                },
              },
            }),
          );
        }
      });
    });

    const unsub = await transport.subscribe((ev) => {
      events.push(ev);
    });

    // Wait briefly for WS messages to be processed
    await new Promise((r) => setTimeout(r, 200));

    const textMsgs = events.filter((e) => e.type === EventTypes.NEW_MESSAGE);
    expect(textMsgs).toHaveLength(1);
    expect(events.some((e) => e.type === EventTypes.NEW_DEAL)).toBe(true);

    // Enable review on deal and trigger review poll
    srv.setReviewReady(true);
    await new Promise((r) => setTimeout(r, 80));
    await transport.pollPendingReviews((ev) => {
      events.push(ev);
    });
    expect(events.some((e) => e.type === EventTypes.NEW_REVIEW)).toBe(true);

    // Test catchUpMessages recovers missed message
    await transport.catchUpMessages(Date.now() - 60_000, (ev) => {
      events.push(ev);
    });
    expect(
      events.some(
        (e) => e.type === EventTypes.NEW_MESSAGE && e.message.id === 'catchup-msg-1',
      ),
    ).toBe(true);

    unsub();
    await transport.close();
  });
});
