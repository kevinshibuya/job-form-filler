import { describe, it, expect } from 'vitest'
import { buildWrapperScript, buildNativeManifest, nativeManifestPath, HOST_NAME } from './templates.js'

describe('buildWrapperScript', () => {
  const sh = buildWrapperScript({ nodePath: '/opt/homebrew/bin/node', entryPath: '/repo/host/dist/index.js' })

  it('starts with a POSIX shebang', () => {
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('exports an explicit PATH because Chrome launches hosts without a shell profile', () => {
    expect(sh).toMatch(/^export PATH=/m)
    expect(sh).toContain('/opt/homebrew/bin')
    expect(sh).toContain('/usr/local/bin')
  })

  it('execs node and the entry point by ABSOLUTE path', () => {
    expect(sh).toContain('exec "/opt/homebrew/bin/node" "/repo/host/dist/index.js"')
  })

  it('never writes anything to stdout itself', () => {
    expect(sh).not.toMatch(/^\s*echo /m)
  })
})

describe('buildNativeManifest', () => {
  const json = JSON.parse(buildNativeManifest({ wrapperPath: '/repo/host/bin/jff-host.sh', extensionId: 'abcdefghijklmnopabcdefghijklmnop' }))

  it('uses the pinned host name and stdio type', () => {
    expect(json.name).toBe(HOST_NAME)
    expect(json.type).toBe('stdio')
  })

  it('points at the wrapper, not at node or the JS entry point', () => {
    expect(json.path).toBe('/repo/host/bin/jff-host.sh')
  })

  it('allows exactly one origin, the pinned extension id', () => {
    expect(json.allowed_origins).toEqual(['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
  })
})

describe('nativeManifestPath', () => {
  it('targets Chrome’s macOS NativeMessagingHosts directory', () => {
    expect(nativeManifestPath('/Users/k')).toBe(
      '/Users/k/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kevin.jobformfiller.json',
    )
  })
})
