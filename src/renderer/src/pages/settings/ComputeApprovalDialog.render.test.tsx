// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { ComputeApprovalDialog } from './ComputeApprovalDialog'

const request: ComputeApprovalRequest = {
  id: 'approval-1',
  provider_id: 'ssh:cluster',
  provider_name: 'Research cluster',
  shape: 'direct_ssh',
  intent: 'Inspect the remote environment',
  command_preview: 'python ...',
  command_full: 'python --version && pip list'
}

const jobRequest: ComputeApprovalRequest = {
  id: 'job-approval-1',
  provider_id: 'ssh:cluster',
  provider_name: 'Research cluster',
  shape: 'scheduler_cluster',
  intent: 'Run a differential-expression analysis',
  command_preview: 'python analyze.py',
  command_full: 'python analyze.py --input counts.tsv',
  execution_mode: 'slurm',
  single_use: true,
  dispatch_binding: {
    binding_hash: 'b'.repeat(64),
    inputs: [
      {
        destination: 'counts.tsv',
        label: 'counts.tsv',
        size_bytes: 1234,
        sha256: 'c'.repeat(64)
      }
    ],
    ssh_target: {
      alias: 'cluster-login',
      hostname: 'login.example.org',
      user: 'researcher',
      port: 2222,
      identity_file: '~/.ssh/research',
      proxy_jump: 'bastion',
      host_key_alias: null,
      proxy_command_hash: null,
      effective_config_hash: 'd'.repeat(64),
      invocation_options: ['-o', 'User=researcher', '-p', '2222'],
      invocation_hash: 'e'.repeat(64)
    }
  },
  job_summary: {
    host: 'cluster-login',
    partition: 'gpu-long',
    account: 'genbiolab',
    cpu: {
      nodes: 1,
      tasks_per_node: 2,
      cpus_per_task: 4,
      total_cpus: 8
    },
    gpu: { count: 2, type: 'H100' },
    memory_mib: 32768,
    wall_time_seconds: 90061,
    script_hash: 'a'.repeat(64),
    inputs: ['counts.tsv', 'metadata.tsv'],
    expected_outputs: ['results/*.tsv', 'figures/*.svg'],
    working_directory: '/scratch/research agent/job-1'
  }
}

