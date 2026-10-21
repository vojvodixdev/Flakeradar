export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, 'not_found');
export const unauthorized = (message = 'Missing or invalid token') => new HttpError(401, message, 'unauthorized');
