import type { AudioFileEntry, AudioMeta, CollectionEntry } from '@/types/soundboard'

export interface StorageRoot {
  name: string
  storageRef: unknown
}

export interface StorageAdapter {
  isSupported(): boolean
  connectRoot(): Promise<StorageRoot | null>
  restoreRoot(): Promise<StorageRoot | null>
  ensureRootPermission(root: StorageRoot, shouldRequest: boolean): Promise<boolean>
  loadCollections(root: StorageRoot): Promise<CollectionEntry[]>
  createCollection(root: StorageRoot, name: string, iconFile?: File | null): Promise<void>
  importAudioFiles(collection: CollectionEntry, files: File[], targetDirectoryPath?: string): Promise<void>
  createCollectionSubDirectory(
    collection: CollectionEntry,
    parentDirectoryPath: string,
    directoryName: string,
  ): Promise<void>
  renameCollectionSubDirectory(
    collection: CollectionEntry,
    directoryPath: string,
    newDirectoryName: string,
  ): Promise<{ fromPath: string; toPath: string } | null>
  moveCollectionSubDirectory(
    collection: CollectionEntry,
    directoryPath: string,
    targetParentDirectoryPath: string,
  ): Promise<{ fromPath: string; toPath: string } | null>
  deleteCollectionSubDirectory(collection: CollectionEntry, directoryPath: string): Promise<string | null>
  setCollectionIcon(collection: CollectionEntry, iconFile: File | null): Promise<void>
  setCollectionTitle(collection: CollectionEntry, title: string): Promise<void>
  deleteCollection(root: StorageRoot, collectionName: string): Promise<void>
  updateAudioMeta(audio: AudioFileEntry, patch: Partial<AudioMeta>): Promise<AudioMeta>
  setAudioIcon(audio: AudioFileEntry, iconFile: File | null): Promise<AudioMeta>
  deleteAudioFile(audio: AudioFileEntry): Promise<void>
  moveAudioFilesToDirectory(
    collection: CollectionEntry,
    audios: AudioFileEntry[],
    targetDirectoryPath: string,
  ): Promise<string[]>
  moveAudioFilesToCollection(targetCollection: CollectionEntry, audios: AudioFileEntry[]): Promise<string[]>
  getAudioFile(audio: AudioFileEntry): Promise<File>
  resolveCollectionIconUrl(collection: CollectionEntry): Promise<string | null>
  resolveAudioIconUrl(audio: AudioFileEntry): Promise<string | null>
}
