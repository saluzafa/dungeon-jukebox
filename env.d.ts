/// <reference types="vite/client" />

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

type PermissionState = 'granted' | 'denied' | 'prompt'

interface FileSystemHandle {
  kind: 'file' | 'directory'
  name: string
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: 'file'
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: 'directory'
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}
