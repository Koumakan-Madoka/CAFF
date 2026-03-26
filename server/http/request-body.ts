import type { Readable } from 'node:stream';

import config = require('../app/config');
import { createHttpError } from './http-errors';

export type ReadRequestJsonOptions = {
  bodyLimit?: number;
};

export function readRequestJson(req: Readable, options: ReadRequestJsonOptions = {}): Promise<any> {
  const providedBodyLimit = options.bodyLimit;
  const bodyLimit =
    typeof providedBodyLimit === 'number' && Number.isFinite(providedBodyLimit) && providedBodyLimit > 0
      ? providedBodyLimit
      : config.DEFAULT_BODY_LIMIT;

  return new Promise<any>((resolve, reject) => {
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
