import { Context, Service } from 'cordis';
import type { GitHubRelease } from '../types/models.js';

export interface UpdaterConfig {
  repo?: string;
  currentVersion: string;
  checkIntervalMs?: number;
  enableTimer?: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export function compareVersions(a: string, b: string): number {
  const clean = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = clean(a);
  const pb = clean(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export class UpdaterService extends Service {
  static provide = 'updater';
  static inject = ['storage'];

  public readonly repo: string;
  public readonly currentVersion: string;
  public latestRelease: GitHubRelease | null = null;

  private readonly log;
  private cachedReleases: GitHubRelease[] = [];
  private cachedAt = 0;
  private notifiedTag: string | null = null;

  constructor(ctx: Context, config: UpdaterConfig) {
    super(ctx, 'updater');
    this.log = ctx.logger('updater');
    this.repo = config.repo ?? 'alleexxeeyy/playerok-universal';
    this.currentVersion = config.currentVersion;

    if (config.enableTimer !== false) {
      const interval = config.checkIntervalMs ?? 30 * 60 * 1000;
      ctx.effect(() => {
        const timer = setInterval(() => {
          void this.checkAndNotify();
        }, interval);
        timer.unref?.();
        return () => clearInterval(timer);
      }, 'updater:checkTimer');
    }
  }

  public async getReleases(force = false): Promise<GitHubRelease[]> {
    if (!force && this.cachedReleases.length > 0 && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedReleases;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const resp = await fetch(`https://api.github.com/repos/${this.repo}/releases?per_page=10`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `PlayerokUniversal/${this.currentVersion}`,
        },
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`GitHub API HTTP ${resp.status}`);
      }
      const raw = (await resp.json()) as Array<Record<string, unknown>>;
      const releases: GitHubRelease[] = raw
        .filter((r) => typeof r.tag_name === 'string')
        .map((r) => ({
          tagName: String(r.tag_name),
          name: String(r.name || r.tag_name),
          body: String(r.body || ''),
          htmlUrl: String(r.html_url || ''),
          publishedAt: String(r.published_at || ''),
          zipballUrl: typeof r.zipball_url === 'string' ? r.zipball_url : undefined,
        }));

      this.cachedReleases = releases;
      this.cachedAt = Date.now();
      this.latestRelease = this.pickLatest(releases);
      return releases;
    } finally {
      clearTimeout(timer);
    }
  }

  public pickLatest(releases: GitHubRelease[]): GitHubRelease | null {
    let best: GitHubRelease | null = null;
    for (const rel of releases) {
      if (!best || compareVersions(rel.tagName, best.tagName) > 0) {
        best = rel;
      }
    }
    return best;
  }

  public hasNewerRelease(): boolean {
    if (!this.latestRelease) return false;
    return compareVersions(this.latestRelease.tagName, this.currentVersion) > 0;
  }

  public async checkAndNotify(): Promise<GitHubRelease | null> {
    try {
      await this.getReleases(true);
      if (this.latestRelease && this.hasNewerRelease()) {
        const cfg = this.ctx.storage.getConfig().updates;
        if (cfg.notify && this.notifiedTag !== this.latestRelease.tagName) {
          this.notifiedTag = this.latestRelease.tagName;
          await this.ctx.parallel('update/available', this.latestRelease);
        }
        return this.latestRelease;
      }
      return null;
    } catch (err) {
      this.log.debug(`Не удалось проверить обновления: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
