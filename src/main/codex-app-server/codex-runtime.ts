import { randomUUID } from 'node:crypto'

import type {
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionSettlementState
} from '../../shared/acp'
import type {
  AgentRuntimeEvent,
  AgentRuntimeForkRequest,
  AgentRuntimeInput,
  AgentRuntimePort,
  AgentRuntimeResumeRequest,
  AgentRuntimeSessionRequest,
  AgentRuntimeSessionState,
  AgentRuntimeSteerRequest,
  AgentRuntimeTurnAdmission,
  AgentRuntimeTurnRequest
} from '../agent-runtime'
import {
  startCodexAppServer,
  type CodexAppServerProviderHandoff,
  type StartCodexAppServerOptions
} from './start'
import { CodexPathAuthority } from './path-authority'
import {
  projectCodexNotification,
  type CodexNotificationProjection
} from './notification-projector'
import {
  validateCodexRuntimeThreadLink,
  type CodexRuntimeThreadLink,
  type CodexRuntimeThreadLinkStore
} from './runtime-links'
import type { CodexAppServerClient, CodexAppServerRpcError } from './client'
import type {
  CodexAppServerNotification,
  CodexAppServerProtocolError,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexSafeSandboxMode,
  CodexThreadStartParams,
  CodexUserInput
} from './types'

type JsonRecord = Record<string, unknown>

type ThreadMetadata = Readonly<{
  threadId: string
  ephemeral: boolean
  forkedFromId?: string
  cwd: string
  sandbox: CodexSafeSandboxMode
  model: string
  modelProvider: string
  approvalPolicy: 'on-request'
  approvalsReviewer: 'user'
}>

type ThreadReadAuthority = Readonly<{
  threadId: string
  ephemeral: boolean
  forkedFromId?: string
  cwd: string
  modelProvider: string
  activeTurnIds: readonly string[]
}>

type RuntimeRecord = {
  link: CodexRuntimeThreadLink
  request: AgentRuntimeSessionRequest
  state: AgentRuntimeSessionStatusMutable
  activeTurnId?: string
  lastTerminalTurnId?: string
  terminalTurnIds: Set<string>
  turnStartInFlight: boolean
  waiters: Map<string, Set<() => void>>
  effective?: ThreadMetadata
}

type AgentRuntimeSessionStatusMutable = {
  status: AgentRuntimeSessionState['status']
  errorCode?: string
  updatedAt: number
}

export type CodexRuntimeApprovalRequest = Readonly<{
  request: CodexApprovalRequest
  projection: AcpPermissionRequest
}>

export type CodexRuntimeGenerationOptions = Readonly<{
  applicationVersion: string
  dataRoot: string
  authorizedRoots: readonly string[]
  defaultCwd: string
  workspaceWriteRoots?: readonly string[]
  provider?: CodexAppServerProviderHandoff
  links: CodexRuntimeThreadLinkStore
  maxThreads?: number
  cancelTimeoutMs?: number
  onEvent?: (event: AgentRuntimeEvent) => void
  onProtocolError?: (error: CodexAppServerProtocolError) => void
  onApprovalRequest?: (
    request: CodexRuntimeApprovalRequest
  ) => CodexApprovalDecision | Promise<CodexApprovalDecision>
  onApprovalSettled?: (requestId: string, state: AcpPermissionSettlementState) => void
  releaseCredentialLease?: () => void | Promise<void>
  startClient?: (options: StartCodexAppServerOptions) => Promise<CodexAppServerClient>
  idFactory?: () => string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}>

const DEFAULT_MAX_THREADS = 16
const MAX_ALLOWED_THREADS = 32
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000
const SAFE_FAILURE_PROCESS_CLOSED = 'runtime_process_closed'
const SAFE_FAILURE_PROTOCOL = 'runtime_protocol_error'

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredIdentifier = (value: unknown, label: string): string => {
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

const optionalIdentifier = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  return requiredIdentifier(value, label)
}

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256_000) {
    throw new Error(`${label} must be non-empty and bounded.`)
  }
  return value
}

