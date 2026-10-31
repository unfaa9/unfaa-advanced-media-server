import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Not env(): that throws when the variable is unset, which would break `prisma generate` in
  // postinstall on machines without a database URL. Migrate commands still fail without one.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
