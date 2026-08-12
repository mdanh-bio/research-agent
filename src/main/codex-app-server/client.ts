import { CodexApprovalBroker } from './approval-broker'
import { CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS } from './notification-projector'
import { CodexPathAuthority } from './path-authority'
import type {
  CodexAppServerClientInfo,
  CodexAppServerInitializeResult,
  CodexAppServerNotification,
  CodexAppServerProtocolError,
  CodexAppServerRequestId,
  CodexAppServerTransport,
  CodexApprovalHandler,
  CodexThreadForkParams,
  CodexThreadResumeOptions,
  CodexThreadStartParams,
  CodexTurnInterruptParams,
  CodexTurnStartParams,
  CodexTurnSteerParams
} from './types'
import type { AcpPermissionSettlementState } from '../../shared/acp'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout?: ReturnType<typeof setTimeout>
}

type JsonRecord = Record<string, unknown>

type AllowedRequestMethod =
  | 'initialize'
  | 'thread/start'
  | 'thread/resume'
  | 'thread/fork'
  | 'thread/read'
  | 'thread/list'
  | 'turn/start'
  | 'turn/steer'
  | 'turn/interrupt'

export const MAX_CODEX_APP_SERVER_JSONL_BYTES = 2 * 1024 * 1024
export const MAX_CODEX_APP_SERVER_NOTIFICATION_BYTES = 1 * 1024 * 1024
export const MAX_CODEX_APP_SERVER_PENDING_REQUESTS = 128
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000

const THREAD_START_KEYS = new Set([
  'model',
  'modelProvider',
  'cwd',
  'sandbox',
  'baseInstructions',
  'developerInstructions',
  'ephemeral'
])

const THREAD_RESUME_KEYS = new Set([
  'model',
  'modelProvider',
  'cwd',
  'sandbox',
  'baseInstructions',
  'developerInstructions'
])

const THREAD_FORK_KEYS = new Set([...THREAD_START_KEYS, 'threadId', 'lastTurnId'])

const TURN_START_KEYS = new Set([
  'threadId',
  'input',
  'clientUserMessageId',
  'model',
  'effort',
  'outputSchema'
])

const TURN_STEER_KEYS = new Set(['threadId', 'expectedTurnId', 'input', 'clientUserMessageId'])

const TURN_INTERRUPT_KEYS = new Set(['threadId', 'turnId'])

const USER_INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  text: new Set(['type', 'text', 'text_elements']),
  image: new Set(['type', 'url', 'detail']),
  localImage: new Set(['type', 'path', 'detail']),
  audio: new Set(['type', 'url']),
  localAudio: new Set(['type', 'path']),
  skill: new Set(['type', 'name', 'path']),
  mention: new Set(['type', 'name', 'path'])
})

const IMAGE_DETAILS = new Set(['auto', 'low', 'high', 'original'])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRequestId = (value: unknown): value is CodexAppServerRequestId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))

const safeProtocolErrorText = (value: string): string =>
  value
    .slice(0, 2_048)
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|password|secret|token)\b\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')

const requireRecord = (value: unknown, method: string): JsonRecord => {
  if (isRecord(value)) return value
  throw new Error(`Codex app-server ${method} parameters must be an object.`)
}

const assertAllowedKeys = (
  method: string,
  params: JsonRecord,
  allowed: ReadonlySet<string>
): void => {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`Codex app-server ${method} parameter ${key} is not permitted.`)
    }
  }
}

const requireNonEmptyString = (value: unknown, method: string, key: string): string => {
  if (typeof value === 'string' && value.trim()) return value
  throw new Error(`Codex app-server ${method} parameter ${key} must be a non-empty string.`)
}

const copyOptionalString = (
  source: JsonRecord,
  target: JsonRecord,
  method: string,
  key: string,
  allowEmpty = false
): void => {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(
      `Codex app-server ${method} parameter ${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`
    )
  }
  target[key] = value
}

