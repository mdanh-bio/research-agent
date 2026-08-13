import { type PersistedSideQuestion, type SideQuestionLifecycle } from '../../shared/side-question'

export type CreateSideQuestionRecord = Omit<
  PersistedSideQuestion,
  'lifecycle' | 'updatedAt' | 'completedAt'
> & { lifecycle?: Extract<SideQuestionLifecycle, 'preparing'> }

export type SideQuestionRepository = Readonly<{
  create(input: CreateSideQuestionRecord): Promise<PersistedSideQuestion>
  get(projectId: string, sessionId: string, id: string): Promise<PersistedSideQuestion | undefined>
  listForSession(projectId: string, sessionId: string): Promise<readonly PersistedSideQuestion[]>
  transition(
    projectId: string,
    sessionId: string,
    id: string,
    lifecycle: SideQuestionLifecycle,
    update?: Readonly<{
      answer?: string
      answerTruncated?: boolean
      safeFailureCode?: string
      runtimeSessionId?: string
      runtimeThreadId?: string
      model?: string
      modelProvider?: string
      runtimeLinkClosed?: boolean
      runtimeDisposed?: boolean
      completedAt?: number
    }>
  ): Promise<PersistedSideQuestion>
}>
