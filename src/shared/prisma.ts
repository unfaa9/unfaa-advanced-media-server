import { PrismaPg } from '@prisma/adapter-pg';
import config from '../config';
import { PrismaClient } from '../generated/prisma/client';

// pg has no connection timeout by default and drops idle connections after 10 s. These are the
// values Prisma documents for keeping the behaviour of its previous built-in pool.
const adapter = new PrismaPg({
  connectionString: config.database_url,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
});

const prisma = new PrismaClient({ adapter });

export default prisma;
