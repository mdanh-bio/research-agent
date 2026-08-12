import type { PrismaClient } from '@prisma/client'

type RuntimeThreadLinkDelegate = PrismaClient['runtimeThreadLink']

export type CodexRuntimeThreadLink = Readonly<{
  id: string
  agentRunId: string
  appSessionId: string
  backend: 'codex'
  runtimeThreadId: string
  parentRuntimeThreadId?: string
  ephemeral: boolean
  runtimeOwner: 'codex_app_server'
  authorizedCwd: string
  sandbox: 'read-only' | 'workspace-write'
  model: string
  modelProvider: string
  approvalPolicy: 'on-request'
  approvalsReviewer: 'user'
  createdAt: number
  closedAt?: number
}>

export interface CodexRuntimeThreadLinkStore {
  listActive(): Promise<readonly CodexRuntimeThreadLink[]>
  findActiveByAppSessionId(appSessionId: string): Promise<CodexRuntimeThreadLink | undefined>
  save(link: CodexRuntimeThreadLink): Promise<void>
  close(runtimeThreadId: string, closedAt?: number): Promise<void>
}

const assertIdentifier = (value: string, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${label} must be a non-empty bounded identifier.`)
  }
  return value
}

const assertTimestamp = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
  return value
}

const assertPath = (value: string, label: string): string => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4_096 ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`${label} must be a non-empty bounded path.`)
  }
  return value
}

export const validateCodexRuntimeThreadLink = (
  value: CodexRuntimeThreadLink
): CodexRuntimeThreadLink => {
  if (!value || typeof value !== 'object')
    throw new Error('Codex runtime thread link must be an object.')
  assertIdentifier(value.id, 'Runtime thread link id')
  assertIdentifier(value.agentRunId, 'Runtime thread link Agent Run id')
  assertIdentifier(value.appSessionId, 'Runtime thread link Session id')
  if (value.backend !== 'codex') throw new Error('Runtime thread link backend is not Codex.')
  assertIdentifier(value.runtimeThreadId, 'Runtime thread id')
  if (value.parentRuntimeThreadId !== undefined) {
    assertIdentifier(value.parentRuntimeThreadId, 'Parent runtime thread id')
    if (value.parentRuntimeThreadId === value.runtimeThreadId) {
      throw new Error('Runtime thread link cannot be its own parent.')
    }
  }
  if (typeof value.ephemeral !== 'boolean') {
    throw new Error('Runtime thread link ephemeral flag is invalid.')
  }
  if (value.runtimeOwner !== 'codex_app_server') {
    throw new Error('Runtime thread link owner is not direct Codex app-server.')
  }
  assertPath(value.authorizedCwd, 'Runtime thread link authorized cwd')
  if (value.sandbox !== 'read-only' && value.sandbox !== 'workspace-write') {
    throw new Error('Runtime thread link sandbox is invalid.')
  }
  assertIdentifier(value.model, 'Runtime thread link model')
  assertIdentifier(value.modelProvider, 'Runtime thread link model provider')
  if (value.approvalPolicy !== 'on-request') {
    throw new Error('Runtime thread link approval policy is invalid.')
  }
  if (value.approvalsReviewer !== 'user') {
    throw new Error('Runtime thread link approval reviewer is invalid.')
  }
  assertTimestamp(value.createdAt, 'Runtime thread link createdAt')
  if (value.closedAt !== undefined) assertTimestamp(value.closedAt, 'Runtime thread link closedAt')
  return Object.freeze({ ...value })
}

const rowToLink = (row: {
  id: string
  agentRunId: string
  appSessionId: string
  backend: string
  runtimeThreadId: string
  parentRuntimeThreadId: string | null
  ephemeral: boolean
  runtimeOwner: string | null
  authorizedCwd: string | null
  sandbox: string | null
  model: string | null
  modelProvider: string | null
  approvalPolicy: string | null
  approvalsReviewer: string | null
  createdAt: Date
  closedAt: Date | null
}): CodexRuntimeThreadLink =>
  validateCodexRuntimeThreadLink({
    id: row.id,
    agentRunId: row.agentRunId,
    appSessionId: row.appSessionId,
    backend: row.backend as 'codex',
    runtimeThreadId: row.runtimeThreadId,
    ...(row.parentRuntimeThreadId ? { parentRuntimeThreadId: row.parentRuntimeThreadId } : {}),
    ephemeral: row.ephemeral,
    runtimeOwner: row.runtimeOwner as 'codex_app_server',
    authorizedCwd: row.authorizedCwd ?? '',
    sandbox: row.sandbox as 'read-only' | 'workspace-write',
    model: row.model ?? '',
    modelProvider: row.modelProvider ?? '',
    approvalPolicy: row.approvalPolicy as 'on-request',
    approvalsReviewer: row.approvalsReviewer as 'user',
    createdAt: row.createdAt.getTime(),
    ...(row.closedAt ? { closedAt: row.closedAt.getTime() } : {})
  })

const assertUniqueActiveLinks = (links: readonly CodexRuntimeThreadLink[]): void => {
  const threads = new Set<string>()
  const sessions = new Set<string>()
  for (const link of links) {
    if (threads.has(link.runtimeThreadId)) {
      throw new Error(`Duplicate active Codex runtime thread link: ${link.runtimeThreadId}`)
    }
    if (sessions.has(link.appSessionId)) {
      throw new Error(`Duplicate active Codex runtime Session link: ${link.appSessionId}`)
    }
    threads.add(link.runtimeThreadId)
    sessions.add(link.appSessionId)
  }
}

// The Prisma adapter is deliberately identifier-only. It is the persistence seam for the runtime
// owner, not a general provider-thread repository.
export class PrismaCodexRuntimeThreadLinkStore implements CodexRuntimeThreadLinkStore {
  constructor(private readonly getDelegate: () => Promise<RuntimeThreadLinkDelegate>) {}

  async listActive(): Promise<readonly CodexRuntimeThreadLink[]> {
    const delegate = await this.getDelegate()
    const rows = await delegate.findMany({
      where: { backend: 'codex', runtimeOwner: 'codex_app_server', closedAt: null },
      orderBy: { createdAt: 'asc' }
    })
    const links = rows.map(rowToLink)
    assertUniqueActiveLinks(links)
    return Object.freeze(links)
  }

  async findActiveByAppSessionId(
    appSessionId: string
  ): Promise<CodexRuntimeThreadLink | undefined> {
    assertIdentifier(appSessionId, 'Runtime Session id')
    const delegate = await this.getDelegate()
    const rows = await delegate.findMany({
      where: {
        backend: 'codex',
        runtimeOwner: 'codex_app_server',
        appSessionId,
        closedAt: null
      },
      orderBy: { createdAt: 'desc' }
    })
    if (rows.length > 1)
      throw new Error(`Duplicate active Codex runtime Session link: ${appSessionId}`)
    return rows[0] ? rowToLink(rows[0]) : undefined
  }

  async save(link: CodexRuntimeThreadLink): Promise<void> {
    const validated = validateCodexRuntimeThreadLink(link)
    if (validated.closedAt !== undefined) {
      throw new Error('Cannot save a closed Codex runtime thread link as active.')
    }
    const delegate = await this.getDelegate()
    const existingSession = await delegate.findMany({
      where: {
        backend: 'codex',
        runtimeOwner: 'codex_app_server',
        appSessionId: validated.appSessionId,
        closedAt: null
      },
      select: { id: true }
    })
    if (existingSession.length > 0) {
      throw new Error(`Duplicate active Codex runtime Session link: ${validated.appSessionId}`)
    }
    await delegate.create({
      data: {
        id: validated.id,
        agentRunId: validated.agentRunId,
        appSessionId: validated.appSessionId,
        backend: 'codex',
        runtimeThreadId: validated.runtimeThreadId,
        parentRuntimeThreadId: validated.parentRuntimeThreadId,
        ephemeral: validated.ephemeral,
        runtimeOwner: validated.runtimeOwner,
        authorizedCwd: validated.authorizedCwd,
        sandbox: validated.sandbox,
        model: validated.model,
        modelProvider: validated.modelProvider,
        approvalPolicy: validated.approvalPolicy,
        approvalsReviewer: validated.approvalsReviewer,
        createdAt: new Date(validated.createdAt)
      }
    })
  }

  async close(runtimeThreadId: string, closedAt = Date.now()): Promise<void> {
    assertIdentifier(runtimeThreadId, 'Runtime thread id')
    assertTimestamp(closedAt, 'Runtime thread closedAt')
    const delegate = await this.getDelegate()
    await delegate.updateMany({
      where: {
        backend: 'codex',
        runtimeOwner: 'codex_app_server',
        runtimeThreadId,
        closedAt: null
      },
      data: { closedAt: new Date(closedAt) }
    })
  }
}

export type InMemoryCodexRuntimeThreadLinkStoreOptions = Readonly<{
  links?: readonly CodexRuntimeThreadLink[]
}>

export class InMemoryCodexRuntimeThreadLinkStore implements CodexRuntimeThreadLinkStore {
  private readonly links = new Map<string, CodexRuntimeThreadLink>()

  constructor(options: InMemoryCodexRuntimeThreadLinkStoreOptions = {}) {
    for (const link of options.links ?? []) {
      const validated = validateCodexRuntimeThreadLink(link)
      this.links.set(validated.runtimeThreadId, validated)
    }
    assertUniqueActiveLinks([...this.links.values()].filter((link) => link.closedAt === undefined))
  }

  async listActive(): Promise<readonly CodexRuntimeThreadLink[]> {
    const links = [...this.links.values()].filter((link) => link.closedAt === undefined)
    assertUniqueActiveLinks(links)
    return Object.freeze(links.sort((left, right) => left.createdAt - right.createdAt))
  }

  async findActiveByAppSessionId(
    appSessionId: string
  ): Promise<CodexRuntimeThreadLink | undefined> {
    const links = await this.listActive()
    return links.find(
      (link) => link.appSessionId === assertIdentifier(appSessionId, 'Runtime Session id')
    )
  }

  async save(link: CodexRuntimeThreadLink): Promise<void> {
    const validated = validateCodexRuntimeThreadLink(link)
    if (validated.closedAt !== undefined) {
      throw new Error('Cannot save a closed Codex runtime thread link as active.')
    }
    const existingThread = this.links.get(validated.runtimeThreadId)
    if (existingThread && existingThread.closedAt === undefined) {
      throw new Error(`Duplicate active Codex runtime thread link: ${validated.runtimeThreadId}`)
    }
    const existingSession = [...this.links.values()].find(
      (candidate) =>
        candidate.closedAt === undefined && candidate.appSessionId === validated.appSessionId
    )
    if (existingSession)
      throw new Error(`Duplicate active Codex runtime Session link: ${validated.appSessionId}`)
    this.links.set(validated.runtimeThreadId, validated)
  }

  async close(runtimeThreadId: string, closedAt = Date.now()): Promise<void> {
    const normalized = assertIdentifier(runtimeThreadId, 'Runtime thread id')
    assertTimestamp(closedAt, 'Runtime thread closedAt')
    const existing = this.links.get(normalized)
    if (!existing || existing.closedAt !== undefined) return
    this.links.set(normalized, Object.freeze({ ...existing, closedAt }))
  }
}