const requiredTimestamp = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`)
  return value
}

const requiredSandbox = (value: unknown): CodexSafeSandboxMode => {
  if (value !== 'read-only' && value !== 'workspace-write') {
    throw new Error('Codex runtime sandbox must be read-only or workspace-write.')
  }
  return value
}

const recordAt = (value: unknown, key: string): JsonRecord | undefined =>
  isRecord(value) && isRecord(value[key]) ? value[key] : undefined

const threadMetadata = (value: unknown, label: string): ThreadMetadata => {
  const response = isRecord(value) ? value : undefined
  const thread = recordAt(response, 'thread')
  if (!thread) throw new Error(`${label} response thread is missing.`)
  const threadId = requiredIdentifier(thread.id, `${label} response thread id`)
  if (typeof thread.ephemeral !== 'boolean') {
    throw new Error(`${label} response thread ephemeral flag is invalid.`)
  }
  const forkedFromId =
    thread.forkedFromId === null
      ? undefined
      : optionalIdentifier(thread.forkedFromId, `${label} response fork provenance`)
  const sandbox = recordAt(response, 'sandbox')
  const sandboxType = sandbox?.type
  const normalizedSandbox =
    sandboxType === 'readOnly'
      ? 'read-only'
      : sandboxType === 'workspaceWrite'
        ? 'workspace-write'
        : undefined
  if (normalizedSandbox === undefined) {
    throw new Error(`${label} response sandbox is invalid.`)
  }
  if (sandbox?.networkAccess !== false) {
    throw new Error(`${label} response sandbox network access is invalid.`)
  }
  const allowedSandboxKeys =
    normalizedSandbox === 'read-only'
      ? new Set(['type', 'networkAccess'])
      : new Set([
          'type',
          'writableRoots',
          'networkAccess',
          'excludeTmpdirEnvVar',
          'excludeSlashTmp'
        ])
  if (Object.keys(sandbox ?? {}).some((key) => !allowedSandboxKeys.has(key))) {
    throw new Error(`${label} response sandbox contains unsupported policy fields.`)
  }
  if (normalizedSandbox === 'workspace-write') {
    if (
      !Array.isArray(sandbox?.writableRoots) ||
      sandbox.writableRoots.length !== 0 ||
      sandbox.excludeTmpdirEnvVar !== true ||
      sandbox.excludeSlashTmp !== true
    ) {
      throw new Error(`${label} response workspace-write policy is invalid.`)
    }
  }
  const cwd = requiredText(response?.cwd, `${label} response cwd`)
  const model = requiredIdentifier(response?.model, `${label} response model`)
  const modelProvider = requiredIdentifier(
    response?.modelProvider,
    `${label} response model provider`
  )
  if (response?.approvalPolicy !== 'on-request') {
    throw new Error(`${label} response approval policy is invalid.`)
  }
  if (response?.approvalsReviewer !== 'user') {
    throw new Error(`${label} response approvals reviewer is invalid.`)
  }
  return Object.freeze({
    threadId,
    ephemeral: thread.ephemeral,
    ...(forkedFromId ? { forkedFromId } : {}),
    cwd,
    sandbox: normalizedSandbox,
    model,
    modelProvider,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user'
  })
}

const turnIdFromResponse = (value: unknown): string => {
  const turn = recordAt(value, 'turn')
  return requiredIdentifier(turn?.id, 'Codex app-server turn id')
}

const safeCodexInput = (input: AgentRuntimeInput): CodexUserInput => {
  switch (input.kind) {
    case 'text':
      return {
        type: 'text',
        text: requiredText(input.text, 'Runtime text input'),
        text_elements: []
      }
    case 'image':
      return input.source === 'url'
        ? {
            type: 'image',
            url: requiredText(input.value, 'Runtime image URL'),
            detail: input.detail
          }
        : {
            type: 'localImage',
            path: requiredText(input.value, 'Runtime image path'),
            detail: input.detail
          }
    case 'audio':
      return input.source === 'url'
        ? { type: 'audio', url: requiredText(input.value, 'Runtime audio URL') }
        : { type: 'localAudio', path: requiredText(input.value, 'Runtime audio path') }
    case 'skill':
    case 'mention':
      return {
        type: input.kind,
        name: requiredText(input.name, `Runtime ${input.kind} name`),
        path: requiredText(input.path, `Runtime ${input.kind} path`)
      }
  }
}

const safeThreadParams = (request: AgentRuntimeSessionRequest): CodexThreadStartParams => ({
  ...(request.model ? { model: requiredText(request.model, 'Runtime model') } : {}),
  ...(request.modelProvider
    ? { modelProvider: requiredText(request.modelProvider, 'Runtime model provider') }
    : {}),
  cwd: requiredText(request.cwd, 'Runtime cwd'),
  sandbox: requiredSandbox(request.sandbox),
  ...(request.baseInstructions !== undefined
    ? { baseInstructions: requiredText(request.baseInstructions, 'Runtime base instructions') }
    : {}),
  ...(request.developerInstructions !== undefined
    ? {
        developerInstructions: requiredText(
          request.developerInstructions,
          'Runtime developer instructions'
        )
      }
    : {}),
  ...(request.ephemeral === undefined ? {} : { ephemeral: request.ephemeral })
})

const safeResumeParams = (
  request: AgentRuntimeResumeRequest
): Omit<CodexThreadStartParams, 'ephemeral'> => {
  const { ephemeral: _ephemeral, ...params } = safeThreadParams(request)
  void _ephemeral
  return params
}

const safePermissionOptions = (): AcpPermissionOption[] => [
  { optionId: 'codex-allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
  { optionId: 'codex-deny-once', name: 'Deny', kind: 'reject_once', scope: 'once' },
  { optionId: 'codex-cancel', name: 'Cancel', kind: 'cancel', scope: 'once' }
]

const permissionProjection = (
  request: CodexApprovalRequest,
  sessionId: string
): AcpPermissionRequest => ({
  requestId: String(request.requestId),
  sessionId,
  toolCallId: request.itemId,
  title:
    request.kind === 'command-execution' ? 'Codex command approval' : 'Codex file change approval',
  status: 'pending',
  providerToolName: request.kind,
  isMcp: false,
  toolKind: 'execute',
  ...(request.kind === 'command-execution' && request.command
    ? { rawInput: { command: request.command } }
    : {}),
  options: safePermissionOptions()
})

const threadReadAuthority = (value: unknown): ThreadReadAuthority => {
  const response = isRecord(value) ? value : undefined
  const thread = recordAt(response, 'thread')
  if (!thread || !Array.isArray(thread.turns)) {
    throw new Error('Codex thread/read response turn list is invalid.')
  }
  if (typeof thread.ephemeral !== 'boolean') {
    throw new Error('Codex thread/read response persistence mode is invalid.')
  }
  const forkedFromId =
    thread.forkedFromId === null
      ? undefined
      : optionalIdentifier(thread.forkedFromId, 'Codex thread/read fork provenance')
  const activeTurnIds: string[] = []
  for (const rawTurn of thread.turns) {
    if (!isRecord(rawTurn)) throw new Error('Codex thread/read response turn is invalid.')
    const turnId = requiredIdentifier(rawTurn.id, 'Codex thread/read turn id')
    if (rawTurn.status === 'inProgress') activeTurnIds.push(turnId)
    else if (
      rawTurn.status !== 'completed' &&
      rawTurn.status !== 'failed' &&
      rawTurn.status !== 'interrupted'
    ) {
      throw new Error('Codex thread/read response turn status is invalid.')
    }
  }
  return Object.freeze({
    threadId: requiredIdentifier(thread.id, 'Codex thread/read thread id'),
    ephemeral: thread.ephemeral,
    ...(forkedFromId ? { forkedFromId } : {}),
    cwd: requiredText(thread.cwd, 'Codex thread/read cwd'),
    modelProvider: requiredIdentifier(thread.modelProvider, 'Codex thread/read model provider'),
    activeTurnIds: Object.freeze(activeTurnIds)
  })
}

const protocolError = (message: string): CodexAppServerProtocolError => ({ message })

// Main-process owner for one verified Codex app-server generation. It owns the process, all loaded
// thread identities, active turn state, approval bridge, and safe notification projection. No raw RPC
// surface is returned to callers.
export class CodexRuntimeGenerationOwner implements AgentRuntimePort {
  readonly backend = 'codex' as const
  readonly capabilities

  private readonly records = new Map<string, RuntimeRecord>()
  private readonly sessionReservations = new Set<string>()
  private readonly activeLinks = new Map<string, CodexRuntimeThreadLink>()
  private readonly threadToSession = new Map<string, string>()
  private readonly eventListeners = new Set<(event: AgentRuntimeEvent) => void>()
  private readonly idFactory: () => string
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly maxThreads: number
  private readonly cancelTimeoutMs: number
  private readonly pathAuthority: CodexPathAuthority
  private client: CodexAppServerClient | undefined
  private removeNotification?: () => void
  private removeProtocolError?: () => void
  private removeClose?: () => void
  private removeApprovalHandler?: () => void
  private removeApprovalSettlementHandler?: () => void
  private startPromise?: Promise<void>
  private linksClosedAfterFailure = false
  private started = false
  private closing = false
  private generationError = false
  private credentialsReleased = false

  constructor(private readonly options: CodexRuntimeGenerationOptions) {
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS
    this.pathAuthority = new CodexPathAuthority({
      authorizedRoots: options.authorizedRoots,
      workspaceWriteRoots: options.workspaceWriteRoots
    })
    if (
      !Number.isSafeInteger(this.maxThreads) ||
      this.maxThreads < 1 ||
      this.maxThreads > MAX_ALLOWED_THREADS
    ) {
      throw new Error('Codex runtime thread limit is invalid.')
    }
    if (!Number.isSafeInteger(this.cancelTimeoutMs) || this.cancelTimeoutMs < 1) {
      throw new Error('Codex runtime cancellation timeout is invalid.')
    }
    this.capabilities = Object.freeze({
      nativeSteer: (request: AgentRuntimeSteerRequest) => this.steer(request),
      nativeFork: (request: AgentRuntimeForkRequest) => this.fork(request)
    })
  }

  private async startGeneration(): Promise<void> {
    if (this.started) return
    if (this.closing) throw new Error('Codex runtime generation is closing.')
    if (this.startPromise) return this.startPromise

    const startPromise = this.startGenerationOnce()
    this.startPromise = startPromise
    try {
      await startPromise
    } catch (error) {
      await this.releaseCredentialLease().catch(() => undefined)
      throw error
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined
    }
  }

  private async startGenerationOnce(): Promise<void> {
    if (this.started) return
    const links = (await this.options.links.listActive()).map((link) =>
      validateCodexRuntimeThreadLink(link)
    )
    if (links.length > this.maxThreads) {
      throw new Error('Codex runtime thread limit has been exceeded by persisted links.')
    }
    const seenThreads = new Set<string>()
    const seenSessions = new Set<string>()
    for (const link of links) {
      if (seenThreads.has(link.runtimeThreadId)) {
        throw new Error(`Duplicate persisted Codex runtime thread: ${link.runtimeThreadId}`)
      }
      if (seenSessions.has(link.appSessionId)) {
        throw new Error(`Duplicate persisted Codex runtime Session: ${link.appSessionId}`)
      }
      seenThreads.add(link.runtimeThreadId)
      seenSessions.add(link.appSessionId)
    }
    const client = await (this.options.startClient ?? startCodexAppServer)({
      applicationVersion: this.options.applicationVersion,
      dataRoot: this.options.dataRoot,
      authorizedRoots: this.options.authorizedRoots,
      cwd: this.options.defaultCwd,
      workspaceWriteRoots: this.options.workspaceWriteRoots,
      ownedThreadIds: links.map((link) => link.runtimeThreadId),
      provider: this.options.provider
    })
    if (!client.isInitialized()) {
      await client.close().catch(() => undefined)
      await Promise.allSettled(
        links.map((link) => this.options.links.close(link.runtimeThreadId, this.now()))
      )
      throw new Error('Codex runtime app-server client was not initialized.')
    }
    if (this.closing) {
      await client.close().catch(() => undefined)
      throw new Error('Codex runtime generation is closing.')
    }
    try {
      this.client = client
      this.removeNotification = client.onNotification((notification) =>
        this.handleNotification(notification)
      )
      this.removeProtocolError = client.onProtocolError((error) => this.handleProtocolError(error))
      this.removeClose = client.onClose((error) => this.handleClientClose(error))
      this.removeApprovalHandler = client.setApprovalHandler((request) =>
        this.handleApproval(request)
      )
      this.removeApprovalSettlementHandler = client.setApprovalSettlementHandler(
        (requestId, state) => this.options.onApprovalSettled?.(String(requestId), state)
      )
      for (const link of links) {
        this.activeLinks.set(link.appSessionId, link)
        this.threadToSession.set(link.runtimeThreadId, link.appSessionId)
        this.records.set(link.appSessionId, this.recordForLink(link))
      }
      this.started = true
    } catch (error) {
      await client.close().catch(() => undefined)
      await Promise.allSettled(
        links.map((link) => this.options.links.close(link.runtimeThreadId, this.now()))
      )
      throw error
    }
  }

  async startSession(request: AgentRuntimeSessionRequest): Promise<AgentRuntimeSessionState> {
    return this.start(request)
  }

  async start(request: AgentRuntimeSessionRequest): Promise<AgentRuntimeSessionState> {
    await this.ensureStarted()
    return this.startNewSession(request)
  }

  async resume(request: AgentRuntimeResumeRequest): Promise<AgentRuntimeSessionState> {
    await this.ensureStarted()
    const appSessionId = requiredIdentifier(request.appSessionId, 'Runtime Session id')
    const persisted =
      this.activeLinks.get(appSessionId) ??
      (await this.options.links.findActiveByAppSessionId(appSessionId))
    if (!persisted)
      throw new Error(`No active Codex runtime link exists for Session ${appSessionId}.`)
    const threadId = request.runtimeThreadId ?? persisted.runtimeThreadId
    if (threadId !== persisted.runtimeThreadId) {
      throw new Error('Codex runtime resume thread does not match the persisted link.')
    }
    if (persisted.backend !== 'codex') throw new Error('Codex runtime link backend is invalid.')
    this.assertResumeRequest(persisted, request)
    if (this.threadToSession.has(threadId) && this.threadToSession.get(threadId) !== appSessionId) {
      throw new Error('Codex runtime resume thread is owned by another Session.')
    }
    const client = this.requireClient()
    if (!client.hasOwnedThread(threadId)) client.registerOwnedThread(threadId)
    const authoritativeRequest = this.requestForLink(persisted, request)
    const metadata = await client
      .resumeThread(threadId, safeResumeParams(authoritativeRequest))
      .then((value) => threadMetadata(value, 'Codex thread/resume'))
    this.assertResumeMetadata(metadata, persisted, authoritativeRequest)
    const record = this.records.get(appSessionId) ?? this.recordForLink(persisted)
    record.request = authoritativeRequest
    record.effective = metadata
    record.state.status = 'idle'
    record.state.errorCode = undefined
    record.state.updatedAt = this.now()
    record.activeTurnId = undefined
    this.activeLinks.set(appSessionId, persisted)
    this.threadToSession.set(threadId, appSessionId)
    this.records.set(appSessionId, record)
    return this.snapshot(record)
  }

  async readState(appSessionId: string): Promise<AgentRuntimeSessionState> {
    await this.ensureStarted()
    const record = this.requireRecord(appSessionId)
    const response = await this.requireClient().readThread<JsonRecord>(
      record.link.runtimeThreadId,
      // Codex 0.147.0 rejects includeTurns for ephemeral threads. Those threads cannot survive a
      // generation restart, so their exact active-turn authority remains notification-owned in this
      // process; metadata-only reads preserve that local state until the matching terminal event.
      !record.link.ephemeral
    )
    const authority = threadReadAuthority(response)
    if (authority.threadId !== record.link.runtimeThreadId) {
      throw new Error('Codex thread/read returned an unowned thread.')
    }
    if (authority.ephemeral !== record.link.ephemeral) {
      throw new Error('Codex thread/read persistence mode differs from the owned Session.')
    }
    if (authority.forkedFromId !== record.link.parentRuntimeThreadId) {
      throw new Error('Codex thread/read fork provenance differs from the durable link.')
    }
    const authoritativeCwd =
      record.link.sandbox === 'workspace-write'
        ? this.pathAuthority.resolveWorkspaceDirectory(
            authority.cwd,
            'Codex thread/read workspace-write cwd'
          )
        : this.pathAuthority.resolveAuthorizedDirectory(authority.cwd, 'Codex thread/read cwd')
    if (authoritativeCwd !== record.link.authorizedCwd) {
      throw new Error('Codex thread/read cwd differs from the durable link.')
    }
    if (authority.modelProvider !== record.link.modelProvider) {
      throw new Error('Codex thread/read provider differs from the durable link.')
    }
    const activeTurnIds = record.link.ephemeral ? [] : authority.activeTurnIds
    if (activeTurnIds.length > 1) {
      throw new Error('Codex thread/read reported multiple active turns for one Session.')
    }
    const providerActiveTurnId = activeTurnIds[0]
    if (
      providerActiveTurnId &&
      (record.terminalTurnIds.has(providerActiveTurnId) ||
        (record.activeTurnId && record.activeTurnId !== providerActiveTurnId))
    ) {
      throw new Error('Codex thread/read active turn conflicts with local turn authority.')
    }
    if (!record.activeTurnId && providerActiveTurnId) {
      record.activeTurnId = providerActiveTurnId
      record.state.status = 'running'
    } else if (!record.activeTurnId) {
      record.state.status = 'idle'
    }
    record.state.updatedAt = this.now()
    return this.snapshot(record)
  }

  async startTurn(request: AgentRuntimeTurnRequest): Promise<AgentRuntimeTurnAdmission> {
    await this.ensureStarted()
    const record = this.requireRecord(request.appSessionId)
    if (record.activeTurnId || record.turnStartInFlight || record.state.status === 'cancelling') {
      throw new Error('Codex runtime Session already has an active turn.')
    }
    record.turnStartInFlight = true
    record.state.status = 'starting'
    record.state.updatedAt = this.now()
    try {
      const result = await this.requireClient().startTurn<JsonRecord>({
        threadId: record.link.runtimeThreadId,
        input: request.input.map(safeCodexInput),
        ...(request.clientUserMessageId
          ? {
              clientUserMessageId: requiredIdentifier(
                request.clientUserMessageId,
                'Client Message id'
              )
            }
          : {}),
        ...(request.model ? { model: requiredText(request.model, 'Runtime turn model') } : {}),
        ...(request.effort ? { effort: requiredText(request.effort, 'Runtime turn effort') } : {}),
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema })
      })
      const runtimeTurnId = turnIdFromResponse(result)
      if (record.activeTurnId && record.activeTurnId !== runtimeTurnId) {
        throw new Error('Codex runtime accepted a turn that differs from the active turn.')
      }
      record.activeTurnId = record.terminalTurnIds.has(runtimeTurnId) ? undefined : runtimeTurnId
      record.state.status = record.activeTurnId ? 'running' : 'idle'
      record.state.updatedAt = this.now()
      return Object.freeze({
        appSessionId: record.link.appSessionId,
        runtimeThreadId: record.link.runtimeThreadId,
        runtimeTurnId,
        acceptedAt: this.now()
      })
    } catch (error) {
      record.state.status = 'error'
      record.state.errorCode = this.safeErrorCode(error)
      record.state.updatedAt = this.now()
      throw error
    } finally {
      record.turnStartInFlight = false
    }
  }

  async cancel(appSessionId: string, expectedTurnId?: string): Promise<void> {
    if (!this.started || !this.client) await this.ensureStarted()
    const record = this.requireRecord(appSessionId)
    const turnId = expectedTurnId ?? record.activeTurnId
    if (!turnId) return
    if (record.activeTurnId !== turnId) {
      throw new Error('Codex runtime cancellation targeted a stale turn.')
    }
    await this.requireClient().interruptTurn({
      threadId: record.link.runtimeThreadId,
      turnId: requiredIdentifier(turnId, 'Codex turn id')
    })
    // The interrupt response is admission only. The exact turn remains active until the matching
    // terminal notification is observed.
    if (record.activeTurnId === turnId && !record.terminalTurnIds.has(turnId)) {
      record.state.status = 'cancelling'
    }
    record.state.updatedAt = this.now()
  }

  async closeSession(appSessionId: string): Promise<void> {
    const record = this.records.get(requiredIdentifier(appSessionId, 'Runtime Session id'))
    if (!record) return
    let closeError: unknown
    try {
      const activeTurnId = record.activeTurnId
      if (activeTurnId && !this.generationError && this.client) {
        await this.cancel(record.link.appSessionId, activeTurnId)
        await this.waitForTerminal(record, activeTurnId)
      }
    } catch (error) {
      closeError = error
      record.state.status = 'error'
      record.state.errorCode = this.safeErrorCode(error)
      record.state.updatedAt = this.now()
    } finally {
      await this.options.links.close(record.link.runtimeThreadId, this.now()).catch((error) => {
        closeError ??= error
      })
      this.records.delete(record.link.appSessionId)
      this.activeLinks.delete(record.link.appSessionId)
      this.threadToSession.delete(record.link.runtimeThreadId)
      this.client?.unregisterOwnedThread(record.link.runtimeThreadId)
    }
    if (closeError) throw closeError
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const startup = this.startPromise
    let startupError: unknown
    if (startup) {
      try {
        await startup
      } catch (error) {
        startupError = error
      }
    }
    const sessionIds = [...this.records.keys()]
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => this.closeSession(sessionId))
    )
    const client = this.client
    this.removeApprovalHandler?.()
    this.removeNotification?.()
    this.removeProtocolError?.()
    this.removeClose?.()
    this.removeApprovalHandler = undefined
    this.removeNotification = undefined
    this.removeProtocolError = undefined
    this.removeClose = undefined
    if (client) await client.close().catch(() => undefined)
    this.removeApprovalSettlementHandler?.()
    this.removeApprovalSettlementHandler = undefined
    this.client = undefined
    await this.releaseCredentialLease()
    this.started = false
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) throw failure.reason
    if (startupError) throw startupError
  }

  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private async startNewSession(
    request: AgentRuntimeSessionRequest
  ): Promise<AgentRuntimeSessionState> {
    const appSessionId = requiredIdentifier(request.appSessionId, 'Runtime Session id')
    if (
      this.records.has(appSessionId) ||
      this.activeLinks.has(appSessionId) ||
      this.sessionReservations.has(appSessionId)
    ) {
      throw new Error(`Codex runtime Session ${appSessionId} is already owned.`)
    }
    if (this.threadToSession.size + this.sessionReservations.size >= this.maxThreads) {
      throw new Error('Codex runtime thread limit has been reached.')
    }
    this.sessionReservations.add(appSessionId)
    try {
      return await this.createSession(request)
    } finally {
      this.sessionReservations.delete(appSessionId)
    }
  }

  private async createSession(
    request: AgentRuntimeSessionRequest
  ): Promise<AgentRuntimeSessionState> {
    const appSessionId = requiredIdentifier(request.appSessionId, 'Runtime Session id')
    requiredIdentifier(request.agentRunId, 'Agent Run id')
    if (request.parentRuntimeThreadId !== undefined) {
      throw new Error('Codex root Session start cannot assign a parent runtime thread.')
    }
    const client = this.requireClient()
    const metadata = await client
      .startThread<JsonRecord>(safeThreadParams(request))
      .then((value) => threadMetadata(value, 'Codex thread/start'))
    if (metadata.ephemeral !== Boolean(request.ephemeral)) {
      throw new Error('Codex thread/start persistence mode differs from the request.')
    }
    this.assertRequestedMetadata(metadata, request, 'started')
    if (metadata.forkedFromId !== undefined) {
      throw new Error('Codex root thread unexpectedly has fork provenance.')
    }
    const link = validateCodexRuntimeThreadLink({
      id: this.idFactory(),
      agentRunId: requiredIdentifier(request.agentRunId, 'Agent Run id'),
      appSessionId,
      backend: 'codex',
      runtimeThreadId: metadata.threadId,
      ephemeral: Boolean(request.ephemeral),
      runtimeOwner: 'codex_app_server',
      authorizedCwd: this.resolveRequestedCwd(request),
      sandbox: metadata.sandbox,
      model: metadata.model,
      modelProvider: metadata.modelProvider,
      approvalPolicy: metadata.approvalPolicy,
      approvalsReviewer: metadata.approvalsReviewer,
      createdAt: requiredTimestamp(this.now(), 'Runtime thread link createdAt')
    })
    if (this.generationError || this.closing) {
      throw new Error('Codex runtime generation is unavailable.')
    }
    try {
      await this.options.links.save(link)
    } catch (error) {
      // A started thread without a durable link cannot be safely resumed or audited. Tear down the
      // whole generation instead of continuing with an unowned provider thread.
      await this.close().catch(() => undefined)
      throw error
    }
    if (this.generationError || this.closing) {
      await this.options.links.close(link.runtimeThreadId, this.now()).catch(() => undefined)
      throw new Error('Codex runtime generation is unavailable.')
    }
    const record: RuntimeRecord = {
      link,
      request,
      state: { status: 'idle', updatedAt: this.now() },
      terminalTurnIds: new Set(),
      turnStartInFlight: false,
      waiters: new Map(),
      effective: metadata
    }
    this.activeLinks.set(appSessionId, link)
    this.threadToSession.set(metadata.threadId, appSessionId)
    this.records.set(appSessionId, record)
    return this.snapshot(record)
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started || !this.client) {
      if (this.generationError) throw new Error('Codex runtime generation is unavailable.')
      await this.startGeneration()
    }
    if (this.closing) throw new Error('Codex runtime generation is closing.')
  }

  private requireClient(): CodexAppServerClient {
    if (!this.client || !this.started || this.generationError) {
      throw new Error('Codex runtime generation is unavailable.')
    }
    return this.client
  }

  private recordForLink(link: CodexRuntimeThreadLink): RuntimeRecord {
    return {
      link,
      request: this.requestForLink(link),
      state: { status: 'idle', updatedAt: this.now() },
      terminalTurnIds: new Set(),
      turnStartInFlight: false,
      waiters: new Map()
    }
  }

  private requireRecord(appSessionId: string): RuntimeRecord {
    const normalized = requiredIdentifier(appSessionId, 'Runtime Session id')
    const record = this.records.get(normalized)
    if (record) return record
    const link = this.activeLinks.get(normalized)
    if (!link) throw new Error(`Codex runtime Session ${normalized} is not owned.`)
    const recovered = this.recordForLink(link)
    this.records.set(normalized, recovered)
    return recovered
  }

  private snapshot(record: RuntimeRecord): AgentRuntimeSessionState {
    const effective = record.effective
    return Object.freeze({
      appSessionId: record.link.appSessionId,
      backend: 'codex',
      runtimeThreadId: record.link.runtimeThreadId,
      ...(record.link.parentRuntimeThreadId
        ? { parentRuntimeThreadId: record.link.parentRuntimeThreadId }
        : {}),
      ephemeral: record.link.ephemeral,
      cwd: effective?.cwd ?? record.request.cwd,
      sandbox: effective?.sandbox ?? record.request.sandbox,
      ...((effective?.model ?? record.request.model)
        ? { model: effective?.model ?? record.request.model }
        : {}),
      ...((effective?.modelProvider ?? record.request.modelProvider)
        ? { modelProvider: effective?.modelProvider ?? record.request.modelProvider }
        : {}),
      status: record.state.status,
      ...(record.activeTurnId ? { activeTurnId: record.activeTurnId } : {}),
      ...(record.lastTerminalTurnId ? { lastTerminalTurnId: record.lastTerminalTurnId } : {}),
      ...(record.state.errorCode ? { errorCode: record.state.errorCode } : {}),
      updatedAt: record.state.updatedAt
    })
  }

  private assertResumeMetadata(
    metadata: ThreadMetadata,
    link: CodexRuntimeThreadLink,
    request: AgentRuntimeResumeRequest
  ): void {
    if (metadata.threadId !== link.runtimeThreadId)
      throw new Error('Codex resume returned another thread.')
    if (
      metadata.ephemeral !== link.ephemeral ||
      metadata.ephemeral !== Boolean(request.ephemeral)
    ) {
      throw new Error('Codex resumed thread persistence mode is not owned by this Session.')
    }
    if (link.parentRuntimeThreadId !== metadata.forkedFromId) {
      throw new Error('Codex resumed thread fork provenance differs from the persisted link.')
    }
    this.assertRequestedMetadata(metadata, request, 'resumed')
  }

  private requestForLink(
    link: CodexRuntimeThreadLink,
    source: Partial<AgentRuntimeResumeRequest> = {}
  ): AgentRuntimeSessionRequest {
    return {
      appSessionId: link.appSessionId,
      agentRunId: link.agentRunId,
      cwd: link.authorizedCwd,
      sandbox: link.sandbox,
      model: link.model,
      modelProvider: link.modelProvider,
      ephemeral: link.ephemeral,
      ...(link.parentRuntimeThreadId ? { parentRuntimeThreadId: link.parentRuntimeThreadId } : {}),
      ...(source.baseInstructions !== undefined
        ? { baseInstructions: source.baseInstructions }
        : {}),
      ...(source.developerInstructions !== undefined
        ? { developerInstructions: source.developerInstructions }
        : {})
    }
  }

  private assertResumeRequest(
    link: CodexRuntimeThreadLink,
    request: AgentRuntimeResumeRequest
  ): void {
    requiredIdentifier(request.agentRunId, 'Runtime resume Agent Run id')
    if (request.agentRunId !== link.agentRunId) {
      throw new Error('Codex runtime resume Agent Run differs from the durable link.')
    }
    if (Boolean(request.ephemeral) !== link.ephemeral) {
      throw new Error('Codex runtime resume persistence mode differs from the durable link.')
    }
    if (request.sandbox !== link.sandbox) {
      throw new Error('Codex runtime resume sandbox differs from the durable link.')
    }
    const requestedCwd = this.resolveRequestedCwd(request, 'resume')
    if (requestedCwd !== link.authorizedCwd) {
      throw new Error('Codex runtime resume cwd differs from the durable link.')
    }
    if (request.model !== link.model || request.modelProvider !== link.modelProvider) {
      throw new Error('Codex runtime resume model/provider differs from the durable link.')
    }
    if (request.parentRuntimeThreadId !== link.parentRuntimeThreadId) {
      throw new Error('Codex runtime resume fork provenance differs from the durable link.')
    }
  }

  private resolveRequestedCwd(
    request: Pick<AgentRuntimeSessionRequest, 'cwd' | 'sandbox'>,
    verb: 'start' | 'resume' | 'fork' = 'start'
  ): string {
    return request.sandbox === 'workspace-write'
      ? this.pathAuthority.resolveWorkspaceDirectory(
          request.cwd,
          `Codex runtime ${verb} workspace-write cwd`
        )
      : this.pathAuthority.resolveAuthorizedDirectory(request.cwd, `Codex runtime ${verb} cwd`)
  }

  private assertRequestedMetadata(
    metadata: ThreadMetadata,
    request: AgentRuntimeSessionRequest,
    verb: 'started' | 'resumed' | 'forked'
  ): void {
    const requestedCwd =
      request.sandbox === 'workspace-write'
        ? this.pathAuthority.resolveWorkspaceDirectory(
            request.cwd,
            `Codex ${verb} workspace-write cwd`
          )
        : this.pathAuthority.resolveAuthorizedDirectory(request.cwd, `Codex ${verb} cwd`)
    const effectiveMetadataCwd =
      request.sandbox === 'workspace-write'
        ? this.pathAuthority.resolveWorkspaceDirectory(
            metadata.cwd,
            `Codex ${verb} effective workspace-write cwd`
          )
        : this.pathAuthority.resolveAuthorizedDirectory(metadata.cwd, `Codex ${verb} effective cwd`)
    if (effectiveMetadataCwd !== requestedCwd) {
      throw new Error(`Codex ${verb} thread cwd differs from the requested authorized cwd.`)
    }
    if (metadata.sandbox !== request.sandbox) {
      throw new Error(`Codex ${verb} thread sandbox differs from the requested policy.`)
    }
    if (request.model !== undefined && metadata.model !== request.model) {
      throw new Error(`Codex ${verb} thread model differs from the selected target.`)
    }
    if (request.modelProvider !== undefined && metadata.modelProvider !== request.modelProvider) {
      throw new Error(`Codex ${verb} thread provider differs from the selected target.`)
    }
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    const projection = projectCodexNotification(notification)
    if (projection.kind === 'ignored') {
      this.handleProtocolError(
        protocolError(`Codex notification ${notification.method} is not allowlisted.`)
      )
      return
    }
    if (projection.kind === 'malformed' || !projection.threadId) {
      this.handleProtocolError(
        protocolError(`Codex notification ${notification.method} is malformed.`)
      )
      return
    }
    const appSessionId = this.threadToSession.get(projection.threadId)
    if (!appSessionId) {
      this.handleProtocolError(protocolError('Codex notification referenced an unowned thread.'))
      return
    }
    const record = this.requireRecord(appSessionId)
    this.applyProjection(record, projection)
    if (!projection.event) return
    const event: AgentRuntimeEvent = Object.freeze({
      runtimeThreadId: record.link.runtimeThreadId,
      ...(projection.turnId ? { runtimeTurnId: projection.turnId } : {}),
      ...(projection.terminal ? { terminal: true } : {}),
      event: Object.freeze({
        ...projection.event,
        sessionId: record.link.appSessionId
      })
    })
    this.options.onEvent?.(event)
    for (const listener of this.eventListeners) listener(event)
  }

  private applyProjection(record: RuntimeRecord, projection: CodexNotificationProjection): void {
    const turnId = projection.turnId
    if (projection.terminal && !turnId) {
      this.handleProtocolError(
        protocolError('Codex terminal notification did not identify a turn.')
      )
      return
    }
    if (!projection.terminal && turnId && record.activeTurnId && record.activeTurnId !== turnId) {
      this.handleProtocolError(
        protocolError('Codex notification changed the active turn identity.')
      )
      return
    }
    if (!projection.terminal && turnId && !record.activeTurnId && !record.turnStartInFlight) {
      this.handleProtocolError(
        protocolError('Codex notification referenced a turn that was not admitted.')
      )
      return
    }
    if (!projection.terminal && turnId && !record.activeTurnId) {
      record.activeTurnId = turnId
      record.state.status = 'running'
    }
    if (projection.terminal && turnId) {
      if (record.terminalTurnIds.has(turnId)) {
        this.handleProtocolError(protocolError('Codex terminal notification was duplicated.'))
        return
      }
      if (record.activeTurnId !== turnId && !record.turnStartInFlight) {
        this.handleProtocolError(
          protocolError('Codex terminal notification referenced a non-active turn.')
        )
        return
      }
      record.terminalTurnIds.add(turnId)
      if (record.terminalTurnIds.size > 64) {
        const oldest = record.terminalTurnIds.values().next().value
        if (oldest) record.terminalTurnIds.delete(oldest)
      }
      record.lastTerminalTurnId = turnId
      if (record.activeTurnId === turnId) {
        record.activeTurnId = undefined
        record.state.status = 'idle'
        this.resolveWaiters(record, turnId)
      }
    }
    if (projection.event?.kind === 'error' && !projection.terminal) {
      record.state.errorCode = SAFE_FAILURE_PROTOCOL
    }
    record.state.updatedAt = this.now()
  }

  private async handleApproval(request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    const appSessionId = this.threadToSession.get(request.threadId)
    if (!appSessionId) return 'decline'
    const record = this.records.get(appSessionId)
    if (!record || record.activeTurnId !== request.turnId) return 'decline'
    const projection: CodexRuntimeApprovalRequest = {
      request,
      projection: permissionProjection(request, appSessionId)
    }
    this.emitApprovalEvent(projection)
    const decision = this.options.onApprovalRequest
      ? await this.options.onApprovalRequest(projection)
      : 'decline'
    const normalized: CodexApprovalDecision =
      decision === 'accept' || decision === 'cancel' ? decision : 'decline'
    return normalized
  }

  private emitApprovalEvent(input: CodexRuntimeApprovalRequest): void {
    const record = this.records.get(input.projection.sessionId)
    if (!record) return
    const event: AgentRuntimeEvent = Object.freeze({
      runtimeThreadId: record.link.runtimeThreadId,
      runtimeTurnId: input.request.turnId,
      event: Object.freeze({
        kind: 'permission',
        level: 'info',
        sessionId: record.link.appSessionId,
        toolCallId: input.request.itemId,
        title: input.projection.title,
        status: 'pending'
      })
    })
    this.options.onEvent?.(event)
    for (const listener of this.eventListeners) listener(event)
  }

  private handleProtocolError(error: CodexAppServerProtocolError): void {
    this.options.onProtocolError?.(error)
    if (this.closing) return
    this.generationError = true
    for (const record of this.records.values()) {
      record.state.status = 'error'
      record.state.errorCode = SAFE_FAILURE_PROTOCOL
      record.state.updatedAt = this.now()
      if (record.activeTurnId) this.resolveWaiters(record, record.activeTurnId)
    }
    void this.client?.close().catch(() => undefined)
  }

  private handleClientClose(error?: Error): void {
    if (this.closing) return
    this.generationError = true
    for (const record of this.records.values()) {
      record.state.status = 'error'
      record.state.errorCode = SAFE_FAILURE_PROCESS_CLOSED
      record.state.updatedAt = this.now()
      if (record.activeTurnId) this.resolveWaiters(record, record.activeTurnId)
    }
    if (error) this.options.onProtocolError?.(protocolError(SAFE_FAILURE_PROCESS_CLOSED))
    void this.closeLinksAfterFailure()
    void this.releaseCredentialLease()
  }

  private async closeLinksAfterFailure(): Promise<void> {
    if (this.linksClosedAfterFailure) return
    this.linksClosedAfterFailure = true
    await Promise.allSettled(
      [...this.records.values()].map((record) =>
        this.options.links.close(record.link.runtimeThreadId, this.now())
      )
    )
  }

  private async releaseCredentialLease(): Promise<void> {
    if (this.credentialsReleased) return
    this.credentialsReleased = true
    await this.options.releaseCredentialLease?.()
  }

  private async waitForTerminal(record: RuntimeRecord, turnId: string): Promise<void> {
    if (record.activeTurnId !== turnId || record.terminalTurnIds.has(turnId)) return
    await new Promise<void>((resolve, reject) => {
      const waiters = record.waiters.get(turnId) ?? new Set<() => void>()
      let settled = false
      const resolveWaiter = (): void => {
        if (settled) return
        settled = true
        this.clearTimer(timer)
        waiters.delete(resolveWaiter)
        if (waiters.size === 0) record.waiters.delete(turnId)
        resolve()
      }
      const timer = this.setTimer(() => {
        if (settled) return
        settled = true
        waiters.delete(resolveWaiter)
        if (waiters.size === 0) record.waiters.delete(turnId)
        reject(new Error('Codex runtime turn did not reach terminal confirmation.'))
      }, this.cancelTimeoutMs)
      waiters.add(resolveWaiter)
      record.waiters.set(turnId, waiters)
    })
  }

  private resolveWaiters(record: RuntimeRecord, turnId: string): void {
    const waiters = record.waiters.get(turnId)
    if (!waiters) return
    record.waiters.delete(turnId)
    for (const resolve of waiters) resolve()
  }

  private safeErrorCode(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as CodexAppServerRpcError).code
      if (typeof code === 'number' && Number.isSafeInteger(code)) return `rpc_${code}`
    }
    return 'runtime_request_failed'
  }

  private async steer(request: AgentRuntimeSteerRequest): Promise<AgentRuntimeTurnAdmission> {
    await this.ensureStarted()
    const record = this.requireRecord(request.appSessionId)
    if (!record.activeTurnId || record.activeTurnId !== request.expectedTurnId) {
      throw new Error('Codex native steering targeted a stale turn.')
    }
    const result = await this.requireClient().steerTurn<JsonRecord>({
      threadId: record.link.runtimeThreadId,
      expectedTurnId: requiredIdentifier(request.expectedTurnId, 'Codex expected turn id'),
      input: request.input.map(safeCodexInput),
      ...(request.clientUserMessageId
        ? {
            clientUserMessageId: requiredIdentifier(
              request.clientUserMessageId,
              'Client Message id'
            )
          }
        : {})
    })
    const turnId = requiredIdentifier(result.turnId, 'Codex steered turn id')
    if (turnId !== request.expectedTurnId) {
      throw new Error('Codex native steering returned a different turn id.')
    }
    return Object.freeze({
      appSessionId: record.link.appSessionId,
      runtimeThreadId: record.link.runtimeThreadId,
      runtimeTurnId: turnId,
      acceptedAt: this.now()
    })
  }

  private async fork(request: AgentRuntimeForkRequest): Promise<AgentRuntimeSessionState> {
    await this.ensureStarted()
    const childSessionId = requiredIdentifier(request.appSessionId, 'Child Runtime Session id')
    if (
      this.records.has(childSessionId) ||
      this.activeLinks.has(childSessionId) ||
      this.sessionReservations.has(childSessionId)
    ) {
      throw new Error(`Codex runtime Session ${childSessionId} is already owned.`)
    }
    if (this.threadToSession.size + this.sessionReservations.size >= this.maxThreads) {
      throw new Error('Codex runtime thread limit has been reached.')
    }
    this.sessionReservations.add(childSessionId)
    try {
      return await this.createFork(request)
    } finally {
      this.sessionReservations.delete(childSessionId)
    }
  }

  private async createFork(request: AgentRuntimeForkRequest): Promise<AgentRuntimeSessionState> {
    await this.ensureStarted()
    const parent = this.requireRecord(request.parentAppSessionId)
    requiredIdentifier(request.appSessionId, 'Child Runtime Session id')
    requiredIdentifier(request.agentRunId, 'Child Agent Run id')
    const response = await this.requireClient().forkThread<JsonRecord>({
      threadId: parent.link.runtimeThreadId,
      ...(request.lastTurnId
        ? { lastTurnId: requiredIdentifier(request.lastTurnId, 'Codex fork turn id') }
        : {}),
      ...safeThreadParams({
        ...request,
        ephemeral: true,
        parentRuntimeThreadId: parent.link.runtimeThreadId
      })
    })
    const metadata = threadMetadata(response, 'Codex thread/fork')
    if (metadata.forkedFromId !== parent.link.runtimeThreadId || !metadata.ephemeral) {
      throw new Error('Codex fork provenance or persistence mode is invalid.')
    }
    this.assertRequestedMetadata(metadata, { ...request, ephemeral: true }, 'forked')
    const link = validateCodexRuntimeThreadLink({
      id: this.idFactory(),
      agentRunId: request.agentRunId,
      appSessionId: request.appSessionId,
      backend: 'codex',
      runtimeThreadId: metadata.threadId,
      parentRuntimeThreadId: parent.link.runtimeThreadId,
      ephemeral: true,
      runtimeOwner: 'codex_app_server',
      authorizedCwd: this.resolveRequestedCwd(request, 'fork'),
      sandbox: metadata.sandbox,
      model: metadata.model,
      modelProvider: metadata.modelProvider,
      approvalPolicy: metadata.approvalPolicy,
      approvalsReviewer: metadata.approvalsReviewer,
      createdAt: requiredTimestamp(this.now(), 'Runtime thread link createdAt')
    })
    if (this.generationError || this.closing) {
      throw new Error('Codex runtime generation is unavailable.')
    }
    try {
      await this.options.links.save(link)
    } catch (error) {
      // A provider child that cannot be linked is unowned work. Reap the whole generation rather
      // than leaving a process-owned thread that cannot be resumed or audited after a crash.
      await this.close().catch(() => undefined)
      throw error
    }
    if (this.generationError || this.closing) {
      await this.options.links.close(link.runtimeThreadId, this.now()).catch(() => undefined)
      throw new Error('Codex runtime generation is unavailable.')
    }
    const record: RuntimeRecord = {
      link,
      request: { ...request, ephemeral: true },
      state: { status: 'idle', updatedAt: this.now() },
      terminalTurnIds: new Set(),
      turnStartInFlight: false,
      waiters: new Map(),
      effective: metadata
    }
    this.activeLinks.set(link.appSessionId, link)
    this.threadToSession.set(link.runtimeThreadId, link.appSessionId)
    this.records.set(link.appSessionId, record)
    return this.snapshot(record)
  }
}

export { CodexRuntimeGenerationOwner as CodexRuntime }
