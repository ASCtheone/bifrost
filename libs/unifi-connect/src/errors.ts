export class UniFiApiError extends Error {
  readonly statusCode: number;
  readonly apiMessage?: string;

  constructor(statusCode: number, message: string, apiMessage?: string) {
    super(message);
    this.name = "UniFiApiError";
    this.statusCode = statusCode;
    this.apiMessage = apiMessage;
  }
}

export class AuthError extends UniFiApiError {
  constructor(message: string, apiMessage?: string) {
    super(401, message, apiMessage);
    this.name = "AuthError";
  }
}

export class NetworkError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class NotFoundError extends UniFiApiError {
  constructor(resource: string, id: string) {
    super(404, `${resource} not found: ${id}`);
    this.name = "NotFoundError";
  }
}
