import { prisma } from '../config/prisma.js'
import { getAppConnection, trackConnection } from './connection.js'
import { isJobType } from './job-types.js'
import { markCancelled } from './mirror.js'
import { logger } from './logger.js'
import { getQueue, queueNameForType } from './queues.js'

export const CANCEL_CHANNEL = '9drive:job:cancel'

const CANCELABLE_STATES = new Set(['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children'])

export function cancelMarkerKey(jobId: string): string {
  return `9drive:job:${jobId}:cancel`
}

export async function requestJobCancel(jobId: string): Promise<{ removed: boolean }> {
  const connection = getAppConnection()
  await connection.set(cancelMarkerKey(jobId), '1', 'EX', 3_600)
  const row = await prisma.job.findUnique({
    where: { id: jobId },
    select: { type: true, bullJobId: true },
  })
  if (row?.bullJobId && isJobType(row.type)) {
    const bullJob = await getQueue(queueNameForType(row.type)).getJob(row.bullJobId)
    if (bullJob) {
      const state = await bullJob.getState()
      if (CANCELABLE_STATES.has(state)) {
        await bullJob.remove()
        await markCancelled(jobId, 'cancelled while queued')
        await connection.publish(CANCEL_CHANNEL, jobId)
        return { removed: true }
      }
    }
  }
  await connection.publish(CANCEL_CHANNEL, jobId)
  return { removed: false }
}

export async function isCancelRequested(jobId: string): Promise<boolean> {
  const exists = await getAppConnection().exists(cancelMarkerKey(jobId))
  return exists === 1
}

export function subscribeJobCancel(handler: (jobId: string) => void | Promise<void>): () => Promise<void> {
  const subscriber = trackConnection(getAppConnection().duplicate())
  const onMessage = (_channel: string, message: string) => {
    void Promise.resolve(handler(message)).catch((error: unknown) => {
      logger.error('job cancel handler failed', { jobId: message, error: (error as Error).message })
    })
  }
  subscriber.on('message', onMessage)
  void subscriber.subscribe(CANCEL_CHANNEL).catch((error: unknown) => {
    logger.error('job cancel subscription failed', { error: (error as Error).message })
  })
  return async () => {
    subscriber.off('message', onMessage)
    try {
      await subscriber.unsubscribe(CANCEL_CHANNEL)
    } catch {
      return
    }
    try {
      await subscriber.quit()
    } catch {
      subscriber.disconnect()
    }
  }
}
