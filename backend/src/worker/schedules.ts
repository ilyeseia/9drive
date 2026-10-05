import type { JobType } from '../queues/job-types.js'
import { JOB_DEFINITIONS, getQueue, queueNameForType } from '../queues/queues.js'
import { logger } from '../queues/logger.js'

export interface ScheduleRegistration {
  id: string
  type: JobType
  everyMs: number
}

export function collectSchedules(): ScheduleRegistration[] {
  const registrations: ScheduleRegistration[] = []
  for (const definition of Object.values(JOB_DEFINITIONS)) {
    for (const schedule of definition.schedules ?? []) {
      registrations.push({ id: schedule.id, type: definition.type, everyMs: schedule.everyMs })
    }
  }
  return registrations
}

export async function registerSchedules(): Promise<ScheduleRegistration[]> {
  const registered: ScheduleRegistration[] = []
  for (const schedule of collectSchedules()) {
    const definition = JOB_DEFINITIONS[schedule.type]
    const payload = definition.schedules?.find((entry) => entry.id === schedule.id)?.payload
    await getQueue(queueNameForType(schedule.type)).upsertJobScheduler(
      schedule.id,
      { every: schedule.everyMs },
      { name: schedule.type, data: payload },
    )
    registered.push(schedule)
  }
  logger.info('schedules registered', {
    count: registered.length,
    ids: registered.map((entry) => entry.id),
  })
  return registered
}

export async function removeSchedules(): Promise<void> {
  for (const schedule of collectSchedules()) {
    try {
      await getQueue(queueNameForType(schedule.type)).removeJobScheduler(schedule.id)
    } catch (error) {
      logger.warn('failed to remove schedule', { id: schedule.id, error: (error as Error).message })
    }
  }
}
