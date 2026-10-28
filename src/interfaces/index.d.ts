/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { TAuthenticatedKey } from '../lib/auth/apiKeys';

declare global {
  namespace Express {
    interface Request {
      id: string;
      apiKey?: TAuthenticatedKey;
    }
  }
}
