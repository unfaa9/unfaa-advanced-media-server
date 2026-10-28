import { NextFunction, Request, Response } from 'express';
import config from '../../config';
import ProblemError from '../../errors/ProblemError';
import { TScope, verifyKey } from '../../lib/auth/apiKeys';
import { TokenBuckets } from '../../lib/auth/tokenBucket';
import { clientIp } from '../../lib/net/clientIp';

// Per key: RATE_LIMIT_RPS with a burst of 2×. Failed auth per IP: burst 30, then 1/s.
const keyBuckets = new TokenBuckets(
  config.upload.rateLimitRps,
  config.upload.rateLimitRps * 2
);
const failedAuthBuckets = new TokenBuckets(1, 30);

const rateLimited = (retryAfter: number, detail: string) =>
  new ProblemError('rate_limited', detail, {
    'Retry-After': String(retryAfter),
  });

export const apiKeyAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const ip = clientIp(req);
    const blocked = failedAuthBuckets.blockedFor(ip);
    if (blocked) {
      throw rateLimited(blocked, 'too many failed API-key attempts');
    }

    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const key = match ? await verifyKey(match[1]) : null;
    if (!key) {
      failedAuthBuckets.take(ip);
      throw new ProblemError('unauthorized', 'missing or invalid API key');
    }

    const wait = keyBuckets.take(key.id);
    if (wait) throw rateLimited(wait, 'rate limit exceeded');

    req.apiKey = key;
    next();
  } catch (e) {
    next(e);
  }
};

export const requireScope =
  (scope: TScope) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.apiKey?.scopes.includes(scope)) {
      return next(
        new ProblemError('forbidden_scope', `API key lacks scope ${scope}`)
      );
    }
    next();
  };
