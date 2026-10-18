import type { ProviderContext, StorageProvider } from '../../providers/types.js'

export type CompensationOutcome = 'deleted' | 'unsupported' | 'failed'

/**
 * Runs `record` (the database write for an object that was just uploaded). If it throws, the remote object would be
 * left behind with no database row pointing at it, so a best-effort permanent delete is attempted before the original
 * error is rethrown. The outcome is reported to `onCompensate` (for logging) and never masks the original error.
 */
export async function recordWithCompensation<T>(
  provider: Pick<StorageProvider, 'capabilities' | 'delete'>,
  ctx: ProviderContext,
  remoteId: string,
  record: () => Promise<T>,
  onCompensate?: (outcome: CompensationOutcome, error?: unknown) => void,
): Promise<T> {
  try {
    return await record()
  } catch (recordError) {
    if (!provider.capabilities.has('delete')) {
      onCompensate?.('unsupported')
    } else {
      try {
        await provider.delete(ctx, { remoteId, permanent: true })
        onCompensate?.('deleted')
      } catch (deleteError) {
        onCompensate?.('failed', deleteError)
      }
    }
    throw recordError
  }
}
