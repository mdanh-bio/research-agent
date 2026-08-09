import { expect, test } from '@playwright/test'
import { delimiter } from 'node:path'
import { electronLaunchTarget, launchEnvironment } from './fixtures/electron-app'

test('normalizes a Windows-style Path before injecting the fake Agent directory', () => {
  const environment = launchEnvironment('storage-root', 'fake-agent-bin', {
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173',
    Path: 'system-bin'
  })

  expect(environment.PATH).toBe(`fake-agent-bin${delimiter}system-bin`)
  expect(environment.Path).toBeUndefined()
  expect(environment.ELECTRON_RENDERER_URL).toBeUndefined()
  expect(environment.RESEARCH_AGENT_E2E_STORAGE_ROOT).toBeUndefined()
  expect(environment.RESEARCH_AGENT_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_STORAGE_ROOT).toBeUndefined()
})

test('isolates packaged certification storage without changing the process home', () => {
  const environment = launchEnvironment('storage-root', undefined, {
    RESEARCH_AGENT_E2E_EXECUTABLE: '/artifacts/Research Agent'
  })

  expect(environment.RESEARCH_AGENT_E2E_STORAGE_ROOT).toBe('storage-root')
  expect(environment.RESEARCH_AGENT_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_E2E_STORAGE_ROOT).toBeUndefined()
})

test('ignores a legacy packaged executable unless compatibility is explicitly enabled', () => {
  const legacyExecutable = '/artifacts/Open Science'

  expect(
    electronLaunchTarget('profile-root', { OPEN_SCIENCE_E2E_EXECUTABLE: legacyExecutable }, 'linux')
  ).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic', expect.any(String)]
  })
  expect(
    electronLaunchTarget(
      'profile-root',
      {
        RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV: '1',
        OPEN_SCIENCE_E2E_EXECUTABLE: legacyExecutable
      },
      'linux'
    )
  ).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic'],
    executablePath: legacyExecutable
  })
})

test('prefers the Research Agent packaged executable when compatibility is enabled', () => {
  expect(
    electronLaunchTarget(
      'profile-root',
      {
        RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV: '1',
        RESEARCH_AGENT_E2E_EXECUTABLE: '/artifacts/Research Agent',
        OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open Science'
      },
      'linux'
    )
  ).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic'],
    executablePath: '/artifacts/Research Agent'
  })
})

test('enables the basic password store only for Linux E2E profiles', () => {
  expect(electronLaunchTarget('profile-root', {}, 'linux')).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic', expect.any(String)]
  })
  expect(electronLaunchTarget('profile-root', {}, 'darwin')).toEqual({
    args: ['--user-data-dir=profile-root', expect.any(String)]
  })
  expect(electronLaunchTarget('profile-root', {}, 'win32')).toEqual({
    args: ['--user-data-dir=profile-root', expect.any(String)]
  })
})

test('launches packaged and source applications with the expected Linux arguments', () => {
  expect(
    electronLaunchTarget(
      'profile-root',
      {
        RESEARCH_AGENT_E2E_EXECUTABLE: '/artifacts/Research Agent.app/Contents/MacOS/Research Agent'
      },
      'linux'
    )
  ).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic'],
    executablePath: '/artifacts/Research Agent.app/Contents/MacOS/Research Agent'
  })
  expect(electronLaunchTarget('profile-root', {}, 'linux')).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic', expect.any(String)]
  })
})