const copyOptionalBoolean = (
  source: JsonRecord,
  target: JsonRecord,
  method: string,
  key: string
): void => {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'boolean') {
    throw new Error(`Codex app-server ${method} parameter ${key} must be a boolean.`)
  }
  target[key] = value
}

const safeSandbox = (value: unknown, method: string): 'read-only' | 'workspace-write' => {
  if (value === undefined) return 'read-only'
  if (value === 'read-only' || value === 'workspace-write') return value
  throw new Error(
    `Codex app-server ${method} sandbox must be read-only or workspace-write; full access is forbidden.`
  )
}

// The app-server protocol accepts arbitrary per-thread config overrides, but Research Agent callers
// never do. These values are injected only after caller keys have been validated so the adapter owns
// the complete legacy workspace-write policy: cwd is the sole implicit writable root, with no
// network, /tmp, or inherited TMPDIR escape.
const adapterOwnedThreadConfig = (): JsonRecord => ({
  'sandbox_workspace_write.writable_roots': [],
  'sandbox_workspace_write.network_access': false,
  'sandbox_workspace_write.exclude_tmpdir_env_var': true,
  'sandbox_workspace_write.exclude_slash_tmp': true
})

const safeThreadOptions = (
  value: unknown,
  method: 'thread/start' | 'thread/resume' | 'thread/fork',
  allowed: ReadonlySet<string>,
  pathAuthority: CodexPathAuthority,
  defaultCwd: string
): JsonRecord => {
  const source = requireRecord(value, method)
  assertAllowedKeys(method, source, allowed)
  const result: JsonRecord = {}
  copyOptionalString(source, result, method, 'model')
  copyOptionalString(source, result, method, 'modelProvider')
  if (source.cwd !== undefined) {
    result.cwd = pathAuthority.resolveAuthorizedDirectory(
      requireNonEmptyString(source.cwd, method, 'cwd'),
      `Codex app-server ${method} cwd`
    )
  } else {
    result.cwd = defaultCwd
  }
  copyOptionalString(source, result, method, 'baseInstructions', true)
  copyOptionalString(source, result, method, 'developerInstructions', true)
  if (method !== 'thread/resume') copyOptionalBoolean(source, result, method, 'ephemeral')

  // These values are owned by the adapter, not callers or ~/.codex defaults. They keep every
  // managed thread sandbox-backed and route any requested escape to the user.
  result.approvalPolicy = 'on-request'
  result.approvalsReviewer = 'user'
  result.sandbox = safeSandbox(source.sandbox, method)
  result.config = adapterOwnedThreadConfig()
  if (result.sandbox === 'workspace-write') {
    if (typeof result.cwd !== 'string') {
      throw new Error(
        `Codex app-server ${method} workspace-write requires a cwd inside an application-approved root.`
      )
    }
    result.cwd = pathAuthority.resolveWorkspaceDirectory(
      result.cwd,
      `Codex app-server ${method} workspace-write cwd`
    )
  }
  return result
}

const copyDetail = (source: JsonRecord, target: JsonRecord, method: string): void => {
  if (source.detail === undefined) return
  if (typeof source.detail !== 'string' || !IMAGE_DETAILS.has(source.detail)) {
    throw new Error(`Codex app-server ${method} input detail is invalid.`)
  }
  target.detail = source.detail
}

const safeRemoteUrl = (value: unknown, method: string, type: 'image' | 'audio'): string => {
  const raw = requireNonEmptyString(value, method, 'url')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Codex app-server ${method} ${type} URL is invalid.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'data:') {
    throw new Error(
      `Codex app-server ${method} ${type} URL must use HTTPS, HTTP, or an inline data URL.`
    )
  }
  return raw
}

