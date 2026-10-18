/**
 * Re-encrypts stored credentials from an old TOKEN_ENCRYPTION_KEY to a new one.
 *
 *   OLD_TOKEN_ENCRYPTION_KEY=... NEW_TOKEN_ENCRYPTION_KEY=... npm run credentials:reencrypt            # dry run
 *   OLD_TOKEN_ENCRYPTION_KEY=... NEW_TOKEN_ENCRYPTION_KEY=... npm run credentials:reencrypt -- --apply # write
 *
 * Keys come from the environment only (never argv, never printed). Take a database backup first, run the dry run, and
 * only switch the application's TOKEN_ENCRYPTION_KEY to the new value after `--apply` reports 0 undecryptable values.
 */
import { prisma } from '../config/prisma.js'
import { rotateEncryptionKey } from '../utils/key-rotation.js'

async function main() {
  const apply = process.argv.includes('--apply')
  const report = await rotateEncryptionKey(prisma, {
    oldSecret: process.env.OLD_TOKEN_ENCRYPTION_KEY ?? '',
    newSecret: process.env.NEW_TOKEN_ENCRYPTION_KEY ?? '',
    apply,
  })
  console.log(JSON.stringify(report, null, 2))
  if (report.totalUndecryptable > 0) {
    console.error('Some values could not be decrypted with either key; do NOT switch the application key.')
    process.exitCode = 2
  } else if (!apply) {
    console.log('Dry run only. Re-run with --apply to write.')
  }
}

main()
  .catch((error) => {
    console.error('re-encryption failed:', error instanceof Error ? error.message : 'unknown error')
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
