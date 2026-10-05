import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export const uploadHandler: JobHandler<JobPayloads['UPLOAD']> = async () => {
  throw new NotImplementedError('UPLOAD')
}