const safeUserInput = (
  value: unknown,
  method: 'turn/start' | 'turn/steer',
  pathAuthority: CodexPathAuthority
): JsonRecord => {
  const source = requireRecord(value, `${method} input`)
  const type = requireNonEmptyString(source.type, `${method} input`, 'type')
  const allowed = USER_INPUT_KEYS[type]
  if (!allowed) throw new Error(`Codex app-server ${method} input type ${type} is not permitted.`)
  assertAllowedKeys(`${method} input`, source, allowed)
  const result: JsonRecord = { type }
  switch (type) {
    case 'text': {
      const text = requireNonEmptyString(source.text, `${method} input`, 'text')
      result.text = text
      if (source.text_elements !== undefined) {
        if (!Array.isArray(source.text_elements)) {
          throw new Error(`Codex app-server ${method} text_elements must be an array.`)
        }
        const textBytes = Buffer.byteLength(text, 'utf8')
        result.text_elements = source.text_elements.map((element) => {
          const record = requireRecord(element, `${method} text element`)
          assertAllowedKeys(`${method} text element`, record, new Set(['byteRange', 'placeholder']))
          const byteRange = requireRecord(record.byteRange, `${method} text element byteRange`)
          assertAllowedKeys(
            `${method} text element byteRange`,
            byteRange,
            new Set(['start', 'end'])
          )
          const { start, end } = byteRange
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            (start as number) < 0 ||
            (end as number) < (start as number) ||
            (end as number) > textBytes
          ) {
            throw new Error(`Codex app-server ${method} text element byte range is invalid.`)
          }
          if (
            record.placeholder !== undefined &&
            record.placeholder !== null &&
            typeof record.placeholder !== 'string'
          ) {
            throw new Error(`Codex app-server ${method} text element placeholder is invalid.`)
          }
          return {
            byteRange: { start, end },
            ...(record.placeholder === undefined ? {} : { placeholder: record.placeholder })
          }
        })
      }
      return result
    }
    case 'image':
      result.url = safeRemoteUrl(source.url, method, 'image')
      copyDetail(source, result, method)
      return result
    case 'audio':
      result.url = safeRemoteUrl(source.url, method, 'audio')
      return result
    case 'localImage':
      result.path = pathAuthority.resolveAuthorizedFile(
        requireNonEmptyString(source.path, `${method} input`, 'path'),
        `Codex app-server ${method} local image`
      )
      copyDetail(source, result, method)
      return result
    case 'localAudio':
      result.path = pathAuthority.resolveAuthorizedFile(
        requireNonEmptyString(source.path, `${method} input`, 'path'),
        `Codex app-server ${method} local audio`
      )
      return result
    case 'skill':
    case 'mention':
      result.name = requireNonEmptyString(source.name, `${method} input`, 'name')
      result.path = pathAuthority.resolveAuthorizedFile(
        requireNonEmptyString(source.path, `${method} input`, 'path'),
        `Codex app-server ${method} ${type}`
      )
      return result
    default:
      throw new Error(`Codex app-server ${method} input type ${type} is not permitted.`)
  }
}

const safeTurnStartParams = (value: unknown, pathAuthority: CodexPathAuthority): JsonRecord => {
  const method = 'turn/start'
  const source = requireRecord(value, method)
  assertAllowedKeys(method, source, TURN_START_KEYS)
  const result: JsonRecord = {
    threadId: requireNonEmptyString(source.threadId, method, 'threadId')
  }
  if (!Array.isArray(source.input)) {
    throw new Error(`Codex app-server ${method} parameter input must be an array.`)
  }
  result.input = source.input.map((input) => safeUserInput(input, method, pathAuthority))
  copyOptionalString(source, result, method, 'clientUserMessageId')
  copyOptionalString(source, result, method, 'model')
  copyOptionalString(source, result, method, 'effort')
  if ('outputSchema' in source && source.outputSchema !== undefined) {
    result.outputSchema = source.outputSchema
  }
  return result
}

