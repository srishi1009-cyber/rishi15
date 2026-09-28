// ============================================================
// RISHI MUSIC - APP.JS (PERMANENT CONTINUOUS PLAYBACK ENGINE)
// ============================================================

const DB_NAME = "RishiMusicDB";
const DB_VERSION = 1;
const STORE_NAME = "tracks";

let db = null;
let songs = [];

let currentIndex = -1;

let activeDirector = "all";
let searchQuery = "";

let playbackGeneration = 0;
let isTransitioning = false;
let nextSongTimer = null;
let activePlayPromise = null;

// Unique shuffle playlist queue
let unplayedQueue = [];

// Persistent Blob URL cache: keeps object URLs valid across the entire session
const blobUrlCache = new WeakMap();

const audio = document.getElementById("audioEngine") || new Audio();
if (!document.getElementById("audioEngine")) {
    audio.id = "audioEngine";
    audio.preload = "auto";
    document.body.appendChild(audio);
}

// ============================================================
// DATABASE
// ============================================================

function openDatabase() {
    return new Promise(function(resolve, reject) {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function(event) {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, {
                    keyPath: "id",
                    autoIncrement: true
                });
            }
        };

        request.onsuccess = function() {
            db = request.result;
            resolve(db);
        };

        request.onerror = function() {
            reject(request.error);
        };
    });
}

