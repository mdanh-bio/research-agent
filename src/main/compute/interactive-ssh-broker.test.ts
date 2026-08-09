import { isAbsolute } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONTROL_MASTER_PERSIST_SECONDS, buildControlMasterConfig } from './interactive-ssh-broker'

describe('buildControlMasterConfig', () => {
  it('builds an app-scoped, eight-hour, per-alias configuration without connecting', () => {
    const config = buildControlMasterConfig('otp-cluster')

    expect(isAbsolute(config.controlDirectory)).toBe(true)
    expect(config.persistSeconds).toBe(8 * 60 * 60)
    expect(config.args).toEqual([
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${config.controlPath}`,
      '-o',
      `ControlPersist=${CONTROL_MASTER_PERSIST_SECONDS}`
    ])
  })

  it('hashes a validated alias so it never appears in ControlPath', () => {
    const config = buildControlMasterConfig('cluster.safe_name-1', {
      controlDirectory: '/private/tmp/research-agent-control'
    })
    expect(config.controlPath).toMatch(/^\/private\/tmp\/research-agent-control\/cm-[a-f0-9]{24}$/)
    expect(config.controlPath).not.toContain('cluster.safe_name-1')
  })

  it.each(['../%h/cluster', '-oProxyCommand=malicious', 'cluster name', 'cluster:*'])(
    'rejects unsafe SSH alias %s before building OpenSSH arguments',
    (alias) => {
      expect(() =>
        buildControlMasterConfig(alias, {
          controlDirectory: '/private/tmp/research-agent-control'
        })
      ).toThrow(/alias/i)
    }
  )

  it('uses resolved connection identity to prevent stale master reuse after a host edit', () => {
    const first = buildControlMasterConfig('cluster', {
      controlDirectory: '/private/tmp/research-agent-control',
      connectionKey: JSON.stringify(['login.example', 'anh', 22, '~/.ssh/a'])
    })
    const changedPort = buildControlMasterConfig('cluster', {
      controlDirectory: '/private/tmp/research-agent-control',
      connectionKey: JSON.stringify(['login.example', 'anh', 2222, '~/.ssh/a'])
    })
    expect(changedPort.controlPath).not.toBe(first.controlPath)
  })

  it('rejects relative directories and invalid persistence values', () => {
    expect(() =>
      buildControlMasterConfig('cluster', { controlDirectory: 'relative/control' })
    ).toThrow(/absolute/)
    expect(() => buildControlMasterConfig('cluster', { persistSeconds: 0 })).toThrow()
  })
})