const safeTurnSteerParams = (value: unknown, pathAuthority: CodexPathAuthority): JsonRecord => {
  const method = 'turn/steer'
  const source = requireRecord(value, method)
  assertAllowedKeys(method, source, TURN_STEER_KEYS)
  const result: JsonRecord = {
    threadId: requireNonEmptyString(source.threadId, method, 'threadId'),
    expectedTurnId: requireNonEmptyString(source.expectedTurnId, method, 'expectedTurnId')
  }
  if (!Array.isArray(source.input)) {
    throw new Error(`Codex app-server ${method} parameter input must be an array.`)
  }
  result.input = source.input.map((input) => safeUserInput(input, method, pathAuthority))
  copyOptionalString(source, result, method, 'clientUserMessageId')
  return result
}

const safeTurnInterruptParams = (value: unknown): JsonRecord => {
  const method = 'turn/interrupt'
  const source = requireRecord(value, method)
  assertAllowedKeys(method, source, TURN_INTERRUPT_KEYS)
  return {
    threadId: requireNonEmptyString(source.threadId, method, 'threadId'),
    turnId: requireNonEmptyString(source.turnId, method, 'turnId')
  }
}

const READ_ONLY_SANDBOX_KEYS = new Set(['type', 'networkAccess'])
const WORKSPACE_WRITE_SANDBOX_KEYS = new Set([
  'type',
  'writableRoots',
  'networkAccess',
  'excludeSlashTmp',
  'excludeTmpdirEnvVar'
])

const requireEffectiveThreadResponse = (
  value: unknown,
  method: 'thread/start' | 'thread/resume' | 'thread/fork',
  expected: JsonRecord,
  pathAuthority: CodexPathAuthority,
  expectedThreadId?: string,
  sourceThreadId?: string
): string => {
  const response = requireRecord(value, `${method} response`)
  const thread = requireRecord(response.thread, `${method} response thread`)
  const threadId = requireNonEmptyString(thread.id, `${method} response thread`, 'id')
  if (typeof thread.ephemeral !== 'boolean') {
    throw new Error(`Codex app-server ${method} response thread ephemeral flag is invalid.`)
  }
  if (
    thread.forkedFromId !== null &&
    (typeof thread.forkedFromId !== 'string' || !thread.forkedFromId.trim())
  ) {
    throw new Error(`Codex app-server ${method} response thread fork provenance is invalid.`)
  }
  if (expectedThreadId !== undefined && threadId !== expectedThreadId) {
    throw new Error(`Codex app-server ${method} returned a different thread id.`)
  }
  if (method !== 'thread/resume') {
    const expectedEphemeral = expected.ephemeral === true
    if (thread.ephemeral !== expectedEphemeral) {
      throw new Error(`Codex app-server ${method} did not apply the requested persistence mode.`)
    }
  }
  if (method === 'thread/start' && thread.forkedFromId !== null) {
    throw new Error(`Codex app-server ${method} unexpectedly returned a forked thread.`)
  }
  if (method === 'thread/fork') {
    if (sourceThreadId === undefined || threadId === sourceThreadId) {
      throw new Error(`Codex app-server ${method} did not create a distinct child thread.`)
    }
    if (thread.forkedFromId !== sourceThreadId) {
      throw new Error(`Codex app-server ${method} returned incorrect fork provenance.`)
    }
  }

  const expectedCwd = requireNonEmptyString(expected.cwd, method, 'cwd')
  const effectiveCwd = pathAuthority.resolveAuthorizedDirectory(
    requireNonEmptyString(response.cwd, `${method} response`, 'cwd'),
    `Codex app-server ${method} effective cwd`
  )
  if (effectiveCwd !== expectedCwd) {
    throw new Error(`Codex app-server ${method} did not apply the authorized cwd.`)
  }
  if (response.approvalPolicy !== 'on-request') {
    throw new Error(`Codex app-server ${method} did not apply the on-request approval policy.`)
  }
  if (response.approvalsReviewer !== 'user') {
    throw new Error(`Codex app-server ${method} did not route approvals to the user.`)
  }

  const expectedSandbox = expected.sandbox
  const sandbox = requireRecord(response.sandbox, `${method} response sandbox`)
  if (expectedSandbox === 'read-only') {
    assertAllowedKeys(`${method} response sandbox`, sandbox, READ_ONLY_SANDBOX_KEYS)
    if (sandbox.type !== 'readOnly') {
      throw new Error(`Codex app-server ${method} did not apply the read-only sandbox.`)
    }
  } else if (expectedSandbox === 'workspace-write') {
    assertAllowedKeys(`${method} response sandbox`, sandbox, WORKSPACE_WRITE_SANDBOX_KEYS)
    if (sandbox.type !== 'workspaceWrite') {
      throw new Error(`Codex app-server ${method} did not apply the workspace-write sandbox.`)
    }
    if (!Array.isArray(sandbox.writableRoots)) {
      throw new Error(`Codex app-server ${method} effective writable roots must be an array.`)
    }
    if (sandbox.writableRoots.length !== 0) {
      throw new Error(`Codex app-server ${method} enabled unapproved additional writable roots.`)
    }
    if (sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true) {
      throw new Error(`Codex app-server ${method} enabled unapproved temporary writable roots.`)
    }
  } else {
    throw new Error(`Codex app-server ${method} expected sandbox is invalid.`)
  }
  if (sandbox.networkAccess !== false) {
    throw new Error(`Codex app-server ${method} effective network access must be false.`)
  }

  const effectiveModel = requireNonEmptyString(response.model, `${method} response`, 'model')
  const effectiveProvider = requireNonEmptyString(
    response.modelProvider,
    `${method} response`,
    'modelProvider'
  )
  if (typeof expected.model === 'string' && effectiveModel !== expected.model) {
    throw new Error(`Codex app-server ${method} did not apply the requested model.`)
  }
  if (typeof expected.modelProvider === 'string' && effectiveProvider !== expected.modelProvider) {
    throw new Error(`Codex app-server ${method} did not apply the requested model provider.`)
  }
  return threadId
}

