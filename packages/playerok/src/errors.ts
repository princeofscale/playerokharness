export class PlayerokError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayerokError';
  }
}

export class UnauthorizedError extends PlayerokError {
  constructor(message = 'Сессия PlayerOK не авторизована или истекла') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class BotCheckDetectedError extends PlayerokError {
  constructor(
    message = 'PlayerOK вернул антибот-проверку (Cloudflare/DDoS-Guard). Автоматический обход не выполняется; обновите сессию или проверьте доступность.',
  ) {
    super(message);
    this.name = 'BotCheckDetectedError';
  }
}

export class RequestFailedError extends PlayerokError {
  public readonly statusCode: number;
  public readonly responseBody?: string;

  constructor(statusCode: number, message: string, responseBody?: string) {
    super(message);
    this.name = 'RequestFailedError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class AccountBlockedError extends PlayerokError {
  public readonly reason?: string | null;

  constructor(reason?: string | null) {
    super(`Аккаунт PlayerOK заблокирован${reason ? `: ${reason}` : ''}`);
    this.name = 'AccountBlockedError';
    this.reason = reason;
  }
}
