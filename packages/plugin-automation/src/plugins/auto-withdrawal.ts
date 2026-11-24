import {
  Context,
  isDue,
  Service,
  TransactionProviderIds,
} from '@pkh/core';
import '@pkh/adapter';

export interface AutoWithdrawalConfig {
  tickIntervalMs?: number;
  enableTimer?: boolean;
}

export class AutoWithdrawalService extends Service {
  static provide = 'autoWithdrawal';
  static inject = ['storage', 'playerok'];

  private readonly log;

  constructor(ctx: Context, config: AutoWithdrawalConfig = {}) {
    super(ctx, 'autoWithdrawal');
    this.log = ctx.logger('automation.withdrawal');

    if (config.enableTimer !== false) {
      const tickMs = config.tickIntervalMs ?? 10_000;
      ctx.effect(() => {
        const timer = setInterval(() => {
          void this.tick();
        }, tickMs);
        timer.unref?.();
        return () => clearInterval(timer);
      }, 'autoWithdrawal:timer');
    }
  }

  public async tick(now: Date = new Date()): Promise<void> {
    const aw = this.ctx.storage.getConfig().playerok.auto_withdrawal;
    if (!aw.enabled) return;
    if (!isDue(aw.last_time, aw.interval, now)) return;
    await this.requestWithdrawal(now);
  }

  public async requestWithdrawal(
    now: Date = new Date(),
  ): Promise<{ ok: boolean; amount: number; error?: string }> {
    const cfg = this.ctx.storage.updateConfig((c) => {
      c.playerok.auto_withdrawal.last_time = now.toISOString();
    });
    const aw = cfg.playerok.auto_withdrawal;

    let balance = 0;
    try {
      const account = await this.ctx.playerok.refreshAccount();
      balance = account?.profile.balance?.withdrawable ?? 0;

      if (balance <= 500) {
        throw new Error('Слишком маленький баланс. Транзакция должна быть на сумму более 500₽');
      }

      let provider: TransactionProviderIds;
      let destination: string;
      let sbpBankMemberId: string | null = null;

      if (aw.credentials_type === 'card') {
        provider = TransactionProviderIds.BANK_CARD_RU;
        destination = aw.card_id;
      } else if (aw.credentials_type === 'sbp') {
        provider = TransactionProviderIds.SBP;
        destination = aw.sbp_phone_number;
        sbpBankMemberId = aw.sbp_bank_id || null;
      } else if (aw.credentials_type === 'usdt') {
        provider = TransactionProviderIds.USDT;
        destination = aw.usdt_address;
      } else {
        throw new Error('Не указан способ вывода средств (card / sbp / usdt)');
      }

      if (!destination) {
        throw new Error('Не заполнены реквизиты вывода');
      }

      const tx = await this.ctx.playerok.requestWithdrawal({
        provider,
        account: destination,
        value: balance,
        sbpBankMemberId,
      });

      this.log.info(`Создана заявка на вывод ${balance}₽ (ID: ${tx.id}, провайдер: ${provider})`);
      await this.ctx.parallel('withdrawal/requested', {
        transactionId: tx.id,
        amount: balance,
        provider,
      });
      return { ok: true, amount: balance };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Ошибка авто-вывода (${balance}₽): ${message}`);
      await this.ctx.parallel('notify/log', {
        eventKey: 'withdrawal_requested',
        title: `❌ Ошибка при создании транзакции на вывод ${balance}₽`,
        body: `<blockquote>${message}</blockquote>`,
      });
      return { ok: false, amount: 0, error: message };
    }
  }
}

declare module 'cordis' {
  interface Context {
    autoWithdrawal: AutoWithdrawalService;
  }
}
