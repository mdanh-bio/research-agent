import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

import type { ComputeHost } from '../../shared/compute'
import type { ComputeDispatchApprovalSummary } from '../../shared/compute-scheduler'
import type { ResolvedSshTarget } from './ssh-runner'
import { resolvedSshTargetHash } from './ssh-runner'

export type InputContentIdentity = {
  sizeBytes: number
  sha256: string
}

export type StagedInputEntry =
  | {
      kind: 'upload'
      // Absolute path selected by the workspace/artifact authority. It may be an in-root symlink.
      sourcePath: string
      // Canonical regular-file path used for hashing and staging.
      localPath: string
      // Canonical root that authorized this input. Persisting it lets queued dispatch fail closed if
      // either the root or source symlink is retargeted after approval.
      authorizedRoot: string
      dstFilename: string
      label: string
      contentIdentity?: InputContentIdentity
    }
  | { kind: 'symlink'; remotePath: string; dstFilename: string; label: string }

export type ApprovedUploadInputEntry = Extract<StagedInputEntry, { kind: 'upload' }> & {
  contentIdentity: InputContentIdentity
}

export type DirectSshHostProof = {
  hostId: string
  providerId: string
  sshAlias: string
  sshOverridesHash: string
  probeAt: string
}

export type ApprovedDispatchBinding = {
  version: 2
  hostProof: DirectSshHostProof
  sshTarget: ResolvedSshTarget
  inputs: ApprovedUploadInputEntry[]
  scriptHash: string
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const isPathInsideOrEqual = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (!isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
}

export type AuthorizedLocalInputPath = Readonly<{
  sourcePath: string
  localPath: string
  authorizedRoot: string
}>

// Resolves an explicitly authorized root and source through the live filesystem. Symlinks are
// allowed only when their canonical target remains inside that root; an outside target is rejected
// before any content read or approval request.
export const resolveAuthorizedLocalInputPath = async (
  sourcePath: string,
  authorizedRoot: string
): Promise<AuthorizedLocalInputPath> => {
  if (!isAbsolute(sourcePath) || !isAbsolute(authorizedRoot)) {
    throw new Error('Compute input source and authorized root must be absolute paths.')
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(authorizedRoot),
    realpath(sourcePath)
  ])
  const rootMetadata = await stat(canonicalRoot)
  if (!rootMetadata.isDirectory()) {
    throw new Error(`Compute input authorized root is not a directory: ${authorizedRoot}`)
  }
  if (!isPathInsideOrEqual(canonicalRoot, canonicalPath)) {
    throw new Error('Compute input resolves outside its authorized root.')
  }
  return Object.freeze({ sourcePath, localPath: canonicalPath, authorizedRoot: canonicalRoot })
}

const assertAuthorizedLocalInputPath = async (
  entry: Pick<ApprovedUploadInputEntry, 'sourcePath' | 'localPath' | 'authorizedRoot'>
): Promise<void> => {
  const current = await resolveAuthorizedLocalInputPath(entry.sourcePath, entry.authorizedRoot)
  const canonicalLocalPath = await realpath(entry.localPath)
  if (
    current.authorizedRoot !== entry.authorizedRoot ||
    current.localPath !== entry.localPath ||
    canonicalLocalPath !== entry.localPath
  ) {
    throw new Error('Compute input path or authorized root changed after selection.')
  }
}

const canonicalOverrides = (host: ComputeHost): string =>
  JSON.stringify({
    user: host.sshOverrides?.user?.trim() || undefined,
    port: host.sshOverrides?.port,
    identityFile: host.sshOverrides?.identityFile?.trim() || undefined
  })

export const directSshHostProof = (host: ComputeHost): DirectSshHostProof | undefined => {
  const probe = host.probeResult
  if (
    host.shape !== 'direct_ssh' ||
    !probe?.ok ||
    probe.exitCode !== 0 ||
    probe.detectedScheduler !== 'none'
  ) {
    return undefined
  }
  return {
    hostId: host.id,
    providerId: host.providerId,
    sshAlias: host.sshAlias,
    sshOverridesHash: sha256(canonicalOverrides(host)),
    probeAt: probe.probedAt
  }
}

export const sameDirectSshHostProof = (approved: DirectSshHostProof, host: ComputeHost): boolean =>
  JSON.stringify(approved) === JSON.stringify(directSshHostProof(host))

const localFileIdentity = async (localPath: string): Promise<InputContentIdentity> => {
  const before = await stat(localPath)
  if (!before.isFile()) throw new Error(`Compute input is not a regular file: ${localPath}`)

  const hash = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(localPath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(bytes)
    sizeBytes += bytes.byteLength
  }

  const after = await stat(localPath)
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    sizeBytes !== after.size
  ) {
    throw new Error(
      `Compute input changed while its content identity was being calculated: ${localPath}`
    )
  }
  return { sizeBytes, sha256: hash.digest('hex') }
}

