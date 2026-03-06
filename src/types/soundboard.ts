export type AudioCategory = 'music' | 'effect' | 'sound'

export interface AudioMeta {
  title: string | null
  iconImage: string | null
  category: AudioCategory
  infiniteLoop: boolean
  trimStart: number | null
  trimEnd: number | null
  volume: number
}

export interface AudioFileEntry {
  id: string
  name: string
  relativePath: string
  collectionName: string
  fileHandle: FileSystemFileHandle
  audioDirHandle: FileSystemDirectoryHandle
  metadataFileName: string
  metadata: AudioMeta
}

export interface CollectionEntry {
  name: string
  title: string
  iconImage: string | null
  dirHandle: FileSystemDirectoryHandle
  audioDirHandle: FileSystemDirectoryHandle
  directoryPaths: string[]
  audioFiles: AudioFileEntry[]
}

export interface ActiveTrack {
  id: string
  audioId: string
  title: string
  category: AudioCategory
  isSuperTrack?: boolean
  superTrackPosition?: number
  superTrackTotal?: number
  superTrackCurrentTitle?: string | null
  volume: number
  currentSeconds: number
  totalSeconds: number
  audioElement: HTMLAudioElement | null
  sourceUrl: string | null
  outputGainNode?: GainNode | null
  timingIntervalId?: number | null
  startedAt: number
  cleanup: () => void
}
