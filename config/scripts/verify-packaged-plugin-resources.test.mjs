import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyPackagedPluginResources } = require('./verify-packaged-plugin-resources.cjs')

describe('verify packaged plugin resources', () => {
  it('accepts exact launch bytes copied into a packaged resources directory', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-plugins-'))
    try {
      await cp(
        join(process.cwd(), 'resources', 'plugins', 'launch'),
        join(resourcesDir, 'plugins', 'launch'),
        { recursive: true }
      )

      expect(() => verifyPackagedPluginResources(resourcesDir)).not.toThrow()
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('rejects mutated bytes in the packaged output', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-plugins-'))
    try {
      const launchRoot = join(resourcesDir, 'plugins', 'launch')
      await cp(join(process.cwd(), 'resources', 'plugins', 'launch'), launchRoot, {
        recursive: true
      })
      await writeFile(
        join(launchRoot, 'stablyai.orca-midnight-theme', 'theme.json'),
        '{"mutated":true}\n'
      )

      expect(() => verifyPackagedPluginResources(resourcesDir)).toThrow(
        'packaged bytes do not match stablyai.orca-midnight-theme'
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })
})