export const bindInputContentIdentities = async (
  entries: StagedInputEntry[]
): Promise<ApprovedUploadInputEntry[]> => {
  const approved: ApprovedUploadInputEntry[] = []
  for (const entry of entries) {
    if (entry.kind !== 'upload') {
      throw new Error(
        `Remote input "${entry.label}" cannot be approved until its content identity can be verified.`
      )
    }
    await assertAuthorizedLocalInputPath(entry)
    const contentIdentity = await localFileIdentity(entry.localPath)
    await assertAuthorizedLocalInputPath(entry)
    approved.push({ ...entry, contentIdentity })
  }
  return approved
}

export const revalidateInputContentIdentities = async (
  entries: ApprovedUploadInputEntry[]
): Promise<void> => {
  for (const entry of entries) {
    await assertAuthorizedLocalInputPath(entry)
    const current = await localFileIdentity(entry.localPath)
    await assertAuthorizedLocalInputPath(entry)
    if (
      current.sha256 !== entry.contentIdentity.sha256 ||
      current.sizeBytes !== entry.contentIdentity.sizeBytes
    ) {
      throw new Error(`Compute input changed after approval: ${entry.label}`)
    }
  }
}

export const buildApprovedDispatchBinding = (
  host: ComputeHost,
  sshTarget: ResolvedSshTarget,
  inputs: ApprovedUploadInputEntry[],
  scriptHash: string
): ApprovedDispatchBinding => {
  const hostProof = directSshHostProof(host)
  if (!hostProof) throw new Error('The compute host does not have a successful direct-SSH probe.')
  if (!sshTarget.connectionIdentity?.configResolved) {
    throw new Error('The effective SSH endpoint and options could not be resolved with ssh -G.')
  }
  if (!/^[a-f0-9]{64}$/.test(scriptHash)) throw new Error('The approved script hash is invalid.')
  return { version: 2, hostProof, sshTarget, inputs, scriptHash }
}

export const approvedDispatchBindingHash = (binding: ApprovedDispatchBinding): string =>
  sha256(JSON.stringify(binding))

export const buildDispatchApprovalSummary = (
  binding: ApprovedDispatchBinding
): ComputeDispatchApprovalSummary => {
  const identity = binding.sshTarget.connectionIdentity
  if (!identity?.configResolved) throw new Error('The approved SSH identity is unavailable.')
  return {
    binding_hash: approvedDispatchBindingHash(binding),
    inputs: binding.inputs.map((entry) => ({
      destination: entry.dstFilename,
      label: entry.label,
      size_bytes: entry.contentIdentity.sizeBytes,
      sha256: entry.contentIdentity.sha256
    })),
    ssh_target: {
      alias: identity.alias,
      hostname: identity.hostname,
      user: identity.user ?? null,
      port: identity.port,
      identity_file: identity.identityFile ?? null,
      proxy_jump: identity.proxyJump ?? null,
      host_key_alias: identity.hostKeyAlias ?? null,
      proxy_command_hash: identity.proxyCommandHash ?? null,
      effective_config_hash: identity.effectiveConfigHash,
      invocation_options: [...binding.sshTarget.extraArgs],
      invocation_hash: resolvedSshTargetHash(binding.sshTarget)
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseApprovedDispatchBinding = (raw: string | undefined): ApprovedDispatchBinding => {
  let value: unknown
  try {
    value = raw ? JSON.parse(raw) : undefined
  } catch {
    throw new Error('The approved dispatch binding is not valid JSON.')
  }
  if (!isRecord(value) || value['version'] !== 2) {
    throw new Error('The job has no supported approved dispatch binding.')
  }
  const binding = value as ApprovedDispatchBinding
  if (
    !isRecord(binding.hostProof) ||
    !isRecord(binding.sshTarget) ||
    !isRecord(binding.sshTarget.connectionIdentity) ||
    !binding.sshTarget.connectionIdentity.configResolved ||
    !Array.isArray(binding.sshTarget.extraArgs) ||
    typeof binding.scriptHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.scriptHash) ||
    !Array.isArray(binding.inputs) ||
    binding.inputs.some(
      (entry) =>
        !isRecord(entry) ||
        entry.kind !== 'upload' ||
        typeof entry.sourcePath !== 'string' ||
        !isAbsolute(entry.sourcePath) ||
        typeof entry.localPath !== 'string' ||
        !isAbsolute(entry.localPath) ||
        typeof entry.authorizedRoot !== 'string' ||
        !isAbsolute(entry.authorizedRoot) ||
        !isRecord(entry.contentIdentity) ||
        typeof entry.contentIdentity.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.contentIdentity.sha256) ||
        !Number.isSafeInteger(entry.contentIdentity.sizeBytes) ||
        entry.contentIdentity.sizeBytes < 0
    )
  ) {
    throw new Error('The approved dispatch binding is incomplete or malformed.')
  }
  return binding
}

export const assertApprovedHostAndTarget = (
  binding: ApprovedDispatchBinding,
  host: ComputeHost,
  target: ResolvedSshTarget
): void => {
  if (!sameDirectSshHostProof(binding.hostProof, host)) {
    throw new Error('The compute host classification or SSH settings changed after approval.')
  }
  if (resolvedSshTargetHash(binding.sshTarget) !== resolvedSshTargetHash(target)) {
    throw new Error('The resolved SSH endpoint or options changed after approval.')
  }
}
