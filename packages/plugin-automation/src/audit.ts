import type { AuditActor, AuditOutcome, Context } from '@pkh/core';

/** One audit line an automation plugin wants to append. */
export interface AutomationAuditEntry {
  /** Dotted action name, e.g. 'delivery.sent'. */
  action: string;
  /** One-line human summary (never a token, cookie or delivered goods value). */
  title: string;
  outcome?: AuditOutcome;
  /** Small structured context: ids, amounts, counts, reasons. */
  details?: Record<string, unknown>;
  /**
   * Identity of the fact, used to drop a duplicate inside one pass. The default is
   * action + dealId + reason: two rules that match the same deal in one NEW_DEAL
   * pass would otherwise append the same line twice.
   */
  key?: string;
}

/** Recorder scoped to one pass over a rule list (delivery pass, bump pass). */
export interface AuditPass {
  record(entry: AutomationAuditEntry): void;
}

/**
 * The one member of the core AuditService this bundle calls. Structural on purpose:
 * the trail is an optional service (ctx.get('audit', false)), so automation must not
 * depend on the concrete class being mounted.
 */
export interface AuditRecorderLike {
  record(entry: {
    action: string;
    title: string;
    actor: AuditActor;
    outcome: AuditOutcome;
    details?: Record<string, unknown>;
  }): unknown;
}

function dedupeKey(entry: AutomationAuditEntry): string | undefined {
  if (entry.key) return entry.key;
  const dealId = entry.details?.dealId;
  if (typeof dealId !== 'string' || dealId.length === 0) return undefined;
  const reason = entry.details?.reason;
  return entry.action + ':' + dealId + ':' + (typeof reason === 'string' ? reason : '');
}

/**
 * Appends one line to the audit trail through the optional 'audit' service.
 *
 * The service is core-level and mounted by the app bootstrap, not by this bundle:
 * an automation stack without it must still deliver deals, so the lookup is the
 * non-strict ctx.get('audit', false) and every failure is swallowed here. Auditing
 * never changes the outcome of the action it records.
 */
export function auditSafely(ctx: Context, entry: AutomationAuditEntry, seen?: Set<string>): void {
  const audit = ctx.get('audit', false) as AuditRecorderLike | undefined;
  if (!audit) return;

  if (seen !== undefined) {
    const key = dedupeKey(entry);
    if (key !== undefined) {
      if (seen.has(key)) return;
      seen.add(key);
    }
  }

  try {
    audit.record({
      action: entry.action,
      title: entry.title,
      actor: 'auto',
      outcome: entry.outcome ?? 'ok',
      details: entry.details,
    });
  } catch (err) {
    ctx
      .logger('automation.audit')
      .warn(
        'Не удалось записать запись аудита «' +
          entry.action +
          '»: ' +
          (err instanceof Error ? err.message : String(err)),
      );
  }
}

/** Recorder for one pass: the same (action, dealId, reason) is logged only once. */
export function auditPass(ctx: Context): AuditPass {
  const seen = new Set<string>();
  return {
    record: (entry: AutomationAuditEntry): void => {
      auditSafely(ctx, entry, seen);
    },
  };
}

/** Recorder for an event that cannot repeat inside a pass. */
export function auditOnce(ctx: Context, entry: AutomationAuditEntry): void {
  auditSafely(ctx, entry);
}
