# Dungeon Jukebox UI

Local-first soundboard for tabletop sessions, streams, and live scene control.

It uses the browser File System Access API, so your collections, audio files, and metadata stay on your disk (no backend required).

## What You Can Do

- Manage collections: create, rename title, set/remove icon, destroy.
- Import audio files and organize them in nested folders.
- Drag and drop audio:
  - onto folder cards to move between folders,
  - onto collection cards to move between collections,
  - onto the track deck to play immediately.
- Drag and drop folders into other folders to move directory trees.
- Search audio across all collections.
- Multi-select audio cards (`Ctrl/Cmd` toggle, `Shift` range).
- Edit per-audio metadata:
  - title,
  - category (`music`, `effect`, `sound`),
  - volume,
  - trim start/end,
  - infinite loop,
  - custom icon.
- Control playback with per-track volume, global volume, and Stop All.
- Play random audio from current visible results.
- Share/restore view state with URL hash:
  - `#<collection-name>`
  - `#collection=<name>&dir=<path>`
- Restore previously connected root folder (via IndexedDB + permission check).

## Quick Start

### Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- Chromium-based browser (Chrome, Edge, Brave, Arc, etc.)

### Setup

```sh
npm install
npm run dev
```

Open the Vite URL, then click `Select Folder` / `Connect Folder` and choose your local soundboard root.

## Interaction Cheatsheet

### Mouse + Keyboard

| Action | Result |
| --- | --- |
| Left click audio card | Selects card and plays it |
| Middle click audio card | Selects card for property editing (without auto-play) |
| `Ctrl/Cmd + click` audio | Toggle in multi-selection |
| `Shift + click` audio | Range selection |
| Drag audio card(s) | Move selected audio together |
| Drop audio on track deck | Play audio |
| Drop audio on folder card | Move audio into that folder |
| Drop audio on collection card | Move audio to that collection |
| Drag folder card onto another folder | Move folder into target folder |
| `Enter` in "Collection name" field | Create collection |
| `Enter` in "New folder name" field | Create folder (or folder with selected audio) |

### Right-Click Shortcuts

| Where you right-click | Menu action(s) |
| --- | --- |
| Folder card | `Rename`, `Delete` |
| Audio card | `Edit properties` |
| Empty space in files grid | `New folder` |

Notes:
- Right-click folder actions are disabled while search is active.
- Right-click on `..` parent shortcut has no menu.

## Typical Workflow

1. Connect a root folder.
2. Create one or more collections.
3. Import audio into the current collection/folder.
4. Organize with drag-and-drop and right-click menus.
5. Multi-select clips, then use `New folder with selection` to batch-organize.
6. Click or drop onto track deck to perform live playback.
7. Tune per-track and global volume in the Active Tracks panel.

## Supported Audio Formats

- `.mp3`
- `.wav`
- `.ogg`
- `.m4a`
- `.aac`
- `.flac`

## Project Scripts

- `npm run dev` - start Vite dev server
- `npm run type-check` - run `vue-tsc`
- `npm run build` - type-check + production build
- `npm run build-only` - production build only
- `npm run preview` - preview the built app

## Optional Deploy (S3)

```sh
./deploy-to-s3.sh <s3-bucket-name>
```

This builds `dist/`, uploads assets with cache headers, uploads `index.html` as no-cache, waits, then syncs with `--delete`.

## Local Folder Layout

```text
<root>/
  collections/
    <collection-name>/
      collection.json
      collection-icon.<ext>              # optional
      audio_files/
        <audio-file>.<ext>
        <audio-file>.<ext>.json          # metadata
        <audio-file>.<ext>.icon.<ext>    # optional
        <subfolder>/
          ...
```

Notes:
- `collection.json` stores collection title and icon filename.
- Imported audio gets a sibling metadata JSON file.
- Move operations preserve metadata/icons and auto-rename on collisions.

## Audio Metadata Schema

```json
{
  "title": null,
  "iconImage": null,
  "category": "sound",
  "infiniteLoop": false,
  "trimStart": null,
  "trimEnd": null,
  "volume": 100
}
```

## Development Notes

- No backend services are required.
- If folder restore fails, reconnect from the sidebar.
- If File System Access API is unavailable, folder connection is not possible.

## Storage Adapter API

Storage is now pluggable through a `StorageAdapter` interface:

- Interface: `src/storage/storageAdapter.ts`
- Default adapter (File System Access API): `src/storage/fileSystemStorageAdapter.ts`

`useSoundboard()` accepts an optional adapter:

```ts
import { useSoundboard } from '@/composables/useSoundboard'
import type { StorageAdapter } from '@/storage/storageAdapter'

const myAdapter: StorageAdapter = /* your implementation */
const soundboard = useSoundboard({ storageAdapter: myAdapter })
```

Adapter implementations must provide all operations needed by the UI, including:

- root connection/restore/permission
- collection listing and CRUD
- folder CRUD inside collections
- audio import/move/delete and metadata/icon updates
- resolving playable audio `File` objects and icon URLs

This lets you keep the same UI behavior while replacing storage backend logic (for example, a remote/S3-backed adapter).
