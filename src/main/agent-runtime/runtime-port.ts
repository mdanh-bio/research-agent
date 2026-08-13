import type { AcpRuntimeEvent } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'

export type AgentRuntimeSandbox = 'read-only' | 'workspace-write'

export type AgentRuntimeInput = Readonly<
  | { kind: 'text'; text: string }
  | {
      kind: 'image'
      source: 'url' | 'path'
      value: string
      detail?: 'auto' | 'low' | 'high' | 'original'
    }
  | { kind: 'audio'; source: 'url' | 'path'; value: string }
  | { kind: 'skill' | 'mention'; name: string; path: string }
>

export type AgentRuntimeSessionRequest = Readonly<{
  appSessionId: string
  agentRunId: string
  cwd: string
  model?: string
  modelProvider?: string
  sandbox: AgentRuntimeSandbox
  baseInstructions?: string
  developerInstructions?: string
  ephemeral?: boolean
  parentRuntimeThreadId?: string
  lastTurnId?: string
}>

export type AgentRuntimeResumeRequest = AgentRuntimeSessionRequest &
  Readonly<{
    runtimeThreadId?: string
  }>

export type AgentRuntimeTurnRequest = Readonly<{
  appSessionId: string
  input: readonly AgentRuntimeInput[]
  clientUserMessageId?: string
  model?: string
  effort?: string
  outputSchema?: unknown
}>

export type AgentRuntimeTurnAdmission = Readonly<{
  appSessionId: string
  runtimeThreadId: string
  runtimeTurnId: string
  acceptedAt: number
}>

export type AgentRuntimeSessionStatus =
  'starting' | 'idle' | 'running' | 'cancelling' | 'closed' | 'error'

export type AgentRuntimeSessionState = Readonly<{
  appSessionId: string
  backend: AgentFrameworkId
  runtimeThreadId: string
  parentRuntimeThreadId?: string
  ephemeral: boolean
  cwd: string
  sandbox: AgentRuntimeSandbox
  model?: string
  modelProvider?: string
  status: AgentRuntimeSessionStatus
  activeTurnId?: string
  lastTerminalTurnId?: string
  errorCode?: string
  updatedAt: number
}>

// Runtime events are already renderer-safe application projections. Provider RPC envelopes and
// credentials never cross this port.
export type AgentRuntimeEvent = Readonly<{
  runtimeThreadId: string
  runtimeTurnId?: string
  terminal?: boolean
  event: Omit<AcpRuntimeEvent, 'id' | 'timestamp'>
}>

export type AgentRuntimeSteerRequest = Readonly<{
  appSessionId: string
  expectedTurnId: string
  input: readonly AgentRuntimeInput[]
  clientUserMessageId?: string
}>

export type AgentRuntimeForkRequest = AgentRuntimeSessionRequest &
  Readonly<{
    parentAppSessionId: string
  }>

export type AgentRuntimeCapabilities = Readonly<{
  nativeSteer?: (request: AgentRuntimeSteerRequest) => Promise<AgentRuntimeTurnAdmission>
  nativeFork?: (request: AgentRuntimeForkRequest) => Promise<AgentRuntimeSessionState>
}>

export interface AgentRuntimePort {
  readonly backend: AgentFrameworkId
  readonly capabilities: AgentRuntimeCapabilities
  start(request: AgentRuntimeSessionRequest): Promise<AgentRuntimeSessionState>
  resume(request: AgentRuntimeResumeRequest): Promise<AgentRuntimeSessionState>
  readState(appSessionId: string): Promise<AgentRuntimeSessionState>
  startTurn(request: AgentRuntimeTurnRequest): Promise<AgentRuntimeTurnAdmission>
  cancel(appSessionId: string, expectedTurnId?: string): Promise<void>
  interruptAndAwaitTerminal?(appSessionId: string, expectedTurnId: string): Promise<void>
  closeSession(appSessionId: string): Promise<void>
  close(): Promise<void>
  onEvent(listener: (event: AgentRuntimeEvent) => void): () => void
}
