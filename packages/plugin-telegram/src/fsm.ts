export type BindingStoreKey =
  | 'auto_bump_items'
  | 'auto_restore_items'
  | 'auto_complete_deals';

export type BindingBucket = 'included' | 'excluded';

export type PendingInput =
  | { kind: 'reply_chat'; chatId: string }
  | { kind: 'edit_watermark' }
  | { kind: 'edit_message'; messageKey: string }
  | { kind: 'add_command' }
  | { kind: 'add_fast_reply' }
  | { kind: 'add_blacklist' }
  | { kind: 'add_delivery' }
  | { kind: 'delivery_add_goods'; ruleIndex: number }
  | { kind: 'delivery_edit_message'; ruleIndex: number }
  | { kind: 'add_data_replacement' }
  | { kind: 'dr_add_lines'; ruleIndex: number }
  | { kind: 'dr_edit_sep'; ruleIndex: number }
  | { kind: 'add_binding'; store: BindingStoreKey; bucket: BindingBucket }
  | { kind: 'edit_bump_num'; field: 'interval' | 'position' | 'cooldown' | 'check_interval' | 'night_interval' | 'night_position' }
  | { kind: 'edit_bump_time'; field: 'time_from' | 'time_to' }
  | { kind: 'edit_withdrawal_interval' }
  | { kind: 'edit_withdrawal_sbp_phone'; bankId: string }
  | { kind: 'edit_withdrawal_usdt' }
  | { kind: 'edit_conn'; field: 'pl_cookies' | 'pl_ua' | 'pl_proxy' | 'pl_timeout' | 'tg_proxy' | 'tg_api_url' | 'notif_chat_id' | 'tg_password' }
  | { kind: 'upload_plugin' }
  | { kind: 'auth_password' };

export class InputStateStore {
  private readonly states = new Map<number, PendingInput>();

  public get(userId: number): PendingInput | undefined {
    return this.states.get(userId);
  }

  public set(userId: number, state: PendingInput): void {
    this.states.set(userId, state);
  }

  public clear(userId: number): void {
    this.states.delete(userId);
  }
}
