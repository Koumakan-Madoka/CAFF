function createHttpError(statusCode, message, details = {}) {
  const error = /** @type {Error & { statusCode: number } & Record<string, any>} */ (new Error(message));
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

module.exports = {
  createHttpError,
};
