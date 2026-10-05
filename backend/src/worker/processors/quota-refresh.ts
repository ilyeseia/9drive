import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export const quotaRefreshHandler: JobHandler<JobPayloads['QUOTA_REFRESH']> = async () => {
  throw new NotImplementedError('QUOTA_REFRESH')
}