function saveTrackToDB(track) {
    return new Promise(function(resolve, reject) {
        if (!db) return reject(new Error("Database not ready"));
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(track);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function updateTrackInDB(track) {
    return new Promise(function(resolve, reject) {
        if (!db) return reject(new Error("Database not ready"));
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(track);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function loadAllTracksFromDB() {
    return new Promise(function(resolve, reject) {
        if (!db) return reject(new Error("Database not ready"));
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

// ============================================================
// HELPERS & DIVERSE SELECTION
// ============================================================

function getSongDirector(song) {
    return String(song?.director || song?.artist || "Unknown Director").trim();
}

function getSongTitle(song) {
    return song?.title || song?.name || "Unknown Song";
}

function getSongSource(song) {
    if (!song) return null;
    if (song.blob) {
        if (!blobUrlCache.has(song.blob)) {
            blobUrlCache.set(song.blob, URL.createObjectURL(song.blob));
        }
        return blobUrlCache.get(song.blob);
    }
    return song.url || null;
}

function getFilteredSongIndexes() {
    const result = [];
    const query = searchQuery.trim().toLowerCase();

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        if (activeDirector !== "all" && getSongDirector(song).toLowerCase() !== activeDirector.toLowerCase()) {
            continue;
        }
        if (query) {
            const searchable = [song.title || "", song.name || "", song.artist || "", song.director || ""].join(" ").toLowerCase();
            if (!searchable.includes(query)) continue;
        }
        result.push(i);
    }
    return result;
}

function getAutomaticSongIndexes() {
    const result = [];
    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        if (activeDirector !== "all" && getSongDirector(song).toLowerCase() !== activeDirector.toLowerCase()) {
            continue;
        }
        result.push(i);
    }
    return result;
}

function getNextUniqueSongIndex() {
    const validIndexes = getAutomaticSongIndexes();
    if (validIndexes.length === 0) return -1;
    if (validIndexes.length === 1) return validIndexes[0];

    // Filter queue to current pool
    unplayedQueue = unplayedQueue.filter(idx => validIndexes.includes(idx));

    // When the queue drains, re-populate and shuffle all valid songs except the one currently finishing
    if (unplayedQueue.length === 0) {
        unplayedQueue = validIndexes.filter(idx => idx !== currentIndex);
        if (unplayedQueue.length === 0) {
            unplayedQueue = validIndexes.slice();
        }

        for (let i = unplayedQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [unplayedQueue[i], unplayedQueue[j]] = [unplayedQueue[j], unplayedQueue[i]];
        }
    }

    // Rotate composers when in "All" view
    let chosenPointer = 0;
    if (activeDirector === "all" && unplayedQueue.length > 1) {
        const currentDirector = songs[currentIndex] ? getSongDirector(songs[currentIndex]) : null;
        const differentDirectorIndex = unplayedQueue.findIndex(idx => getSongDirector(songs[idx]) !== currentDirector);
        if (differentDirectorIndex !== -1) {
            chosenPointer = differentDirectorIndex;
        }
    }

    return unplayedQueue.splice(chosenPointer, 1)[0];
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

// ============================================================
// MEDIA SESSION / AIRPODS HARDWARE RECOVERY
// ============================================================

function updateMediaSession(song) {
    if (!("mediaSession" in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: getSongTitle(song),
            artist: getSongDirector(song),
            album: "Rishi Music"
        });
        updateMediaPositionState();
    } catch (e) {}
}

function updateMediaPositionState() {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
        try {
            navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate || 1,
                position: audio.currentTime || 0
            });
        } catch (e) {}
    }
}

function setMediaSessionState(state) {
    if (!("mediaSession" in navigator)) return;
    try {
        navigator.mediaSession.playbackState = state;
    } catch (e) {}
}

function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    // Stem single press: Unstick stalled playback or toggle play/pause
    navigator.mediaSession.setActionHandler("play", async () => {
        isTransitioning = false;
        if (nextSongTimer) clearTimeout(nextSongTimer);
        try {
            await audio.play();
            updatePlayButton();
            setMediaSessionState("playing");
        } catch (e) {
            playNextAutomaticSong();
        }
    });

    navigator.mediaSession.setActionHandler("pause", () => {
        isTransitioning = false;
        audio.pause();
        updatePlayButton();
        setMediaSessionState("paused");
    });

    // Stem double press: Force unfreezes lock and skips track immediately
    navigator.mediaSession.setActionHandler("nexttrack", () => {
        isTransitioning = false;
        if (nextSongTimer) clearTimeout(nextSongTimer);
        playNextAutomaticSong();
    });

    // Stem triple press: Skips backward
    navigator.mediaSession.setActionHandler("previoustrack", () => {
        isTransitioning = false;
        if (nextSongTimer) clearTimeout(nextSongTimer);
        prevSong();
    });

    try {
        navigator.mediaSession.setActionHandler("seekforward", details => {
            const skip = details.seekOffset || 10;
            audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + skip);
            updateMediaPositionState();
        });
        navigator.mediaSession.setActionHandler("seekbackward", details => {
            const skip = details.seekOffset || 10;
            audio.currentTime = Math.max(0, audio.currentTime - skip);
            updateMediaPositionState();
        });
        navigator.mediaSession.setActionHandler("seekto", details => {
            if (details.seekTime !== undefined && Number.isFinite(details.seekTime)) {
                audio.currentTime = details.seekTime;
                updateMediaPositionState();
            }
        });
    } catch (e) {}
}

// ============================================================
// PLAYBACK ENGINE
// ============================================================

async function playSongAtIndex(index, isAutomatic = false) {
    if (index < 0 || index >= songs.length) return false;
    const song = songs[index];
    if (!song) return false;

    const generation = ++playbackGeneration;

    if (nextSongTimer) {
        clearTimeout(nextSongTimer);
        nextSongTimer = null;
    }

    currentIndex = index;
    const source = getSongSource(song);
    if (!source) return false;

    // 1. Await any running play promise before resetting to avoid AbortError
    if (activePlayPromise) {
        try { await activePlayPromise; } catch (e) {}
    }

    // 2. Hardware Decoder Flush: Clears accumulated RAM from previous tracks
    try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
    } catch (e) {}

    // 3. Mount fresh track
    audio.src = source;
    audio.currentTime = 0;

    const titleEl = document.getElementById("playerTitle");
    const artistEl = document.getElementById("playerArtist");
    if (titleEl) titleEl.textContent = getSongTitle(song);
    if (artistEl) artistEl.textContent = getSongDirector(song);

    updateMediaSession(song);
    renderSongList();

    // 4. Safe single-flight playback invocation
    try {
        activePlayPromise = audio.play();
        await activePlayPromise;
        activePlayPromise = null;

        if (generation === playbackGeneration) {
            updatePlayButton();
            setMediaSessionState("playing");
            return true;
        }
        return false;
    } catch (e) {
        activePlayPromise = null;
        console.warn("Mobile playback caught error:", e);
        if (generation === playbackGeneration) {
            updatePlayButton();
        }
        return false;
    }
}

async function playNextAutomaticSong() {
    if (isTransitioning) return;
    isTransitioning = true;

    try {
        const pool = getAutomaticSongIndexes();
        if (pool.length === 0) return;

        let attempts = 0;
        const maxAttempts = Math.min(pool.length, 6);

        while (attempts < maxAttempts) {
            attempts++;
            const nextIndex = getNextUniqueSongIndex();
            if (nextIndex === -1) break;

            const success = await playSongAtIndex(nextIndex, true);
            if (success) return;
        }

        // Sequential fallback
        const nextPos = (currentIndex + 1) % songs.length;
        await playSongAtIndex(nextPos, true);
    } catch (err) {
        console.error("Auto transition failure:", err);
    } finally {
        isTransitioning = false;
    }
}

function togglePlay() {
    if (currentIndex === -1 || !audio.src) {
        playNextAutomaticSong();
        return;
    }

    if (audio.paused) {
        audio.play()
            .then(() => {
                updatePlayButton();
                setMediaSessionState("playing");
            })
            .catch(() => playNextAutomaticSong());
    } else {
        audio.pause();
        updatePlayButton();
        setMediaSessionState("paused");
    }
}

function nextSong() {
    isTransitioning = false;
    playNextAutomaticSong();
}

async function prevSong() {
    isTransitioning = false;
    const filtered = getFilteredSongIndexes();
    if (filtered.length === 0) return;

    const pos = filtered.indexOf(currentIndex);
    const prevIndex = pos <= 0 ? filtered[filtered.length - 1] : filtered[pos - 1];
    await playSongAtIndex(prevIndex, false);
}

function updatePlayButton() {
    const playButton = document.getElementById("playBtn");
    if (playButton) playButton.textContent = audio.paused ? "▶" : "❚❚";
}

// ============================================================
// AUDIO EVENTS
// ============================================================

audio.addEventListener("play", () => {
    updatePlayButton();
    setMediaSessionState("playing");
});

audio.addEventListener("pause", () => {
    updatePlayButton();
    if (!audio.ended) setMediaSessionState("paused");
});

audio.addEventListener("waiting", () => {
    setMediaSessionState("paused");
});

audio.addEventListener("canplaythrough", () => {
    if (!audio.paused) {
        audio.play().catch(() => {});
        setMediaSessionState("playing");
    }
});

// Immediate transition trigger
audio.addEventListener("ended", () => {
    if (nextSongTimer) clearTimeout(nextSongTimer);
    isTransitioning = false;
    playNextAutomaticSong();
});

audio.addEventListener("error", () => {
    isTransitioning = false;
    playNextAutomaticSong();
});

audio.addEventListener("loadedmetadata", () => {
    const totalTime = document.getElementById("totalTime");
    if (totalTime) totalTime.textContent = formatTime(audio.duration);
    updateMediaPositionState();
});

audio.addEventListener("timeupdate", () => {
    const progressBar = document.getElementById("progressBar");
    const currentTime = document.getElementById("currentTime");
    if (currentTime) currentTime.textContent = formatTime(audio.currentTime);
    if (progressBar && Number.isFinite(audio.duration) && audio.duration > 0) {
        progressBar.value = (audio.currentTime / audio.duration) * 100;
    }
});

const progressBar = document.getElementById("progressBar");
if (progressBar) {
    progressBar.addEventListener("input", () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
            audio.currentTime = (progressBar.value / 100) * audio.duration;
            updateMediaPositionState();
        }
    });
}

