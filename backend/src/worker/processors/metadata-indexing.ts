import type { JobPayloads } from '../../queues/job-types.js'
import { NotImplementedError } from '../errors.js'
import type { JobHandler } from '../types.js'

export const metadataIndexingHandler: JobHandler<JobPayloads['METADATA_INDEXING']> = async () => {
  throw new NotImplementedError('METADATA_INDEXING')
}
