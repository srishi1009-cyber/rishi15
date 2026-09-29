from pathlib import Path

code = r'''// ============================================================
// RISHI MUSIC - BULLETPROOF APP ENGINE
// FULL UPDATED APP.JS
// ============================================================
//
// IMPORTANT:
// - Keeps the existing RishiMusicDB / tracks database.
// - Existing uploaded Blob audio files are preserved.
// - DB_VERSION 2 adds playlists + metadata without deleting tracks.
// ============================================================

const DB_NAME = "RishiMusicDB";
const DB_VERSION = 2;

const STORES = {
    TRACKS: "tracks",
    PLAYLISTS: "playlists",
    METADATA: "metadata"
};

// ============================================================
// 1. APP STATE
// ============================================================

let db = null;
let songs = [];
let currentIndex = -1;

let activeDirector = "all";
let searchQuery = "";

let favorites = new Set();
let recentlyPlayed = [];
let playlists = {};
let playHistoryStats = {};

let repeatMode = "off";       // off | all | one
let isShuffle = false;

let sleepTimerId = null;
let sleepTimerRemaining = 0;

// Playback protection
let playbackGeneration = 0;
let isTransitioning = false;
let activePlayPromise = null;
let nextSongTimer = null;
let stallWatchdog = null;
let lastKnownTime = -1;
let stallCount = 0;

// Queue
let unplayedQueue = [];

// Blob URL cache
const blobUrlCache = new WeakMap();

// ============================================================
// 2. AUDIO ELEMENT
// ============================================================

const audio =
    document.getElementById("audioEngine") ||
    new Audio();

if (!document.getElementById("audioEngine")) {
    audio.id = "audioEngine";
    document.body.appendChild(audio);
}

audio.preload = "auto";
audio.setAttribute("playsinline", "true");
audio.setAttribute("webkit-playsinline", "true");
audio.crossOrigin = "anonymous";

// ============================================================
// 3. PERSISTENT STORAGE
// ============================================================

async function requestPersistentStorage() {
    try {
        if (!navigator.storage || !navigator.storage.persist) return;

        const alreadyPersistent =
            navigator.storage.persisted
                ? await navigator.storage.persisted()
                : false;

        if (!alreadyPersistent) {
            await navigator.storage.persist();
        }
    } catch (err) {
        console.debug("Persistent storage request skipped:", err);
    }
}

// ============================================================
// 4. INDEXEDDB
// ============================================================

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            // NEVER replace/delete the existing tracks store.
            if (!database.objectStoreNames.contains(STORES.TRACKS)) {
                database.createObjectStore(STORES.TRACKS, {
                    keyPath: "id",
                    autoIncrement: true
                });
            }

            if (!database.objectStoreNames.contains(STORES.PLAYLISTS)) {
                database.createObjectStore(STORES.PLAYLISTS, {
                    keyPath: "name"
                });
            }

            if (!database.objectStoreNames.contains(STORES.METADATA)) {
                database.createObjectStore(STORES.METADATA, {
                    keyPath: "key"
                });
            }
        };

        request.onsuccess = () => {
            db = request.result;

            db.onversionchange = () => {
                try {
                    db.close();
                } catch (e) {}
            };

            resolve(db);
        };

        request.onerror = () => reject(request.error);

        request.onblocked = () => {
            console.warn("IndexedDB upgrade is blocked by another tab.");
        };
    });
}

function saveTrackToDB(track) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error("Database not ready"));
            return;
        }

        const tx = db.transaction(STORES.TRACKS, "readwrite");
        const store = tx.objectStore(STORES.TRACKS);
        const request = store.add(track);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function updateTrackInDB(track) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error("Database not ready"));
            return;
        }

        const tx = db.transaction(STORES.TRACKS, "readwrite");
        const store = tx.objectStore(STORES.TRACKS);
        const request = store.put(track);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function loadAllTracksFromDB() {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error("Database not ready"));
            return;
        }

        const tx = db.transaction(STORES.TRACKS, "readonly");
        const store = tx.objectStore(STORES.TRACKS);
        const request = store.getAll();

        request.onsuccess = () => {
            resolve(request.result || []);
        };

        request.onerror = () => reject(request.error);
    });
}

function setPersistentMeta(key, value) {
    return new Promise((resolve) => {
        if (!db) {
            resolve();
            return;
        }

        try {
            const tx = db.transaction(STORES.METADATA, "readwrite");
            tx.objectStore(STORES.METADATA).put({
                key,
                value
            });

            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (e) {
            resolve();
        }
    });
}

function getPersistentMeta(key) {
    return new Promise((resolve) => {
        if (!db) {
            resolve(null);
            return;
        }

        try {
            const tx = db.transaction(STORES.METADATA, "readonly");
            const request =
                tx.objectStore(STORES.METADATA).get(key);

            request.onsuccess = () => {
                resolve(request.result ? request.result.value : null);
            };

            request.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

// ============================================================
// 5. PLAYLIST DATABASE HELPERS
// ============================================================

function savePlaylistToDB(name, ids) {
    return new Promise((resolve) => {
        if (!db) {
            resolve();
            return;
        }

        try {
            const tx = db.transaction(STORES.PLAYLISTS, "readwrite");

            tx.objectStore(STORES.PLAYLISTS).put({
                name,
                ids: Array.isArray(ids) ? ids : []
            });

            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (e) {
            resolve();
        }
    });
}

function loadPlaylistsFromDB() {
    return new Promise((resolve) => {
        if (!db) {
            resolve({});
            return;
        }

        try {
            const tx = db.transaction(STORES.PLAYLISTS, "readonly");
            const request =
                tx.objectStore(STORES.PLAYLISTS).getAll();

            request.onsuccess = () => {
                const result = {};

                (request.result || []).forEach((item) => {
                    if (item && item.name) {
                        result[item.name] =
                            Array.isArray(item.ids) ? item.ids : [];
                    }
                });

                resolve(result);
            };

            request.onerror = () => resolve({});
        } catch (e) {
            resolve({});
        }
    });
}

// ============================================================
// 6. METADATA HELPERS
// ============================================================

function getSongTitle(song) {
    if (!song) return "Unknown Track";
    return String(
        song.title ||
        song.name ||
        "Unknown Track"
    );
}

function getSongDirector(song) {
    if (!song) return "UNKNOWN DIRECTOR";

    return String(
        song.director ||
        song.artist ||
        "UNKNOWN DIRECTOR"
    ).trim().toUpperCase();
}

function getSongSource(song) {
    if (!song) return null;

    // Existing Rishi15 songs are stored as Blob/File objects.
    if (song.blob instanceof Blob) {
        if (!blobUrlCache.has(song.blob)) {
            blobUrlCache.set(
                song.blob,
                URL.createObjectURL(song.blob)
            );
        }

        return blobUrlCache.get(song.blob);
    }

    // Compatibility with future/remote tracks.
    if (song.url) return song.url;

    return null;
}

// ============================================================
// 7. FILTERING / QUEUE
// ============================================================

function getFilteredSongIndexes() {
    const result = [];
    const query = searchQuery.trim().toLowerCase();

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];

        if (
            activeDirector !== "all" &&
            getSongDirector(song) !== activeDirector
        ) {
            continue;
        }

        if (query) {
            const searchable = [
                song.title || "",
                song.name || "",
                song.artist || "",
                song.director || ""
            ]
                .join(" ")
                .toLowerCase();

            if (!searchable.includes(query)) {
                continue;
            }
        }

        result.push(i);
    }

    return result;
}

function getAutomaticSongIndexes() {
    const result = [];

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];

        if (
            activeDirector !== "all" &&
            getSongDirector(song) !== activeDirector
        ) {
            continue;
        }

        result.push(i);
    }

    return result;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }

    return array;
}

function rebuildQueue() {
    const pool = getAutomaticSongIndexes();

    if (pool.length === 0) {
        unplayedQueue = [];
        return;
    }

    unplayedQueue = pool.filter(
        (index) => index !== currentIndex
    );

    shuffleArray(unplayedQueue);
}

function getNextUniqueSongIndex() {
    const pool = getAutomaticSongIndexes();

    if (pool.length === 0) return -1;

    if (pool.length === 1) {
        return pool[0];
    }

    // Remove songs that are no longer valid.
    unplayedQueue = unplayedQueue.filter(
        (index) => pool.includes(index)
    );

    if (unplayedQueue.length === 0) {
        rebuildQueue();
    }

    if (unplayedQueue.length === 0) {
        return -1;
    }

    // In ALL mode, prefer another music director.
    if (activeDirector === "all" && unplayedQueue.length > 1) {
        const currentDirector =
            songs[currentIndex]
                ? getSongDirector(songs[currentIndex])
                : null;

        const differentDirectorIndex =
            unplayedQueue.findIndex(
                (index) =>
                    getSongDirector(songs[index]) !==
                    currentDirector
            );

        if (differentDirectorIndex !== -1) {
            return unplayedQueue.splice(
                differentDirectorIndex,
                1
            )[0];
        }
    }

    return unplayedQueue.shift();
}

// ============================================================
// 8. FORMATTERS
// ============================================================

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }

    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);

    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ============================================================
// 9. MEDIA SESSION / AIRPODS / BLUETOOTH
// ============================================================

function setMediaSessionState(state) {
    if (!("mediaSession" in navigator)) return;

    try {
        navigator.mediaSession.playbackState = state;
    } catch (e) {}
}

function updateMediaSession(song) {
    if (!("mediaSession" in navigator) || !song) {
        return;
    }

    try {
        navigator.mediaSession.metadata =
            new MediaMetadata({
                title: getSongTitle(song),
                artist: getSongDirector(song),
                album: "Rishi Music"
            });

        updateMediaPositionState();
    } catch (e) {}
}

function updateMediaPositionState() {
    if (
        !("mediaSession" in navigator) ||
        !("setPositionState" in navigator.mediaSession)
    ) {
        return;
    }

    if (
        Number.isFinite(audio.duration) &&
        audio.duration > 0
    ) {
        try {
            navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate || 1,
                position: Math.min(
                    audio.currentTime || 0,
                    audio.duration
                )
            });
        } catch (e) {}
    }
}

function setupMediaSession() {
    if (!("mediaSession" in navigator)) {
        return;
    }

    function safeHandler(action, callback) {
        try {
            navigator.mediaSession.setActionHandler(
                action,
                callback
            );
        } catch (e) {}
    }

    safeHandler("play", async () => {
        isTransitioning = false;
        clearNextTimer();

        try {
            await resumeAudioContext();
            await audio.play();

            updatePlayButton();
            setMediaSessionState("playing");
        } catch (err) {
            // If the player is stuck, AirPods play can recover it
            // or immediately move to another track.
            const recovered =
                await recoverCurrentTrack();

            if (!recovered) {
                playNextAutomaticSong();
            }
        }
    });

    safeHandler("pause", () => {
        isTransitioning = false;

        audio.pause();

        updatePlayButton();
        setMediaSessionState("paused");
    });

    safeHandler("nexttrack", () => {
        isTransitioning = false;
        clearNextTimer();
        playNextAutomaticSong();
    });

    safeHandler("previoustrack", () => {
        isTransitioning = false;
        clearNextTimer();
        prevSong();
    });

    safeHandler("seekforward", (details) => {
        const skip =
            details && details.seekOffset
                ? details.seekOffset
                : 10;

        if (Number.isFinite(audio.duration)) {
            audio.currentTime = Math.min(
                audio.duration,
                audio.currentTime + skip
            );
        }

        updateMediaPositionState();
    });

    safeHandler("seekbackward", (details) => {
        const skip =
            details && details.seekOffset
                ? details.seekOffset
                : 10;

        audio.currentTime = Math.max(
            0,
            audio.currentTime - skip
        );

        updateMediaPositionState();
    });

    safeHandler("seekto", (details) => {
        if (
            details &&
            Number.isFinite(details.seekTime)
        ) {
            audio.currentTime =
                details.seekTime;

            updateMediaPositionState();
        }
    });
}

// ============================================================
// 10. WEB AUDIO EQUALIZER
// ============================================================

let audioCtx = null;
let audioSource = null;
let bassNode = null;
let trebleNode = null;
let eqInitialized = false;

function initEqualizer() {
    if (eqInitialized) return;

    try {
        const AudioContextClass =
            window.AudioContext ||
            window.webkitAudioContext;

        if (!AudioContextClass) return;

        audioCtx = new AudioContextClass();

        audioSource =
            audioCtx.createMediaElementSource(audio);

        bassNode =
            audioCtx.createBiquadFilter();

        bassNode.type = "lowshelf";
        bassNode.frequency.value = 250;
        bassNode.gain.value = 0;

        trebleNode =
            audioCtx.createBiquadFilter();

        trebleNode.type = "highshelf";
        trebleNode.frequency.value = 4000;
        trebleNode.gain.value = 0;

        audioSource.connect(bassNode);
        bassNode.connect(trebleNode);
        trebleNode.connect(
            audioCtx.destination
        );

        eqInitialized = true;
    } catch (err) {
        // Some browsers restrict AudioContext creation.
        // Normal playback still works without EQ.
        console.debug(
            "Equalizer unavailable:",
            err
        );

        audioCtx = null;
        audioSource = null;
        bassNode = null;
        trebleNode = null;
        eqInitialized = false;
    }
}

async function resumeAudioContext() {
    try {
        if (!audioCtx) {
            initEqualizer();
        }

        if (
            audioCtx &&
            audioCtx.state === "suspended"
        ) {
            await audioCtx.resume();
        }
    } catch (e) {}
}

function applyEqualizerPreset(presetName) {
    if (!eqInitialized) {
        initEqualizer();
    }

    if (!bassNode || !trebleNode) {
        return;
    }

    switch (presetName) {
        case "Bass Boost":
            bassNode.gain.value = 8;
            trebleNode.gain.value = -1;
            break;

        case "Vocal":
            bassNode.gain.value = -2;
            trebleNode.gain.value = 6;
            break;

        case "Rock":
            bassNode.gain.value = 5;
            trebleNode.gain.value = 4;
            break;

        case "Flat":
        default:
            bassNode.gain.value = 0;
            trebleNode.gain.value = 0;
            break;
    }

    setPersistentMeta(
        "eqPreset",
        presetName
    );
}

// ============================================================
// 11. SLEEP TIMER
// ============================================================

function setSleepTimer(minutes) {
    if (sleepTimerId) {
        clearInterval(sleepTimerId);
        sleepTimerId = null;
    }

    const buttons = {
        15: document.getElementById("timer15"),
        30: document.getElementById("timer30"),
        60: document.getElementById("timer60"),
        0: document.getElementById("timerOff")
    };

    Object.values(buttons).forEach((button) => {
        button?.classList.remove("active");
    });

    if (!minutes || minutes <= 0) {
        sleepTimerRemaining = 0;

        buttons[0]?.classList.add("active");

        updateSleepTimerUI();

        return;
    }

    if (buttons[minutes]) {
        buttons[minutes].classList.add("active");
    }

    sleepTimerRemaining =
        Math.floor(minutes * 60);

    updateSleepTimerUI();

    sleepTimerId = setInterval(() => {
        sleepTimerRemaining--;

        updateSleepTimerUI();

        if (sleepTimerRemaining <= 0) {
            clearInterval(sleepTimerId);
            sleepTimerId = null;

            audio.pause();

            updatePlayButton();
            setMediaSessionState("paused");

            buttons[0]?.classList.add("active");
        }
    }, 1000);
}

function updateSleepTimerUI() {
    const label =
        document.getElementById(
            "sleepTimerDisplay"
        );

    if (!label) return;

    label.textContent =
        sleepTimerRemaining <= 0
            ? "Off"
            : formatTime(sleepTimerRemaining);
}

// ============================================================
// 12. PLAY HISTORY / FAVORITES
// ============================================================

function recordSongPlay(song) {
    if (!song || song.id == null) {
        return;
    }

    recentlyPlayed = [
        song.id,
        ...recentlyPlayed.filter(
            (id) => id !== song.id
        )
    ].slice(0, 30);

    setPersistentMeta(
        "recentlyPlayed",
        recentlyPlayed
    );

    if (!playHistoryStats[song.id]) {
        playHistoryStats[song.id] = {
            playCount: 0,
            lastPlayed: 0
        };
    }

    playHistoryStats[song.id].playCount++;
    playHistoryStats[song.id].lastPlayed =
        Date.now();

    setPersistentMeta(
        "playHistoryStats",
        playHistoryStats
    );
}

function toggleFavorite(songId) {
    if (songId == null) return;

    if (favorites.has(songId)) {
        favorites.delete(songId);
    } else {
        favorites.add(songId);
    }

    setPersistentMeta(
        "favorites",
        Array.from(favorites)
    );

    renderSongList();
    renderFavoritesView();

    if (currentIndex !== -1) {
        updatePlayerInformation(
            songs[currentIndex]
        );
    }
}

// ============================================================
// 13. PLAYLISTS
// ============================================================

async function createPlaylist(name) {
    const cleanName = String(name || "").trim();

    if (!cleanName) return;

    if (playlists[cleanName]) {
        alert("Playlist already exists.");
        return;
    }

    playlists[cleanName] = [];

    await savePlaylistToDB(
        cleanName,
        playlists[cleanName]
    );

    setPersistentMeta(
        "playlists",
        playlists
    );

    renderPlaylistsView();
}

async function addSongToPlaylist(
    playlistName,
    songId
) {
    if (!playlists[playlistName]) {
        return;
    }

    if (!playlists[playlistName].includes(songId)) {
        playlists[playlistName].push(songId);

        await savePlaylistToDB(
            playlistName,
            playlists[playlistName]
        );

        setPersistentMeta(
            "playlists",
            playlists
        );
    }

    renderPlaylistsView();
}

async function choosePlaylistForSong(song) {
    if (!song || !Object.keys(playlists).length) {
        alert("Create a playlist first.");
        return;
    }

    const names = Object.keys(playlists);

    const message =
        "Enter playlist number:\n\n" +
        names
            .map(
                (name, index) =>
                    `${index + 1}. ${name}`
            )
            .join("\n");

    const answer = prompt(message);

    const selected =
        Number(answer) - 1;

    if (
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected >= names.length
    ) {
        return;
    }

    await addSongToPlaylist(
        names[selected],
        song.id
    );
}

// ============================================================
// 14. PLAYBACK UTILITIES
// ============================================================

function clearNextTimer() {
    if (nextSongTimer) {
        clearTimeout(nextSongTimer);
        nextSongTimer = null;
    }
}

function stopStallWatchdog() {
    if (stallWatchdog) {
        clearInterval(stallWatchdog);
        stallWatchdog = null;
    }

    lastKnownTime = -1;
    stallCount = 0;
}

function startStallWatchdog(generation) {
    stopStallWatchdog();

    stallWatchdog = setInterval(() => {
        if (generation !== playbackGeneration) {
            stopStallWatchdog();
            return;
        }

        if (
            audio.paused ||
            audio.ended ||
            currentIndex === -1
        ) {
            stallCount = 0;
            lastKnownTime = audio.currentTime;
            return;
        }

        const currentTime =
            audio.currentTime;

        if (
            lastKnownTime >= 0 &&
            Math.abs(
                currentTime - lastKnownTime
            ) < 0.05
        ) {
            stallCount++;
        } else {
            stallCount = 0;
        }

        lastKnownTime = currentTime;

        // Local Blob tracks should not remain frozen.
        // Five consecutive checks ~= 7.5 seconds.
        if (stallCount >= 5) {
            console.warn(
                "Playback stall detected. Moving to next track."
            );

            stopStallWatchdog();

            if (!isTransitioning) {
                playNextAutomaticSong();
            }
        }
    }, 1500);
}

async function recoverCurrentTrack() {
    if (currentIndex < 0) {
        return false;
    }

    const song = songs[currentIndex];

    if (!song) return false;

    try {
        await resumeAudioContext();

        audio.pause();

        const source =
            getSongSource(song);

        if (!source) return false;

        audio.removeAttribute("src");
        audio.load();

        audio.src = source;
        audio.currentTime = 0;

        await audio.play();

        updatePlayButton();
        setMediaSessionState("playing");

        startStallWatchdog(
            playbackGeneration
        );

        return true;
    } catch (e) {
        return false;
    }
}

// ============================================================
// 15. MAIN PLAY FUNCTION
// ============================================================

async function playSongAtIndex(
    index,
    isAutomatic = false
) {
    if (
        index < 0 ||
        index >= songs.length
    ) {
        return false;
    }

    const song = songs[index];

    if (!song) {
        return false;
    }

    const source =
        getSongSource(song);

    if (!source) {
        console.warn(
            "No playable source:",
            song
        );

        return false;
    }

    const generation =
        ++playbackGeneration;

    clearNextTimer();
    stopStallWatchdog();

    currentIndex = index;

    // Wait for a previous play() call before
    // replacing the source. This avoids AbortError.
    if (activePlayPromise) {
        try {
            await activePlayPromise;
        } catch (e) {}

        activePlayPromise = null;
    }

    // Flush old decoder state.
    try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
    } catch (e) {}

    audio.src = source;
    audio.currentTime = 0;

    updatePlayerInformation(song);
    updateMediaSession(song);

    recordSongPlay(song);

    renderSongList();
    renderMiniPlayer();

    try {
        await resumeAudioContext();

        activePlayPromise =
            audio.play();

        await activePlayPromise;

        activePlayPromise = null;

        if (
            generation !==
            playbackGeneration
        ) {
            return false;
        }

        updatePlayButton();
        setMediaSessionState("playing");

        startStallWatchdog(
            generation
        );

        return true;
    } catch (err) {
        activePlayPromise = null;

        console.warn(
            "Track playback failed:",
            err
        );

        if (
            generation ===
            playbackGeneration
        ) {
            updatePlayButton();
        }

        return false;
    }
}

// ============================================================
// 16. NEXT TRACK
// ============================================================

async function playNextAutomaticSong() {
    if (isTransitioning) {
        return;
    }

    isTransitioning = true;

    clearNextTimer();

    try {
        // Repeat current track.
        if (
            repeatMode === "one" &&
            currentIndex !== -1
        ) {
            const generation =
                ++playbackGeneration;

            try {
                audio.currentTime = 0;

                await resumeAudioContext();

                await audio.play();

                startStallWatchdog(
                    generation
                );

                updatePlayButton();
                setMediaSessionState(
                    "playing"
                );

                return;
            } catch (e) {
                // Fall through to another song.
            }
        }

        const pool =
            getAutomaticSongIndexes();

        if (!pool.length) {
            return;
        }

        let attempts = 0;

        // Try several tracks if one is broken.
        const maxAttempts =
            Math.max(
                1,
                Math.min(pool.length, 8)
            );

        while (
            attempts < maxAttempts
        ) {
            attempts++;

            let nextIndex = -1;

            if (isShuffle) {
                const choices =
                    pool.filter(
                        (index) =>
                            index !==
                            currentIndex
                    );

                if (!choices.length) {
                    nextIndex =
                        pool[0];
                } else {
                    nextIndex =
                        choices[
                            Math.floor(
                                Math.random() *
                                choices.length
                            )
                        ];
                }
            } else {
                nextIndex =
                    getNextUniqueSongIndex();
            }

            if (nextIndex === -1) {
                break;
            }

            const success =
                await playSongAtIndex(
                    nextIndex,
                    true
                );

            if (success) {
                return;
            }
        }

        // Final sequential fallback.
        const filtered =
            getAutomaticSongIndexes();

        if (filtered.length) {
            const position =
                filtered.indexOf(
                    currentIndex
                );

            const fallback =
                position === -1
                    ? filtered[0]
                    : filtered[
                          (position + 1) %
                          filtered.length
                      ];

            if (
                fallback !==
                currentIndex ||
                filtered.length === 1
            ) {
                await playSongAtIndex(
                    fallback,
                    true
                );
            }
        }
    } catch (err) {
        console.error(
            "Automatic transition failed:",
            err
        );
    } finally {
        isTransitioning = false;
    }
}

// ============================================================
// 17. PLAY / PAUSE / NEXT / PREVIOUS
// ============================================================

async function togglePlay() {
    if (
        currentIndex === -1 ||
        !audio.src
    ) {
        await playNextAutomaticSong();
        return;
    }

    if (audio.paused) {
        try {
            await resumeAudioContext();

            await audio.play();

            updatePlayButton();
            setMediaSessionState(
                "playing"
            );

            startStallWatchdog(
                playbackGeneration
            );
        } catch (e) {
            const recovered =
                await recoverCurrentTrack();

            if (!recovered) {
                await playNextAutomaticSong();
            }
        }
    } else {
        audio.pause();

        stopStallWatchdog();

        updatePlayButton();
        setMediaSessionState("paused");
    }
}

function nextSong() {
    isTransitioning = false;
    clearNextTimer();

    playNextAutomaticSong();
}

async function prevSong() {
    isTransitioning = false;
    clearNextTimer();

    const filtered =
        getFilteredSongIndexes();

    if (!filtered.length) {
        return;
    }

    const position =
        filtered.indexOf(currentIndex);

    let previousIndex;

    if (position <= 0) {
        previousIndex =
            filtered[filtered.length - 1];
    } else {
        previousIndex =
            filtered[position - 1];
    }

    await playSongAtIndex(
        previousIndex,
        false
    );
}

// ============================================================
// 18. SHUFFLE / REPEAT
// ============================================================

function toggleShuffle() {
    isShuffle = !isShuffle;

    unplayedQueue = [];

    const button =
        document.getElementById(
            "shuffleBtn"
        );

    if (button) {
        button.classList.toggle(
            "active",
            isShuffle
        );
    }

    setPersistentMeta(
        "shuffle",
        isShuffle
    );
}

function updateRepeatButton() {
    const button =
        document.getElementById(
            "repeatBtn"
        );

    if (!button) return;

    if (repeatMode === "one") {
        button.textContent = "🔂";
    } else {
        button.textContent = "🔁";
    }

    button.classList.toggle(
        "active",
        repeatMode !== "off"
    );
}

function toggleRepeat() {
    const modes = [
        "off",
        "all",
        "one"
    ];

    const current =
        modes.indexOf(repeatMode);

    repeatMode =
        modes[
            (current + 1) %
            modes.length
        ];

    updateRepeatButton();

    setPersistentMeta(
        "repeatMode",
        repeatMode
    );
}

// ============================================================
// 19. AUDIO EVENTS
// ============================================================

audio.addEventListener("play", () => {
    updatePlayButton();

    setMediaSessionState(
        "playing"
    );

    startStallWatchdog(
        playbackGeneration
    );
});

audio.addEventListener("pause", () => {
    updatePlayButton();

    if (!audio.ended) {
        setMediaSessionState(
            "paused"
        );
    }

    stopStallWatchdog();
});

audio.addEventListener("loadedmetadata", () => {
    const totalTime =
        document.getElementById(
            "totalTime"
        );

    if (totalTime) {
        totalTime.textContent =
            formatTime(
                audio.duration
            );
    }

    updateMediaPositionState();
});

audio.addEventListener("durationchange", () => {
    updateMediaPositionState();
});

audio.addEventListener("timeupdate", () => {
    const progressBar =
        document.getElementById(
            "progressBar"
        );

    const currentTime =
        document.getElementById(
            "currentTime"
        );

    if (currentTime) {
        currentTime.textContent =
            formatTime(
                audio.currentTime
            );
    }

    if (
        progressBar &&
        Number.isFinite(
            audio.duration
        ) &&
        audio.duration > 0
    ) {
        progressBar.value =
            (
                audio.currentTime /
                audio.duration
            ) * 100;
    }

    updateMediaPositionState();
});

audio.addEventListener("waiting", () => {
    setMediaSessionState("paused");
});

audio.addEventListener("stalled", () => {
    console.warn(
        "Audio stalled."
    );

    if (!audio.paused && !isTransitioning) {
        recoverCurrentTrack()
            .then((success) => {
                if (!success) {
                    playNextAutomaticSong();
                }
            });
    }
});

audio.addEventListener("ended", () => {
    clearNextTimer();
    stopStallWatchdog();

    isTransitioning = false;

    // repeat=all means continuous playback.
    // "off" also continues through the music library,
    // preserving the original Rishi Music behaviour.
    playNextAutomaticSong();
});

audio.addEventListener("error", () => {
    stopStallWatchdog();

    const failedIndex =
        currentIndex;

    console.warn(
        "Audio element error:",
        audio.error
    );

    isTransitioning = false;

    // Skip the broken track.
    if (
        failedIndex >= 0 &&
        songs[failedIndex]
    ) {
        unplayedQueue =
            unplayedQueue.filter(
                (index) =>
                    index !==
                    failedIndex
            );
    }

    playNextAutomaticSong();
});

// ============================================================
// 20. PROGRESS BAR
// ============================================================

function setupProgressBar() {
    const progressBar =
        document.getElementById(
            "progressBar"
        );

    if (!progressBar) return;

    progressBar.addEventListener(
        "input",
        () => {
            if (
                Number.isFinite(
                    audio.duration
                ) &&
                audio.duration > 0
            ) {
                audio.currentTime =
                    (
                        Number(
                            progressBar.value
                        ) / 100
                    ) *
                    audio.duration;

                updateMediaPositionState();
            }
        }
    );
}

// ============================================================
// 21. UI
// ============================================================

function updatePlayButton() {
    const playButton =
        document.getElementById(
            "playBtn"
        );

    const miniPlay =
        document.getElementById(
            "miniPlayBtn"
        );

    const text =
        audio.paused
            ? "▶"
            : "❚❚";

    if (playButton) {
        playButton.textContent =
            text;
    }

    if (miniPlay) {
        miniPlay.textContent =
            text;
    }
}

function updatePlayerInformation(song) {
    if (!song) return;

    const title =
        document.getElementById(
            "playerTitle"
        );

    const artist =
        document.getElementById(
            "playerArtist"
        );

    const favoriteButton =
        document.getElementById(
            "playerFavoriteBtn"
        );

    if (title) {
        title.textContent =
            getSongTitle(song);
    }

    if (artist) {
        artist.textContent =
            getSongDirector(song);
    }

    if (favoriteButton) {
        favoriteButton.textContent =
            favorites.has(song.id)
                ? "❤️"
                : "🤍";
    }
}

function renderMiniPlayer() {
    const miniPlayer =
        document.getElementById(
            "miniPlayer"
        );

    if (
        !miniPlayer ||
        currentIndex === -1
    ) {
        return;
    }

    const song =
        songs[currentIndex];

    if (!song) return;

    const title =
        document.getElementById(
            "miniPlayerTitle"
        );

    const artist =
        document.getElementById(
            "miniPlayerArtist"
        );

    if (title) {
        title.textContent =
            getSongTitle(song);
    }

    if (artist) {
        artist.textContent =
            getSongDirector(song);
    }

    miniPlayer.style.display =
        "flex";
}

function updateTrackCountUI() {
    const badge =
        document.getElementById(
            "trackCountBadge"
        );

    if (!badge) return;

    badge.textContent =
        `${songs.length} track${
            songs.length === 1
                ? ""
                : "s"
        }`;
}

// ============================================================
// 22. DIRECTORS
// ============================================================

function getDirectors() {
    const set = new Set();

    songs.forEach((song) => {
        const director =
            getSongDirector(song);

        if (
            director &&
            director !==
                "UNKNOWN DIRECTOR"
        ) {
            set.add(director);
        }
    });

    return Array.from(set).sort(
        (a, b) =>
            a.localeCompare(b)
    );
}

function updateDirectorFilter() {
    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (!filter) return;

    const previous =
        activeDirector;

    filter.innerHTML = "";

    const all =
        document.createElement(
            "option"
        );

    all.value = "all";
    all.textContent =
        "ALL DIRECTORS";

    filter.appendChild(all);

    getDirectors().forEach(
        (director) => {
            const option =
                document.createElement(
                    "option"
                );

            option.value =
                director;

            option.textContent =
                director;

            filter.appendChild(
                option
            );
        }
    );

    const exists =
        Array.from(
            filter.options
        ).some(
            (option) =>
                option.value ===
                previous
        );

    filter.value =
        exists
            ? previous
            : "all";

    activeDirector =
        filter.value === "all"
            ? "all"
            : filter.value;
}

function openDirectorView(
    directorName
) {
    activeDirector =
        !directorName ||
        String(
            directorName
        ).toLowerCase() ===
            "all"
            ? "all"
            : String(
                  directorName
              ).toUpperCase();

    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (filter) {
        filter.value =
            activeDirector === "all"
                ? "all"
                : activeDirector;
    }

    unplayedQueue = [];

    const title =
        document.getElementById(
            "viewTitle"
        );

    if (title) {
        title.textContent =
            activeDirector ===
            "all"
                ? "All Songs"
                : `🎼 ${activeDirector}`;
    }

    renderSongList();
}

// ============================================================
// 23. SONG LIST
// ============================================================

function renderSongList() {
    const container =
        document.getElementById(
            "songListContainer"
        ) ||
        document.querySelector(
            ".song-list"
        );

    if (!container) return;

    const filtered =
        getFilteredSongIndexes();

    container.innerHTML = "";

    if (!filtered.length) {
        const empty =
            document.createElement(
                "div"
            );

        empty.style.padding =
            "24px";

        empty.style.opacity =
            "0.65";

        empty.style.textAlign =
            "center";

        empty.textContent =
            "No tracks found in library.";

        container.appendChild(
            empty
        );

        return;
    }

    filtered.forEach(
        (index) => {
            const song =
                songs[index];

            const card =
                document.createElement(
                    "div"
                );

            card.className =
                "song-card" +
                (
                    index ===
                    currentIndex
                        ? " active"
                        : ""
                );

            const info =
                document.createElement(
                    "div"
                );

            info.className =
                "song-info";

            const icon =
                document.createElement(
                    "span"
                );

            icon.className =
                "song-icon";

            icon.textContent =
                "♫";

            const meta =
                document.createElement(
                    "div"
                );

            meta.className =
                "song-meta";

            const title =
                document.createElement(
                    "h4"
                );

            title.textContent =
                getSongTitle(song);

            const director =
                document.createElement(
                    "p"
                );

            director.textContent =
                getSongDirector(song);

            meta.appendChild(
                title
            );

            meta.appendChild(
                director
            );

            info.appendChild(
                icon
            );

            info.appendChild(
                meta
            );

            const actions =
                document.createElement(
                    "div"
                );

            actions.className =
                "song-actions";

            const fav =
                document.createElement(
                    "button"
                );

            fav.type = "button";
            fav.className =
                "fav-btn";

            fav.textContent =
                favorites.has(
                    song.id
                )
                    ? "❤️"
                    : "🤍";

            fav.title =
                "Favorite";

            fav.onclick = (event) => {
                event.stopPropagation();

                toggleFavorite(
                    song.id
                );
            };

            const playlistButton =
                document.createElement(
                    "button"
                );

            playlistButton.type =
                "button";

            playlistButton.className =
                "playlist-btn";

            playlistButton.textContent =
                "＋";

            playlistButton.title =
                "Add to playlist";

            playlistButton.onclick =
                (event) => {
                    event.stopPropagation();

                    choosePlaylistForSong(
                        song
                    );
                };

            const edit =
                document.createElement(
                    "button"
                );

            edit.type = "button";
            edit.className =
                "edit-btn";

            edit.textContent =
                "Edit";

            edit.onclick =
                (event) => {
                    event.stopPropagation();

                    editSong(index);
                };

            const play =
                document.createElement(
                    "button"
                );

            play.type = "button";

            play.className =
                "play-mini";

            play.textContent =
                "▶";

            play.onclick =
                (event) => {
                    event.stopPropagation();

                    playSongAtIndex(
                        index,
                        false
                    );
                };

            actions.appendChild(
                fav
            );

            actions.appendChild(
                playlistButton
            );

            actions.appendChild(
                edit
            );

            actions.appendChild(
                play
            );

            card.appendChild(
                info
            );

            card.appendChild(
                actions
            );

            card.onclick = () => {
                playSongAtIndex(
                    index,
                    false
                );
            };

            container.appendChild(
                card
            );
        }
    );
}

// ============================================================
// 24. EDIT SONG
// ============================================================

async function editSong(index) {
    const song =
        songs[index];

    if (!song) return;

    const newTitle =
        prompt(
            "Enter song name:",
            getSongTitle(song)
        );

    if (
        !newTitle ||
        !newTitle.trim()
    ) {
        return;
    }

    const newDirector =
        prompt(
            "Enter music director name:",
            getSongDirector(song)
        );

    if (
        !newDirector ||
        !newDirector.trim()
    ) {
        return;
    }

    song.title =
        newTitle.trim();

    song.director =
        newDirector
            .trim()
            .toUpperCase();

    song.artist =
        song.director;

    if (
        song.id !== undefined &&
        song.id !== null
    ) {
        await updateTrackInDB(
            song
        );
    }

    updateDirectorFilter();
    renderSongList();
    renderSmartDashboard();

    if (
        currentIndex === index
    ) {
        updatePlayerInformation(
            song
        );

        updateMediaSession(
            song
        );

        renderMiniPlayer();
    }
}

// ============================================================
// 25. FAVORITES VIEW
// ============================================================

function renderFavoritesView() {
    const container =
        document.getElementById(
            "favoritesContainer"
        );

    if (!container) return;

    container.innerHTML = "";

    const favoriteSongs =
        songs.filter(
            (song) =>
                favorites.has(
                    song.id
                )
        );

    if (!favoriteSongs.length) {
        const empty =
            document.createElement(
                "p"
            );

        empty.style.padding =
            "12px";

        empty.style.opacity =
            "0.6";

        empty.textContent =
            "No favorites marked yet.";

        container.appendChild(
            empty
        );

        return;
    }

    favoriteSongs.forEach(
        (song) => {
            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "song-card mini";

            item.textContent =
                `❤️ ${getSongTitle(
                    song
                )}`;

            item.onclick = () => {
                const index =
                    songs.findIndex(
                        (s) =>
                            s.id ===
                            song.id
                    );

                if (index !== -1) {
                    playSongAtIndex(
                        index,
                        false
                    );
                }
            };

            container.appendChild(
                item
            );
        }
    );
}

// ============================================================
// 26. PLAYLIST VIEW
// ============================================================

function renderPlaylistsView() {
    const container =
        document.getElementById(
            "playlistsContainer"
        );

    if (!container) return;

    container.innerHTML = "";

    const names =
        Object.keys(playlists);

    if (!names.length) {
        const empty =
            document.createElement(
                "span"
            );

        empty.textContent =
            "No playlists";

        empty.style.opacity =
            "0.6";

        container.appendChild(
            empty
        );

        return;
    }

    names.forEach(
        (name) => {
            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "playlist-item";

            item.textContent =
                `📁 ${name} (${
                    playlists[name]
                        .length
                })`;

            item.onclick = () => {
                const ids =
                    playlists[name];

                const index =
                    songs.findIndex(
                        (song) =>
                            ids.includes(
                                song.id
                            )
                    );

                if (index !== -1) {
                    playSongAtIndex(
                        index,
                        false
                    );
                }
            };

            container.appendChild(
                item
            );
        }
    );
}

// ============================================================
// 27. SMART DASHBOARD
// ============================================================

function renderSmartDashboard() {
    const hour =
        new Date().getHours();

    const greeting =
        document.getElementById(
            "dashboardGreeting"
        );

    if (greeting) {
        const text =
            hour < 12
                ? "Good morning"
                : hour < 18
                    ? "Good afternoon"
                    : "Good evening";

        greeting.textContent =
            `${text}, Rishi 👋`;
    }

    const directorContainer =
        document.getElementById(
            "topDirectorsList"
        );

    if (!directorContainer) {
        return;
    }

    directorContainer.innerHTML =
        "";

    const counts = {};

    songs.forEach(
        (song) => {
            const director =
                getSongDirector(song);

            counts[director] =
                (counts[director] || 0) +
                1;
        }
    );

    Object.keys(counts)
        .sort(
            (a, b) =>
                counts[b] -
                counts[a]
        )
        .slice(0, 8)
        .forEach(
            (director) => {
                const item =
                    document.createElement(
                        "div"
                    );

                item.className =
                    "director-tile";

                const title =
                    document.createElement(
                        "h4"
                    );

                title.textContent =
                    `🎼 ${director}`;

                const count =
                    document.createElement(
                        "p"
                    );

                count.textContent =
                    `${counts[director]} Track${
                        counts[director] ===
                        1
                            ? ""
                            : "s"
                    }`;

                item.appendChild(
                    title
                );

                item.appendChild(
                    count
                );

                item.onclick =
                    () => {
                        openDirectorView(
                            director
                        );
                    };

                directorContainer.appendChild(
                    item
                );
            }
        );
}

// ============================================================
// 28. IMPORT TRACKS
// ============================================================

async function importAudioFiles(
    files
) {
    if (!files || !files.length) {
        return;
    }

    for (const file of files) {
        if (!(file instanceof Blob)) {
            continue;
        }

        const cleanName =
            file.name.replace(
                /\.[^/.]+$/,
                ""
            );

        const songName =
            prompt(
                "Enter song name:",
                cleanName
            );

        if (
            !songName ||
            !songName.trim()
        ) {
            continue;
        }

        const directorName =
            prompt(
                "Enter music director name:",
                "UNKNOWN DIRECTOR"
            );

        if (
            !directorName ||
            !directorName.trim()
        ) {
            continue;
        }

        const track = {
            title:
                songName.trim(),

            name:
                file.name,

            artist:
                directorName
                    .trim()
                    .toUpperCase(),

            director:
                directorName
                    .trim()
                    .toUpperCase(),

            blob:
                file,

            type:
                file.type ||
                "audio/*",

            createdAt:
                Date.now()
        };

        try {
            const id =
                await saveTrackToDB(
                    track
                );

            track.id = id;

            songs.push(track);
        } catch (err) {
            console.error(
                "Could not save track:",
                err
            );

            alert(
                `Could not save ${file.name}`
            );
        }
    }

    songs.sort(
        (a, b) =>
            (a.id || 0) -
            (b.id || 0)
    );

    unplayedQueue = [];

    updateDirectorFilter();
    updateTrackCountUI();
    renderSmartDashboard();
    renderSongList();
    renderFavoritesView();
}

// ============================================================
// 29. SEARCH
// ============================================================

function setupSearch() {
    const input =
        document.getElementById(
            "searchInput"
        );

    if (!input) return;

    input.addEventListener(
        "input",
        () => {
            searchQuery =
                input.value || "";

            renderSongList();
        }
    );
}

// ============================================================
// 30. VOLUME / MUTE
// ============================================================

function setupVolume() {
    const volumeBar =
        document.getElementById(
            "volumeBar"
        );

    const muteButton =
        document.getElementById(
            "muteBtn"
        );

    if (volumeBar) {
        audio.volume =
            Number(
                volumeBar.value
            ) || 1;

        volumeBar.addEventListener(
            "input",
            (event) => {
                const value =
                    Number(
                        event.target.value
                    );

                audio.volume =
                    Math.max(
                        0,
                        Math.min(
                            1,
                            value
                        )
                    );

                if (muteButton) {
                    muteButton.textContent =
                        audio.volume === 0
                            ? "🔇"
                            : "🔊";
                }
            }
        );
    }

    if (muteButton) {
        muteButton.addEventListener(
            "click",
            () => {
                if (
                    audio.volume >
                    0
                ) {
                    audio.dataset.prevVolume =
                        String(
                            audio.volume
                        );

                    audio.volume =
                        0;

                    if (volumeBar) {
                        volumeBar.value =
                            "0";
                    }

                    muteButton.textContent =
                        "🔇";
                } else {
                    const restored =
                        Number(
                            audio.dataset
                                .prevVolume ||
                                1
                        );

                    audio.volume =
                        Math.max(
                            0,
                            Math.min(
                                1,
                                restored
                            )
                        );

                    if (volumeBar) {
                        volumeBar.value =
                            String(
                                audio.volume
                            );
                    }

                    muteButton.textContent =
                        "🔊";
                }
            }
        );
    }
}

// ============================================================
// 31. SPEED
// ============================================================

function setupSpeedControls() {
    const buttons =
        document.querySelectorAll(
            ".btn-speed"
        );

    buttons.forEach(
        (button) => {
            button.addEventListener(
                "click",
                () => {
                    buttons.forEach(
                        (item) =>
                            item.classList.remove(
                                "active"
                            )
                    );

                    button.classList.add(
                        "active"
                    );

                    const speed =
                        Number(
                            button.dataset
                                .speed ||
                                1
                        );

                    audio.playbackRate =
                        Number.isFinite(
                            speed
                        )
                            ? speed
                            : 1;
                }
            );
        }
    );
}

// ============================================================
// 32. EVENT BUTTONS
// ============================================================

function setupButtons() {
    document
        .getElementById("playBtn")
        ?.addEventListener(
            "click",
            togglePlay
        );

    document
        .getElementById("miniPlayBtn")
        ?.addEventListener(
            "click",
            togglePlay
        );

    document
        .getElementById("nextBtn")
        ?.addEventListener(
            "click",
            nextSong
        );

    document
        .getElementById("prevBtn")
        ?.addEventListener(
            "click",
            prevSong
        );

    document
        .getElementById("shuffleBtn")
        ?.addEventListener(
            "click",
            toggleShuffle
        );

    document
        .getElementById("repeatBtn")
        ?.addEventListener(
            "click",
            toggleRepeat
        );

    document
        .getElementById(
            "playerFavoriteBtn"
        )
        ?.addEventListener(
            "click",
            () => {
                if (
                    currentIndex !==
                        -1 &&
                    songs[
                        currentIndex
                    ]
                ) {
                    toggleFavorite(
                        songs[
                            currentIndex
                        ].id
                    );
                }
            }
        );

    document
        .getElementById(
            "newPlaylistBtn"
        )
        ?.addEventListener(
            "click",
            () => {
                const name =
                    prompt(
                        "Enter new playlist name:"
                    );

                if (
                    name &&
                    name.trim()
                ) {
                    createPlaylist(
                        name.trim()
                    );
                }
            }
        );
}

// ============================================================
// 33. DIRECTOR FILTER
// ============================================================

function setupDirectorFilter() {
    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (!filter) return;

    filter.addEventListener(
        "change",
        () => {
            openDirectorView(
                filter.value
            );

            unplayedQueue = [];
        }
    );
}

// ============================================================
// 34. SLEEP TIMER BUTTONS
// ============================================================

function setupSleepTimer() {
    document
        .getElementById("timer15")
        ?.addEventListener(
            "click",
            () =>
                setSleepTimer(15)
        );

    document
        .getElementById("timer30")
        ?.addEventListener(
            "click",
            () =>
                setSleepTimer(30)
        );

    document
        .getElementById("timer60")
        ?.addEventListener(
            "click",
            () =>
                setSleepTimer(60)
        );

    document
        .getElementById("timerOff")
        ?.addEventListener(
            "click",
            () =>
                setSleepTimer(0)
        );
}

// ============================================================
// 35. EQUALIZER UI
// ============================================================

async function setupEqualizer() {
    const selector =
        document.getElementById(
            "eqPresetSelector"
        );

    if (!selector) return;

    const saved =
        await getPersistentMeta(
            "eqPreset"
        );

    if (
        saved &&
        Array.from(
            selector.options
        ).some(
            (option) =>
                option.value ===
                saved
        )
    ) {
        selector.value =
            saved;
    }

    selector.addEventListener(
        "change",
        () => {
            applyEqualizerPreset(
                selector.value
            );
        }
    );
}

// ============================================================
// 36. IMPORT INPUT
// ============================================================

function setupAudioImport() {
    const input =
        document.getElementById(
            "audioFileInput"
        );

    if (!input) return;

    input.addEventListener(
        "change",
        async (event) => {
            const files =
                Array.from(
                    event.target.files ||
                        []
                );

            await importAudioFiles(
                files
            );

            input.value = "";
        }
    );
}

// ============================================================
// 37. RESTORE SAVED SETTINGS
// ============================================================

async function restoreSettings() {
    const savedFavorites =
        await getPersistentMeta(
            "favorites"
        );

    if (
        Array.isArray(
            savedFavorites
        )
    ) {
        favorites =
            new Set(
                savedFavorites
            );
    }

    const savedRecent =
        await getPersistentMeta(
            "recentlyPlayed"
        );

    if (
        Array.isArray(
            savedRecent
        )
    ) {
        recentlyPlayed =
            savedRecent;
    }

    const savedStats =
        await getPersistentMeta(
            "playHistoryStats"
        );

    if (
        savedStats &&
        typeof savedStats ===
            "object"
    ) {
        playHistoryStats =
            savedStats;
    }

    // Load playlists from the new store.
    playlists =
        await loadPlaylistsFromDB();

    // Also support metadata playlists
    // created by an older build.
    if (
        !Object.keys(
            playlists
        ).length
    ) {
        const oldPlaylists =
            await getPersistentMeta(
                "playlists"
            );

        if (
            oldPlaylists &&
            typeof oldPlaylists ===
                "object"
        ) {
            playlists =
                oldPlaylists;
        }
    }

    const savedShuffle =
        await getPersistentMeta(
            "shuffle"
        );

    if (
        typeof savedShuffle ===
        "boolean"
    ) {
        isShuffle =
            savedShuffle;
    }

    const savedRepeat =
        await getPersistentMeta(
            "repeatMode"
        );

    if (
        savedRepeat === "off" ||
        savedRepeat === "all" ||
        savedRepeat === "one"
    ) {
        repeatMode =
            savedRepeat;
    }
}

// ============================================================
// 38. INITIALIZATION
// ============================================================

document.addEventListener(
    "DOMContentLoaded",
    async () => {
        try {
            await requestPersistentStorage();

            await openDatabase();

            // THIS LOADS YOUR EXISTING RISHI15 SONGS.
            songs =
                await loadAllTracksFromDB();

            songs.sort(
                (a, b) =>
                    (a.id || 0) -
                    (b.id || 0)
            );

            await restoreSettings();

            unplayedQueue = [];

            updateDirectorFilter();
            updateTrackCountUI();
            updateRepeatButton();

            const shuffleButton =
                document.getElementById(
                    "shuffleBtn"
                );

            if (shuffleButton) {
                shuffleButton.classList.toggle(
                    "active",
                    isShuffle
                );
            }

            renderSmartDashboard();
            renderSongList();
            renderFavoritesView();
            renderPlaylistsView();
            updatePlayButton();
            setupMediaSession();

            setupProgressBar();
            setupSearch();
            setupVolume();
            setupSpeedControls();
            setupButtons();
            setupDirectorFilter();
            setupSleepTimer();
            setupAudioImport();

            await setupEqualizer();

            console.log(
                `Rishi Music loaded ${songs.length} track(s).`
            );
        } catch (err) {
            console.error(
                "Rishi Music bootloader failed:",
                err
            );

            const container =
                document.getElementById(
                    "songListContainer"
                );

            if (container) {
                container.innerHTML =
                    `<div style="padding:24px;text-align:center;">
                        <strong>Music library could not be loaded.</strong>
                        <br>
                        <small>Do not clear browser storage. Check the console for details.</small>
                    </div>`;
            }
        }
    }
);

// ============================================================
// 39. SERVICE WORKER
// ============================================================

if ("serviceWorker" in navigator) {
    window.addEventListener(
        "load",
        () => {
            navigator.serviceWorker
                .register("./sw.js")
                .catch((err) => {
                    console.debug(
                        "Service worker registration skipped:",
                        err
                    );
                });
        }
    );
}

// ============================================================
// 40. CLEANUP
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {
        clearNextTimer();
        stopStallWatchdog();

        playbackGeneration++;

        // Revoke cached Blob URLs.
        // This does NOT delete the IndexedDB audio.
        songs.forEach((song) => {
            if (
                song &&
                song.blob instanceof Blob &&
                blobUrlCache.has(song.blob)
            ) {
                try {
                    URL.revokeObjectURL(
                        blobUrlCache.get(
                            song.blob
                        )
                    );
                } catch (e) {}
            }
        });
    }
);

// ============================================================
// END OF RISHI MUSIC APP.JS
// ============================================================
'''

path = Path("/mnt/data/rishi15_updated_app.js")
path.write_text(code, encoding="utf-8")

print(f"Created: {path}")
print(f"Lines: {len(code.splitlines())}")
