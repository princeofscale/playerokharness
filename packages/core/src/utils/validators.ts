const COMMON_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', 'password', 'qwerty',
  'admin', '123123', '111111', 'abc123', 'letmein', 'welcome',
  'monkey', 'login', 'root', 'pass', 'test', '000000', 'user',
  'qwerty123', 'iloveyou',
]);

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function stripHtml(text: string): string {
  return String(text ?? '').replace(/<[^>]+>/g, '');
}

export function isCookiesValid(cookieStr: string): boolean {
  if (!cookieStr || !cookieStr.includes('=')) return false;
  const parts = cookieStr.split(';');
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) return false;
  }
  return true;
}

export function parseCookieString(cookieStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of cookieStr.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      if (key) result[key] = val;
    }
  }
  return result;
}

export function isUserAgentValid(ua: string): boolean {
  if (!ua || ua.length < 10 || ua.length > 512) return false;
  return /^[\x20-\x7E]+$/.test(ua);
}

export function isProxyValid(proxy: string): boolean {
  const ip = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)';
  const ipPort = new RegExp(`^${ip}\\.${ip}\\.${ip}\\.${ip}:(\\d+)$`);
  const authIpPort = new RegExp(`^[^:@]+:[^:@]+@${ip}\\.${ip}\\.${ip}\\.${ip}:(\\d+)$`);
  const match = proxy.match(ipPort) || proxy.match(authIpPort);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

export function isTgTokenValid(token: string): boolean {
  return /^\d{7,12}:[A-Za-z0-9_-]{35}$/.test(token);
}

export function normalizeCustomApiUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const withProto = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;
  return withProto.replace(/\/+$/, '');
}

export function isPasswordValid(password: string): boolean {
  if (password.length < 6 || password.length > 64) return false;
  return !COMMON_PASSWORDS.has(password.toLowerCase());
}

export function maskProxy(proxy: string): string {
  if (!proxy) return '';
  let user = '';
  let hostPort = proxy;
  if (proxy.includes('@')) {
    const [auth, hp] = proxy.split('@');
    user = auth.split(':')[0] || '';
    hostPort = hp || '';
  }
  const [ip = '', port = ''] = hostPort.split(':');
  const maskedIp = ip
    .split('.')
    .map((part, idx) => (idx >= 2 ? '*'.repeat(part.length) : part))
    .join('.');
  const maskedPort = port.length > 3 ? `${port.slice(0, 3)}**` : port;
  return `${maskedIp}:${maskedPort}${user ? ` (user ${user.slice(0, 3)}*****)` : ''}`;
}
