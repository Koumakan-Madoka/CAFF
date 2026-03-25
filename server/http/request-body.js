const { DEFAULT_BODY_LIMIT } = require('../app/config');
const { createHttpError } = require('./http-errors');

function readRequestJson(req, options = {}) {
  const bodyLimit =
    Number.isFinite(options.bodyLimit) && options.bodyLimit > 0 ? options.bodyLimit : DEFAULT_BODY_LIMIT;

  return new Promise((resolve, reject) => {
    let body = '';
    let bodyLimitExceeded = false;

    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      if (bodyLimitExceeded) {
        return;
      }

      body += chunk;

      if (body.length > bodyLimit) {
        bodyLimitExceeded = true;
        reject(createHttpError(413, 'Request body is too large'));
        req.resume();
      }
    });

    req.on('end', () => {
      if (bodyLimitExceeded) {
        return;
      }

      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(createHttpError(400, 'Invalid JSON body'));
      }
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

module.exports = {
  readRequestJson,
};
