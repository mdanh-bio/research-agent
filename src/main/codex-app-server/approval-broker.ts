import type {
  CodexAppServerRequestId,
  CodexApprovalDecision,
  CodexApprovalHandler,
  CodexApprovalRequest
} from './types'
import type { AcpPermissionSettlementState } from '../../shared/acp'

type JsonRecord = Record<string, unknown>

type ApprovalResponseWriter = (
  id: CodexAppServerRequestId,
  response:
    | Readonly<{ result: Readonly<{ decision: CodexApprovalDecision }> }>
    | Readonly<{ error: Readonly<{ code: number; message: string }> }>
) => void

type ApprovalSettlementHandler = (
  requestId: CodexAppServerRequestId,
  state: AcpPermissionSettlementState
) => void

const COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval'
const FILE_CHANGE_APPROVAL_METHOD = 'item/fileChange/requestApproval'
const METHOD_NOT_FOUND = -32_601
const INVALID_PARAMS = -32_602

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (params: JsonRecord, key: string): string => {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Codex approval parameter ${key} must be a non-empty string.`)
  }
  return value
}

const optionalString = (params: JsonRecord, key: string): string | undefined => {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`Codex approval parameter ${key} must be a string.`)
  }
  return value
}

const requiredTimestamp = (params: JsonRecord): number => {
  const value = params.startedAtMs
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Codex approval parameter startedAtMs must be a non-negative integer.')
  }
  return value as number
}

const optionalNetworkContext = (
  value: unknown
):
  | Readonly<{ host: string; protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp' }>
  | undefined => {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new Error('Codex command approval network context must be an object.')
  }
  const host = requiredString(value, 'host')
  const protocol = requiredString(value, 'protocol')
  if (
    protocol !== 'http' &&
    protocol !== 'https' &&
    protocol !== 'socks5Tcp' &&
    protocol !== 'socks5Udp'
  ) {
    throw new Error('Codex command approval network context protocol is invalid.')
  }
  return Object.freeze({ host, protocol })
}

const parseApprovalRequest = (
  id: CodexAppServerRequestId,
  method: string,
  rawParams: unknown
): CodexApprovalRequest => {
  if (!isRecord(rawParams)) throw new Error('Codex approval parameters must be an object.')
  const common = {
    requestId: id,
    itemId: requiredString(rawParams, 'itemId'),
    threadId: requiredString(rawParams, 'threadId'),
    turnId: requiredString(rawParams, 'turnId'),
    startedAtMs: requiredTimestamp(rawParams)
  }
  if (method === COMMAND_APPROVAL_METHOD) {
    const approvalId = optionalString(rawParams, 'approvalId')
    const environmentId = optionalString(rawParams, 'environmentId')
    const reason = optionalString(rawParams, 'reason')
    const command = optionalString(rawParams, 'command')
    const cwd = optionalString(rawParams, 'cwd')
    const networkApprovalContext = optionalNetworkContext(rawParams.networkApprovalContext)
    return Object.freeze({
      kind: 'command-execution' as const,
      ...common,
      ...(approvalId === undefined ? {} : { approvalId }),
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(reason === undefined ? {} : { reason }),
      ...(command === undefined ? {} : { command }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(networkApprovalContext === undefined ? {} : { networkApprovalContext })
    })
  }
  if (method === FILE_CHANGE_APPROVAL_METHOD) {
    const reason = optionalString(rawParams, 'reason')
    const grantRoot = optionalString(rawParams, 'grantRoot')
    return Object.freeze({
      kind: 'file-change' as const,
      ...common,
      ...(reason === undefined ? {} : { reason }),
      ...(grantRoot === undefined ? {} : { grantRoot })
    })
  }
  throw new Error(`Unsupported Codex app-server request method ${method}.`)
}

const isApprovalDecision = (value: unknown): value is CodexApprovalDecision =>
  value === 'accept' || value === 'decline' || value === 'cancel'

// Owns the only path from a server-initiated approval request to a positive response. Callers
// provide one typed handler and return a narrow, single-use decision; they never receive a raw
// JSON-RPC responder or permission to amend Codex's execution policy.
export class CodexApprovalBroker {
  private handler?: CodexApprovalHandler
  private settlementHandler?: ApprovalSettlementHandler
  private closed = false
  private readonly pending = new Map<string, CodexAppServerRequestId>()

  constructor(
    private readonly writeResponse: ApprovalResponseWriter,
    private readonly isOwnedThread: (threadId: string) => boolean
  ) {}

  setHandler(handler: CodexApprovalHandler): () => void {
    if (this.closed) throw new Error('Codex approval broker is closed.')
    if (this.handler) throw new Error('Codex approval broker already has a handler.')
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }

  setSettlementHandler(handler: ApprovalSettlementHandler): () => void {
    if (this.closed) throw new Error('Codex approval broker is closed.')
    if (this.settlementHandler)
      throw new Error('Codex approval broker already has a settlement handler.')
    this.settlementHandler = handler
    return () => {
      if (this.settlementHandler === handler) this.settlementHandler = undefined
    }
  }

  private settle(id: CodexAppServerRequestId, state: AcpPermissionSettlementState): void {
    this.settlementHandler?.(id, state)
  }

  dispatch(id: CodexAppServerRequestId, method: string, params: unknown): void {
    if (this.closed) return
    if (method !== COMMAND_APPROVAL_METHOD && method !== FILE_CHANGE_APPROVAL_METHOD) {
      this.writeResponse(id, {
        error: {
          code: METHOD_NOT_FOUND,
          message: 'Research Agent denies unsupported app-server requests.'
        }
      })
      return
    }

    let request: CodexApprovalRequest
    try {
      request = parseApprovalRequest(id, method, params)
    } catch (error) {
      this.writeResponse(id, {
        error: {
          code: INVALID_PARAMS,
          message: error instanceof Error ? error.message : 'Invalid Codex approval parameters.'
        }
      })
      return
    }

    const key = `${typeof id}:${String(id)}`
    if (this.pending.has(key)) {
      this.writeResponse(id, {
        error: { code: INVALID_PARAMS, message: 'Duplicate Codex approval request id.' }
      })
      return
    }
    const handler = this.handler
    if (!this.isOwnedThread(request.threadId)) {
      this.writeResponse(id, { result: { decision: 'decline' } })
      return
    }
    // `grantRoot` asks for a session-scoped write expansion in the pinned protocol. The Research
    // Agent v1 approval contract is exact and single-use, so there is no positive representation.
    if (request.kind === 'file-change' && request.grantRoot !== undefined) {
      this.writeResponse(id, { result: { decision: 'decline' } })
      return
    }
    if (!handler) {
      this.writeResponse(id, { result: { decision: 'decline' } })
      return
    }

    this.pending.set(key, id)
    void Promise.resolve()
      .then(() => handler(request))
      .then((decision) => {
        if (!this.pending.delete(key)) return
        const normalized = isApprovalDecision(decision) ? decision : 'decline'
        this.writeResponse(id, { result: { decision: normalized } })
        this.settle(
          id,
          normalized === 'accept' ? 'resolved' : normalized === 'cancel' ? 'cancelled' : 'rejected'
        )
      })
      .catch(() => {
        if (!this.pending.delete(key)) return
        this.writeResponse(id, { result: { decision: 'decline' } })
        this.settle(id, 'rejected')
      })
  }

  markResolved(id: CodexAppServerRequestId): void {
    if (!this.pending.delete(`${typeof id}:${String(id)}`)) return
    this.settle(id, 'cancelled')
  }

  close(respondToPending = true): void {
    if (this.closed) return
    this.closed = true
    for (const [key, id] of this.pending) {
      this.pending.delete(key)
      if (respondToPending) this.writeResponse(id, { result: { decision: 'cancel' } })
      this.settle(id, 'cancelled')
    }
    this.handler = undefined
    this.settlementHandler = undefined
  }
}

export const CODEX_APPROVAL_REQUEST_METHODS = Object.freeze([
  COMMAND_APPROVAL_METHOD,
  FILE_CHANGE_APPROVAL_METHOD
] as const)