// ============================================================
// UI & CONTROLS
// ============================================================

function getDirectors() {
    const set = new Set();
    songs.forEach(s => {
        const d = getSongDirector(s);
        if (d && d !== "Unknown Director") set.add(d);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function updateDirectorFilter() {
    const filter = document.getElementById("directorFilter");
    if (!filter) return;
    const old = activeDirector;
    filter.innerHTML = "";

    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "All";
    filter.appendChild(all);

    getDirectors().forEach(dir => {
        const opt = document.createElement("option");
        opt.value = dir;
        opt.textContent = dir;
        filter.appendChild(opt);
    });

    filter.value = Array.from(filter.options).some(o => o.value === old) ? old : "all";
    activeDirector = filter.value;
}

function renderSongList() {
    const container = document.getElementById("songListContainer") || document.querySelector(".song-list");
    if (!container) return;
    const filtered = getFilteredSongIndexes();
    container.innerHTML = "";

    if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.style.padding = "30px";
        empty.style.color = "rgba(255,255,255,0.6)";
        empty.textContent = "No songs found.";
        container.appendChild(empty);
        return;
    }

    filtered.forEach(index => {
        const song = songs[index];
        const card = document.createElement("div");
        card.className = "song-card" + (index === currentIndex ? " active" : "");

        const info = document.createElement("div");
        info.className = "song-info";

        const icon = document.createElement("span");
        icon.className = "song-icon";
        icon.textContent = "♫";

        const meta = document.createElement("div");
        meta.className = "song-meta";

        const title = document.createElement("h4");
        title.textContent = getSongTitle(song);

        const dir = document.createElement("p");
        dir.textContent = getSongDirector(song);

        meta.appendChild(title);
        meta.appendChild(dir);
        info.appendChild(icon);
        info.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "song-actions";

        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = "Edit";
        edit.onclick = e => { e.stopPropagation(); editSong(index); };

        const play = document.createElement("button");
        play.type = "button";
        play.className = "play-mini";
        play.textContent = "▶";
        play.onclick = e => { e.stopPropagation(); playSongAtIndex(index, false); };

        actions.appendChild(edit);
        actions.appendChild(play);

        card.appendChild(info);
        card.appendChild(actions);
        card.onclick = () => playSongAtIndex(index, false);

        container.appendChild(card);
    });
}

async function editSong(index) {
    const song = songs[index];
    if (!song) return;

    const newTitle = prompt("Enter song name:", getSongTitle(song));
    if (!newTitle || !newTitle.trim()) return;

    const newDirector = prompt("Enter music director name:", getSongDirector(song));
    if (!newDirector || !newDirector.trim()) return;

    song.title = newTitle.trim();
    song.director = newDirector.trim();
    song.artist = song.director;

    if (song.id !== undefined && song.id !== null) {
        await updateTrackInDB(song);
    }

    updateDirectorFilter();
    renderSongList();
    if (currentIndex === index) {
        updatePlayerInformation(song);
        updateMediaSession(song);
    }
}

function updatePlayerInformation(song) {
    const titleElement = document.getElementById("playerTitle");
    const artistElement = document.getElementById("playerArtist");
    if (titleElement) titleElement.textContent = getSongTitle(song);
    if (artistElement) artistElement.textContent = getSongDirector(song);
}

const audioFileInput = document.getElementById("audioFileInput");
if (audioFileInput) {
    audioFileInput.addEventListener("change", async function(event) {
        const files = Array.from(event.target.files);
        for (const file of files) {
            const cleanName = file.name.replace(/\.[^/.]+$/, "");
            const songName = prompt("Enter song name:", cleanName);
            if (!songName || !songName.trim()) continue;

            const directorName = prompt("Enter music director name:", "");
            if (!directorName || !directorName.trim()) continue;

            const track = {
                title: songName.trim(),
                name: file.name,
                artist: directorName.trim(),
                director: directorName.trim(),
                blob: file,
                type: file.type,
                createdAt: Date.now()
            };

            const id = await saveTrackToDB(track);
            track.id = id;
            songs.push(track);
        }
        unplayedQueue = [];
        updateDirectorFilter();
        renderSongList();
        audioFileInput.value = "";
    });
}

const searchInput = document.getElementById("searchInput");
if (searchInput) {
    searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        renderSongList();
    });
}

