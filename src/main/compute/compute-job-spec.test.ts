import { describe, expect, it } from 'vitest'

import type { ComputeJobSpec } from '../../shared/compute-scheduler'
import {
  buildComputeJobApprovalSummary,
  computeJobSpecFromSubmission,
  computeScriptHash,
  validateComputeJobSpec
} from './compute-job-spec'

const sampleSpec = (overrides: Partial<ComputeJobSpec> = {}): ComputeJobSpec => ({
  jobId: 'job-123',
  providerId: 'ssh:cluster',
  host: 'cluster',
  intent: 'Run a validated analysis',
  script: '#!/usr/bin/env bash\npython analyze.py',
  workingDirectory: '/scratch/research agent/job-123',
  resources: {
    partition: 'gpu-long',
    account: 'genbiolab',
    nodes: 1,
    tasksPerNode: 2,
    cpusPerTask: 4,
    memoryMib: 16_384,
    gpus: { count: 1, type: 'h100' },
    wallTimeSeconds: 3_661
  },
  inputs: ['reads.fastq.gz'],
  expectedOutputs: ['results/*.tsv'],
  ...overrides
})

describe('ComputeJobSpec validation', () => {
  it('accepts a canonical backend-neutral job spec', () => {
    expect(validateComputeJobSpec(sampleSpec())).toEqual(sampleSpec())
  })

  it('rejects scheduler option and control-character injection', () => {
    expect(() =>
      validateComputeJobSpec({
        ...sampleSpec(),
        resources: { ...sampleSpec().resources, partition: '--wrap=malicious' }
      })
    ).toThrow()
    expect(() =>
      validateComputeJobSpec({ ...sampleSpec(), workingDirectory: '/scratch/job\nscancel 1' })
    ).toThrow()
  })

  it('rejects unknown fields instead of silently changing scheduler meaning', () => {
    expect(() =>
      validateComputeJobSpec({
        ...sampleSpec(),
        resources: { ...sampleSpec().resources, exclusive: true }
      })
    ).toThrow()
  })
})

describe('buildComputeJobApprovalSummary', () => {
  it('returns every exact single-use approval field with a verified script hash', () => {
    const spec = sampleSpec()
    expect(buildComputeJobApprovalSummary(spec)).toEqual({
      host: 'cluster',
      partition: 'gpu-long',
      account: 'genbiolab',
      cpu: {
        nodes: 1,
        tasks_per_node: 2,
        cpus_per_task: 4,
        total_cpus: 8
      },
      gpu: { count: 1, type: 'h100' },
      memory_mib: 16_384,
      wall_time_seconds: 3_661,
      script_hash: computeScriptHash(spec.script),
      inputs: ['reads.fastq.gz'],
      expected_outputs: ['results/*.tsv'],
      working_directory: '/scratch/research agent/job-123'
    })
  })

  it('normalizes the existing submit_job JSON shape without copying credentials', () => {
    const spec = computeJobSpecFromSubmission({
      jobId: 'job-1',
      providerId: 'ssh:cluster',
      host: 'cluster',
      intent: 'Analyze data',
      command: 'python analyze.py',
      remoteWorkdir: '~/jobs/job-1',
      timeoutSeconds: 600,
      resourceRequest: JSON.stringify({
        partition: 'cpu',
        account: 'lab',
        cpus: 4,
        memory_gb: 8,
        gpu_count: 1,
        gpu_type: 'a100'
      }),
      stagedInputs: [
        {
          kind: 'upload',
          sourcePath: '/private/input.csv',
          localPath: '/private/input.csv',
          authorizedRoot: '/private',
          dstFilename: 'input.csv',
          label: 'in'
        }
      ],
      outputManifest: JSON.stringify([
        'result.tsv',
        { glob: 'figures/*.svg', visibility: 'featured' }
      ])
    })

    expect(spec.resources).toEqual({
      partition: 'cpu',
      account: 'lab',
      nodes: 1,
      tasksPerNode: 1,
      cpusPerTask: 4,
      memoryMib: 8192,
      gpus: { count: 1, type: 'a100' },
      wallTimeSeconds: 600
    })
    expect(spec.inputs).toEqual(['input.csv'])
    expect(spec.expectedOutputs).toEqual(['result.tsv', 'figures/*.svg'])
    expect(JSON.stringify(spec)).not.toContain('/private/input.csv')
  })
})
