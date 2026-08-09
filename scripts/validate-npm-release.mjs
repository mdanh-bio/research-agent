#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@mdanh-bio/research-agent'
const PACKAGE_BINARY = 'research-agent'

export const validatePrivatePackageManifest = (manifest) => {
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error(
      `Expected private package name ${PACKAGE_NAME}, received ${manifest?.name ?? 'missing'}.`
    )
  }
  if (manifest.private !== true) {
    throw new Error(`${PACKAGE_NAME} must remain marked private.`)
  }
  if (manifest.publishConfig?.access === 'public') {
    throw new Error(`${PACKAGE_NAME} must not declare public npm access.`)
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('The private package version is missing.')
  }
  if (
    typeof manifest.bin !== 'object' ||
    manifest.bin === null ||
    typeof manifest.bin[PACKAGE_BINARY] !== 'string' ||
    !manifest.bin[PACKAGE_BINARY].trim()
  ) {
    throw new Error(`The private package must expose the ${PACKAGE_BINARY} binary.`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    private: true,
    binary: PACKAGE_BINARY
  }
}

export const validatePrivateRootManifest = (manifest) => {
  if (manifest?.name !== 'research-agent' || manifest.private !== true) {
    throw new Error('The Research Agent application root must remain marked private.')
  }
}

const main = async () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
  const packagePath = resolve(repositoryRoot, 'packages/open-science/package.json')
  const [manifest, rootManifest] = await Promise.all([
    readFile(packagePath, 'utf8').then(JSON.parse),
    readFile(resolve(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse)
  ])
  const result = validatePrivatePackageManifest(manifest)
  validatePrivateRootManifest(rootManifest)
  console.log(`Verified private ${result.name}@${result.version} package metadata.`)
}

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
