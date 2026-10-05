import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export const healthCheckHandler: JobHandler<JobPayloads['HEALTH_CHECK']> = async () => {
  throw new NotImplementedError('HEALTH_CHECK')
}
