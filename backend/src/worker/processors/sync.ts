import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export const syncHandler: JobHandler<JobPayloads['SYNC']> = async () => {
  throw new NotImplementedError('SYNC')
}
