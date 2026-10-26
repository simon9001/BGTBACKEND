import path from 'node:path';
import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Application logger (pino).
 *
 * Every log line is structured JSON with a timestamp, level and a `channel`
 * that says what kind of event it is:
 *
 *   http      one line per request: method, route, status, duration, user, IP
 *   security  logins, failed logins, rejected tokens, permission denials
 *   audit     every create / update / delete of business data
 *   db        database connection events
 *   app       startup, shutdown, unexpected errors
 *
 * Output goes to two places:
 *   - the console (pretty-printed in development, JSON otherwise)
 *   - daily rotating files: <LOG_DIR>/app.YYYY-MM-DD.N.log, kept for
 *     LOG_RETENTION_DAYS days
 *
 * Finding things in the files (one JSON object per line), e.g. in PowerShell:
 *   Select-String -Path logs\*.log -Pattern '"channel":"security"'
 *   Select-String -Path logs\*.log -Pattern '"request_id":"<id from an error response>"'
 */

const isDevelopment = env.NODE_ENV === 'development';

const transport = pino.transport({
    targets: [
        isDevelopment
            ? {
                  target: 'pino-pretty',
                  level: env.LOG_LEVEL,
                  options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', ignore: 'pid,hostname,service' },
              }
            : { target: 'pino/file', level: env.LOG_LEVEL, options: { destination: 1 } }, // stdout
        {
            target: 'pino-roll',
            level: env.LOG_LEVEL,
            options: {
                file: path.resolve(env.LOG_DIR, 'app'),
                frequency: 'daily',
                dateFormat: 'yyyy-MM-dd',
                mkdir: true,
                limit: { count: env.LOG_RETENTION_DAYS },
            },
        },
    ],
});

export const logger = pino(
    {
        level: env.LOG_LEVEL,
        base: { service: 'bgttracker-api' },
        timestamp: pino.stdTimeFunctions.isoTime,
        // Readable level next to pino's numeric one, e.g. "level_name":"warn"
        mixin: (_context, level) => ({ level_name: pino.levels.labels[level] }),
        // Never write secrets to the logs, even if someone logs a whole object
        redact: {
            paths: [
                'password', 'new_password', 'current_password', 'password_hash', 'token',
                '*.password', '*.new_password', '*.current_password', '*.password_hash', '*.token',
                'headers.authorization', '*.headers.authorization',
            ],
            censor: '[REDACTED]',
        },
    },
    transport,
);

// One child logger per channel (see the list above)
export const httpLogger = logger.child({ channel: 'http' });
export const securityLogger = logger.child({ channel: 'security' });
export const auditLogger = logger.child({ channel: 'audit' });
export const dbLogger = logger.child({ channel: 'db' });
export const appLogger = logger.child({ channel: 'app' });