let container: HTMLDivElement
let root: Root

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === label
  )

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    respondApproval: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ComputeApprovalDialog', () => {
  it('renders nothing without a pending approval', () => {
    act(() => root.render(<ComputeApprovalDialog />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('uses shared dialog chrome while preserving the approval content', () => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const overlay = Array.from(document.body.querySelectorAll<HTMLElement>('div')).find((element) =>
      element.className.includes('bg-black/50')
    )

    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(dialog?.className).toContain('data-[state=open]:zoom-in-95')
    expect(dialog?.className).toContain('z-[60]')
    expect(document.body.textContent).toContain('Research cluster')
    expect(document.body.textContent).toContain('python ...')
  })

  it('shows the full command without changing approval state', () => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton('Show full command')?.click())

    expect(document.body.textContent).toContain('python --version && pip list')
    expect(useComputeStore.getState().respondApproval).not.toHaveBeenCalled()
  })

  it('renders every exact job summary field', () => {
    useComputeStore.setState({ pendingApprovals: [jobRequest] })
    act(() => root.render(<ComputeApprovalDialog />))

    const summary = document.body.querySelector('[data-testid="compute-job-summary"]')
    expect(document.body.textContent).toContain('Approve remote job?')
    expect(document.body.textContent).toContain('This approval applies only to this job.')
    expect(document.body.textContent).toContain('cluster-login')
    expect(summary?.textContent).toContain('Slurm scheduler (sbatch)')
    expect(summary?.textContent).toContain('researcher@login.example.org:2222')
    expect(summary?.textContent).toContain('~/.ssh/research')
    expect(summary?.textContent).toContain('bastion')
    expect(summary?.textContent).toContain('-o User=researcher -p 2222')
    expect(summary?.textContent).toContain('b'.repeat(64))
    expect(summary?.textContent).toContain('gpu-long')
    expect(summary?.textContent).toContain('genbiolab')
    expect(summary?.textContent).toContain('1 node(s); 2 task(s)/node; 4 CPU(s)/task; 8 total')
    expect(summary?.textContent).toContain('2 × H100')
    expect(summary?.textContent).toContain('32768 MiB')
    expect(summary?.textContent).toContain('90061 seconds (1d 1h 1m 1s)')
    expect(summary?.textContent).toContain('a'.repeat(64))
    expect(summary?.textContent).toContain(`counts.tsv: 1234 bytes; sha256 ${'c'.repeat(64)}`)
    expect(summary?.textContent).toContain('results/*.tsv, figures/*.svg')
    expect(summary?.textContent).toContain('/scratch/research agent/job-1')
  })

  it('offers only a single-use job decision and sends allow-once', () => {
    useComputeStore.setState({ pendingApprovals: [jobRequest] })
    act(() => root.render(<ComputeApprovalDialog />))

    expect(findButton('Approve job')).toBeDefined()
    expect(findButton('Once')).toBeUndefined()
    expect(findButton('This session')).toBeUndefined()
    expect(findButton('This project')).toBeUndefined()
    expect(findButton('Always')).toBeUndefined()

    act(() => findButton('Approve job')?.click())
    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(jobRequest.id, 'once')
  })

  it('labels direct SSH resources as unenforced instead of implying scheduler control', () => {
    useComputeStore.setState({
      pendingApprovals: [
        {
          ...jobRequest,
          id: 'direct-job-approval',
          shape: 'direct_ssh',
          execution_mode: 'direct_ssh'
        }
      ]
    })
    act(() => root.render(<ComputeApprovalDialog />))

    const summary = document.body.querySelector('[data-testid="compute-job-summary"]')
    expect(summary?.textContent).toContain('Direct SSH (no scheduler)')
    expect(
      document.body.querySelector('[data-testid="direct-ssh-resource-warning"]')?.textContent
    ).toContain('does not enforce partition, account, CPU, GPU, or memory requests')
    expect(summary?.textContent).toContain('gpu-long (not applied)')
    expect(summary?.textContent).toContain('genbiolab (not applied)')
    expect(summary?.textContent).toContain('8 total (not enforced)')
    expect(summary?.textContent).toContain('2 × H100 (not enforced)')
    expect(summary?.textContent).toContain('32768 MiB (not enforced)')
  })

  it('collapses the command when the approval queue advances to a new request', () => {
    const nextRequest: ComputeApprovalRequest = {
      ...request,
      id: 'approval-2',
      command_preview: 'Rscript ...',
      command_full: 'Rscript analysis.R --all'
    }
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))
    act(() => findButton('Show full command')?.click())

    act(() => useComputeStore.setState({ pendingApprovals: [nextRequest] }))

    expect(document.body.textContent).toContain('Rscript ...')
    expect(document.body.textContent).not.toContain('Rscript analysis.R --all')
    expect(findButton('Show full command')).toBeDefined()
  })

  it.each([
    ['Deny', 'deny'],
    ['Once', 'once'],
    ['This session', 'conversation']
  ] as const)('keeps the %s approval decision', (label, decision) => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton(label)?.click())

    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(request.id, decision)
  })

  it.each([
    ['This project', 'project', 'for this project'],
    ['Always', 'global', 'globally']
  ] as const)('requires confirmation before %s is remembered', (label, decision, scopePhrase) => {
    useComputeStore.setState({ pendingApprovals: [request] })
    act(() => root.render(<ComputeApprovalDialog />))

    act(() => findButton(label)?.click())

    expect(useComputeStore.getState().respondApproval).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(scopePhrase)

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )

    expect(useComputeStore.getState().respondApproval).toHaveBeenCalledWith(request.id, decision)
  })
})
