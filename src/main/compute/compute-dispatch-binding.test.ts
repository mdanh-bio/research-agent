import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import {
  bindInputContentIdentities,
  buildApprovedDispatchBinding,
  buildDispatchApprovalSummary,
  directSshHostProof,
  parseApprovedDispatchBinding,
  revalidateInputContentIdentities,
  resolveAuthorizedLocalInputPath
} from './compute-dispatch-binding'
import type { ResolvedSshTarget } from './ssh-runner'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:cluster',
  displayName: 'Cluster',
  shape: 'direct_ssh',
  sshAlias: 'cluster',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: '2026-08-10T00:00:00.000Z',
    exitCode: 0,
    errorTail: null,
    detectedScheduler: 'none'
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const target: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'cluster',
  extraArgs: ['-o', 'User=researcher', '-p', '2222', '-o', 'BatchMode=yes'],
  connectionIdentity: {
    configResolved: true,
    alias: 'cluster',
    hostname: 'login.example.org',
    user: 'researcher',
    port: 2222,
    identityFile: '~/.ssh/research',
    proxyJump: 'bastion',
    effectiveConfigHash: 'a'.repeat(64)
  }
}

describe('compute dispatch approval binding', () => {
  it('does not produce a direct-host proof for unknown or failed classification', () => {
    expect(
      directSshHostProof(host({ shape: 'unclassified', probeResult: undefined }))
    ).toBeUndefined()
    expect(
      directSshHostProof(
        host({
          probeResult: {
            ok: false,
            probedAt: '2026-08-10T00:00:00.000Z',
            exitCode: 255,
            errorTail: 'Connection refused'
          }
        })
      )
    ).toBeUndefined()
  })

  it('binds exact input bytes and rejects mutation before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-binding-'))
    roots.push(root)
    const localPath = join(root, 'counts.tsv')
    await writeFile(localPath, 'gene\tcount\nA\t1\n')
    const authorized = await resolveAuthorizedLocalInputPath(localPath, root)

    const inputs = await bindInputContentIdentities([
      {
        kind: 'upload',
        ...authorized,
        dstFilename: 'counts.tsv',
        label: 'counts.tsv'
      }
    ])
    expect(inputs[0]?.contentIdentity.sha256).toMatch(/^[a-f0-9]{64}$/)
    await expect(revalidateInputContentIdentities(inputs)).resolves.toBeUndefined()

    await writeFile(localPath, 'gene\tcount\nA\t999\n')
    await expect(revalidateInputContentIdentities(inputs)).rejects.toThrow(/changed after approval/)
  })

  it('fails closed when an approved in-root symlink is retargeted outside its authorized root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'compute-binding-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'compute-binding-outside-'))
    roots.push(root, outside)
    const approvedTarget = join(root, 'approved.tsv')
    const outsideTarget = join(outside, 'secret.txt')
    const sourcePath = join(root, 'input.tsv')
    await writeFile(approvedTarget, 'approved\n')
    await writeFile(outsideTarget, 'secret\n')
    await symlink(approvedTarget, sourcePath)
    const authorized = await resolveAuthorizedLocalInputPath(sourcePath, root)

    const inputs = await bindInputContentIdentities([
      {
        kind: 'upload',
        ...authorized,
        dstFilename: 'input.tsv',
        label: 'input.tsv'
      }
    ])
    await unlink(sourcePath)
    await symlink(outsideTarget, sourcePath)

    await expect(revalidateInputContentIdentities(inputs)).rejects.toThrow(
      /outside its authorized root|changed after selection/
    )
  })

  it('projects the resolved endpoint/options and rejects legacy unbound manifests', () => {
    const binding = buildApprovedDispatchBinding(host(), target, [], 'b'.repeat(64))
    expect(buildDispatchApprovalSummary(binding)).toMatchObject({
      binding_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ssh_target: {
        alias: 'cluster',
        hostname: 'login.example.org',
        user: 'researcher',
        port: 2222,
        identity_file: '~/.ssh/research',
        proxy_jump: 'bastion',
        effective_config_hash: 'a'.repeat(64),
        invocation_options: target.extraArgs,
        invocation_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(parseApprovedDispatchBinding(JSON.stringify(binding))).toEqual(binding)
    expect(() => parseApprovedDispatchBinding(JSON.stringify([]))).toThrow(
      /no supported approved dispatch binding/
    )
  })

  it('rejects remote symlink inputs whose content identity is unavailable', async () => {
    await expect(
      bindInputContentIdentities([
        {
          kind: 'symlink',
          remotePath: '/shared/reference.fa',
          dstFilename: 'reference.fa',
          label: '/shared/reference.fa'
        }
      ])
    ).rejects.toThrow(/cannot be approved until its content identity can be verified/)
  })
})
