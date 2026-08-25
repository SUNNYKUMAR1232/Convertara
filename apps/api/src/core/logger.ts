import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config().LOG_LEVEL,
  base: { service: 'convertara-api' },
  redact: {
    paths: ['req.headers.authorization', 'apiKey', '*.apiKey', 'api_key', '*.api_key'],
    censor: '[redacted]',
  },
});

export type Logger = pino.Logger;