const directorFilter = document.getElementById("directorFilter");
if (directorFilter) {
    directorFilter.addEventListener("change", () => {
        activeDirector = directorFilter.value;
        unplayedQueue = [];
        const viewTitle = document.getElementById("viewTitle");
        if (viewTitle) {
            viewTitle.textContent = activeDirector === "all" ? "All Songs" : activeDirector + " Songs";
        }
        renderSongList();
    });
}

const playBtn = document.getElementById("playBtn");
const nextBtn = document.getElementById("nextBtn");
const prevBtn = document.getElementById("prevBtn");
if (playBtn) playBtn.addEventListener("click", togglePlay);
if (nextBtn) nextBtn.addEventListener("click", nextSong);
if (prevBtn) prevBtn.addEventListener("click", prevSong);

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}

document.addEventListener("DOMContentLoaded", async function() {
    try {
        await openDatabase();
        songs = await loadAllTracksFromDB();
        songs.sort((a, b) => (a.id || 0) - (b.id || 0));
        unplayedQueue = [];
        updateDirectorFilter();
        renderSongList();
        updatePlayButton();
        setupMediaSession();
    } catch (e) {
        console.error("Initialization failed:", e);
    }
});

window.addEventListener("beforeunload", () => {
    if (nextSongTimer) clearTimeout(nextSongTimer);
    playbackGeneration++;
});