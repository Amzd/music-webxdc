import { RealTime } from '@webxdc/realtime'
import { parseBlob } from 'music-metadata'

import { CHUNK_SIZE, db, getDownloadProgress } from './lib/storage'
import { isRequest, isResponse } from './lib/validate-payload'

init()

async function init() {
    const uploadBtn = /** @type {HTMLButtonElement} */ (
        document.getElementById('upload-btn')
    )
    const fileInput = /** @type {HTMLInputElement} */ (
        document.getElementById('file-input')
    )
    const titleEl = /** @type {HTMLHeadingElement} */ (
        document.querySelector('header h1')
    )
    const playlist = /** @type {HTMLElement} */ (
        document.getElementById('playlist')
    )
    const emptyMsg = /** @type {HTMLElement} */ (
        document.getElementById('empty-msg')
    )
    const nowPlaying = /** @type {HTMLElement} */ (
        document.getElementById('now-playing')
    )
    const playBtn = /** @type {HTMLButtonElement} */ (
        document.getElementById('play-btn')
    )
    const syncBtn = /** @type {HTMLButtonElement} */ (
        document.getElementById('sync-btn')
    )
    const prevBtn = /** @type {HTMLButtonElement} */ (
        document.getElementById('prev-btn')
    )
    const nextBtn = /** @type {HTMLButtonElement} */ (
        document.getElementById('next-btn')
    )
    const progressBar = /** @type {HTMLInputElement} */ (
        document.getElementById('progress-bar')
    )
    const currentTimeEl = /** @type {HTMLElement} */ (
        document.getElementById('current-time')
    )
    const durationEl = /** @type {HTMLElement} */ (
        document.getElementById('duration')
    )
    const renameOverlay = /** @type {HTMLElement} */ (
        document.getElementById('rename-overlay')
    )
    const renameInput = /** @type {HTMLInputElement} */ (
        document.getElementById('rename-input')
    )
    const renameOk = /** @type {HTMLButtonElement} */ (
        document.getElementById('rename-ok')
    )
    const renameCancel = /** @type {HTMLButtonElement} */ (
        document.getElementById('rename-cancel')
    )

    /** @type {string[]} File IDs in playlist order. */
    let trackIds = []
    let currentIndex = -1
    let isPlaying = false
    let isSeeking = false
    /** Whether the user has enabled shared-playback sync with peers. */
    let isSyncing = true
    /** @type {string | null} */
    let currentObjectUrl = null

    const audio = new Audio()

    /** Map from file ID to its playlist button element. */
    /** @type {Map<string, HTMLButtonElement>} */
    const trackElements = new Map()

    /**
     * Cache of name/subtitle span references per playlist button element, to
     * avoid repeated querySelector calls on every update.
     *
     * @type {WeakMap<
     *     HTMLButtonElement,
     *     { nameEl: HTMLElement; subtitleEl: HTMLElement }
     * >}
     */
    const trackSpans = new WeakMap()

    /**
     * Cache of parsed metadata per file ID. Stores both the raw common tags and
     * the pre-computed artwork data URLs.
     *
     * @type {Map<
     *     string,
     *     {
     *         common: import('music-metadata').ICommonTagsResult
     *         artwork: MediaImage[]
     *     }
     * >}
     */
    const metadataCache = new Map()

    const PLAYLIST_NAME_KEY = 'playlistName'
    let playlistName = localStorage.getItem(PLAYLIST_NAME_KEY) ?? 'Music'

    /** @param {string} name */
    function applyPlaylistName(name) {
        playlistName = name
        localStorage.setItem(PLAYLIST_NAME_KEY, name)
        document.title = name
        titleEl.textContent = '🎵 ' + name
    }

    applyPlaylistName(playlistName)

    /**
     * Show the custom rename dialog and resolve with the new name (trimmed), or
     * null if the user cancelled.
     *
     * @returns {Promise<string | null>}
     */
    function showRenamePrompt() {
        return new Promise((resolve) => {
            renameInput.value = playlistName
            renameOverlay.classList.add('open')
            renameInput.focus()
            renameInput.select()

            /** @param {string | null} value */
            function close(value) {
                renameOverlay.classList.remove('open')
                renameOk.removeEventListener('click', onOk)
                renameCancel.removeEventListener('click', onCancel)
                renameOverlay.removeEventListener('click', onOverlayClick)
                renameInput.removeEventListener('keydown', onKeydown)
                resolve(value)
            }

            function onOk() {
                close(renameInput.value.trim() || null)
            }

            function onCancel() {
                close(null)
            }

            /** @param {MouseEvent} e */
            function onOverlayClick(e) {
                if (e.target === renameOverlay) close(null)
            }

            /** @param {KeyboardEvent} e */
            function onKeydown(e) {
                if (e.key === 'Enter') onOk()
                else if (e.key === 'Escape') close(null)
            }

            renameOk.addEventListener('click', onOk)
            renameCancel.addEventListener('click', onCancel)
            renameOverlay.addEventListener('click', onOverlayClick)
            renameInput.addEventListener('keydown', onKeydown)
        })
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /** @param {Blob} blob @returns {Promise<string>} */
    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(/** @type {string} */ (reader.result))
            reader.onerror = reject
            reader.readAsDataURL(blob)
        })
    }

    /**
     * Pushes current playback position into the shared realtime state so peers
     * can see what is playing. Publishes null when sync is disabled so peers
     * know this device is listening solo.
     */
    function broadcastPlayback() {
        const state = realtime.getState() ?? { files: [], nowPlaying: null }
        const fileId =
            currentIndex >= 0 ? (trackIds[currentIndex] ?? null) : null
        realtime.setState({
            ...state,
            nowPlaying:
                isSyncing && fileId
                    ? {
                          fileId,
                          isPlaying: isPlaying,
                          currentTime: audio.currentTime,
                          actionTime: Date.now(),
                      }
                    : null,
        })
    }

    const ICON_SOLO =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>'
    const ICON_SYNC =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>'

    /** Reflects the current isSyncing state on the button element. */
    function updateSyncButton() {
        syncBtn.innerHTML = isSyncing ? ICON_SYNC : ICON_SOLO
        syncBtn.setAttribute(
            'aria-label',
            isSyncing ? 'Syncing with peers' : 'Listen solo'
        )
        syncBtn.setAttribute('aria-pressed', String(isSyncing))
    }

    let lastSync = 0
    /**
     * If sync is enabled and a peer is actively playing a fully-downloaded
     * track while we are idle, start playing at the peer's current position.
     * Only follows the peer with the newest actionTime, and only when that
     * actionTime is newer than our own nowPlaying.actionTime.
     *
     * @param {import('@webxdc/realtime').Peer<
     *     import('./lib/validate-payload').AppState
     * >[]} peers
     */
    async function trySyncToPeer(peers) {
        if (!isSyncing) return
        const state = realtime.getState()
        const files = state?.files ?? []
        const myActionTime = state?.nowPlaying?.actionTime ?? 0

        // Find the peer with the newest actionTime that is still playing.
        /** @type {import('./lib/validate-payload').NowPlaying | null} */
        let bestNp = null
        for (const peer of peers) {
            const np = peer.state?.nowPlaying
            if (!np) continue
            if (np.actionTime <= myActionTime) continue
            const file = files.find((f) => f.id === np.fileId)
            if (!file || file.pending.length > 0) continue
            if (trackIds.indexOf(np.fileId) === -1) continue
            if (!bestNp || np.actionTime > bestNp.actionTime) bestNp = np
        }

        if (!bestNp) return
        if (bestNp.actionTime <= lastSync) return
        lastSync = bestNp.actionTime

        let index = trackIds.indexOf(bestNp.fileId)
        await playTrack(index)
        const elapsed = (Date.now() - bestNp.actionTime) / 1000
        let seekTo = bestNp.currentTime + elapsed
        while (seekTo >= audio.duration) {
            seekTo -= audio.duration
            index += 1
            await playTrack(index)
        }
        if (isFinite(audio.duration) && seekTo < audio.duration) {
            audio.currentTime = seekTo
            while (audio.currentTime < seekTo) {
                audio.currentTime = seekTo
                await new Promise((r) => setTimeout(r, 10))
            }
        }
        if (!bestNp.isPlaying) audio.pause()

        return true
    }

    const ICON_PLAY =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
    const ICON_PAUSE =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'

    /** @param {number} seconds */
    function formatTime(seconds) {
        if (!isFinite(seconds)) return '0:00'
        const m = Math.floor(seconds / 60)
        const s = Math.floor(seconds % 60)
        return `${m}:${s.toString().padStart(2, '0')}`
    }

    function updatePlayButton() {
        playBtn.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY
        playBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play')
    }

    /** @param {number} index */
    function highlightTrack(index) {
        document
            .querySelectorAll('.playlist-item')
            .forEach((el, i) => el.classList.toggle('active', i === index))
    }

    /**
     * Updates a playlist button to show current download progress.
     *
     * @param {HTMLButtonElement} el
     * @param {import('./lib/validate-payload').FileMeta} file
     */
    function updateTrackElement(el, file) {
        const pct = getDownloadProgress(file)
        const spans = trackSpans.get(el)
        const nameEl = spans
            ? spans.nameEl
            : /** @type {HTMLElement} */ (el.querySelector('.track-name'))
        const subtitleEl = spans
            ? spans.subtitleEl
            : /** @type {HTMLElement} */ (el.querySelector('.track-subtitle'))
        if (pct < 100) {
            nameEl.textContent = pct + '% \u2014 ' + file.name
            el.classList.add('downloading')
        } else {
            nameEl.textContent = file.name
            el.classList.remove('downloading')
        }
        if (file.uploadedBy) {
            subtitleEl.textContent = 'Shared by ' + file.uploadedBy
            subtitleEl.hidden = false
        } else {
            subtitleEl.hidden = true
        }
    }

    /** @type {{ row: HTMLElement; menu: HTMLElement } | null} */
    let openMenu = null

    function closeOpenMenu() {
        if (openMenu) {
            openMenu.menu.hidden = true
            openMenu = null
        }
    }

    document.addEventListener('click', closeOpenMenu)

    /**
     * Adds a new track row to the playlist.
     *
     * @param {import('./lib/validate-payload').FileMeta} file
     */
    function addTrackToPlaylist(file) {
        emptyMsg.hidden = true
        const row = document.createElement('div')
        row.className = 'playlist-row'

        const item = document.createElement('button')
        item.className = 'playlist-item'
        item.type = 'button'

        const nameSpan = document.createElement('span')
        nameSpan.className = 'track-name'

        const subtitleSpan = document.createElement('span')
        subtitleSpan.className = 'track-subtitle'
        subtitleSpan.hidden = true

        item.appendChild(nameSpan)
        item.appendChild(subtitleSpan)
        trackSpans.set(item, { nameEl: nameSpan, subtitleEl: subtitleSpan })

        updateTrackElement(item, file)

        const menuBtn = document.createElement('button')
        menuBtn.className = 'playlist-menu-btn'
        menuBtn.type = 'button'
        menuBtn.setAttribute('aria-label', 'More options')
        menuBtn.textContent = '\u22EE'

        const menu = document.createElement('div')
        menu.className = 'playlist-menu'
        menu.hidden = true

        const downloadBtn = document.createElement('button')
        downloadBtn.className = 'playlist-menu-item'
        downloadBtn.type = 'button'
        downloadBtn.textContent = 'Download'

        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'playlist-menu-item playlist-menu-delete'
        deleteBtn.type = 'button'
        deleteBtn.textContent = 'Delete'

        menu.appendChild(downloadBtn)
        menu.appendChild(deleteBtn)
        row.appendChild(item)
        row.appendChild(menuBtn)
        row.appendChild(menu)

        const fileId = file.id
        item.addEventListener('click', () => {
            if (item.classList.contains('downloading')) return
            const index = trackIds.indexOf(fileId)
            if (index !== -1) playTrack(index).then(broadcastPlayback)
        })

        menuBtn.addEventListener('click', (e) => {
            // stopPropagation prevents the document-level click listener from
            // immediately closing the menu we are about to open.
            e.stopPropagation()
            const isOpen = !menu.hidden
            closeOpenMenu()
            if (!isOpen) {
                menu.hidden = false
                openMenu = { row, menu }
            }
        })

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            closeOpenMenu()
            deleteTrack(fileId)
        })

        downloadBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            closeOpenMenu()
            if (item.classList.contains('downloading')) return
            const chunks = await db.chunks
                .where('file')
                .equals(fileId)
                .sortBy('id')
            if (!chunks.length) return
            const blob = new Blob(
                chunks.map((c) => c.blob),
                { type: 'audio/mpeg' }
            )
            window.webxdc.sendToChat({
                file: {
                    name: file.name,
                    blob,
                },
            })
        })

        playlist.appendChild(row)
        trackIds.push(file.id)
        trackElements.set(file.id, item)
    }

    /**
     * Syncs the playlist DOM with the given file list. Adds buttons for new
     * tracks and updates progress indicators on existing ones.
     *
     * @param {import('./lib/validate-payload').FileMeta[]} files
     */
    function refreshPlaylist(files) {
        for (const file of files) {
            if (file.size <= 0) continue
            const el = trackElements.get(file.id)
            if (!el) {
                addTrackToPlaylist(file)
            } else {
                updateTrackElement(el, file)
            }
        }
    }

    /**
     * Removes a track from the DOM and in-memory structures. Stops playback if
     * the removed track was currently playing.
     *
     * @param {string} fileId
     */
    function removeTrackFromUI(fileId) {
        const el = trackElements.get(fileId)
        if (el) {
            el.closest('.playlist-row')?.remove()
            trackElements.delete(fileId)
        }

        const index = trackIds.indexOf(fileId)
        if (index !== -1) {
            trackIds.splice(index, 1)

            if (currentIndex === index) {
                audio.pause()
                if (currentObjectUrl) {
                    URL.revokeObjectURL(currentObjectUrl)
                    currentObjectUrl = null
                }
                isPlaying = false
                currentIndex = -1
                nowPlaying.textContent = 'Nothing playing'
                playBtn.disabled = trackIds.length === 0
                updatePlayButton()
                if ('mediaSession' in navigator) {
                    navigator.mediaSession.playbackState = 'none'
                }
            } else if (currentIndex > index) {
                currentIndex--
            }
        }

        if (trackIds.length === 0) {
            emptyMsg.hidden = false
        }

        highlightTrack(currentIndex)
    }

    /**
     * Deletes a track for all peers: removes local chunks, writes a size-0
     * tombstone so the deletion propagates, and updates the shared state.
     *
     * @param {string} fileId
     */
    async function deleteTrack(fileId) {
        const wasCurrentTrack =
            currentIndex >= 0 && trackIds[currentIndex] === fileId

        removeTrackFromUI(fileId)

        const now = Date.now()
        const existingFile = await db.files.where('id').equals(fileId).first()
        if (existingFile) {
            // Keep a tombstone (size: 0) so we never re-download this file.
            await db.files.put({
                ...existingFile,
                size: 0,
                pending: [],
                lastModified: now,
            })
        }
        await db.chunks.where('file').equals(fileId).delete()

        const currentState = realtime.getState() ?? {
            files: [],
            nowPlaying: null,
        }
        const updatedFiles = currentState.files.map((f) =>
            f.id === fileId
                ? { ...f, size: 0, pending: [], lastModified: now }
                : f
        )
        realtime.setState({
            ...currentState,
            files: updatedFiles,
            nowPlaying: wasCurrentTrack ? null : currentState.nowPlaying,
        })
    }

    function setAudioSrc(src) {
        return new Promise((resolve) => {
            audio.src = src
            audio.load()
            audio.addEventListener('canplaythrough', resolve, { once: true })
        })
    }

    /** @param {number} index */
    async function playTrack(index) {
        if (index < 0 || index >= trackIds.length) return

        const id = trackIds[index]
        if (!id) return

        // Don't attempt playback if the track is still downloading.
        const el = trackElements.get(id)
        if (el?.classList.contains('downloading')) return

        /** @type {import('./lib/validate-payload').Chunk[]} */
        const chunks = await db.chunks.where('file').equals(id).sortBy('id')
        if (!chunks.length) return

        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl)
            currentObjectUrl = null
        }

        const blob = new Blob(
            chunks.map((c) => c.blob),
            { type: 'audio/mpeg' }
        )

        const file = (realtime.getState()?.files ?? []).find((f) => f.id === id)

        // Start playback immediately — iOS requires audio.play() to be called
        // synchronously within the user-gesture handler. Any await before play()
        // causes iOS to reject the call and the media session never activates.
        //
        // Set basic metadata synchronously before play() so that iOS can
        // determine the control layout (prev/next track vs. skip-10s) at the
        // moment playback starts. Without metadata iOS defaults to skip buttons.
        currentObjectUrl = URL.createObjectURL(blob)
        await setAudioSrc(currentObjectUrl)
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: file?.name ?? id,
                artist: '',
                album: '',
            })
        }
        // Set currentIndex before play() so the 'play' event sees the correct track.
        currentIndex = index
        audio.play()
        isPlaying = true
        nowPlaying.textContent = file?.name ?? id
        playBtn.disabled = false
        updatePlayButton()
        highlightTrack(index)

        // Update metadata asynchronously with full tags and artwork after
        // playback has started. iOS picks up metadata updates mid-playback.
        if ('mediaSession' in navigator) {
            if (!metadataCache.has(id)) {
                const { common } = await parseBlob(blob)
                const artwork = await Promise.all(
                    (common?.picture ?? []).map(async (pic) => {
                        const dataUrl = await blobToDataURL(
                            new Blob([pic.data], { type: pic.format })
                        )
                        return /** @type {MediaImage} */ ({
                            src: dataUrl,
                            type: pic.format,
                        })
                    })
                )
                metadataCache.set(id, { common, artwork })
            }
            const { common, artwork } =
                /** @type {NonNullable<ReturnType<typeof metadataCache.get>>} */ (
                    metadataCache.get(id)
                )
            navigator.mediaSession.metadata = new MediaMetadata({
                title: common?.title || (file?.name ?? id),
                artist: common?.artist,
                album: common?.album,
                artwork,
            })
        }
    }

    // ── audio events ───────────────────────────────────────────────────────

    audio.addEventListener('ended', () => {
        if (isSeeking) return
        if (trackIds.length > 0) {
            playTrack((currentIndex + 1) % trackIds.length)
        }
    })

    audio.addEventListener('timeupdate', () => {
        if (isSeeking) return
        if (!isFinite(audio.duration)) return
        const pct = (audio.currentTime / audio.duration) * 100
        progressBar.value = String(pct)
        currentTimeEl.textContent = formatTime(audio.currentTime)
    })

    audio.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(audio.duration)
        progressBar.value = '0'
    })

    audio.addEventListener('play', () => {
        isPlaying = true
        updatePlayButton()
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing'
        }
    })

    audio.addEventListener('pause', () => {
        isPlaying = false
        updatePlayButton()
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused'
        }
    })

    // ── Media Session action handlers ──────────────────────────────────────

    // https://stackoverflow.com/a/78001443
    audio.addEventListener('playing', () => {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => {
                audio.play()
            })
            navigator.mediaSession.setActionHandler('pause', () => {
                audio.pause()
            })

            // Only register previoustrack/nexttrack — never register seekbackward,
            // seekforward, or seekto so that iOS shows next/prev track buttons
            // instead of the default skip-10-seconds controls.
            navigator.mediaSession.setActionHandler('previoustrack', () => {
                if (trackIds.length === 0) return
                playTrack(
                    currentIndex <= 0 ? trackIds.length - 1 : currentIndex - 1
                )
            })
            navigator.mediaSession.setActionHandler('nexttrack', () => {
                if (trackIds.length === 0) return
                playTrack((currentIndex + 1) % trackIds.length)
            })
        }
    })

    // ── controls ───────────────────────────────────────────────────────────

    playBtn.addEventListener('click', () => {
        if (currentIndex === -1 && trackIds.length > 0) {
            playTrack(0)
            return
        }
        if (isPlaying) {
            audio.pause()
            isPlaying = false
        } else {
            audio.play()
            isPlaying = true
        }
        updatePlayButton()
        broadcastPlayback()
    })

    syncBtn.addEventListener('click', () => {
        isSyncing = !isSyncing
        updateSyncButton()
        if (isSyncing) {
            trySyncToPeer(realtime.getPeers()).then((syncedToPeer) => {
                if (!syncedToPeer) {
                    broadcastPlayback()
                    const songCount = (realtime.getState() ?? { files: [] })
                        .files.length
                    const onPlaylist =
                        playlistName == 'Music' ? '' : ` on "${playlistName}"`
                    window.webxdc.sendUpdate(
                        {
                            payload: null,
                            info: `${window.webxdc.selfName} started a jam${onPlaylist}!`,
                            summary: `${songCount} song${songCount === 1 ? '' : 's'}`,
                        },
                        ''
                    )
                }
            })
        } else {
            lastSync = 0
        }
    })

    prevBtn.addEventListener('click', () => {
        if (trackIds.length === 0) return
        playTrack(
            currentIndex <= 0 ? trackIds.length - 1 : currentIndex - 1
        ).then(broadcastPlayback)
    })

    nextBtn.addEventListener('click', () => {
        if (trackIds.length === 0) return
        playTrack((currentIndex + 1) % trackIds.length).then(broadcastPlayback)
    })

    var wasPlayingWhenStartedSeeking = false
    progressBar.addEventListener('pointerdown', () => {
        isSeeking = true
        wasPlayingWhenStartedSeeking = !audio.paused
    })

    const onSeekEnd = () => {
        if (!isSeeking) return
        isSeeking = false
        if (trackIds.length == 0) return
        setTimeout(() => {
            // make sure seek finished
            audio.currentTime =
                (Number(progressBar.value) / 100) * audio.duration
            if (audio.currentTime >= audio.duration) {
                playTrack((currentIndex + 1) % trackIds.length).then(
                    broadcastPlayback
                )
            } else {
                broadcastPlayback()
            }
        }, 310)
    }
    progressBar.addEventListener('pointerup', onSeekEnd)
    progressBar.addEventListener('pointercancel', onSeekEnd)

    const seek = throttleWithTrailing(() => {
        audio.currentTime = (Number(progressBar.value) / 100) * audio.duration
        if (
            wasPlayingWhenStartedSeeking &&
            audio.paused &&
            progressBar.value < 100
        )
            audio.play()
    }, 300)
    progressBar.addEventListener('input', () => {
        if (!isSeeking) return
        if (!isFinite(audio.duration)) return
        seek()
    })

    // ── upload ─────────────────────────────────────────────────────────────

    const sendSongCountUpdate = debounce(() => {
        const songCount = (realtime.getState() ?? { files: [] }).files.length
        window.webxdc.sendUpdate(
            {
                payload: null,
                summary: `${songCount} song${songCount === 1 ? '' : 's'}`,
            },
            ''
        )
    }, 10_000)

    titleEl.addEventListener('click', async () => {
        const newName = await showRenamePrompt()
        if (!newName || newName === playlistName || newName.length > 100) return
        applyPlaylistName(newName)
        const state = realtime.getState() ?? { files: [], nowPlaying: null }
        realtime.setState({ ...state, playlistName: newName })
        const songCount = state.files.length
        window.webxdc.sendUpdate(
            {
                payload: null,
                document: newName,
                summary: `${songCount} song${songCount === 1 ? '' : 's'}`,
            },
            ''
        )
    })

    uploadBtn.addEventListener('click', () => fileInput.click())

    fileInput.addEventListener('change', async () => {
        if (!fileInput.files) return
        for (const file of Array.from(fileInput.files)) {
            if (!file.type.includes('audio') && !file.name.endsWith('.mp3'))
                continue
            await sendFile(file)
        }
        fileInput.value = ''
    })

    /**
     * Stores a file as chunks in IndexedDB and advertises it to peers via
     * realtime state so they can pull it chunk by chunk.
     *
     * @param {File} file
     */
    async function sendFile(file) {
        const lastModified = file.lastModified || Date.now()
        const currentState = realtime.getState() ?? {
            files: [],
            nowPlaying: null,
        }
        const existing = currentState.files.find(
            (f) => f.name === file.name && f.size > 0
        )
        const id = existing ? existing.id : crypto.randomUUID()

        /** @satisfies {import('./lib/validate-payload').FileMeta} */
        const meta = {
            id,
            name: file.name,
            lastModified,
            size: file.size,
            type: file.type,
            pending: [],
            uploadedBy: window.webxdc.selfName,
        }

        if (existing) {
            await db.chunks.where('file').equals(id).delete()
        }
        await db.files.put(meta)

        const chunkCount = Math.ceil(file.size / CHUNK_SIZE)
        for (let i = 0; i < chunkCount; i++) {
            const start = i * CHUNK_SIZE
            const end = Math.min(start + CHUNK_SIZE, file.size)
            await db.chunks.add({
                file: id,
                id: i,
                blob: file.slice(start, end),
            })
        }

        const updatedFiles = existing
            ? currentState.files.map((f) => (f.id === id ? meta : f))
            : [...currentState.files, meta]
        realtime.setState({ ...currentState, files: updatedFiles })
        refreshPlaylist([meta])
        sendSongCountUpdate()
    }

    // ── realtime sync ──────────────────────────────────────────────────────

    // currentRequest is read/written only in syncChunks and handlePayload, both
    // of which run on the JS single-threaded event loop, so no locking is needed.
    /** @type {import('./lib/validate-payload').PeerRequest | null} */
    let currentRequest = null

    /** Milliseconds before a chunk request is considered timed-out. */
    const CHUNK_REQUEST_TIMEOUT_MS = 10_000
    /** Poll interval while a chunk request is in flight. */
    const SYNC_POLL_ACTIVE_MS = 10
    /** Poll interval while no chunk request is in flight. */
    const SYNC_POLL_IDLE_MS = 100

    /**
     * Fisher-Yates shuffle - returns a new array.
     *
     * @template T
     * @param {T[]} arr
     *
     * @returns {T[]}
     */
    function shuffle(arr) {
        const a = arr.slice()
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            const tmp = a[i]
            a[i] = /** @type {T} */ (a[j])
            a[j] = /** @type {T} */ (tmp)
        }
        return a
    }

    /**
     * Tries to find a peer that has the given chunk. Returns null if none
     * found.
     *
     * @param {import('./lib/validate-payload').FileMeta} file
     * @param {number} chunkId
     *
     * @returns {import('./lib/validate-payload').PeerRequest | null}
     */
    function createRequest(file, chunkId) {
        for (const peer of shuffle(realtime.getPeers())) {
            const peerFile = peer.state?.files?.find((f) => f.id === file.id)
            if (
                peerFile &&
                peerFile.lastModified === file.lastModified &&
                peerFile.pending.indexOf(chunkId) < 0
            ) {
                return {
                    time: Date.now(),
                    file: file.id,
                    chunk: chunkId,
                    peer: peer.id,
                }
            }
        }
        return null
    }

    /**
     * Periodic loop: requests one missing chunk from a peer that has it. Runs
     * every 100 ms when idle, 10 ms while a request is in flight.
     */
    function syncChunks() {
        if (
            !currentRequest ||
            Date.now() - currentRequest.time > CHUNK_REQUEST_TIMEOUT_MS
        ) {
            let request = null
            const files = realtime.getState()?.files ?? []
            outer: for (const file of files) {
                if (file.pending.length > 0) {
                    for (const chunkId of shuffle(file.pending)) {
                        request = createRequest(file, chunkId)
                        if (request) break outer
                    }
                }
            }
            if (request) {
                currentRequest = request
                realtime.sendPayload({ request })
            }
        }
        setTimeout(
            syncChunks,
            currentRequest ? SYNC_POLL_ACTIVE_MS : SYNC_POLL_IDLE_MS
        )
    }

    /**
     * Discovers new tracks from connected peers and queues them for download.
     *
     * @param {import('@webxdc/realtime').Peer<
     *     import('./lib/validate-payload').AppState
     * >[]} peers
     */
    async function syncFileList(peers) {
        const files = realtime.getState()?.files ?? []
        let changed = false

        for (const peer of peers) {
            const peerName = peer.state?.playlistName
            if (peerName && peerName !== playlistName) {
                applyPlaylistName(peerName)
            }

            const peerFiles = peer.state?.files ?? []
            for (let peerFile of peerFiles) {
                const myFile = files.find((f) => f.id === peerFile.id)

                if (peerFile.size === 0) {
                    // Deletion tombstone from peer.
                    if (!myFile) {
                        // Record the tombstone so we never re-download this file.
                        await db.files.put({ ...peerFile })
                        files.push({ ...peerFile })
                        changed = true
                    } else if (
                        myFile.size > 0 &&
                        peerFile.lastModified >= myFile.lastModified
                    ) {
                        // Peer deleted a file we still have - remove it locally.
                        await db.chunks
                            .where('file')
                            .equals(peerFile.id)
                            .delete()
                        await db.files.put({ ...peerFile })
                        Object.assign(myFile, {
                            size: 0,
                            pending: [],
                            lastModified: peerFile.lastModified,
                        })
                        removeTrackFromUI(peerFile.id)
                        changed = true
                    }
                    continue
                }

                if (!myFile) {
                    // New file from peer - queue all chunks for download.
                    peerFile = { ...peerFile, pending: [] }
                    const chunkCount = Math.ceil(peerFile.size / CHUNK_SIZE)
                    for (let i = 0; i < chunkCount; i++) {
                        peerFile.pending.push(i)
                    }
                    await db.files.add(peerFile)
                    files.push(peerFile)
                    changed = true
                } else if (myFile.lastModified < peerFile.lastModified) {
                    // File was updated - reset and re-download all chunks.
                    peerFile = { ...peerFile, pending: [] }
                    if (peerFile.size > 0) {
                        const chunkCount = Math.ceil(peerFile.size / CHUNK_SIZE)
                        for (let i = 0; i < chunkCount; i++) {
                            peerFile.pending.push(i)
                        }
                    }
                    await db.files.put(peerFile)
                    await db.chunks.where('file').equals(peerFile.id).delete()
                    myFile.name = peerFile.name
                    myFile.pending = peerFile.pending
                    myFile.lastModified = peerFile.lastModified
                    myFile.size = peerFile.size
                    myFile.type = peerFile.type
                    changed = true
                }
            }
        }

        if (changed) {
            const state = realtime.getState() ?? { files: [], nowPlaying: null }
            realtime.setState({ ...state, files })
            refreshPlaylist(files)
        }
    }

    /**
     * Handles an incoming realtime payload (chunk request or chunk response).
     *
     * @param {string} _deviceId
     * @param {unknown} payload
     */
    async function handlePayload(_deviceId, payload) {
        if (isRequest(payload)) {
            const { request: req } = payload
            // Only the targeted peer responds.
            if (req.peer !== realtime.getDeviceId()) return

            const file = await db.files.where('id').equals(req.file).first()
            if (file) {
                const chunk = await db.chunks
                    .where({ file: req.file, id: req.chunk })
                    .first()
                if (chunk) {
                    const data = new Uint8Array(await chunk.blob.arrayBuffer())
                    realtime.sendPayload({
                        response: {
                            file: req.file,
                            lastModified: file.lastModified,
                            chunk: req.chunk,
                            data,
                        },
                    })
                }
            }
        } else if (isResponse(payload)) {
            const { response: res } = payload
            const files = realtime.getState()?.files ?? []
            const file = files.find((f) => f.id === res.file)
            if (
                file &&
                file.lastModified === res.lastModified &&
                file.pending.indexOf(res.chunk) >= 0
            ) {
                file.pending = file.pending.filter((c) => c !== res.chunk)
                await db.files.put(file)
                await db.chunks.put({
                    file: res.file,
                    id: res.chunk,
                    blob: new Blob([res.data]),
                })
                if (
                    currentRequest?.file === res.file &&
                    currentRequest?.chunk === res.chunk
                ) {
                    currentRequest = null
                }

                const state = realtime.getState() ?? {
                    files: [],
                    nowPlaying: null,
                }
                realtime.setState({ ...state, files })
                refreshPlaylist(files)
            }
        }
    }

    /**
     * @type {import('@webxdc/realtime').RealTime<
     *     import('./lib/validate-payload').AppState,
     *     import('./lib/validate-payload').AppPayload
     * >}
     */
    const realtime = new RealTime({
        onPeersChanged: (peers) => {
            void syncFileList(peers)
            void trySyncToPeer(peers)
        },
        onPayload: (_deviceId, payload) => {
            void handlePayload(_deviceId, payload)
        },
    })

    // ── startup ────────────────────────────────────────────────────────────

    const allFiles = await db.files.toArray()
    realtime.setState({ files: allFiles, nowPlaying: null })
    realtime.connect()
    window.addEventListener('beforeunload', () => realtime.disconnect())
    updateSyncButton()
    refreshPlaylist(allFiles)
    setTimeout(syncChunks, 100)
}

function debounce(fn, delay) {
    let timeout = null
    return function (...args) {
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() => {
            timeout = null
            fn(...args)
        }, delay)
    }
}

function throttleWithTrailing(fn, delay) {
    let lastCall = 0
    let timeout = null
    let lastArgs = null

    return function (...args) {
        const now = performance.now()
        lastArgs = args

        const remaining = delay - (now - lastCall)

        if (remaining <= 0) {
            // Run immediately
            if (timeout) {
                clearTimeout(timeout)
                timeout = null
            }

            lastCall = now
            fn(...args)
        } else if (!timeout) {
            // Schedule trailing call
            timeout = setTimeout(() => {
                lastCall = performance.now()
                timeout = null
                fn(...lastArgs)
            }, remaining)
        }
    }
}
