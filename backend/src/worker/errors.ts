import { UnrecoverableError } from 'bullmq'

export class NotImplementedError extends UnrecoverableError {
  constructor(jobType: string) {
    super(`NOT_IMPLEMENTED: ${jobType} processor is not implemented yet (job-contract.md §2)`)
    this.name = 'NotImplementedError'
  }
}

export class PermanentJobError extends UnrecoverableError {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}

export class JobCancelledError extends UnrecoverableError {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`)
    this.name = 'JobCancelledError'
  }
}
