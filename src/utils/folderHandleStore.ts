const DB_NAME = 'soundboard-db'
const STORE_NAME = 'settings'
const KEY = 'last-folder-handle'

interface HandleRecord {
  id: string
  handle: FileSystemDirectoryHandle
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Unable to open IndexedDB'))
  })
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.put({ id: KEY, handle } satisfies HandleRecord)

    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('Failed to save folder handle'))
  })
  db.close()
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  const record = await new Promise<HandleRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(KEY)

    req.onsuccess = () => resolve((req.result as HandleRecord | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('Failed to load folder handle'))
  })
  db.close()
  return record?.handle ?? null
}
