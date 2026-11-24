import { Bot, Composer, InlineKeyboard, InputFile, type Context as GrammyContext } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  Context,
  escapeHtml,
  ItemDealStatuses,
  ItemStatuses,
  normalizeCustomApiUrl,
  OWNER_PREFIX,
  parseDayTime,
  parseItemRef,
  Service,
  type AutoDeliveryRule,
  type BoundItem,
  type CustomCommandsSettings,
  type DataReplacementRule,
  type FastReply,
  type IncludeExcludeSettings,
  type MessagesSettings,
  type NotificationPayload,
  type SellerCallPayload,
  type SetupProblem,
} from '@pkh/core';
import '@pkh/adapter';
import '@pkh/plugin-automation';
import type { StatsPeriod } from '@pkh/plugin-automation';
import {
  InputStateStore,
  type BindingBucket,
  type BindingStoreKey,
  type PendingInput,
} from './fsm.js';
import {
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
  renderReviewsList,
  renderSetupMode,
  renderSignedUsers,
  renderStats,
  renderTransactionsList,
  renderUpdatesMenu,
  renderWithdrawalCards,
  renderWithdrawalSbpBanks,
  renderWithdrawalSettings,
  toGrammyKeyboard,
  type RenderedView,
} from './keyboards.js';

export interface TelegramServiceConfig {
  token?: string;
  customApiUrl?: string;
  proxy?: string;
  onSetupLaunch?: () => Promise<SetupProblem | null>;
}

export class TelegramService extends Service {
  static provide = 'telegram';
  static inject = ['storage', 'access', 'blacklist', 'plugins'];

  public readonly bot: Bot | null;
  public readonly fsm = new InputStateStore();
  public username: string | null = null;

  private readonly log;
  private readonly extraComposers = new Set<Composer<GrammyContext>>();
  private readonly floatMessageIds = new Map<number, number>(); // chatId -> last floating menu messageId
  private onSetupLaunch?: () => Promise<SetupProblem | null>;
  private running = false;

  constructor(ctx: Context, config: TelegramServiceConfig = {}) {
    super(ctx, 'telegram');
    this.log = ctx.logger('telegram');
    this.onSetupLaunch = config.onSetupLaunch;

    const tgApi = ctx.storage.getConfig().telegram.api;
    const token = config.token ?? tgApi.token;
    const rawApiUrl = config.customApiUrl ?? tgApi.custom_api_url;
    const proxy = config.proxy ?? tgApi.proxy;
    const apiRoot = rawApiUrl ? normalizeCustomApiUrl(rawApiUrl) : undefined;

    if (token) {
      const clientOpts: Record<string, unknown> = {};
      if (apiRoot) clientOpts.apiRoot = apiRoot;
      if (proxy?.trim()) {
        const proxyUrl = /^https?:\/\//i.test(proxy.trim()) ? proxy.trim() : `http://${proxy.trim()}`;
        clientOpts.baseFetchConfig = {
          agent: new HttpsProxyAgent(proxyUrl),
        };
      }
      this.bot = new Bot(token, Object.keys(clientOpts).length ? { client: clientOpts } : undefined);
      this.wireHandlers(this.bot);
    } else {
      this.bot = null;
      this.log.warn('Telegram token не указан — TelegramService запущен в неактивном режиме');
    }

    ctx.on('notify/log', async (payload) => {
      await this.sendNotification(payload);
    });

    ctx.on('notify/call-seller', async (payload) => {
      await this.callSeller(payload);
    });

    ctx.on('bot/setup-mode', async (problem) => {
      await this.announceSetupMode(problem);
    });

    ctx.on('update/available', async (release) => {
      await this.sendNotification({
        title: `🆕 Доступна новая версия <b>${escapeHtml(release.tagName)}</b>`,
        body: release.body ? `<blockquote>${escapeHtml(release.body.slice(0, 600))}</blockquote>` : undefined,
        buttons: release.htmlUrl ? [[{ text: '🌐 Открыть релиз', url: release.htmlUrl }]] : undefined,
      });
    });

    ctx.effect(() => {
      return async () => {
        await this.stop();
      };
    }, 'telegram:lifecycle');
  }

  public setSetupLauncher(fn: () => Promise<SetupProblem | null>): void {
    this.onSetupLaunch = fn;
  }

  public addComposer(composer: Composer<GrammyContext>): () => void {
    this.extraComposers.add(composer);
    return () => {
      this.extraComposers.delete(composer);
    };
  }

