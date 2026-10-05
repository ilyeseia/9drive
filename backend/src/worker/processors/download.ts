import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export const downloadHandler: JobHandler<JobPayloads['DOWNLOAD']> = async () => {
  throw new NotImplementedError('DOWNLOAD')
}
