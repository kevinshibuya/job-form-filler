import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Resume is uploaded once per page load (spec #41, ticket #49). These tests
// drive the page script through the listener it registers, and read what its
// replies actually carry: a Scan after a Resume the page kept says so, a Scan
// after one the page refused does not, and a new document starts with nothing.

// jsdom has no DataTransfer (jsdom/jsdom#1568), and its `files` setter takes
// only an internal FileList: the same shim fill.test.ts carries, inert in Chrome.
if (typeof globalThis.DataTransfer === 'undefined') {
  class FakeDataTransfer {
    private _files: File[] = []
    items = { add: (f: File): void => { this._files.push(f) } }
    get files(): FileList { return this._files as unknown as FileList }
  }
  ;(globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer
  const proto = HTMLInputElement.prototype
  const native = Object.getOwnPropertyDescriptor(proto, 'files')!
  const shadow = new WeakMap<HTMLInputElement, File[]>()
  Object.defineProperty(proto, 'files', {
    configurable: true,
    enumerable: native.enumerable,
    get(this: HTMLInputElement) { return shadow.get(this) ?? native.get!.call(this) },
    set(this: HTMLInputElement, v: unknown) {
      if (Array.isArray(v)) { shadow.set(this, v); return }
      native.set!.call(this, v)
    },
  })
}

type Listener =(raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
type Reply = { ok: boolean; error?: string; scan?: { epoch: number; fields: { fid: number; idAttr: string | null }[]; resumeUploaded?: boolean } }

let listener: Listener | null = null

/** Loads the page script as a new injection would. `freshDocument` clears the
 *  per-document marker, as a reload does; without it the earlier listener
 *  (and what it remembers) stays the one that answers. */
async function inject(freshDocument: boolean): Promise<void> {
  if (freshDocument) delete (window as { __jffLoaded?: boolean }).__jffLoaded
  vi.resetModules()
  await import('./index')
}

function send(message: unknown): Promise<Reply> {
  return new Promise((resolve) => { listener!(message, {}, (r) => resolve(r as Reply)) })
}

/** A Greenhouse-style uploader. `keeps`: the page takes the file and shows its
 *  name; otherwise its uploader throws and an error text appears. */
function mountUploader(keeps: boolean): void {
  document.body.innerHTML = `
    <form>
      <label for="first">First name</label><input id="first" name="first" type="text">
      <div class="file-upload" role="group" aria-labelledby="resume-label">
        <label id="resume-label" for="resume">Resume/CV</label>
        <div class="buttons"><input id="resume" name="resume" type="file" accept=".pdf"></div>
      </div>
    </form>`
  const input = document.getElementById('resume') as HTMLInputElement
  const group = document.querySelector('.file-upload')!
  input.addEventListener('change', () => {
    if (keeps) {
      group.querySelector('.buttons')!.replaceWith(Object.assign(document.createElement('div'), { className: 'filename', textContent: input.files![0]!.name }))
    } else {
      group.appendChild(Object.assign(document.createElement('p'), { className: 'helper-text--error', textContent: 'Upload failed' }))
    }
  })
}

async function scan(epoch: number): Promise<NonNullable<Reply['scan']>> {
  const r = await send({ type: 'JFF_SCAN', epoch })
  expect(r.ok).toBe(true)
  return r.scan!
}

async function uploadResume(epoch: number, fid: number): Promise<Reply> {
  return send({
    type: 'JFF_FILL_RESUME', epoch, handle: { frameId: 0, fid, epoch },
    fileName: 'ada-cv.pdf', mimeType: 'application/pdf', dataBase64: btoa('%PDF'),
  })
}

const resumeFid = (s: NonNullable<Reply['scan']>): number => s.fields.find((f) => f.idAttr === 'resume')!.fid

beforeEach(async () => {
  listener = null
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: { addListener: (fn: Listener) => { listener = fn } },
      sendMessage: vi.fn(),
    },
  }
  await inject(true)
})

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as { __jffLoaded?: boolean }).__jffLoaded
})

describe('the page script remembers the Resume it uploaded', () => {
  it('a new document\'s first Scan reply does not say the Resume was uploaded', async () => {
    mountUploader(true)
    expect((await scan(1)).resumeUploaded).toBeFalsy()
  })

  it('after an upload the page kept, the next Scan reply of the same document says so', async () => {
    mountUploader(true)
    const first = await scan(1)
    expect(await uploadResume(1, resumeFid(first))).toEqual({ ok: true })
    expect((await scan(2)).resumeUploaded).toBe(true)
  }, 15_000)

  it('the memory outlives a second injection into the same document', async () => {
    mountUploader(true)
    const first = await scan(1)
    expect(await uploadResume(1, resumeFid(first))).toEqual({ ok: true })
    await inject(false)
    expect((await scan(2)).resumeUploaded).toBe(true)
  }, 15_000)

  it('after an upload the page refused, the next Scan reply does not say so', async () => {
    mountUploader(false)
    const first = await scan(1)
    expect(await uploadResume(1, resumeFid(first))).toEqual({ ok: false, error: 'file-not-kept' })
    expect((await scan(2)).resumeUploaded).toBeFalsy()
  }, 15_000)

  it('a reload forgets it: the new document\'s first Scan reply does not say so', async () => {
    mountUploader(true)
    const first = await scan(1)
    expect(await uploadResume(1, resumeFid(first))).toEqual({ ok: true })
    await inject(true)
    mountUploader(true)
    expect((await scan(1)).resumeUploaded).toBeFalsy()
  }, 15_000)
})
