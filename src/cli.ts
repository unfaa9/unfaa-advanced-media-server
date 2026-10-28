/* eslint-disable no-console */
import { Command, InvalidArgumentError } from 'commander';
import { purgeFile } from './app/modules/files/files.service';
import { reconcile } from './jobs/reconcile';
import { createKey, SCOPES, TScope } from './lib/auth/apiKeys';
import { isValidId } from './lib/storage/layout';
import { ensureDirs } from './lib/storage/localStorage';
import prisma from './shared/prisma';

// Admin CLI: node dist/cli.js admin <command>   (dev: npx ts-node src/cli.ts admin ...)

const parseScopes = (value: string): TScope[] => {
  const scopes = value.split(',').map(s => s.trim());
  const bad = scopes.filter(s => !(SCOPES as readonly string[]).includes(s));
  if (bad.length) {
    throw new InvalidArgumentError(
      `unknown scope(s) ${bad.join(', ')}; valid: ${SCOPES.join(', ')}`
    );
  }
  return scopes as TScope[];
};

const parseDuration = (value: string): Date => {
  const m = /^(\d+)([hd])$/.exec(value);
  if (!m) throw new InvalidArgumentError('use e.g. 365d or 48h');
  const ms = Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
  return new Date(Date.now() + ms);
};

const uuid = (value: string): string => {
  if (!isValidId(value)) throw new InvalidArgumentError('not a file id');
  return value;
};

const program = new Command('media-server');
const admin = program.command('admin');
const key = admin.command('key').description('manage API keys');

key
  .command('create')
  .requiredOption('--name <name>', 'e.g. backend-prod')
  .option('--scopes <list>', 'comma-separated scopes', parseScopes, [...SCOPES])
  .option('--expires <duration>', 'e.g. 365d', parseDuration)
  .action(async opts => {
    const { id, key: secret } = await createKey({
      name: opts.name,
      scopes: opts.scopes,
      expiresAt: opts.expires,
    });
    console.log(`id:     ${id}`);
    console.log(`scopes: ${opts.scopes.join(',')}`);
    console.log(`key:    ${secret}`);
    console.log('\nStore this key now: it is shown only once.');
  });

key.command('list').action(async () => {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'asc' } });
  console.table(
    keys.map(k => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes.join(','),
      last_used: k.lastUsedAt?.toISOString() ?? '',
      expires: k.expiresAt?.toISOString() ?? '',
      revoked: k.revokedAt?.toISOString() ?? '',
    }))
  );
});

key
  .command('revoke')
  .requiredOption('--id <uuid>')
  .action(async opts => {
    const { count } = await prisma.apiKey.updateMany({
      where: { id: opts.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.log(
      count ? 'revoked (effective within 60 s)' : 'no such active key'
    );
  });

admin
  .command('file')
  .description('emergency operations on one file')
  .command('purge')
  .requiredOption('--id <uuid>', 'file id', uuid)
  .action(async opts => {
    await ensureDirs();
    const done = await purgeFile(opts.id);
    console.log(
      done
        ? 'purged; CDN purge queued (browsers may keep a copy ≤ 7 days)'
        : 'already purged or not found'
    );
  });

admin
  .command('reconcile')
  .option('--dry-run', 'report only')
  .action(async opts => {
    const report = await reconcile({ dryRun: !!opts.dryRun });
    console.log(JSON.stringify(report, null, 2));
  });

program
  .parseAsync()
  .catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
