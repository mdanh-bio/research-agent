import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { CreateSideQuestionRecord, SideQuestionRepository } from './side-question-repository'
import {
  validatePersistedSideQuestion,
  type PersistedSideQuestion
} from '../../shared/side-question'

export class SessionSideQuestionRepository implements SideQuestionRepository {
  constructor(private readonly sessions: SessionPersistenceCoordinator) {}

  create(input: CreateSideQuestionRecord): Promise<PersistedSideQuestion> {
    return this.sessions.createSideQuestionCard({
      card: validatePersistedSideQuestion({
        ...input,
        lifecycle: input.lifecycle ?? 'preparing',
        updatedAt: input.createdAt
      })
    })
  }

  get(
    projectId: string,
    sessionId: string,
    id: string
  ): Promise<PersistedSideQuestion | undefined> {
    return this.sessions.getSideQuestionCard(projectId, sessionId, id)
  }

  listForSession(projectId: string, sessionId: string): Promise<readonly PersistedSideQuestion[]> {
    return this.sessions.listSideQuestionCards(projectId, sessionId)
  }

  transition(
    projectId: string,
    sessionId: string,
    id: string,
    lifecycle: Parameters<SideQuestionRepository['transition']>[3],
    update: Parameters<SideQuestionRepository['transition']>[4] = {}
  ): Promise<PersistedSideQuestion> {
    return this.sessions.transitionSideQuestionCard({
      projectId,
      sessionId,
      sideQuestionId: id,
      lifecycle,
      update
    })
  }
}
