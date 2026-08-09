import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const readPackageFile = (name: string): Promise<string> =>
  readFile(new URL(name, import.meta.url), 'utf8')

describe('Research Agent private package metadata', () => {
  it('uses the private package, executable, and repository identity', async () => {
    const manifest = JSON.parse(await readPackageFile('package.json')) as Record<string, unknown>

    expect(manifest).toMatchObject({
      name: '@mdanh-bio/research-agent',
      private: true,
      bin: { 'research-agent': './cli.mjs' },
      repository: {
        type: 'git',
        url: 'git+https://github.com/mdanh-bio/research-agent.git',
        directory: 'packages/open-science'
      }
    })
    expect(manifest).not.toHaveProperty('publishConfig')
  })

  it('documents the private identity without changing compatibility names', async () => {
    const [readme, cli] = await Promise.all([
      readPackageFile('README.md'),
      readPackageFile('CLI.md')
    ])

    expect(readme).toContain("import { connectToOpenScience } from '@mdanh-bio/research-agent'")
    expect(readme).toMatch(/is not published to the public\s+npm registry/)
    expect(cli).toContain('research-agent start --no-open')
    expect(cli).toContain('node packages/open-science/cli.mjs')
    expect(cli).toContain('upstream Open Science 0.7.3')
    expect(cli).toContain('--config-root /path/to/.open-science')
    expect(`${readme}\n${cli}`).not.toContain('@aipoch/open-science')
    expect(cli).not.toMatch(/`open-science(?:\s|`)/)
  })
})
