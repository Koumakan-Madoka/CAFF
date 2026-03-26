export type HttpError = Error & { statusCode: number } & Record<string, unknown>;

export function createHttpError(
  statusCode: number,
  message: string,
  details: Record<string, unknown> = {}
): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}
