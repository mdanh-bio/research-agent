import { createHash } from 'node:crypto'

import { z } from 'zod'

import type {
  ComputeJobApprovalSummary,
  ComputeJobSpec,
  ComputeResourceSpec
} from '../../shared/compute-scheduler'
import type { StagedInputEntry } from './job-dispatcher'

const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const MAX_LIST_ENTRIES = 1_000
const MAX_WALL_TIME_SECONDS = 31 * 24 * 60 * 60

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const safeJobId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const safeHostAlias = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const schedulerIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(safeIdentifier, 'must contain only letters, digits, dot, underscore, plus, or hyphen')

const remotePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') || value === '~' || value.startsWith('~/'), {
    message: 'must be an absolute remote path or start with ~/'
  })
  .refine((value) => !hasControlCharacter(value), {
    message: 'must not contain control characters'
  })

const summaryEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacter(value), {
    message: 'must not contain control characters'
  })

export const computeResourceSpecSchema = z
  .object({
    partition: schedulerIdentifierSchema.optional(),
    account: schedulerIdentifierSchema.optional(),
    nodes: z.number().int().min(1).max(1_024),
    tasksPerNode: z.number().int().min(1).max(65_536),
    cpusPerTask: z.number().int().min(1).max(65_536),
    memoryMib: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024)
      .optional(),
    gpus: z
      .object({
        count: z.number().int().min(1).max(1_024),
        type: schedulerIdentifierSchema.optional()
      })
      .strict()
      .optional(),
    wallTimeSeconds: z.number().int().min(1).max(MAX_WALL_TIME_SECONDS)
  })
  .strict()

export const computeJobSpecSchema = z
  .object({
    jobId: z.string().trim().min(1).max(255).regex(safeJobId),
    providerId: z.string().trim().min(5).max(512).startsWith('ssh:'),
    host: z.string().trim().min(1).max(255).regex(safeHostAlias),
    intent: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .refine((value) => !hasControlCharacter(value)),
    script: z
      .string()
      .min(1)
      .max(MAX_SCRIPT_BYTES)
      .refine((value) => !value.includes('\0'), { message: 'must not contain NUL bytes' }),
    workingDirectory: remotePathSchema,
    resources: computeResourceSpecSchema,
    inputs: z.array(summaryEntrySchema).max(MAX_LIST_ENTRIES),
    expectedOutputs: z.array(summaryEntrySchema).max(MAX_LIST_ENTRIES)
  })
  .strict()

export const validateComputeJobSpec = (value: unknown): ComputeJobSpec =>
  computeJobSpecSchema.parse(value) as ComputeJobSpec

export const computeScriptHash = (script: string): string =>
  createHash('sha256').update(script).digest('hex')

export const buildComputeJobApprovalSummary = (
  unvalidatedSpec: ComputeJobSpec
): ComputeJobApprovalSummary => {
  const spec = validateComputeJobSpec(unvalidatedSpec)
  const { resources } = spec
  const totalCpus = resources.nodes * resources.tasksPerNode * resources.cpusPerTask

  return {
    host: spec.host,
    partition: resources.partition ?? null,
    account: resources.account ?? null,
    cpu: {
      nodes: resources.nodes,
      tasks_per_node: resources.tasksPerNode,
      cpus_per_task: resources.cpusPerTask,
      total_cpus: totalCpus
    },
    gpu: resources.gpus ? { count: resources.gpus.count, type: resources.gpus.type ?? null } : null,
    memory_mib: resources.memoryMib ?? null,
    wall_time_seconds: resources.wallTimeSeconds,
    script_hash: computeScriptHash(spec.script),
    inputs: [...spec.inputs],
    expected_outputs: [...spec.expectedOutputs],
    working_directory: spec.workingDirectory
  }
}

type SubmissionSpecInput = {
  jobId: string
  providerId: string
  host: string
  intent: string
  command: string
  remoteWorkdir: string
  timeoutSeconds: number
  resourceRequest?: string
  stagedInputs: StagedInputEntry[]
  outputManifest?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

const optionalPositiveNumber = (
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

const parseResourceRequest = (
  raw: string | undefined,
  timeoutSeconds: number
): ComputeResourceSpec => {
  let resources: Record<string, unknown> = {}
  if (raw) {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new Error('resources must be a JSON object')
    resources = parsed
  }

  const gpuObject = isRecord(resources['gpus']) ? resources['gpus'] : undefined
  const gpuCount =
    (gpuObject ? optionalPositiveNumber(gpuObject, 'count') : undefined) ??
    optionalPositiveNumber(resources, 'gpu_count', 'gpus')
  const gpuType =
    (gpuObject ? optionalString(gpuObject, 'type') : undefined) ??
    optionalString(resources, 'gpu_type')
  const memoryMib =
    optionalPositiveNumber(resources, 'memory_mib', 'memory_mb') ??
    (() => {
      const memoryGib = optionalPositiveNumber(resources, 'memory_gb', 'memory_gib')
      return memoryGib === undefined ? undefined : memoryGib * 1024
    })()

  return computeResourceSpecSchema.parse({
    partition: optionalString(resources, 'partition'),
    account: optionalString(resources, 'account'),
    nodes: optionalPositiveNumber(resources, 'nodes') ?? 1,
    tasksPerNode: optionalPositiveNumber(resources, 'tasks_per_node', 'tasksPerNode') ?? 1,
    cpusPerTask: optionalPositiveNumber(resources, 'cpus_per_task', 'cpusPerTask', 'cpus') ?? 1,
    memoryMib,
    gpus: gpuCount === undefined ? undefined : { count: gpuCount, type: gpuType },
    wallTimeSeconds:
      optionalPositiveNumber(resources, 'wall_time_seconds', 'wallTimeSeconds') ?? timeoutSeconds
  }) as ComputeResourceSpec
}

const expectedOutputsFromManifest = (raw: string | undefined): string[] => {
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('outputs must be a JSON array')

  return parsed.map((entry, index) => {
    if (typeof entry === 'string') return entry
    if (isRecord(entry)) {
      const output = optionalString(entry, 'glob', 'path')
      if (output) return output
    }
    throw new Error(`outputs[${index}] must be a path/glob string or object`)
  })
}

// Transitional adapter for the existing submit_job wire shape. It provides the exact approval
// summary now while the public RPC migrates from free-form resources JSON to ComputeJobSpec.
export const computeJobSpecFromSubmission = (input: SubmissionSpecInput): ComputeJobSpec =>
  validateComputeJobSpec({
    jobId: input.jobId,
    providerId: input.providerId,
    host: input.host,
    intent: input.intent,
    script: input.command,
    workingDirectory: input.remoteWorkdir,
    resources: parseResourceRequest(input.resourceRequest, input.timeoutSeconds),
    inputs: input.stagedInputs.map((entry) => entry.dstFilename),
    expectedOutputs: expectedOutputsFromManifest(input.outputManifest)
  })
