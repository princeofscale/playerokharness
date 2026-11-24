import type { BotConfig } from '../schemas/settings.js';

export function parseDayTime(text: string): string | null {
  const clean = (text || '').trim();
  const sepMatch = clean.match(/^(\d{1,2})\s*[:.,-]\s*(\d{1,2})$/);
  let hours: number;
  let minutes: number;

  if (sepMatch) {
    hours = Number(sepMatch[1]);
    minutes = Number(sepMatch[2]);
  } else if (/^\d{3,4}$/.test(clean)) {
    hours = Number(clean.slice(0, -2));
    minutes = Number(clean.slice(-2));
  } else if (/^\d{1,2}$/.test(clean)) {
    hours = Number(clean);
    minutes = 0;
  } else {
    return null;
  }

  if (hours > 23 || minutes > 59 || hours < 0 || minutes < 0) {
    return null;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function formatHM(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function isNightTime(timeFrom: string, timeTo: string, now: Date = new Date()): boolean {
  const start = parseDayTime(timeFrom);
  const end = parseDayTime(timeTo);
  if (!start || !end || start === end) {
    return false;
  }
  const current = formatHM(now);
  if (start < end) {
    return start <= current && current < end;
  }
  return current >= start || current < end;
}

export function getNextDayTime(timeStr: string, now: Date = new Date()): Date | null {
  const parsed = parseDayTime(timeStr);
  if (!parsed) return null;

  const [hours, minutes] = parsed.split(':').map(Number);
  const next = new Date(now.getTime());
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export function isBumpNightNow(config: BotConfig, now: Date = new Date()): boolean {
  const night = config.playerok.auto_bump_items.night;
  return Boolean(night.enabled) && isNightTime(night.time_from, night.time_to, now);
}

export function getCurrentBumpInterval(config: BotConfig, now: Date = new Date()): number {
  if (isBumpNightNow(config, now)) {
    return config.playerok.auto_bump_items.night.interval || 0;
  }
  return config.playerok.auto_bump_items.interval || 0;
}

export function getCurrentBumpPosition(config: BotConfig, now: Date = new Date()): number {
  if (isBumpNightNow(config, now)) {
    return config.playerok.auto_bump_items.night.position || 0;
  }
  return config.playerok.auto_bump_items.position || 0;
}

export function getBumpNextSwitch(config: BotConfig, now: Date): Date | null {
  const night = config.playerok.auto_bump_items.night;
  if (!night.enabled) return null;
  return isBumpNightNow(config, now)
    ? getNextDayTime(night.time_to, now)
    : getNextDayTime(night.time_from, now);
}

export function getBumpNextTime(config: BotConfig, lastTimeIso: string, now: Date = new Date()): Date | null {
  const lastMs = lastTimeIso ? Date.parse(lastTimeIso) : 0;
  let cursor = new Date(now.getTime());

  for (let i = 0; i < 1000; i++) {
    const interval = getCurrentBumpInterval(config, cursor);
    const due = interval
      ? new Date(Math.max(lastMs + interval * 1000, cursor.getTime()))
      : null;
    const sw = getBumpNextSwitch(config, cursor);

    if (due && (!sw || due.getTime() < sw.getTime())) {
      return due;
    }
    if (!sw) return null;
    cursor = sw;
  }
  return null;
}

export function isDue(lastTimeIso: string | undefined | null, intervalSec: number, now: Date = new Date()): boolean {
  if (!lastTimeIso) return true;
  const parsed = Date.parse(lastTimeIso);
  if (Number.isNaN(parsed)) return true;
  return now.getTime() >= parsed + intervalSec * 1000;
}