export class CodexAppServerRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CodexAppServerRpcError'
    this.code = code
    this.data = data
  }
}

export class CodexAppServerClient {
  readonly #transport: CodexAppServerTransport
  private readonly pending = new Map<CodexAppServerRequestId, PendingRequest>()
  private readonly notificationListeners = new Set<
    (notification: CodexAppServerNotification) => void
  >()
  private readonly protocolErrorListeners = new Set<(error: CodexAppServerProtocolError) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private readonly removeLineListener: () => void
  private readonly removeCloseListener: () => void
  private nextRequestId = 0
  private initialized = false
  private closed = false
  private readonly pathAuthority: CodexPathAuthority
  private readonly defaultCwd: string
  private readonly ownedThreadIds: Set<string>
  private readonly maxPendingRequests: number
  private readonly requestTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  readonly approvals: CodexApprovalBroker

  constructor(
    transport: CodexAppServerTransport,
    options: Readonly<{
      authorizedRoots: readonly string[]
      defaultCwd: string
      workspaceWriteRoots?: readonly string[]
      ownedThreadIds?: readonly string[]
      maxPendingRequests?: number
      requestTimeoutMs?: number
      onApprovalSettled?: (
        requestId: CodexAppServerRequestId,
        state: AcpPermissionSettlementState
      ) => void
      setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
      clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
    }>
  ) {
    this.#transport = transport
    this.pathAuthority = new CodexPathAuthority(options)
    this.defaultCwd = this.pathAuthority.resolveAuthorizedDirectory(
      options.defaultCwd,
      'Codex default cwd'
    )
    this.ownedThreadIds = new Set(
      (options.ownedThreadIds ?? []).map((threadId) =>
        requireNonEmptyString(threadId, 'owned thread', 'threadId')
      )
    )
    this.maxPendingRequests = options.maxPendingRequests ?? MAX_CODEX_APP_SERVER_PENDING_REQUESTS
    this.requestTimeoutMs = options.requestTimeoutMs ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.maxPendingRequests) ||
      this.maxPendingRequests < 1 ||
      this.maxPendingRequests > MAX_CODEX_APP_SERVER_PENDING_REQUESTS
    ) {
      throw new Error('Codex app-server pending-request limit is invalid.')
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error('Codex app-server request timeout is invalid.')
    }
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
    this.approvals = new CodexApprovalBroker(
      (id, response) => this.#write({ id, ...response }),
      (threadId) => this.ownedThreadIds.has(threadId)
    )
    if (options.onApprovalSettled) this.approvals.setSettlementHandler(options.onApprovalSettled)
    this.removeLineListener = transport.onLine((line) => this.handleLine(line))
    this.removeCloseListener = transport.onClose((error) => this.handleClose(error))
  }

  isInitialized(): boolean {
    return this.initialized
  }

  hasOwnedThread(threadId: string): boolean {
    return this.ownedThreadIds.has(requireNonEmptyString(threadId, 'owned thread', 'threadId'))
  }

  registerOwnedThread(threadId: string): void {
    this.ownedThreadIds.add(requireNonEmptyString(threadId, 'owned thread', 'threadId'))
  }

  unregisterOwnedThread(threadId: string): void {
    this.ownedThreadIds.delete(requireNonEmptyString(threadId, 'owned thread', 'threadId'))
  }

  async initialize(clientInfo: CodexAppServerClientInfo): Promise<CodexAppServerInitializeResult> {
    if (this.initialized) throw new Error('Codex app-server client is already initialized.')
    const result = await this.#sendRequest<CodexAppServerInitializeResult>(
      'initialize',
      {
        clientInfo,
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: CODEX_APP_SERVER_OPTOUT_NOTIFICATION_METHODS
        }
      },
      true
    )
    this.#sendInitializedNotification()
    this.initialized = true
    return result
  }

  startThread<Result = unknown>(params: CodexThreadStartParams = {}): Promise<Result> {
    const safe = safeThreadOptions(
      params,
      'thread/start',
      THREAD_START_KEYS,
      this.pathAuthority,
      this.defaultCwd
    )
    return this.#sendRequest<Result>('thread/start', safe, false).then(async (result) => {
      const threadId = await this.validateThreadLifecycleResponse(result, 'thread/start', safe)
      this.ownedThreadIds.add(threadId)
      return result
    })
  }

  resumeThread<Result = unknown>(
    threadId: string,
    options: CodexThreadResumeOptions = {}
  ): Promise<Result> {
    this.assertOwnedThread(threadId, 'thread/resume')
    const safe = safeThreadOptions(
      options,
      'thread/resume',
      THREAD_RESUME_KEYS,
      this.pathAuthority,
      this.defaultCwd
    )
    return this.#sendRequest<Result>(
      'thread/resume',
      {
        threadId: requireNonEmptyString(threadId, 'thread/resume', 'threadId'),
        ...safe
      },
      false
    ).then(async (result) => {
      await this.validateThreadLifecycleResponse(result, 'thread/resume', safe, threadId)
      return result
    })
  }

  forkThread<Result = unknown>(params: CodexThreadForkParams): Promise<Result> {
    const source = requireRecord(params, 'thread/fork')
    const sourceThreadId = requireNonEmptyString(source.threadId, 'thread/fork', 'threadId')
    this.assertOwnedThread(sourceThreadId, 'thread/fork')
    const safe = safeThreadOptions(
      source,
      'thread/fork',
      THREAD_FORK_KEYS,
      this.pathAuthority,
      this.defaultCwd
    )
    return this.#sendRequest<Result>(
      'thread/fork',
      {
        threadId: sourceThreadId,
        ...('lastTurnId' in source && source.lastTurnId !== undefined
          ? {
              lastTurnId: requireNonEmptyString(source.lastTurnId, 'thread/fork', 'lastTurnId')
            }
          : {}),
        ...safe
      },
      false
    ).then(async (result) => {
      const threadId = await this.validateThreadLifecycleResponse(
        result,
        'thread/fork',
        safe,
        undefined,
        sourceThreadId
      )
      this.ownedThreadIds.add(threadId)
      return result
    })
  }

  readThread<Result = unknown>(threadId: string, includeTurns = false): Promise<Result> {
    this.assertOwnedThread(threadId, 'thread/read')
    return this.#sendRequest<Result>(
      'thread/read',
      {
        threadId: requireNonEmptyString(threadId, 'thread/read', 'threadId'),
        includeTurns
      },
      false
    )
  }

  async listThreads<Result = unknown>(
    params: Readonly<Record<string, unknown>> = {}
  ): Promise<Result> {
    const response = await this.#sendRequest<unknown>(
      'thread/list',
      requireRecord(params, 'thread/list'),
      false
    )
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new Error('Codex app-server thread/list returned an unsupported response.')
    }
    return {
      ...response,
      data: response.data.filter(
        (thread) =>
          isRecord(thread) && typeof thread.id === 'string' && this.ownedThreadIds.has(thread.id)
      )
    } as Result
  }

  startTurn<Result = unknown>(params: CodexTurnStartParams): Promise<Result> {
    this.assertOwnedThread(params.threadId, 'turn/start')
    return this.#sendRequest<Result>(
      'turn/start',
      safeTurnStartParams(params, this.pathAuthority),
      false
    )
  }

  steerTurn<Result = { turnId: string }>(params: CodexTurnSteerParams): Promise<Result> {
    this.assertOwnedThread(params.threadId, 'turn/steer')
    return this.#sendRequest<Result>(
      'turn/steer',
      safeTurnSteerParams(params, this.pathAuthority),
      false
    )
  }

  interruptTurn<Result = Record<string, never>>(params: CodexTurnInterruptParams): Promise<Result> {
    this.assertOwnedThread(params.threadId, 'turn/interrupt')
    return this.#sendRequest<Result>('turn/interrupt', safeTurnInterruptParams(params), false)
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onProtocolError(listener: (error: CodexAppServerProtocolError) => void): () => void {
    this.protocolErrorListeners.add(listener)
    return () => this.protocolErrorListeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  setApprovalHandler(handler: CodexApprovalHandler): () => void {
    return this.approvals.setHandler(handler)
  }

  setApprovalSettlementHandler(
    handler: (requestId: CodexAppServerRequestId, state: AcpPermissionSettlementState) => void
  ): () => void {
    return this.approvals.setSettlementHandler(handler)
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.approvals.close()
      this.handleClose()
    }
    await this.#transport.close()
  }

  #sendRequest<Result>(
    method: AllowedRequestMethod,
    params: unknown,
    allowBeforeInitialization: boolean
  ): Promise<Result> {
    this.assertUsable(method, allowBeforeInitialization)
    if (this.pending.size >= this.maxPendingRequests) {
      throw new Error('Codex app-server pending-request limit has been reached.')
    }
    const id = this.nextRequestId++
    return new Promise<Result>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as Result),
        reject
      }
      this.pending.set(id, pending)
      pending.timeout = this.setTimer(() => {
        if (this.pending.get(id) !== pending) return
        this.failClosed(new Error(`Codex app-server request ${method} timed out.`))
      }, this.requestTimeoutMs)
      try {
        this.#write({ method, id, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        this.pending.delete(id)
        if (pending.timeout !== undefined) this.clearTimer(pending.timeout)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #sendInitializedNotification(): void {
    this.assertUsable('initialized', true)
    this.#write({ method: 'initialized' })
  }

  private assertUsable(method: string, allowBeforeInitialization: boolean): void {
    if (this.closed) throw new Error('Codex app-server client is closed.')
    if (!allowBeforeInitialization && !this.initialized) {
      throw new Error(`Codex app-server method ${method} requires initialization.`)
    }
  }

  private assertOwnedThread(threadId: unknown, method: string): asserts threadId is string {
    const normalized = requireNonEmptyString(threadId, method, 'threadId')
    if (!this.ownedThreadIds.has(normalized)) {
      throw new Error(`Codex app-server ${method} is not linked to this Research Agent session.`)
    }
  }

  private async validateThreadLifecycleResponse(
    result: unknown,
    method: 'thread/start' | 'thread/resume' | 'thread/fork',
    expected: JsonRecord,
    expectedThreadId?: string,
    sourceThreadId?: string
  ): Promise<string> {
    try {
      return requireEffectiveThreadResponse(
        result,
        method,
        expected,
        this.pathAuthority,
        expectedThreadId,
        sourceThreadId
      )
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  #write(message: JsonRecord): void {
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_CODEX_APP_SERVER_JSONL_BYTES) {
      throw new Error('Codex app-server outbound JSONL message exceeds the size limit.')
    }
    this.#transport.write(line)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_CODEX_APP_SERVER_JSONL_BYTES) {
      this.failClosed(new Error('Codex app-server JSONL message exceeds the size limit.'))
      return
    }
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch (cause) {
      this.failClosed(new Error('Invalid JSON from Codex app-server.'), { cause })
      return
    }
    if (!isRecord(message)) {
      this.failClosed(new Error('Non-object message from Codex app-server.'))
      return
    }
    if ('params' in message) {
      const serializedParams = JSON.stringify(message.params)
      if (
        typeof serializedParams === 'string' &&
        Buffer.byteLength(serializedParams, 'utf8') > MAX_CODEX_APP_SERVER_NOTIFICATION_BYTES
      ) {
        this.failClosed(new Error('Codex app-server notification exceeds the size limit.'))
        return
      }
    }

    if (isRequestId(message.id) && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        this.failClosed(
          new Error(`Response for unknown Codex app-server request id ${String(message.id)}.`)
        )
        return
      }
      this.pending.delete(message.id)
      if (pending.timeout !== undefined) this.clearTimer(pending.timeout)
      if (isRecord(message.error)) {
        const code = typeof message.error.code === 'number' ? message.error.code : -32_000
        const text =
          typeof message.error.message === 'string'
            ? safeProtocolErrorText(message.error.message)
            : 'Codex app-server request failed.'
        // Provider error data can contain request fragments, credentials, or local paths. The
        // stable RPC code/message are enough for runtime classification; raw server data stays at
        // the protocol boundary and never enters application error state.
        pending.reject(new CodexAppServerRpcError(code, text))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && isRequestId(message.id)) {
      this.approvals.dispatch(message.id, message.method, message.params)
      return
    }

    if (typeof message.method === 'string') {
      if (
        message.method === 'serverRequest/resolved' &&
        isRecord(message.params) &&
        isRequestId(message.params.requestId)
      ) {
        this.approvals.markResolved(message.params.requestId)
      }
      const notification: CodexAppServerNotification = {
        method: message.method,
        ...('params' in message ? { params: message.params } : {})
      }
      for (const listener of this.notificationListeners) listener(notification)
      return
    }

    this.failClosed(new Error('Unrecognized message from Codex app-server.'))
  }

  private emitProtocolError(error: CodexAppServerProtocolError): void {
    for (const listener of this.protocolErrorListeners) listener(error)
  }

  private failClosed(error: Error, details: Pick<CodexAppServerProtocolError, 'cause'> = {}): void {
    this.emitProtocolError({ message: error.message, ...details })
    this.handleClose(error)
    void this.#transport.close().catch(() => undefined)
  }

  private handleClose(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.initialized = false
    this.approvals.close(false)
    this.removeLineListener()
    this.removeCloseListener()
    const closeError = error ?? new Error('Codex app-server transport closed.')
    for (const pending of this.pending.values()) {
      if (pending.timeout !== undefined) this.clearTimer(pending.timeout)
      pending.reject(closeError)
    }
    this.pending.clear()
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
  }
}
