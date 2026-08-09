import type { UpdateStatus } from '../../shared/update'
import type { UpdateStrategy } from './strategy'

// Private Research Agent builds are updated manually. Keeping the disabled behavior behind the
// existing strategy contract lets the renderer and IPC retain one stable API while guaranteeing that
// no startup check, user action, or scheduler tick reaches AIPOCH's public update infrastructure.
export class DisabledUpdateStrategy implements UpdateStrategy {
  private readonly status: UpdateStatus

  constructor(currentVersion: string) {
    this.status = { state: 'disabled', current: currentVersion }
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  async check(): Promise<UpdateStatus> {
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    return this.status
  }

  async cancel(): Promise<UpdateStatus> {
    return this.status
  }

  async apply(): Promise<UpdateStatus> {
    return this.status
  }
}
