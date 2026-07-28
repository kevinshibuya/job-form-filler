const DB_NAME = 'jff'
const STORE = 'resume'
const KEY = 'current'

export interface StoredResume {
  name: string
  mimeType: string
  dataBase64: string
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = run(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    t.oncomplete = () => db.close()
  }))
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** The resume lives here, in the extension. It never crosses native messaging. */
export async function saveResume(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const record: StoredResume = {
    name: file.name,
    mimeType: file.type === '' ? 'application/octet-stream' : file.type,
    dataBase64: toBase64(bytes),
  }
  await tx('readwrite', (s) => s.put(record, KEY))
}

export async function loadResume(): Promise<StoredResume | null> {
  const v = await tx<StoredResume | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<StoredResume | undefined>)
  return v ?? null
}

export async function clearResume(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY))
}
