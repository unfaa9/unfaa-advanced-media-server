import pino from 'pino';
import config from '../config';

// JSON logs. Credentials and query strings (idempotency keys, etc.) are never logged.
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["idempotency-key"]',
    ],
    remove: true,
  },
});

export default logger;