  public async start(): Promise<void> {
    if (!this.bot || this.running) return;
    this.running = true;

    const me = await this.bot.api.getMe();
    this.username = me.username ?? null;

    await this.bot.api
      .setMyCommands([
        { command: 'start', description: '🏠 Главное меню' },
        { command: 'status', description: '📊 Статус бота' },
        { command: 'restart', description: '🔄️ Перезагрузить' },
      ])
      .catch(() => {});

    this.log.info(`Telegram бот @${me.username ?? 'unknown'} запущен и активен`);

    if (this.ctx.access.getSignedUsers().length === 0 && me.username) {
      const link = this.ctx.access.getOwnerLink(me.username);
      this.log.info(`Ссылка для привязки владельца (одноразовая): ${link}`);
    }

    void this.bot.start({ drop_pending_updates: true }).catch((err) => {
      this.log.error(`Ошибка polling Telegram: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  public async stop(): Promise<void> {
    if (!this.bot || !this.running) return;
    this.running = false;
    await this.bot.stop();
  }

  public async sendBootReport(): Promise<void> {
    if (!this.bot || !this.ctx.bootReport) return;
    const marker = this.ctx.bootReport.popMarker();
    const errors = this.ctx.bootReport.getErrors();
    const notes = this.ctx.bootReport.getNotes();
    if (!marker && errors.length === 0 && notes.length === 0) return;

    const html = this.ctx.bootReport.formatReportHtml(marker, this.ctx.plugins.list());
    const targets = new Set<number | string>(this.ctx.access.getSignedUsers());
    if (marker?.chat_id) targets.add(marker.chat_id);

    for (const chatId of targets) {
      if (marker?.chat_id === chatId && marker.message_id) {
        try {
          await this.bot.api.editMessageText(chatId, marker.message_id, html, { parse_mode: 'HTML' });
          continue;
        } catch {
          // fallback to sendMessage
        }
      }
      await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  public async announceSetupMode(problem: SetupProblem): Promise<void> {
    if (!this.bot) return;
    const view = renderSetupMode(problem);
    for (const userId of this.ctx.access.getSignedUsers()) {
      await this.bot.api
        .sendMessage(userId, view.text, {
          parse_mode: 'HTML',
          reply_markup: view.keyboard,
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    }
  }

  private getNotificationTargets(): Array<number | string> {
    const cfg = this.ctx.storage.getConfig();
    const chatId = cfg.playerok.notifications.chat_id;
    if (chatId !== '' && chatId !== undefined && chatId !== null) {
      return [chatId];
    }
    return this.ctx.access.getSignedUsers();
  }

  public async sendNotification(payload: NotificationPayload): Promise<void> {
    if (!this.bot) return;
    const targets = this.getNotificationTargets();
    if (targets.length === 0) return;

    const text = payload.body ? `${payload.title}\n\n${payload.body}` : payload.title;
    const replyMarkup = toGrammyKeyboard(payload.buttons);

    for (const chatId of targets) {
      try {
        await this.bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
        });
      } catch (err) {
        this.log.error(`Ошибка отправки уведомления в ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  public async callSeller(payload: SellerCallPayload): Promise<void> {
    if (!this.bot) return;
    const owners = this.ctx.access.getSignedUsers();
    const text = `💬 <b>Вызов продавца!</b>\n\nПокупатель <b>${escapeHtml(payload.username)}</b> просит подключиться к <a href="https://playerok.com/chats/${payload.chatId}">чату</a>.`;
    const kb = new InlineKeyboard()
      .text('✏️ Ответить', `chat:reply:${payload.chatId}`)
      .text('💬 Открыть чат', `chat:view:${payload.chatId}`);

    for (const userId of owners) {
      await this.bot.api
        .sendMessage(userId, text, {
          parse_mode: 'HTML',
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    }
  }

  private async showView(gctx: GrammyContext, view: RenderedView, edit = true): Promise<void> {
    const opts = {
      parse_mode: 'HTML' as const,
      reply_markup: view.keyboard,
      link_preview_options: { is_disabled: true },
    };
    const chatId = gctx.chat?.id;

    if (edit && gctx.callbackQuery?.message) {
      try {
        await gctx.editMessageText(view.text, opts);
        if (chatId) this.floatMessageIds.set(chatId, gctx.callbackQuery.message.message_id);
        return;
      } catch {
        // Fallback to floating edit or fresh reply
      }
    }

    if (edit && chatId && this.floatMessageIds.has(chatId) && this.bot) {
      const floatId = this.floatMessageIds.get(chatId)!;
      try {
        await this.bot.api.editMessageText(chatId, floatId, view.text, opts);
        return;
      } catch {
        this.floatMessageIds.delete(chatId);
      }
    }

    const sent = await gctx.reply(view.text, opts);
    if (chatId) this.floatMessageIds.set(chatId, sent.message_id);
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    if (!this.bot) throw new Error('Telegram bot not initialized');
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram file_path отсутствует');
    const tgApi = this.ctx.storage.getConfig().telegram.api;
    const base = tgApi.custom_api_url
      ? normalizeCustomApiUrl(tgApi.custom_api_url)
      : 'https://api.telegram.org';
    const url = `${base}/file/bot${this.bot.token}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Не удалось скачать файл из Telegram: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  private wireHandlers(bot: Bot): void {
    bot.catch((err) => {
      this.log.error(`GrammY error: ${err.message}`);
    });

    bot.use(async (gctx, next) => {
      let idx = 0;
      const composers = Array.from(this.extraComposers);
      const runNext = async (): Promise<void> => {
        if (idx < composers.length) {
          const current = composers[idx++];
          await current.middleware()(gctx, runNext);
        } else {
          await next();
        }
      };
      await runNext();
    });

    bot.command('start', async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId) return;
      this.fsm.clear(userId);

      const arg = (gctx.match || '').trim();
      if (arg.startsWith(OWNER_PREFIX)) {
        const code = arg.slice(OWNER_PREFIX.length);
        if (this.ctx.access.claimOwner(userId, code)) {
          await gctx.reply('✅ Вы успешно привязаны как владелец бота!');
          const problem = this.ctx.playerok?.setupProblem ?? null;
          await this.showView(
            gctx,
            problem ? renderSetupMode(problem) : renderMainMenu(Boolean(this.ctx.playerok?.isDryRun), null),
            false,
          );
          return;
        }
      }

      if (!this.ctx.access.isSigned(userId)) {
        await this.promptAuth(gctx, userId);
        return;
      }

      const problem = this.ctx.playerok?.setupProblem ?? null;
      await this.showView(
        gctx,
        problem ? renderSetupMode(problem) : renderMainMenu(Boolean(this.ctx.playerok?.isDryRun), null),
        false,
      );
    });

    bot.command('status', async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId || !this.ctx.access.isSigned(userId)) return;
      const acc = this.ctx.playerok?.account;
      const plugins = this.ctx.plugins.list();
      const activePlugins = plugins.filter((p) => p.enabled).length;
      const text = [
        '<b>📊 Статус PlayerOK Harness</b>',
        '',
        `Аккаунт: <b>${escapeHtml(acc?.username ?? 'не подключен')}</b>`,
        `Режим: <b>${this.ctx.playerok?.setupProblem ? 'SETUP MODE' : this.ctx.playerok?.isDryRun ? 'DRY-RUN' : 'LIVE'}</b>`,
        `Плагинов активно: <b>${activePlugins}/${plugins.length}</b>`,
        `Uptime: <b>${Math.floor(process.uptime())}с</b>`,
      ].join('\n');
      await gctx.reply(text, { parse_mode: 'HTML' });
    });

    bot.command('restart', async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId || !this.ctx.access.isSigned(userId)) return;
      const sent = await gctx.reply('🔄️ <b>Перезагружаю бота</b>, подождите...', { parse_mode: 'HTML' });
      this.ctx.bootReport?.setMarker('restart', sent.chat.id, sent.message_id);
      await this.ctx.parallel('bot/shutdown');
    });

    bot.callbackQuery(/^access:/, async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId) return;
      const [, action, targetStr] = gctx.callbackQuery.data.split(':');

      if (action === 'request') {
        if (!this.ctx.access.canRequestAccess(userId)) {
          await gctx.answerCallbackQuery({ text: 'Заявка уже отправлена (повтор раз в 24ч)', show_alert: true });
          return;
        }
        this.ctx.access.rememberRequest(userId, gctx.from?.username, gctx.from?.first_name);
        await gctx.answerCallbackQuery({ text: 'Заявка отправлена владельцу' });
        const owners = this.ctx.access.getSignedUsers();
        const kb = new InlineKeyboard()
          .text('✅ Одобрить', `access:approve:${userId}`)
          .text('❌ Отклонить', `access:deny:${userId}`);
        for (const ownerId of owners) {
          await bot.api
            .sendMessage(
              ownerId,
              `🔐 Запрос доступа от <b>${escapeHtml(gctx.from?.first_name || '')}</b> (@${escapeHtml(gctx.from?.username || '—')}, ID: <code>${userId}</code>)`,
              { parse_mode: 'HTML', reply_markup: kb },
            )
            .catch(() => {});
        }
        return;
      }

      if (!this.ctx.access.isSigned(userId)) {
        await gctx.answerCallbackQuery({ text: 'Нет прав', show_alert: true });
        return;
      }

      const targetId = Number(targetStr);
      if (action === 'approve' && Number.isFinite(targetId)) {
        this.ctx.access.addSignedUser(targetId);
        await gctx.editMessageText(`✅ Пользователю <code>${targetId}</code> выдан доступ`, {
          parse_mode: 'HTML',
        });
        await bot.api.sendMessage(targetId, '✅ Вам выдан доступ! Нажмите /start').catch(() => {});
      } else if (action === 'deny' && Number.isFinite(targetId)) {
        this.ctx.access.forgetRequest(targetId);
        await gctx.editMessageText(`❌ Заявка от <code>${targetId}</code> отклонена`, {
          parse_mode: 'HTML',
        });
      }
      await gctx.answerCallbackQuery();
    });

    bot.on('callback_query:data', async (gctx) => {
      const userId = gctx.from?.id;
      const data = gctx.callbackQuery.data;
      if (data === 'noop') {
        await gctx.answerCallbackQuery();
        return;
      }
      if (!userId || !this.ctx.access.isSigned(userId)) {
        await gctx.answerCallbackQuery({ text: 'Требуется авторизация (/start)', show_alert: true });
        return;
      }

      try {
        await this.handleCallback(gctx, userId, data);
      } catch (err) {
        await gctx.answerCallbackQuery({
          text: `Ошибка: ${err instanceof Error ? err.message.slice(0, 120) : 'неизвестная'}`,
          show_alert: true,
        });
      }
    });

    // Photo handler (send image directly to PlayerOK chat when replying)
    bot.on('message:photo', async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId || !this.ctx.access.isSigned(userId)) return;
      const pending = this.fsm.get(userId);
      if (pending?.kind !== 'reply_chat') return;

      this.fsm.clear(userId);
      const largest = gctx.message.photo[gctx.message.photo.length - 1];
      try {
        const buffer = await this.downloadTelegramFile(largest.file_id);
        const sent = await this.ctx.playerok.sendMessage(pending.chatId, gctx.message.caption || null, {
          images: [{ filename: 'photo.jpg', data: buffer, contentType: 'image/jpeg' }],
        });
        await gctx.reply(sent ? '✅ Изображение отправлено в чат PlayerOK.' : '❌ Не удалось отправить изображение.');
      } catch (err) {
        await gctx.reply(`❌ Ошибка отправки фото: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Document handler (.txt for piece goods / data replacement, .mjs/.js for plugins)
    bot.on('message:document', async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId || !this.ctx.access.isSigned(userId)) return;
      const pending = this.fsm.get(userId);
      if (!pending) return;

      const doc = gctx.message.document;
      const fileName = doc.file_name || 'file';

      if (pending.kind === 'upload_plugin') {
        this.fsm.clear(userId);
        try {
          const buf = await this.downloadTelegramFile(doc.file_id);
          await gctx.reply('⏳ Проверяю плагин в изолированном процессе...');
          const res = await this.ctx.plugins.installPluginFile(fileName, buf);
          if (res.check.status === 'ok') {
            await gctx.reply(`✅ Плагин <b>${escapeHtml(res.record?.meta.name ?? res.id)}</b> установлен и активирован!`, {
              parse_mode: 'HTML',
            });
          } else {
            await gctx.reply(
              `❌ Плагин <code>${escapeHtml(res.id)}</code> не прошёл проверку (${res.check.status}) и был откачен:\n<pre>${escapeHtml((res.check.trace || '').slice(0, 1500))}</pre>`,
              { parse_mode: 'HTML' },
            );
          }
          await this.showView(gctx, renderModulesList(this.ctx.plugins.list()), false);
        } catch (err) {
          await gctx.reply(`❌ Ошибка установки плагина: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (pending.kind === 'delivery_add_goods' || pending.kind === 'dr_add_lines') {
        if (!fileName.toLowerCase().endsWith('.txt')) {
          await gctx.reply('❌ Отправьте текст или .txt файл');
          return;
        }
        try {
          const buf = await this.downloadTelegramFile(doc.file_id);
          await this.handleFsmInput(gctx, userId, pending, buf.toString('utf8'));
        } catch (err) {
          await gctx.reply(`❌ Не удалось прочитать файл: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // Text input handler (FSM & legacy password)
    bot.on('message:text', async (gctx) => {
      const userId = gctx.from?.id;
      if (!userId) return;
      const pending = this.fsm.get(userId);
      if (!pending) return;

      const text = gctx.message.text.trim();
      if (text === '/cancel') {
        this.fsm.clear(userId);
        await gctx.reply('Отменено.');
        return;
      }

      if (pending.kind === 'auth_password') {
        if (this.ctx.access.verifyPasswordLogin(userId, text)) {
          this.fsm.clear(userId);
          await gctx.reply('✅ Пароль принят! Вы авторизованы.');
          await this.showView(
            gctx,
            renderMainMenu(Boolean(this.ctx.playerok?.isDryRun), this.ctx.playerok?.setupProblem ?? null),
            false,
          );
        } else {
          await gctx.reply('❌ Неверный пароль. Попробуйте снова или /cancel');
        }
        return;
      }

      if (!this.ctx.access.isSigned(userId)) return;
      await this.handleFsmInput(gctx, userId, pending, text);
    });
  }

  private async promptAuth(gctx: GrammyContext, userId: number): Promise<void> {
    if (this.ctx.access.isLegacyPasswordLogin()) {
      this.fsm.set(userId, { kind: 'auth_password' });
      await gctx.reply('🔑 Введите пароль администратора:');
      return;
    }

    if (this.ctx.access.getSignedUsers().length === 0) {
      await gctx.reply(
        '🔐 Владелец ещё не привязан. Перейдите по одноразовой ссылке из консоли запуска бота.',
      );
      return;
    }

    const kb = new InlineKeyboard().text('📩 Запросить доступ', 'access:request');
    await gctx.reply('🔒 У вас нет доступа к панели управления этим ботом.', { reply_markup: kb });
  }

  private async handleCallback(gctx: GrammyContext, userId: number, data: string): Promise<void> {
    const parts = data.split(':');
    const [section, arg1, arg2, arg3, arg4] = parts;
    const storage = this.ctx.storage;

    if (section === 'menu') {
      await gctx.answerCallbackQuery();
      switch (arg1) {
        case 'main':
          return this.showView(
            gctx,
            renderMainMenu(Boolean(this.ctx.playerok?.isDryRun), this.ctx.playerok?.setupProblem ?? null),
          );
        case 'setup':
          return this.showView(
            gctx,
            this.ctx.playerok?.setupProblem
              ? renderSetupMode(this.ctx.playerok.setupProblem)
              : renderMainMenu(Boolean(this.ctx.playerok?.isDryRun), null),
          );
        case 'notifications':
          return this.showView(gctx, renderNotificationsSettings(storage.getConfig()));
        case 'restore':
          return this.showView(gctx, renderRestoreSettings(storage.getConfig()));
        case 'complete':
          return this.showView(gctx, renderCompleteSettings(storage.getConfig()));
        case 'bump':
          return this.showView(
            gctx,
            renderBumpSettings(storage.getConfig(), Array.from(this.ctx.autoBump?.itemPositions.values() ?? [])),
          );
        case 'bump_positions':
          return this.showView(
            gctx,
            renderBumpPositions(Array.from(this.ctx.autoBump?.itemPositions.values() ?? [])),
          );
        case 'withdrawal':
          return this.showView(gctx, renderWithdrawalSettings(storage.getConfig()));
        case 'other':
          return this.showView(gctx, renderOtherSettings(storage.getConfig()));
        case 'conn':
          return this.showView(gctx, renderConnectionSettings(storage.getConfig(), Boolean(this.ctx.playerok?.isDryRun)));
        case 'messages':
          return this.showView(gctx, renderMessagesList(storage.getMessages()));
        case 'commands':
          return this.showView(gctx, renderCommandsList(storage.getCustomCommands()));
        case 'fast_replies':
          return this.showView(gctx, renderFastRepliesList(storage.getFastReplies()));
        case 'profile':
          return this.showView(gctx, renderProfile(this.ctx.playerok?.account ?? null));
        case 'modules':
          return this.showView(gctx, renderModulesList(this.ctx.plugins.list()));
        case 'logs':
          return this.showView(gctx, renderLogs(this.ctx.logSink?.getRecentLines(40) ?? []));
        case 'signed_users':
          return this.showView(gctx, renderSignedUsers(this.ctx.access.getSignedUsers()));
        case 'configs':
          return this.showView(gctx, renderConfigsMenu(storage.baseDir));
        case 'updates':
          return this.showView(
            gctx,
            renderUpdatesMenu(
              storage.getConfig(),
              this.ctx.updater?.latestRelease ?? null,
              Boolean(this.ctx.updater?.hasNewerRelease()),
            ),
          );
      }
      return;
    }

    if (section === 'chats' && arg1 === 'page') {
      await gctx.answerCallbackQuery();
      const page = Number(arg2) || 0;
      const list = this.ctx.playerok?.account ? (await this.ctx.playerok.getChats(48)).items : [];
      return this.showView(gctx, renderChatsList(list, this.ctx.playerok?.account?.id, page));
    }

    if (section === 'deals') {
      await gctx.answerCallbackQuery();
      const filter = arg1 || 'ALL';
      const page = Number(arg2) || 0;
      const statuses = filter === 'ALL' ? undefined : [filter as ItemDealStatuses];
      const list = this.ctx.playerok?.account ? (await this.ctx.playerok.getDeals({ statuses, count: 48 })).items : [];
      return this.showView(gctx, renderDealsList(list, filter, page));
    }

    if (section === 'items') {
      await gctx.answerCallbackQuery();
      const filter = (arg1 || ItemStatuses.APPROVED) as ItemStatuses;
      const page = Number(arg2) || 0;
      const list = this.ctx.playerok?.account
        ? await this.ctx.playerok.getMyItems({ statuses: [filter], count: 48 })
        : [];
      return this.showView(gctx, renderItemsList(list, filter, page));
    }

    if (section === 'txs' && arg1 === 'page') {
      await gctx.answerCallbackQuery();
      const page = Number(arg2) || 0;
      const list = this.ctx.playerok?.account ? (await this.ctx.playerok.getTransactions(48)).items : [];
      return this.showView(gctx, renderTransactionsList(list, page));
    }

    if (section === 'reviews') {
      await gctx.answerCallbackQuery();
      const rating = Number(arg1) || 0;
      const page = Number(arg2) || 0;
      const list = this.ctx.playerok?.account
        ? (await this.ctx.playerok.getReviews({ count: 48, rating: rating || null })).items
        : [];
      return this.showView(gctx, renderReviewsList(list, rating, page));
    }

    if (section === 'stats') {
      await gctx.answerCallbackQuery();
      const period = (['day', 'week', 'month', 'all'].includes(arg1) ? arg1 : 'day') as StatsPeriod;
      return this.showView(gctx, renderStats(storage.getCachedOrders(), period));
    }

    if (section === 'bind') {
      await gctx.answerCallbackQuery();
      const store = arg1 as BindingStoreKey;
      const bucket = arg2 as BindingBucket;
      const page = Number(arg3) || 0;
      const dataObj = storage.get<IncludeExcludeSettings>(store);
      return this.showView(gctx, renderBindingsList(store, bucket, dataObj[bucket], page));
    }

    if (section === 'bind_del') {
      const store = arg1 as BindingStoreKey;
      const bucket = arg2 as BindingBucket;
      const idx = Number(arg3);
      const page = Number(arg4) || 0;
      const updated = storage.update<IncludeExcludeSettings>(store, (obj) => {
        if (idx >= 0 && idx < obj[bucket].length) obj[bucket].splice(idx, 1);
      });
      await gctx.answerCallbackQuery({ text: 'Привязка удалена' });
      return this.showView(gctx, renderBindingsList(store, bucket, updated[bucket], page));
    }

    if (section === 'deliv') {
      if (arg1 === 'list') {
        await gctx.answerCallbackQuery();
        return this.showView(gctx, renderDeliveriesList(storage.getAutoDeliveries(), Number(arg2) || 0));
      }
      const idx = Number(arg2);
      if (arg1 === 'view') {
        await gctx.answerCallbackQuery();
        const rule = storage.getAutoDeliveries()[idx];
        if (rule) return this.showView(gctx, renderDeliveryDetail(idx, rule));
      }
      if (arg1 === 'toggle_piece') {
        const updated = storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
          if (list[idx]) {
            list[idx].piece = !list[idx].piece;
            if (list[idx].piece && !list[idx].goods) list[idx].goods = [];
          }
        });
        await gctx.answerCallbackQuery();
        if (updated[idx]) return this.showView(gctx, renderDeliveryDetail(idx, updated[idx]));
      }
      if (arg1 === 'clear_goods') {
        const updated = storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
          if (list[idx]) list[idx].goods = [];
        });
        await gctx.answerCallbackQuery({ text: 'Поштучные товары очищены' });
        if (updated[idx]) return this.showView(gctx, renderDeliveryDetail(idx, updated[idx]));
      }
      if (arg1 === 'del') {
        const updated = storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        });
        await gctx.answerCallbackQuery({ text: 'Правило удалено' });
        return this.showView(gctx, renderDeliveriesList(updated, 0));
      }
      return;
    }

    if (section === 'dr') {
      if (arg1 === 'list') {
        await gctx.answerCallbackQuery();
        return this.showView(gctx, renderDataReplacementList(storage.getDataReplacement(), Number(arg2) || 0));
      }
      const idx = Number(arg2);
      if (arg1 === 'view') {
        await gctx.answerCallbackQuery();
        const rule = storage.getDataReplacement()[idx];
        if (rule) return this.showView(gctx, renderDataReplacementDetail(idx, rule));
      }
      if (arg1 === 'toggle') {
        const updated = storage.update<DataReplacementRule[]>('data_replacement', (list) => {
          if (list[idx]) list[idx].enabled = !list[idx].enabled;
        });
        await gctx.answerCallbackQuery();
        if (updated[idx]) return this.showView(gctx, renderDataReplacementDetail(idx, updated[idx]));
      }
      if (arg1 === 'clear') {
        const updated = storage.update<DataReplacementRule[]>('data_replacement', (list) => {
          if (list[idx]) list[idx].data = [];
        });
        await gctx.answerCallbackQuery({ text: 'Строки очищены' });
        if (updated[idx]) return this.showView(gctx, renderDataReplacementDetail(idx, updated[idx]));
      }
      if (arg1 === 'del') {
        const updated = storage.update<DataReplacementRule[]>('data_replacement', (list) => {
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        });
        await gctx.answerCallbackQuery({ text: 'Правило удалено' });
        return this.showView(gctx, renderDataReplacementList(updated, 0));
      }
      return;
    }

    if (section === 'withdraw') {
      if (arg1 === 'cards') {
        await gctx.answerCallbackQuery();
        const cards = this.ctx.playerok?.account ? await this.ctx.playerok.getVerifiedCards() : [];
        return this.showView(gctx, renderWithdrawalCards(cards));
      }
      if (arg1 === 'set_card') {
        const cfg = storage.updateConfig((c) => {
          c.playerok.auto_withdrawal.credentials_type = 'card';
          c.playerok.auto_withdrawal.card_id = arg2;
        });
        await gctx.answerCallbackQuery({ text: 'Карта выбрана для авто-вывода' });
        return this.showView(gctx, renderWithdrawalSettings(cfg));
      }
      if (arg1 === 'sbp') {
        await gctx.answerCallbackQuery();
        const banks = this.ctx.playerok?.account ? await this.ctx.playerok.getSbpBankMembers() : [];
        return this.showView(gctx, renderWithdrawalSbpBanks(banks));
      }
      if (arg1 === 'set_sbp') {
        this.fsm.set(userId, { kind: 'edit_withdrawal_sbp_phone', bankId: arg2 });
        await gctx.answerCallbackQuery();
        await gctx.reply('📱 Введите номер телефона для СБП (например +79991234567) или /cancel:');
        return;
      }
    }

    if (section === 'toggle') {
      await gctx.answerCallbackQuery();
      if (arg1 === 'notif') {
        const cfg = storage.updateConfig((c) => {
          if (arg2 === 'enabled') {
            c.playerok.notifications.enabled = !c.playerok.notifications.enabled;
          } else if (arg2 in c.playerok.notifications.events) {
            const k = arg2 as keyof typeof c.playerok.notifications.events;
            c.playerok.notifications.events[k] = !c.playerok.notifications.events[k];
          }
        });
        return this.showView(gctx, renderNotificationsSettings(cfg));
      }
      if (arg1 === 'restore') {
        const cfg = storage.updateConfig((c) => {
          const r = c.playerok.auto_restore_items;
          if (arg2 === 'publish_status') {
            r.publish_status = r.publish_status === 'last' ? 'free' : r.publish_status === 'free' ? 'premium' : 'last';
          } else if (arg2 in r && typeof r[arg2 as keyof typeof r] === 'boolean') {
            (r as Record<string, unknown>)[arg2] = !(r as Record<string, unknown>)[arg2];
          }
        });
        return this.showView(gctx, renderRestoreSettings(cfg));
      }
      if (arg1 === 'complete') {
        const cfg = storage.updateConfig((c) => {
          if (arg2 === 'enabled') c.playerok.auto_complete_deals.enabled = !c.playerok.auto_complete_deals.enabled;
          if (arg2 === 'all') c.playerok.auto_complete_deals.all = !c.playerok.auto_complete_deals.all;
        });
        return this.showView(gctx, renderCompleteSettings(cfg));
      }
      if (arg1 === 'bump') {
        const cfg = storage.updateConfig((c) => {
          const b = c.playerok.auto_bump_items;
          if (arg2 === 'enabled') b.enabled = !b.enabled;
          if (arg2 === 'all') b.all = !b.all;
          if (arg2 === 'mode') b.mode = b.mode === 'interval' ? 'position' : 'interval';
          if (arg2 === 'night') b.night.enabled = !b.night.enabled;
        });
        return this.showView(
          gctx,
          renderBumpSettings(cfg, Array.from(this.ctx.autoBump?.itemPositions.values() ?? [])),
        );
      }
      if (arg1 === 'withdrawal') {
        const cfg = storage.updateConfig((c) => {
          if (arg2 === 'enabled') c.playerok.auto_withdrawal.enabled = !c.playerok.auto_withdrawal.enabled;
        });
        return this.showView(gctx, renderWithdrawalSettings(cfg));
      }
      if (arg1 === 'other') {
        const cfg = storage.updateConfig((c) => {
          if (arg2 === 'watermark') c.playerok.watermark.enabled = !c.playerok.watermark.enabled;
          if (arg2 === 'read_chat') c.playerok.read_chat = !c.playerok.read_chat;
          if (arg2 === 'bl_refund') c.playerok.blacklist.auto_refund = !c.playerok.blacklist.auto_refund;
        });
        return this.showView(gctx, renderOtherSettings(cfg));
      }
      if (arg1 === 'updates') {
        const cfg = storage.updateConfig((c) => {
          if (arg2 === 'notify') c.updates.notify = !c.updates.notify;
          if (arg2 === 'auto_update') c.updates.auto_update = !c.updates.auto_update;
        });
        return this.showView(
          gctx,
          renderUpdatesMenu(cfg, this.ctx.updater?.latestRelease ?? null, Boolean(this.ctx.updater?.hasNewerRelease())),
        );
      }
    }

    if (section === 'msg') {
      await gctx.answerCallbackQuery();
      const messages = storage.getMessages();
      if (arg1 === 'view' && messages[arg2]) {
        return this.showView(gctx, renderMessageDetail(arg2, messages[arg2]));
      }
      if (arg1 === 'toggle' && messages[arg2]) {
        const updated = storage.update<MessagesSettings>('messages', (m) => {
          if (m[arg2]) m[arg2].enabled = !m[arg2].enabled;
        });
        return this.showView(gctx, renderMessageDetail(arg2, updated[arg2]));
      }
    }

    if (section === 'cmd' && arg1 === 'del') {
      const key = decodeURIComponent(arg2);
      const updated = storage.update<CustomCommandsSettings>('custom_commands', (c) => {
        delete c[key];
      });
      await gctx.answerCallbackQuery({ text: `Команда ${key} удалена` });
      return this.showView(gctx, renderCommandsList(updated));
    }

    if (section === 'fr' && arg1 === 'del') {
      const idx = Number(arg2);
      const updated = storage.update<FastReply[]>('fast_replies', (list) => {
        if (idx >= 0 && idx < list.length) list.splice(idx, 1);
      });
      await gctx.answerCallbackQuery({ text: 'Быстрый ответ удалён' });
      return this.showView(gctx, renderFastRepliesList(updated));
    }

    if (section === 'bl') {
      if (arg1 === 'list') {
        await gctx.answerCallbackQuery();
        return this.showView(gctx, renderBlacklist(this.ctx.blacklist.list(), Number(arg2) || 0));
      }
      if (arg1 === 'del') {
        const username = decodeURIComponent(arg2);
        this.ctx.blacklist.remove(username);
        await gctx.answerCallbackQuery({ text: `${username} убран из ЧС` });
        return this.showView(gctx, renderBlacklist(this.ctx.blacklist.list(), Number(arg3) || 0));
      }
    }

    if (section === 'mod') {
      const id = decodeURIComponent(arg2);
      if (arg1 === 'toggle') {
        const rec = this.ctx.plugins.get(id);
        if (rec) {
          if (rec.enabled) await this.ctx.plugins.disable(id);
          else await this.ctx.plugins.enable(id);
        }
        await gctx.answerCallbackQuery();
        return this.showView(gctx, renderModulesList(this.ctx.plugins.list()));
      }
      if (arg1 === 'del') {
        await this.ctx.plugins.removePlugin(id);
        await gctx.answerCallbackQuery({ text: `Плагин ${id} удалён` });
        return this.showView(gctx, renderModulesList(this.ctx.plugins.list()));
      }
    }

    if (section === 'logs' && arg1 === 'clear') {
      this.ctx.logSink?.clearLogs();
      await gctx.answerCallbackQuery({ text: 'Логи очищены' });
      return this.showView(gctx, renderLogs([]));
    }

    if (section === 'auth' && arg1 === 'revoke') {
      const targetId = Number(arg2);
      if (targetId === userId) {
        await gctx.answerCallbackQuery({ text: 'Нельзя удалить самого себя', show_alert: true });
        return;
      }
      this.ctx.access.removeSignedUser(targetId);
      await gctx.answerCallbackQuery({ text: `Доступ ${targetId} отозван` });
      return this.showView(gctx, renderSignedUsers(this.ctx.access.getSignedUsers()));
    }

    if (section === 'cfg' && arg1 === 'export') {
      await gctx.answerCallbackQuery();
      const snapshot = JSON.stringify(storage.exportSnapshot(), null, 2);
      const file = new InputFile(Buffer.from(snapshot, 'utf8'), `pkh-config-${Date.now()}.json`);
      await gctx.replyWithDocument(file, { caption: '🗂 Экспорт настроек и данных PlayerOK Harness (pkh)' });
      return;
    }

    if (section === 'chat') {
      if (arg1 === 'view') {
        await gctx.answerCallbackQuery();
        const chat = await this.ctx.playerok.getChat(arg2, false);
        const msgs = await this.ctx.playerok.getChatMessages(arg2, 12);
        return this.showView(
          gctx,
          renderChatDetail(chat, msgs, storage.getFastReplies(), this.ctx.playerok.account?.id),
        );
      }
      if (arg1 === 'reply') {
        this.fsm.set(userId, { kind: 'reply_chat', chatId: arg2 });
        await gctx.answerCallbackQuery();
        await gctx.reply('✏️ Отправьте текст или фото для отправки в чат (или /cancel):');
        return;
      }
      if (arg1 === 'fr') {
        const reply = storage.getFastReplies()[Number(arg3)];
        if (reply) {
          await this.ctx.playerok.sendMessage(arg2, reply.text.join('\n'));
          await gctx.answerCallbackQuery({ text: `Отправлено: ${reply.name}` });
        } else {
          await gctx.answerCallbackQuery({ text: 'Быстрый ответ не найден' });
        }
        return;
      }
    }

    if (section === 'deal') {
      if (arg1 === 'view') {
        await gctx.answerCallbackQuery();
        const deal = await this.ctx.playerok.getDeal(arg2);
        return this.showView(gctx, renderDealDetail(deal));
      }
      if (arg1 === 'confirm') {
        const deal = await this.ctx.playerok.updateDeal(arg2, ItemDealStatuses.SENT);
        await gctx.answerCallbackQuery({ text: 'Сделка отмечена как отправленная' });
        return this.showView(gctx, renderDealDetail(deal));
      }
      if (arg1 === 'refund') {
        const deal = await this.ctx.playerok.updateDeal(arg2, ItemDealStatuses.ROLLED_BACK);
        await gctx.answerCallbackQuery({ text: 'Оформлен возврат по сделке' });
        return this.showView(gctx, renderDealDetail(deal));
      }
    }

    if (section === 'item') {
      if (arg1 === 'view') {
        await gctx.answerCallbackQuery();
        const item = await this.ctx.playerok.getItem({ id: arg2 });
        return this.showView(gctx, renderItemDetail(item));
      }
      if (arg1 === 'bump') {
        const item = await this.ctx.playerok.getItem({ id: arg2 });
        const ok = await this.ctx.autoBump?.bumpItem(item, 'вручную из Telegram');
        await gctx.answerCallbackQuery({ text: ok ? 'Товар поднят!' : 'Товар не подошёл под правила или ошибка' });
        return;
      }
      if (arg1 === 'restore') {
        const item = await this.ctx.playerok.getItem({ id: arg2 });
        const ok = await this.ctx.autoRestore?.restoreItem(item);
        await gctx.answerCallbackQuery({ text: ok ? 'Товар восстановлен!' : 'Не удалось восстановить' });
        return;
      }
    }

    if (section === 'action') {
      if (arg1 === 'setup_launch') {
        await gctx.answerCallbackQuery({ text: 'Проверяю подключение к PlayerOK...' });
        const problem = this.onSetupLaunch
          ? await this.onSetupLaunch()
          : await this.ctx.playerok.diagnose();
        if (problem) {
          return this.showView(gctx, renderSetupMode(problem));
        }
        return this.showView(gctx, renderMainMenu(Boolean(this.ctx.playerok?.isDryRun), null));
      }
      if (arg1 === 'refresh_profile') {
        await this.ctx.playerok?.refreshAccount();
        await gctx.answerCallbackQuery({ text: 'Профиль обновлён' });
        return this.showView(gctx, renderProfile(this.ctx.playerok?.account ?? null));
      }
      if (arg1 === 'bump_now') {
        const res = await this.ctx.autoBump?.bumpItems();
        await gctx.answerCallbackQuery({ text: `Поднято: ${res?.bumped ?? 0}/${res?.total ?? 0}` });
        return;
      }
      if (arg1 === 'check_positions') {
        const res = await this.ctx.autoBump?.checkItemsPositions();
        await gctx.answerCallbackQuery({ text: `Проверено: ${res?.total ?? 0}, поднято: ${res?.bumped ?? 0}` });
        return this.showView(
          gctx,
          renderBumpPositions(Array.from(this.ctx.autoBump?.itemPositions.values() ?? [])),
        );
      }
      if (arg1 === 'restore_expired') {
        const count = (await this.ctx.autoRestore?.restoreExpiredItems()) ?? 0;
        await gctx.answerCallbackQuery({ text: `Восстановлено истёкших: ${count}` });
        return;
      }
      if (arg1 === 'withdraw_now') {
        const res = await this.ctx.autoWithdrawal?.requestWithdrawal();
        await gctx.answerCallbackQuery({
          text: res?.ok ? `Создана заявка на ${res.amount}₽` : `Ошибка: ${res?.error ?? 'неизвестно'}`,
          show_alert: true,
        });
        return;
      }
      if (arg1 === 'check_updates') {
        await this.ctx.updater?.getReleases(true).catch(() => {});
        await gctx.answerCallbackQuery({ text: 'Релизы проверены' });
        return this.showView(
          gctx,
          renderUpdatesMenu(
            storage.getConfig(),
            this.ctx.updater?.latestRelease ?? null,
            Boolean(this.ctx.updater?.hasNewerRelease()),
          ),
        );
      }
    }

    if (section === 'fsm') {
      await gctx.answerCallbackQuery();
      switch (arg1) {
        case 'edit_watermark':
          this.fsm.set(userId, { kind: 'edit_watermark' });
          await gctx.reply('✏️ Введите новый текст водяного знака (или /cancel):');
          return;
        case 'edit_message':
          this.fsm.set(userId, { kind: 'edit_message', messageKey: arg2 });
          await gctx.reply(`✏️ Введите новый текст шаблона <code>${escapeHtml(arg2)}</code> (или /cancel):`, {
            parse_mode: 'HTML',
          });
          return;
        case 'add_command':
          this.fsm.set(userId, { kind: 'add_command' });
          await gctx.reply('✏️ Отправьте команду в формате:\n<code>!команда\nТекст ответа</code>\n(или /cancel):', {
            parse_mode: 'HTML',
          });
          return;
        case 'add_fast_reply':
          this.fsm.set(userId, { kind: 'add_fast_reply' });
          await gctx.reply('✏️ Отправьте быстрый ответ в формате:\n<code>Название\nТекст сообщения</code>\n(или /cancel):', {
            parse_mode: 'HTML',
          });
          return;
        case 'add_blacklist':
          this.fsm.set(userId, { kind: 'add_blacklist' });
          await gctx.reply('✏️ Введите <code>username причина</code> (причина опциональна, или /cancel):', {
            parse_mode: 'HTML',
          });
          return;
        case 'add_delivery':
          this.fsm.set(userId, { kind: 'add_delivery' });
          await gctx.reply(
            '✏️ Введите правило в формате:\n<code>ссылка на товар или ключевая фраза | текст выдачи</code>\n(или /cancel):',
            { parse_mode: 'HTML' },
          );
          return;
        case 'deliv_goods':
          this.fsm.set(userId, { kind: 'delivery_add_goods', ruleIndex: Number(arg2) });
          await gctx.reply('📦 Отправьте товары (каждый с новой строки) или .txt файл (или /cancel):');
          return;
        case 'deliv_msg':
          this.fsm.set(userId, { kind: 'delivery_edit_message', ruleIndex: Number(arg2) });
          await gctx.reply('✏️ Введите новый текст сообщения авто-выдачи (или /cancel):');
          return;
        case 'add_dr':
          this.fsm.set(userId, { kind: 'add_data_replacement' });
          await gctx.reply(
            '✏️ Введите привязку товара (ссылка PlayerOK, ID или ключевая фраза) для правила замены данных (или /cancel):',
          );
          return;
        case 'dr_lines':
          this.fsm.set(userId, { kind: 'dr_add_lines', ruleIndex: Number(arg2) });
          await gctx.reply('📥 Отправьте строки данных (каждая с новой строки) или .txt файл (или /cancel):');
          return;
        case 'dr_sep':
          this.fsm.set(userId, { kind: 'dr_edit_sep', ruleIndex: Number(arg2) });
          await gctx.reply('✏️ Введите символ-разделитель полей (например <code>:</code> или <code>;</code>):', {
            parse_mode: 'HTML',
          });
          return;
        case 'bind':
          this.fsm.set(userId, {
            kind: 'add_binding',
            store: arg2 as BindingStoreKey,
            bucket: arg3 as BindingBucket,
          });
          await gctx.reply(
            '🔗 Отправьте ссылки PlayerOK / ID товаров (по одной в строке) или ключевые фразы (или /cancel):',
          );
          return;
        case 'bump_num':
          this.fsm.set(userId, {
            kind: 'edit_bump_num',
            field: arg2 as Extract<PendingInput, { kind: 'edit_bump_num' }>['field'],
          });
          await gctx.reply(`🔢 Введите целое число для <code>${escapeHtml(arg2)}</code> (или /cancel):`, {
            parse_mode: 'HTML',
          });
          return;
        case 'bump_time':
          this.fsm.set(userId, {
            kind: 'edit_bump_time',
            field: arg2 as 'time_from' | 'time_to',
          });
          await gctx.reply('🕒 Введите время в формате <code>HH:MM</code> (например 23:00) или /cancel:', {
            parse_mode: 'HTML',
          });
          return;
        case 'withdraw':
          if (arg2 === 'interval') {
            this.fsm.set(userId, { kind: 'edit_withdrawal_interval' });
            await gctx.reply('⏱ Введите интервал авто-вывода в секундах (например 86400) или /cancel:');
          } else if (arg2 === 'usdt') {
            this.fsm.set(userId, { kind: 'edit_withdrawal_usdt' });
            await gctx.reply('🪙 Введите адрес USDT (TRC20) или /cancel:');
          }
          return;
        case 'conn':
          this.fsm.set(userId, {
            kind: 'edit_conn',
            field: arg2 as Extract<PendingInput, { kind: 'edit_conn' }>['field'],
          });
          await gctx.reply(
            `✏️ Введите новое значение для <code>${escapeHtml(arg2)}</code> (или <code>-</code> чтобы очистить, /cancel для отмены):`,
            { parse_mode: 'HTML' },
          );
          return;
        case 'upload_plugin':
          this.fsm.set(userId, { kind: 'upload_plugin' });
          await gctx.reply('🔌 Отправьте файл плагина в формате <code>.mjs</code> или <code>.js</code> (или /cancel):', {
            parse_mode: 'HTML',
          });
          return;
      }
    }

    await gctx.answerCallbackQuery();
  }

  private async resolveBindingFromInput(raw: string): Promise<{ items?: BoundItem[]; keyphrases?: string[] }> {
    const trimmed = raw.trim();
    if (this.ctx.playerok?.account && (trimmed.includes('playerok.com') || /^[0-9a-f-]{36}$/i.test(trimmed))) {
      try {
        const ref = parseItemRef(trimmed);
        const item = await this.ctx.playerok.getItem({ [ref.kind]: ref.value });
        return { items: [{ id: item.id, slug: item.slug, name: item.name }] };
      } catch {
        // Fallback to keyphrase if lookup fails
      }
    }
    return { keyphrases: [trimmed] };
  }

  private async handleFsmInput(
    gctx: GrammyContext,
    userId: number,
    pending: PendingInput,
    text: string,
  ): Promise<void> {
    this.fsm.clear(userId);
    const storage = this.ctx.storage;

    switch (pending.kind) {
      case 'reply_chat': {
        const sent = await this.ctx.playerok.sendMessage(pending.chatId, text);
        await gctx.reply(sent ? '✅ Сообщение отправлено в чат.' : '❌ Не удалось отправить сообщение.');
        return;
      }
      case 'edit_watermark': {
        const cfg = storage.updateConfig((c) => {
          c.playerok.watermark.value = text;
        });
        await this.showView(gctx, renderOtherSettings(cfg), false);
        return;
      }
      case 'edit_message': {
        const updated = storage.update<MessagesSettings>('messages', (m) => {
          if (m[pending.messageKey]) {
            m[pending.messageKey].text = text.split('\n');
          }
        });
        const tpl = updated[pending.messageKey];
        if (tpl) await this.showView(gctx, renderMessageDetail(pending.messageKey, tpl), false);
        return;
      }
      case 'add_command': {
        const [cmd, ...rest] = text.split('\n');
        if (!cmd || rest.length === 0) {
          await gctx.reply('❌ Укажите команду на первой строке и текст ответа на следующих.');
          return;
        }
        const updated = storage.update<CustomCommandsSettings>('custom_commands', (c) => {
          c[cmd.trim()] = rest;
        });
        await this.showView(gctx, renderCommandsList(updated), false);
        return;
      }
      case 'add_fast_reply': {
        const [name, ...rest] = text.split('\n');
        if (!name || rest.length === 0) {
          await gctx.reply('❌ Укажите название на первой строке и текст ответа на следующих.');
          return;
        }
        const updated = storage.update<FastReply[]>('fast_replies', (list) => {
          list.push({ name: name.trim(), text: rest });
        });
        await this.showView(gctx, renderFastRepliesList(updated), false);
        return;
      }
      case 'add_blacklist': {
        const [username, ...reasonParts] = text.split(/\s+/);
        const ok = this.ctx.blacklist.add(username, reasonParts.join(' '), `tg:${userId}`);
        await gctx.reply(ok ? `✅ ${username} добавлен в ЧС` : `⚠️ ${username} уже в ЧС или некорректен`);
        await this.showView(gctx, renderBlacklist(this.ctx.blacklist.list(), 0), false);
        return;
      }
      case 'add_delivery': {
        const sep = text.indexOf('|');
        if (sep <= 0) {
          await gctx.reply('❌ Формат: ссылка или ключевая фраза | текст выдачи');
          return;
        }
        const left = text.slice(0, sep).trim();
        const body = text.slice(sep + 1).trim();
        const binding = await this.resolveBindingFromInput(left);
        const updated = storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
          list.push({ ...binding, piece: false, message: body.split('\n') });
        });
        await this.showView(gctx, renderDeliveriesList(updated, 0), false);
        return;
      }
      case 'delivery_add_goods': {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const updated = storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
          const target = list[pending.ruleIndex];
          if (target) {
            target.piece = true;
            target.goods = [...(target.goods ?? []), ...lines];
          }
        });
        if (updated[pending.ruleIndex]) {
          await this.showView(gctx, renderDeliveryDetail(pending.ruleIndex, updated[pending.ruleIndex]), false);
        }
        return;
      }
      case 'delivery_edit_message': {
        const updated = storage.update<AutoDeliveryRule[]>('auto_deliveries', (list) => {
          if (list[pending.ruleIndex]) list[pending.ruleIndex].message = text.split('\n');
        });
        if (updated[pending.ruleIndex]) {
          await this.showView(gctx, renderDeliveryDetail(pending.ruleIndex, updated[pending.ruleIndex]), false);
        }
        return;
      }
      case 'add_data_replacement': {
        const binding = await this.resolveBindingFromInput(text);
        const updated = storage.update<DataReplacementRule[]>('data_replacement', (list) => {
          list.push({ ...binding, enabled: true, separator: ':', data: [] });
        });
        await this.showView(gctx, renderDataReplacementDetail(updated.length - 1, updated[updated.length - 1]), false);
        return;
      }
      case 'dr_add_lines': {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const updated = storage.update<DataReplacementRule[]>('data_replacement', (list) => {
          if (list[pending.ruleIndex]) {
            list[pending.ruleIndex].data.push(...lines);
          }
        });
        if (updated[pending.ruleIndex]) {
          await this.showView(gctx, renderDataReplacementDetail(pending.ruleIndex, updated[pending.ruleIndex]), false);
        }
        return;
      }
      case 'dr_edit_sep': {
        const updated = storage.update<DataReplacementRule[]>('data_replacement', (list) => {
          if (list[pending.ruleIndex]) list[pending.ruleIndex].separator = text || ':';
        });
        if (updated[pending.ruleIndex]) {
          await this.showView(gctx, renderDataReplacementDetail(pending.ruleIndex, updated[pending.ruleIndex]), false);
        }
        return;
      }
      case 'add_binding': {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const resolved: Array<{ items?: BoundItem[]; keyphrases?: string[] }> = [];
        for (const line of lines) {
          resolved.push(await this.resolveBindingFromInput(line));
        }
        const updated = storage.update<IncludeExcludeSettings>(pending.store, (obj) => {
          obj[pending.bucket].push(...resolved);
        });
        await this.showView(gctx, renderBindingsList(pending.store, pending.bucket, updated[pending.bucket], 0), false);
        return;
      }
      case 'edit_bump_num': {
        const num = Number.parseInt(text, 10);
        if (!Number.isFinite(num) || num < 0) {
          await gctx.reply('❌ Введите неотрицательное целое число.');
          return;
        }
        const cfg = storage.updateConfig((c) => {
          const b = c.playerok.auto_bump_items;
          if (pending.field === 'interval') b.interval = num;
          else if (pending.field === 'position') b.position = num;
          else if (pending.field === 'cooldown') b.cooldown = num;
          else if (pending.field === 'check_interval') b.check_interval = Math.max(10, num);
          else if (pending.field === 'night_interval') b.night.interval = num;
          else if (pending.field === 'night_position') b.night.position = num;
        });
        await this.showView(
          gctx,
          renderBumpSettings(cfg, Array.from(this.ctx.autoBump?.itemPositions.values() ?? [])),
          false,
        );
        return;
      }
      case 'edit_bump_time': {
        const parsed = parseDayTime(text);
        if (!parsed) {
          await gctx.reply('❌ Некорректный формат времени. Пример: 23:00');
          return;
        }
        const cfg = storage.updateConfig((c) => {
          c.playerok.auto_bump_items.night[pending.field] = parsed;
        });
        await this.showView(
          gctx,
          renderBumpSettings(cfg, Array.from(this.ctx.autoBump?.itemPositions.values() ?? [])),
          false,
        );
        return;
      }
      case 'edit_withdrawal_interval': {
        const num = Number.parseInt(text, 10);
        if (!Number.isFinite(num) || num < 60) {
          await gctx.reply('❌ Укажите интервал >= 60 секунд.');
          return;
        }
        const cfg = storage.updateConfig((c) => {
          c.playerok.auto_withdrawal.interval = num;
        });
        await this.showView(gctx, renderWithdrawalSettings(cfg), false);
        return;
      }
      case 'edit_withdrawal_sbp_phone': {
        const cfg = storage.updateConfig((c) => {
          c.playerok.auto_withdrawal.credentials_type = 'sbp';
          c.playerok.auto_withdrawal.sbp_bank_id = pending.bankId;
          c.playerok.auto_withdrawal.sbp_phone_number = text;
        });
        await this.showView(gctx, renderWithdrawalSettings(cfg), false);
        return;
      }
      case 'edit_withdrawal_usdt': {
        const cfg = storage.updateConfig((c) => {
          c.playerok.auto_withdrawal.credentials_type = 'usdt';
          c.playerok.auto_withdrawal.usdt_address = text;
        });
        await this.showView(gctx, renderWithdrawalSettings(cfg), false);
        return;
      }
      case 'edit_conn': {
        const val = text === '-' ? '' : text;
        const cfg = storage.updateConfig((c) => {
          if (pending.field === 'pl_cookies') c.playerok.api.cookies = val;
          else if (pending.field === 'pl_ua') c.playerok.api.user_agent = val;
          else if (pending.field === 'pl_proxy') c.playerok.api.proxy = val;
          else if (pending.field === 'pl_timeout') {
            const t = Number.parseInt(val, 10);
            if (Number.isFinite(t) && t >= 5) c.playerok.api.requests_timeout = t;
          } else if (pending.field === 'tg_proxy') c.telegram.api.proxy = val;
          else if (pending.field === 'tg_api_url') c.telegram.api.custom_api_url = val ? normalizeCustomApiUrl(val) : '';
          else if (pending.field === 'notif_chat_id') c.playerok.notifications.chat_id = val;
          else if (pending.field === 'tg_password') c.telegram.bot.password = val;
        });
        if (pending.field.startsWith('pl_')) {
          await this.ctx.playerok?.reconfigureTransport();
        }
        if (pending.field === 'notif_chat_id') {
          await this.showView(gctx, renderNotificationsSettings(cfg), false);
        } else {
          await this.showView(gctx, renderConnectionSettings(cfg, Boolean(this.ctx.playerok?.isDryRun)), false);
        }
        return;
      }
    }
  }
}

declare module 'cordis' {
  interface Context {
    telegram: TelegramService;
  }
}
