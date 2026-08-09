export type CodexAppServerRequestId = number | string

export type CodexAppServerClientInfo = Readonly<{
  name: string
  title: string
  version: string
}>

export type CodexAppServerInitializeResult = Readonly<{
  userAgent?: string
  platformFamily?: string
  platformOs?: string
  [key: string]: unknown
}>

export type CodexUserInput =
  | Readonly<{
      type: 'text'
      text: string
      text_elements?: readonly Readonly<{
        byteRange: Readonly<{ start: number; end: number }>
        placeholder?: string | null
      }>[]
    }>
  | Readonly<{ type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' | 'original' }>
  | Readonly<{ type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' | 'original' }>
  | Readonly<{ type: 'audio'; url: string }>
  | Readonly<{ type: 'localAudio'; path: string }>
  | Readonly<{ type: 'skill'; name: string; path: string }>
  | Readonly<{ type: 'mention'; name: string; path: string }>

// Research Agent deliberately exposes only Codex's sandbox-backed modes. The app-server's
// `danger-full-access` mode is not part of this adapter contract.
export type CodexSafeSandboxMode = 'read-only' | 'workspace-write'

export type CodexThreadStartParams = Readonly<{
  model?: string
  modelProvider?: string
  cwd?: string
  sandbox?: CodexSafeSandboxMode
  baseInstructions?: string
  developerInstructions?: string
  ephemeral?: boolean
}>

export type CodexThreadResumeOptions = Readonly<{
  model?: string
  modelProvider?: string
  cwd?: string
  sandbox?: CodexSafeSandboxMode
  baseInstructions?: string
  developerInstructions?: string
}>

export type CodexThreadForkParams = Readonly<{
  threadId: string
  lastTurnId?: string
  model?: string
  modelProvider?: string
  cwd?: string
  sandbox?: CodexSafeSandboxMode
  baseInstructions?: string
  developerInstructions?: string
  ephemeral?: boolean
}>

export type CodexTurnStartParams = Readonly<{
  threadId: string
  input: readonly CodexUserInput[]
  clientUserMessageId?: string
  model?: string
  effort?: string
  outputSchema?: unknown
}>

export type CodexTurnSteerParams = Readonly<{
  threadId: string
  expectedTurnId: string
  input: readonly CodexUserInput[]
  clientUserMessageId?: string
}>

export type CodexTurnInterruptParams = Readonly<{
  threadId: string
  turnId: string
}>

export type CodexAppServerNotification = Readonly<{
  method: string
  params?: unknown
}>

export type CodexApprovalDecision = 'accept' | 'decline' | 'cancel'

export type CodexCommandApprovalRequest = Readonly<{
  kind: 'command-execution'
  requestId: CodexAppServerRequestId
  itemId: string
  threadId: string
  turnId: string
  startedAtMs: number
  approvalId?: string
  environmentId?: string
  reason?: string
  command?: string
  cwd?: string
  networkApprovalContext?: Readonly<{
    host: string
    protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp'
  }>
}>

export type CodexFileChangeApprovalRequest = Readonly<{
  kind: 'file-change'
  requestId: CodexAppServerRequestId
  itemId: string
  threadId: string
  turnId: string
  startedAtMs: number
  reason?: string
  grantRoot?: string
}>

// The direct app-server adapter intentionally supports only the two stable, sandbox-related
// approval requests used by the v1 trust boundary. Session-wide approvals and exec-policy
// amendments are not representable here: every acceptance is for this exact request only.
export type CodexApprovalRequest = CodexCommandApprovalRequest | CodexFileChangeApprovalRequest

export type CodexApprovalHandler = (
  request: CodexApprovalRequest
) => CodexApprovalDecision | Promise<CodexApprovalDecision>

export type CodexAppServerProtocolError = Readonly<{
  message: string
  line?: string
  cause?: unknown
}>

export interface CodexAppServerTransport {
  write(message: string): void
  onLine(listener: (line: string) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(): Promise<void>
}
