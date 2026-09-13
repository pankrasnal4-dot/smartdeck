let ASSETS_PATH = ""; // Will be filled dynamically
let activePcTimers = {}; // To track running timers
let activeTimerTargets = {}; // Keeps "End Time" of timers in memory (Persistent)
let timerNotificationSent = {}; // Track which timers already sent notification
let currentEditorTmp = null; // Live copy of the button currently being edited
let deviceCurrentPage = 0; // Cihazın gerçekte hangi sayfada olduğunu tutar

// Background timer checker - runs every second to catch timers finishing on other pages
let backgroundTimerChecker = null;

function startBackgroundTimerChecker() {
    if (backgroundTimerChecker) return;
    
    backgroundTimerChecker = setInterval(() => {
        const now = Date.now();
        
        for (const [timerKey, targetTime] of Object.entries(activeTimerTargets)) {
            // Timer bitti mi?
            if (targetTime <= now) {
                // Bu timer için daha önce notification gönderildi mi?
                if (!timerNotificationSent[timerKey]) {
                    timerNotificationSent[timerKey] = true;
                    
                    // Parse page and button index
                    const [pIdx, bIdx] = timerKey.split('_').map(Number);
                    
                    // Get button label
                    const btn = cfg.pages[pIdx]?.[bIdx];
                    const label = btn?.originalLabel || btn?.label || `Button ${bIdx + 1}`;
                    
                    console.log(`[Timer] Background notification for ${timerKey}: ${label}`);
                    
                    // Play notification sound
                    try {
                        const notifUrl = getNotificationSoundPath();
                        if (notifUrl) {
                            const audio = new Audio(notifUrl);
                            audio.volume = 0.8;
                            audio.play().catch(e => console.error("Notification playback failed:", e));
                        }
                    } catch (e) {
                        console.error("Error playing notification sound:", e);
                    }
                    
                    // Show system notification
                    if (window.electronAPI && window.electronAPI.showNotification) {
                        window.electronAPI.showNotification('Timer Finished', `Your timer "${label}" is complete.`);
                    }
                    
                    // DON'T delete flags here - wait for timer reset (state === 2)
                    // This prevents duplicate notifications when switching pages
                }
            }
        }
    }, 1000);
}

function stopBackgroundTimerChecker() {
    if (backgroundTimerChecker) {
        clearInterval(backgroundTimerChecker);
        backgroundTimerChecker = null;
    }
}

// ============================================
// SIMPLE CONNECTION SYSTEM
// ============================================
let connectedSerialPort = null;
let connectedDeviceName = '';
let portReader = null;
let textDecoder = new TextDecoderStream();
let isListening = false;
let isAutoConnected = false;
let autoConnectTimer = null;
let lastConnectedPortInfo = null;
const AUTO_CONNECT_INTERVAL = 3000;

// ESP Ready System - Upload sırasında komutları beklet
let isEspReady = true;
let pendingSerialCommands = [];
let isUploading = false; // Concurrent upload protection

// Simple state for UI
const ConnectionState = {
    DISCONNECTED: 'disconnected',
    SEARCHING: 'searching', 
    CONNECTED: 'connected'
};
let connectionState = ConnectionState.DISCONNECTED;

// ============================================
// AUTO-CONNECT FUNCTIONS
// ============================================
function startAutoConnect() {
    if (autoConnectTimer) return;
    console.log('[AutoConnect] Starting...');
    connectionState = ConnectionState.SEARCHING;
    updateConnectionUI(false, '');
    
    autoConnectTimer = setInterval(async () => {
        if (connectedSerialPort) {
            // Already connected
            return;
        }
        await scanForDevice();
    }, AUTO_CONNECT_INTERVAL);
    
    // Immediate first scan
    scanForDevice();
}

function stopAutoConnect() {
    if (autoConnectTimer) {
        clearInterval(autoConnectTimer);
        autoConnectTimer = null;
        console.log('[AutoConnect] Stopped');
    }
}

let isScanningForDevice = false;
async function scanForDevice() {
    if (connectedSerialPort || isScanningForDevice) return;
    isScanningForDevice = true;
    
    try {
        const ports = await navigator.serial.getPorts();
        if (ports.length === 0) return;
        
        for (const port of ports) {
            if (connectedSerialPort) break; // Already connected
            
            try {
                // Port zaten acik mi kontrol et
                if (port.readable) {
                    try {
                        await port.close();
                        await new Promise(r => setTimeout(r, 100));
                    } catch (e) {
                        continue; // Bu portu atla
                    }
                }
                
                // Port'u ac
                await port.open({ baudRate: 115200 });
                
                // Wait for boot
                await new Promise(r => setTimeout(r, 500));
                
                // Send PING
                const writer = port.writable.getWriter();
                await writer.write(new TextEncoder().encode("PING_DECK\n"));
                writer.releaseLock();
                
                // Wait for PONG with timeout
                const pongReceived = await waitForPong(port, 1500);
                
                if (pongReceived) {
                    // Success!
                    connectedSerialPort = port;
                    lastConnectedPortInfo = port.getInfo();
                    connectionState = ConnectionState.CONNECTED;
                    isAutoConnected = true;
                    
                    // Start listening
                    startSerialListener(port);
                    updateConnectionUI(true, connectedDeviceName);
                    
                    // Start active window monitoring for auto page switching
                    startActiveWindowMonitoring();
                    
                    // Start weather auto-refresh
                    startWeatherAutoRefresh();
                    
                    // ESP hazir, bekleyen komutlari gonder
                    isEspReady = true;
                    flushPendingCommands();
                    
                    console.log('[AutoConnect] Connected to:', connectedDeviceName);
                    stopAutoConnect();
                    return;
                } else {
                    // Not our device, close
                    await safeClosePort(port);
                }
            } catch (e) {
                console.warn('[AutoConnect] Port error:', e.message);
                try { await port.close(); } catch (x) {}
            }
        }
    } catch (e) {
        console.warn('[AutoConnect] Scan error:', e.message);
    } finally {
        isScanningForDevice = false;
    }
}

async function waitForPong(port, timeout) {
    let reader = null;
    let timeoutId = null;
    
    try {
        reader = port.readable.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let found = false;
        
        // Set timeout to cancel reader
        timeoutId = setTimeout(() => {
            if (reader) {
                reader.cancel().catch(() => {});
            }
        }, timeout);
        
        // Read loop
        while (!found) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('PONG_DECK:')) {
                    connectedDeviceName = line.split(':')[1]?.trim() || 'Smart Deck';
                    found = true;
                    break;
                }
            }
        }
        
        clearTimeout(timeoutId);
        reader.releaseLock();
        return found;
        
    } catch (e) {
        // Timeout cancelled the reader, or other error
        if (timeoutId) clearTimeout(timeoutId);
        if (reader) {
            try { reader.releaseLock(); } catch (x) {}
        }
        return false;
    }
}

async function safeClosePort(port) {
    if (!port) return;
    
    try {
        // Wait a bit for any pending operations
        await new Promise(r => setTimeout(r, 50));
        
        // Try to close
        if (port.readable && !port.readable.locked) {
            await port.close();
        }
    } catch (e) {
        console.warn('[SafeClose]', e.message);
    }
}
const AUTO_RECONNECT_DELAY = 3000;
// Serial Write Queue Variables
let isSerialWriting = false;
const serialCommandQueue = [];
// === DEBUG LOG SYSTEM ===
let serialLogHistory = [];
const MAX_LOG_ENTRIES = 500;
// === ACTIVE WINDOW MONITORING ===
let activeWindowMonitorInterval = null;
let lastActiveProcessName = null;
const ACTIVE_WINDOW_CHECK_INTERVAL = 1000; // Check every 1 second

// RobotJS gecikmesini sıfırla (En tepeye veya init kısmına)
if (window.electronAPI && window.electronAPI.robot) {
    // Tuşlar arası bekleme süresini kaldırıyoruz
    window.electronAPI.robot.keyTap("", []).catch(() => { }); // Dummy call to init
    // Not: Bu ayar main.js tarafında yapılsa daha iyi olur ama 
    // biz hızlandırmak için process içinde "limit" mantığı kuracağız.
}

// === TOAST NOTIFICATION SYSTEM ===
function showToast(message, type = 'info', duration = 3000) {
    // Check if any dialog is open
    const openDialog = document.querySelector('dialog[open]');

    let container;
    if (openDialog) {
        // Create toast inside dialog for proper stacking
        container = openDialog.querySelector('.dialog-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'dialog-toast-container';
            container.style.cssText = 'position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); z-index: 999999; display: flex; flex-direction: column; gap: 10px; pointer-events: none;';
            openDialog.appendChild(container);
        }
    } else {
        container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ'}</span><span>${message}</span>`;
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

let currentTranslations = {}; // Holds the loaded language file
let currentLang = 'en'; // Default language
const DEFAULT_LANG = 'en';


// --- NEW: DYNAMIC PLUGIN API BRIDGE (UPDATED) ---

/**
 * Helper function for API: Updates the text and icon of a button element
 * (sidebar or grid).
 */
function updateElementVisuals(btnEl, newLabel, newIcon, btnData = {}) {
    // Update text
    if (newLabel !== null) {
        // Sidebar button uses 'span', grid button uses 'div.label'
        const span = btnEl.querySelector('span') || btnEl.querySelector('.label');
        if (span) span.textContent = newLabel;
    }

    // Update icon
    if (newIcon !== null) {
        // Sidebar button uses 'img'/'i', grid button uses 'img.icon-img'/'i.icon-img'
        const img = btnEl.querySelector('img') || btnEl.querySelector('img.icon-img');
        const iEl = btnEl.querySelector('i') || btnEl.querySelector('i.icon-img');
        const iconUrl = getIconUrl(newIcon);

        if (iconUrl) {
            const isRawImage = iconUrl.startsWith('data:') || iconUrl.startsWith('file:');

            if (isRawImage) {
                if (img) {
                    img.src = iconUrl;
                    img.style.display = 'block';
                    if (iEl) iEl.style.display = 'none';
                }
            } else {
                if (iEl) {
                    iEl.style.display = 'block';

                    // If grid button, get colors from btnData, otherwise (sidebar) leave white
                    // (Assuming btnData is populated for the main grid button)
                    let iconColor = btnData.iconColor || null;

                    // If toggle and active, get active color
                    if (btnData.type === 'toggle' && btnData.toggleState === true) {
                        iconColor = btnData.toggleData?.onIconColor || '#ffffff';
                    }

                    // Default white if no color setting
                    if (!iconColor) {
                        iconColor = '#ffffff';
                    }

                    iEl.style.backgroundColor = iconColor;
                    iEl.style.webkitMaskImage = `url("${iconUrl}")`;
                    iEl.style.maskImage = `url("${iconUrl}")`;
                    iEl.style.backgroundImage = 'none';
                    if (img) img.style.display = 'none';
                }
            }
        } else {
            if (img) img.style.display = 'none';
            if (iEl) iEl.style.display = 'block'; // Revert to default star (sidebar) or empty (grid)
        }
    }
}

window.SmartDeckAPI = {
    /**
     * Updates all relevant buttons in the plugin panel AND the main grid.
     * @param {string} pluginId - 'meta.id' value of the plugin (e.g. "spotify")
     * @param {number} buttonIndex - Button order in the plugin's .json file (starts from 0)
     * @param {string | null} newLabel - New text (unchanged if null)
     * @param {string | null} newIcon - New icon URL (unchanged if null)
     */
    updatePluginButton: (pluginId, buttonIndex, newLabel, newIcon) => {
        if (!cfg) return;
        try {
            // 1. Find and update sidebar button
            const sidebarBtnEl = document.querySelector(`.plugin-btn-drag[data-plugin-id="${pluginId}"][data-button-index="${buttonIndex}"]`);
            if (sidebarBtnEl) {
                // btnData is empty for sidebar buttons, only icon/label is updated
                updateElementVisuals(sidebarBtnEl, newLabel, newIcon, {});
            }

            // 2. Find and update buttons in Main Grid
            let gridChanged = false; // Track if cfg has changed
            let saveNeeded = false; // Track if saving is needed

            cfg.pages.forEach((page, pageIdx) => {
                page.forEach((btn, btnIdx) => {
                    // Is this button a copy of the plugin button that needs updating?
                    if (btn && btn._pluginId === pluginId && btn._buttonIndex === buttonIndex) {

                        // Update cfg data
                        if (newLabel !== null && btn.label !== newLabel) {
                            btn.label = newLabel;
                            saveNeeded = true;
                        }
                        if (newIcon !== null && btn.icon !== newIcon) {
                            btn.icon = newIcon;
                            saveNeeded = true;
                        }

                        // If this button is on the current active page, update DOM (visual) as well
                        if (pageIdx === currentPage) {
                            const gridBtnContainer = document.querySelector(`.cell[data-index="${btnIdx}"] .btn`);
                            if (gridBtnContainer) {
                                // Send full button data (btn) when updating visual
                                updateElementVisuals(gridBtnContainer, newLabel, newIcon, btn);
                            }
                            gridChanged = true;
                        }
                    }
                });
            });

            // If we changed cfg, save (but don't add to history)
            if (saveNeeded) {
                saveConfig(false);
            }

        } catch (e) {
            console.error("SmartDeckAPI Error:", e);
        }
    }
};
/**
 * Translation engine. 
 * Example: t('header.title') -> "SmartDeck"
 * Example: t('device.frame.page', { pageNum: 1 }) -> "Page 1"
 */
function t(key, replacements = {}) {
    let text = key.split('.').reduce((obj, k) => (obj && obj[k] !== undefined) ? obj[k] : null, currentTranslations);

    if (text === null) {
        console.warn(`[i18n] Missing key: ${key}`);
        return key; // Return key as is
    }

    // Fill variables (e.g. {pageNum})
    Object.keys(replacements).forEach(rKey => {
        text = text.replace(`{${rKey}}`, replacements[rKey]);
    });

    return text;
}

/**
 * Arayüzdeki tüm [data-i18n] etiketli elementleri günceller.
 */
/**
 * Updates all elements with [data-i18n] tag in the interface.
 */
function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const translation = t(key);
        if (translation !== key) {
            // Using innerText or textContent prevents HTML injection
            el.textContent = translation;
        }
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        const translation = t(key);
        if (translation !== key) {
            el.title = translation;
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        const translation = t(key);
        if (translation !== key) {
            el.placeholder = translation;
        }
    });

    // --- FIX (PROBLEM 1) ---
    // Device Name: Removed data-i18n tag, now managing manually.
    const webTitleEl = el('#web-title-text');
    if (webTitleEl) {
        // Use name in cfg (saved) first, if empty use translation.
        webTitleEl.textContent = (cfg && cfg.deviceName) ? cfg.deviceName : t('device.frame.title');
    }
    // --- FIX END ---

    // We also need to redraw UIs dynamically created by JavaScript.
    if (cfg) {
        drawGrid();
        renderPageBar();
        populateGridControls();

        // --- FIX (PROBLEM 2) ---
        // Retranslate connection status based on current state
        updateConnectionUI(!!connectedSerialPort, connectedDeviceName || '');
    }
}

/**
 * Loads the JSON file for the specified language code and updates the interface.
 */

async function loadLanguage(langCode = 'en') {
    try {
        const response = await fetch(`locales/${langCode}.json?v=${Date.now()}`);
        if (!response.ok) {
            if (langCode !== DEFAULT_LANG) {
                console.warn(`'${langCode}.json' bulunamadı. Varsayılan (en) yükleniyor.`);
                await loadLanguage(DEFAULT_LANG); // Wait for error to finish
            } else {
                console.error("Varsayılan dil dosyası 'en.json' yüklenemedi!");
            }
            return;
        }

        currentTranslations = await response.json();
        currentLang = langCode;

        if (!cfg.appSettings) cfg.appSettings = {};
        cfg.appSettings.language = langCode;

        // --- FIX (PROBLEM 3 - SIDE EFFECT) ---
        // Prevent saving to history by using saveConfig(false) instead of saveConfig()
        saveConfig(false);
        // --- FIX END ---

        document.documentElement.lang = langCode;
        applyTranslations();

    } catch (error) {
        console.error(`Dil dosyası yüklenirken hata oluştu (${langCode}):`, error);
    }
}

// --- CROP LOGIC VARIABLES ---
let cropState = {
    imgWidth: 0,
    imgHeight: 0,
    scale: 1,
    x: 0,
    y: 0,
    isDragging: false,
    startX: 0,
    startY: 0
};
let cropImgEl = null; // Will be assigned when DOM loads


if (window.electronAPI) {
    const shell = window.electronAPI.shell;
    const path = window.electronAPI.path;
    const child_process = window.electronAPI.child_process;
    // ... other codes
} else {
    console.error('Electron API not found! Make sure you are running in Electron and preload script is loaded.');
}

const TOGGLE_PRESETS = [
    { name: "--- System Audio ---", val: "" },
    { name: "System Unmute", val: "nircmd.exe mutesysvolume 1" },
    { name: "System Mute", val: "nircmd.exe mutesysvolume 0" },

    { name: "--- Application Audio ---", val: "" },
    { name: "Chrome: Mute", val: "nircmd.exe muteappvolume chrome.exe 1" },
    { name: "Chrome: Unmute", val: "nircmd.exe muteappvolume chrome.exe 0" },
    { name: "Opera: Mute", val: "nircmd.exe muteappvolume opera.exe 1" },
    { name: "Opera: Unmute", val: "nircmd.exe muteappvolume opera.exe 0" },
    { name: "Edge: Mute", val: "nircmd.exe muteappvolume msedge.exe 1" },
    { name: "Edge: Unmute", val: "nircmd.exe muteappvolume msedge.exe 0" },
    { name: "Spotify: Mute", val: "nircmd.exe muteappvolume spotify.exe 1" },
    { name: "Spotify: Unmute", val: "nircmd.exe muteappvolume spotify.exe 0" },
    { name: "Discord: Mute", val: "nircmd.exe muteappvolume discord.exe 1" },
    { name: "Discord: Unmute", val: "nircmd.exe muteappvolume discord.exe 0" },
    { name: "Firefox: Mute", val: "nircmd.exe muteappvolume firefox.exe 1" },
    { name: "Firefox: Unmute", val: "nircmd.exe muteappvolume firefox.exe 0" },

    { name: "--- Monitor / Power ---", val: "" },
    { name: "Monitor OFF", val: "nircmd.exe monitor off" },
    { name: "Monitor ON", val: "nircmd.exe monitor on" },
    { name: "Screensaver", val: "nircmd.exe screensaver" },

    { name: "--- Generic Keys ---", val: "" },
    { name: "Play/Pause (Key)", val: "AUDIO_PLAY" },
    { name: "Mute (Toggle Key)", val: "AUDIO_MUTE" }
];

const MAX_HISTORY = 50;
let historyStack = [];
let historyIndex = -1; // Index of the currently displayed configuration
let isRestoringHistory = false; // NEW: To prevent saveHistory while restoring History
let saveDebounceTimer = null;

function debounceSave() {
    clearTimeout(saveDebounceTimer);
    // Save to history as a single step
    saveDebounceTimer = setTimeout(() => {
        saveConfig(); // This function calls saveHistory()
    }, 500);
}

// 1. Cleanup Function (Stops visual loop only, does not delete data)
function clearAllActiveTimers() {
    for (const key in activePcTimers) {
        if (activePcTimers.hasOwnProperty(key)) {
            clearInterval(activePcTimers[key]);
        }
    }
    activePcTimers = {};

    if (typeof mousePosInterval !== 'undefined' && mousePosInterval) {
        clearInterval(mousePosInterval);
        mousePosInterval = null;
    }
}

// NOTE: handlePcTimer is defined later in the file with 4 parameters (pIdx, bIdx, state, remainingSeconds)

// 3. Helper Function Starting Visual Counter
function startVisualTimer(btnIndex, targetTime) {
    const cellDiv = document.querySelector(`.cell[data-index="${btnIndex}"]`);
    if (!cellDiv) return; // Do not start if button is not on screen

    const labelEl = cellDiv.querySelector('.label');

    const updateDisplay = () => {
        // Calculate real time difference
        const now = Date.now();
        const diff = Math.ceil((targetTime - now) / 1000);

        if (diff <= 0) {
            // Time up (Visually)
            labelEl.textContent = "00:00";
            labelEl.style.color = "#ff4444";
            clearInterval(activePcTimers[btnIndex]);
            delete activePcTimers[btnIndex];
            // Note: We don't delete targetKey, it gets deleted when TIMER_DONE comes from serial or on reset.
            return;
        }

        const min = Math.floor(diff / 60);
        const sec = diff % 60;
        labelEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    updateDisplay(); // Do the first one immediately
    activePcTimers[btnIndex] = setInterval(updateDisplay, 1000); // Start loop
}


// Creates SHA-1 hash from file content
async function calculateBlobHash(blob) {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

const MANIFEST_STORAGE_KEY = 'smartDeckFileManifest';


function saveHistory() {
    if (!cfg || isRestoringHistory) return; // NEW CHECK ADDED HERE

    // Clear invalid future history (If undo was performed)
    if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
    }

    // Add new configuration
    const newConfig = JSON.stringify(cfg);

    // If last saved config is same, do not save again
    if (historyStack.length > 0 && historyStack[historyStack.length - 1] === newConfig) {
        return;
    }

    historyStack.push(newConfig);

    // Maintain maximum history count
    if (historyStack.length > MAX_HISTORY) {
        historyStack.shift(); // Remove oldest
    }

    historyIndex = historyStack.length - 1;
    updateUndoRedoButtons();
}
/**
 * Executes Undo action.
 */
function undoAction() {
    if (historyIndex > 0) {
        historyIndex--;
        applyHistoryState(historyIndex);
    }
}

/**
 * Executes Redo action.
 */
function redoAction() {
    if (historyIndex < historyStack.length - 1) {
        historyIndex++;
        applyHistoryState(historyIndex);
    }
}

/**
 * Loads a specific configuration from history stack.
 */
function applyHistoryState(index) {
    if (index >= 0 && index < historyStack.length) {
        isRestoringHistory = true; // History restore starting

        try {
            // Load config from History
            const historicalConfig = JSON.parse(historyStack[index]);

            // Replace current config with historicalConfig
            cfg = ensureDefaults(historicalConfig);

            // Redraw UI
            applyDeviceProfile(cfg.device.resolution);
            applyTheme(); // CRITICAL: This line MUST BE ADDED to apply the theme.
            renderPageBar();

            // Save to LocalStorage (won't save to history thanks to isRestoringHistory)
            saveConfig(false);

            // Update buttons
            updateUndoRedoButtons();
        } finally {
            isRestoringHistory = false; // History restore finished
        }
    }
}

/**
 * Updates status of Undo and Redo buttons.
 */
function updateUndoRedoButtons() {
    const undoBtn = el('#undoBtn');
    const redoBtn = el('#redoBtn');

    if (undoBtn) {
        // Is there a step to go back? (Must have at least 2 steps to go back 1)
        undoBtn.disabled = historyIndex <= 0;
    }
    if (redoBtn) {
        // Is there a step to go forward?
        redoBtn.disabled = historyIndex >= historyStack.length - 1;
    }
}


function openEditor(idx, btn) {
    let tmp = Object.assign({}, emptyBtn(), btn);

    // --- BRIDGE FUNCTION (For Crop) ---
    window.updateCurrentButtonIcon = (url) => {
        tmp.icon = url;
        const iconInput = document.getElementById('iconPath');
        if (iconInput) {
            const fileName = url.split(/[\\/]/).pop().split('?')[0];
            iconInput.value = fileName;
        }
        tmp.iconColor = '';
        const colorInput = document.getElementById('iconColor');
        if (colorInput) {
            colorInput.value = '#ffffff';
            colorInput.classList.add('unset');
        }
        updatePreviewEl(tmp);
    };
    // ---------------------------------------

    currentEditorTmp = tmp; // Reference global variable
    const editorDialog = el('#editor');

    // ----- LANGUAGE CHANGE HERE -----
    el('#editorTitle').textContent = t('editor.title', { cellNum: idx + 1 });
    // ---------------------------------

    const parseNum = (val) => parseInt(val, 10) || 0;

    // 2. Define Panels
    const panels = {
        key: el('#rowKeyMods'),
        goto: el('#rowGotoPages'),
        folder: el('#rowFolder'),
        text: el('#rowTextMacro'),
        app: el('#rowApp'),
        timer: el('#rowTimer'),
        script: el('#rowScript'),
        website: el('#rowWebsite'),
        media: el('#rowMedia'),
        mouse: el('#rowMouse'),
        sound: el('#rowSound'),
        counter: el('#rowCounter'),
        toggle: el('#rowToggle'),
        multi: el('#rowMultiAction')
    };

    const timerMinutes = el('#timerMinutes');
    const timerSeconds = el('#timerSeconds');
    const labelText = el('#labelText');
    const iconPathInput = el('#iconPath');

    // --- Timer List Filling ---
    const ITEM_HEIGHT = 38;
    const MANUAL_SCROLL_OFFSET = 38;
    const MAX_MIN = 99;
    const MAX_SEC = 59;
    let minCenterIndex, secCenterIndex;

    if (timerMinutes.children.length === 0) {
        const createItem = (txt = '') => {
            const div = document.createElement('div');
            div.textContent = txt;
            return div;
        };
        const fillList = (listEl, maxVal) => {
            listEl.innerHTML = '';
            listEl.appendChild(createItem());
            listEl.appendChild(createItem());
            for (let i = maxVal; i >= 1; i--) {
                listEl.appendChild(createItem(String(i).padStart(2, '0')));
            }
            listEl.appendChild(createItem("00"));
            const centerIndex = listEl.children.length - 1;
            for (let i = 1; i <= maxVal; i++) {
                listEl.appendChild(createItem(String(i).padStart(2, '0')));
            }
            listEl.appendChild(createItem());
            listEl.appendChild(createItem());
            return centerIndex;
        };
        minCenterIndex = fillList(timerMinutes, MAX_MIN);
        secCenterIndex = fillList(timerSeconds, MAX_SEC);
    } else {
        minCenterIndex = 2 + MAX_MIN;
        secCenterIndex = 2 + MAX_SEC;
    }

    let minScrollTimer = null;
    let secScrollTimer = null;
    const handleWheelScroll = (e) => {
        e.preventDefault();
        const listEl = e.currentTarget;
        const scrollAmount = (e.deltaY > 0) ? ITEM_HEIGHT : -ITEM_HEIGHT;
        listEl.scrollTo({
            top: listEl.scrollTop + scrollAmount,
            behavior: 'auto'
        });
    };
    const onScrollStop = () => {
        const minIndex = Math.round((timerMinutes.scrollTop - MANUAL_SCROLL_OFFSET) / ITEM_HEIGHT) + 2;
        const secIndex = Math.round((timerSeconds.scrollTop - MANUAL_SCROLL_OFFSET) / ITEM_HEIGHT) + 2;
        const minSnapTop = (minIndex - 2) * ITEM_HEIGHT + MANUAL_SCROLL_OFFSET;
        const secSnapTop = (secIndex - 2) * ITEM_HEIGHT + MANUAL_SCROLL_OFFSET;
        if (timerMinutes.scrollTop !== minSnapTop) {
            timerMinutes.scrollTo({ top: minSnapTop, behavior: 'instant' });
        }
        if (timerSeconds.scrollTop !== secSnapTop) {
            timerSeconds.scrollTo({ top: secSnapTop, behavior: 'instant' });
        }
        const minVal = Math.min(MAX_MIN, Math.abs(minIndex - minCenterIndex));
        const secVal = Math.min(MAX_SEC, Math.abs(secIndex - secCenterIndex));
        tmp.timerDuration = (minVal * 60) + secVal;
        const formattedTime = `${String(minVal).padStart(2, '0')}:${String(secVal).padStart(2, '0')}`;
        labelText.value = formattedTime;
        tmp.label = formattedTime;
        updatePreviewEl(tmp);
    };
    const setTimerScrollPosition = (totalSeconds) => {
        const currentMinutes = Math.floor(totalSeconds / 60);
        const currentSeconds = totalSeconds % 60;
        const minTop = (minCenterIndex + currentMinutes - 2) * ITEM_HEIGHT + MANUAL_SCROLL_OFFSET;
        const secTop = (secCenterIndex + currentSeconds - 2) * ITEM_HEIGHT + MANUAL_SCROLL_OFFSET;
        const formattedTime = `${String(currentMinutes).padStart(2, '0')}:${String(currentSeconds).padStart(2, '0')}`;
        labelText.value = formattedTime;
        tmp.label = formattedTime;
        setTimeout(() => {
            timerMinutes.scrollTo({ top: minTop, behavior: 'instant' });
            timerSeconds.scrollTo({ top: secTop, behavior: 'instant' });
        }, 50);
    };

    let mousePosInterval = null;

    // 3. Main Action Change Function
    function showActionPanel(actionType) {
        // Timer Cleanup
        if (tmp.type === 'timer' && actionType !== 'timer') {
            tmp.label = ""; labelText.value = ""; updatePreviewEl(tmp);
        }
        if (actionType === 'timer' && tmp.type !== 'timer') {
            tmp.timerDuration = 0; tmp.label = "00:00";
            // Timer için default labelSize 28
            tmp.labelSize = 28;
            el('#labelSizeRange').value = 28;
            el('#labelSize').value = 28;
        }

        // Counter Cleanup
        if (tmp.type === 'counter' && actionType !== 'counter') {
            tmp.label = ""; labelText.value = "";
            tmp.icon = ""; iconPathInput.value = "";
            tmp.counterStartValue = 0; el('#counterStartValue').value = 0;
            updatePreviewEl(tmp);
        }
        if (actionType === 'counter' && tmp.type !== 'counter') {
            // Counter için default labelSize 28
            tmp.labelSize = 28;
            el('#labelSizeRange').value = 28;
            el('#labelSize').value = 28;
            el('#counterStartValue').value = 0; tmp.counterStartValue = 0;
            labelText.value = "0"; tmp.label = "0";
            updatePreviewEl(tmp);
        }

        // Folder Defaults
        if (actionType === 'folder') {
            if (!tmp.label || tmp.label === '') {
                tmp.label = 'Folder';
                labelText.value = 'Folder';
            }
            if (!tmp.icon) {
                tmp.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
                iconPathInput.value = tmp.icon;
            }
            if (tmp.gotoPage === undefined) {
                tmp.gotoPage = 0;
            }
            updatePreviewEl(tmp);
            if (typeof updateFolderChooser === 'function') {
                updateFolderChooser();
            }
        }

        tmp.type = actionType;
        for (const [key, panel] of Object.entries(panels)) {
            if (panel) panel.style.display = (key === actionType) ? 'flex' : 'none';
        }
        document.querySelectorAll('.seg-btn[data-act]').forEach(b => {
            b.classList.toggle('active', b.dataset.act === actionType);
        });
        labelText.readOnly = (actionType === 'timer');

        clearInterval(mousePosInterval);
        const mousePosEl = el('#mouseRealtimePos');
        if (actionType === 'mouse') {
            mousePosInterval = setInterval(async () => {
                if (window.electronAPI && window.electronAPI.robot) {
                    const pos = await window.electronAPI.robot.getMousePos();
                    if (pos.success) {
                        mousePosEl.textContent = `Current: X: ${pos.x}, Y: ${pos.y}`;
                    }
                }
            }, 100);
        }

        if (actionType === 'timer') {
            setTimerScrollPosition(tmp.timerDuration);
            timerMinutes.onscroll = () => { clearTimeout(minScrollTimer); minScrollTimer = setTimeout(onScrollStop, 150); };
            timerSeconds.onscroll = () => { clearTimeout(secScrollTimer); secScrollTimer = setTimeout(onScrollStop, 150); };
            timerMinutes.onwheel = handleWheelScroll;
            timerSeconds.onwheel = handleWheelScroll;
        } else {
            timerMinutes.onscroll = null; timerSeconds.onscroll = null;
            timerMinutes.onwheel = null; timerSeconds.onwheel = null;
        }
    }

    // --- Form Listeners ---
    const inlineResults = el('#inlineIconResults');
    const iconColorInput = el('#iconColor');
    let editorSearchTimer = null;

    // Main Icon Search
    iconPathInput.oninput = () => {
        const val = iconPathInput.value;
        tmp.icon = val;
        if (val.startsWith('online:') && val.split(':').length >= 3) {
            autoSetIconColor(val, tmp, iconColorInput);
        }
        updatePreviewEl(tmp);
        clearTimeout(editorSearchTimer);
        editorSearchTimer = setTimeout(() => {
            searchOnlineInline(val, inlineResults, iconPathInput, () => {
                tmp.icon = iconPathInput.value;
                autoSetIconColor(tmp.icon, tmp, iconColorInput);
                updatePreviewEl(tmp);
            });
        }, 300);
    };

    // Standard form elements
    const rawIcon = tmp.icon || '';
    if (rawIcon.startsWith('file:')) {
        iconPathInput.value = rawIcon.split(/[\\/]/).pop().split('?')[0];
    } else {
        iconPathInput.value = rawIcon;
    }
    labelText.value = tmp.label || '';
    el('#labelColor').value = tmp.labelColor || '#ffffff';
    if (!tmp.labelColor) tmp.labelColor = '#ffffff'; // Set default if not set


    const btnBgColorInput = el('#btnBgColor');
    if (tmp.btnBgColor) {
        btnBgColorInput.value = tmp.btnBgColor;
        btnBgColorInput.classList.remove('unset');
    } else {
        btnBgColorInput.value = '#000000';
        btnBgColorInput.classList.add('unset');
    }
    if (tmp.iconColor) {
        iconColorInput.value = tmp.iconColor;
        iconColorInput.classList.remove('unset');
    } else {
        iconColorInput.value = '#ffffff';
        iconColorInput.classList.add('unset');
    }
    const safeSize = Math.min(Math.max(10, tmp.labelSize || 18), 28);
    el('#labelSizeRange').value = safeSize;
    el('#labelSize').value = safeSize;
    const safeScale = Math.min(Math.max(-100, tmp.iconScale || 0), 100);
    el('#iconScale').value = safeScale;
    el('#iconScaleRange').value = safeScale;

    // Slider/Input Listeners
    el('#iconScaleRange').oninput = () => { el('#iconScale').value = el('#iconScaleRange').value; tmp.iconScale = Number(el('#iconScaleRange').value); updatePreviewEl(tmp); };
    el('#iconScale').oninput = () => { let val = Math.min(Math.max(-100, Number(el('#iconScale').value)), 100); if (isNaN(val)) val = 0; el('#iconScale').value = val; el('#iconScaleRange').value = val; tmp.iconScale = val; updatePreviewEl(tmp); };

    document.querySelectorAll('[data-val]').forEach(b => { b.classList.toggle('active', b.dataset.val === tmp.labelV); b.onclick = () => { document.querySelectorAll('[data-val]').forEach(x => x.classList.remove('active')); b.classList.add('active'); tmp.labelV = b.dataset.val; updatePreviewEl(tmp); }; });
    document.querySelectorAll('.seg-btn[data-act]').forEach(b => { 
        b.onclick = () => {
            showActionPanel(b.dataset.act);
            if (b.dataset.act === 'multi') {
                initMultiActionPanel(tmp);
            }
        }; 
    });

    // Show initial panel
    showActionPanel(tmp.type || null);
    
    // Initialize multi-action panel if needed
    if (tmp.type === 'multi') {
        initMultiActionPanel(tmp);
    }

    labelText.oninput = () => { tmp.label = labelText.value; updatePreviewEl(tmp); };
    el('#labelColor').oninput = () => { tmp.labelColor = el('#labelColor').value; updatePreviewEl(tmp); };
    el('#labelColorClear').onclick = () => { el('#labelColor').value = '#ffffff'; tmp.labelColor = '#ffffff'; updatePreviewEl(tmp); };
    el('#labelSizeRange').oninput = () => { el('#labelSize').value = el('#labelSizeRange').value; tmp.labelSize = Number(el('#labelSize').value); updatePreviewEl(tmp); };
    el('#labelSize').oninput = () => { el('#labelSizeRange').value = el('#labelSize').value; tmp.labelSize = Number(el('#labelSize').value); updatePreviewEl(tmp); };
    btnBgColorInput.oninput = () => { tmp.btnBgColor = btnBgColorInput.value; btnBgColorInput.classList.remove('unset'); updatePreviewEl(tmp); };
    el('#btnBgColorClear').onclick = () => { tmp.btnBgColor = ''; btnBgColorInput.value = '#000000'; btnBgColorInput.classList.add('unset'); updatePreviewEl(tmp); };
    iconColorInput.oninput = () => { tmp.iconColor = iconColorInput.value; iconColorInput.classList.remove('unset'); updatePreviewEl(tmp); };
    el('#iconColorClear').onclick = () => { tmp.iconColor = ''; iconColorInput.value = '#ffffff'; iconColorInput.classList.add('unset'); updatePreviewEl(tmp); };

    const combo = el('#combo');
    combo.value = tmp.combo || '';
    combo.readOnly = false;

    const pillsContainer = el('#hotkeyPillsContainer');
    const updateHotkeyPills = (comboStr) => {
        if (!pillsContainer) return;
        pillsContainer.innerHTML = '';
        if (!comboStr || comboStr.trim().length === 0) {
            pillsContainer.innerHTML = '<span class="muted" style="font-size: 11px;">Kliknij "Nagraj skrót" i wciśnij klawisze...</span>';
            return;
        }
        const parts = comboStr.split('+').map(s => s.trim()).filter(Boolean);
        parts.forEach((p, idx) => {
            const span = document.createElement('span');
            span.className = 'key-pill-badge';
            span.textContent = p;
            pillsContainer.appendChild(span);
            if (idx < parts.length - 1) {
                const plus = document.createElement('span');
                plus.style.color = 'var(--muted)';
                plus.style.fontWeight = 'bold';
                plus.textContent = '+';
                pillsContainer.appendChild(plus);
            }
        });
    };

    updateHotkeyPills(tmp.combo || '');

    const clearShortcutBtn = el('#clearShortcutBtn');
    if (clearShortcutBtn) {
        clearShortcutBtn.onclick = () => {
            tmp.combo = '';
            combo.value = '';
            updateHotkeyPills('');
            updatePreviewEl(tmp);
        };
    }

    const addKeyToCombo = (key) => {
        const cv = combo.value.trim();
        if (cv.length === 0) {
            combo.value = key;
        } else if (cv.endsWith('+')) {
            combo.value += key;
        } else {
            combo.value += '+' + key;
        }
        tmp.combo = combo.value;
        updateHotkeyPills(combo.value);
        combo.focus();
    };

    document.querySelectorAll('#rowKeyMods .mod[data-mod]').forEach(b => { b.onclick = () => addKeyToCombo(b.dataset.mod); });
    document.querySelectorAll('#rowKeyMods .mod[data-key]').forEach(b => { b.onclick = () => addKeyToCombo(b.dataset.key); });
    el('#addEnterKey').onclick = () => addKeyToCombo('ENTER');

    const recordShortcutBtn = el('#recordShortcutBtn');
    let isSmartRecording = false;

    function stopSmartRecording() {
        if (!isSmartRecording) return;
        isSmartRecording = false;
        if (recordShortcutBtn) {
            recordShortcutBtn.classList.remove('recording');
            const label = el('#recordShortcutLabel');
            const dot = el('#recordShortcutDot');
            if (label) label.textContent = 'Nagraj skrót / Record';
            if (dot) dot.textContent = '🔴';
        }
        window.removeEventListener('keydown', onSmartKeydown, true);
    }

    function onSmartKeydown(e) {
        e.preventDefault();
        e.stopPropagation();

        const mods = [];
        if (e.ctrlKey) mods.push('CTRL');
        if (e.altKey) mods.push('ALT');
        if (e.shiftKey) mods.push('SHIFT');
        if (e.metaKey) mods.push('GUI');

        let key = e.key ? e.key.toUpperCase() : '';
        if (['CONTROL', 'ALT', 'SHIFT', 'META', 'OS'].includes(key)) {
            if (mods.length > 0) updateHotkeyPills(mods.join('+'));
            return;
        }

        const specialMap = {
            ' ': 'SPACE',
            'ARROWUP': 'ARROW_UP',
            'ARROWDOWN': 'ARROW_DOWN',
            'ARROWLEFT': 'ARROW_LEFT',
            'ARROWRIGHT': 'ARROW_RIGHT',
            'PAGEUP': 'PAGE_UP',
            'PAGEDOWN': 'PAGE_DOWN',
            'ESCAPE': 'ESCAPE',
            'ENTER': 'ENTER',
            'TAB': 'TAB',
            'BACKSPACE': 'BACKSPACE',
            'DELETE': 'DELETE',
            'INSERT': 'INSERT',
            'HOME': 'HOME',
            'END': 'END',
            'CAPSLOCK': 'CAPSLOCK'
        };
        if (specialMap[key]) key = specialMap[key];

        const fullCombo = [...mods, key].join('+');
        tmp.combo = fullCombo;
        combo.value = fullCombo;
        updateHotkeyPills(fullCombo);
        updatePreviewEl(tmp);
        stopSmartRecording();
    }

    if (recordShortcutBtn) {
        recordShortcutBtn.onclick = () => {
            if (isSmartRecording) {
                stopSmartRecording();
            } else {
                isSmartRecording = true;
                recordShortcutBtn.classList.add('recording');
                const label = el('#recordShortcutLabel');
                const dot = el('#recordShortcutDot');
                if (label) label.textContent = 'Wciśnij klawisze...';
                if (dot) dot.textContent = '⏹️';
                if (pillsContainer) {
                    pillsContainer.innerHTML = '<span style="color:#60A5FA; font-weight:600; font-size:12px;">Nasłuchiwanie...</span>';
                }
                window.addEventListener('keydown', onSmartKeydown, true);
            }
        };
    }

    let isCapturing = false;
    const captureBtn = el('#captureToggle');
    captureBtn.style.display = 'none';

    function stopCapture() {
        if (!isCapturing) return;
        isCapturing = false;
        captureBtn.textContent = t('editor.capture.start');
        captureBtn.classList.remove('capturing');
        editorDialog.onkeydown = null;
    }

    captureBtn.onclick = () => {
        if (isCapturing) { stopCapture(); } else {
            isCapturing = true; captureBtn.textContent = t('editor.capture.listening'); captureBtn.classList.add('capturing'); combo.value = t('editor.capture.pressKeys');
            editorDialog.focus();
            editorDialog.onkeydown = (e) => {
                e.preventDefault(); e.stopPropagation(); const key = e.key.toUpperCase();
                if (key === 'ESCAPE') { combo.value = tmp.combo || ''; stopCapture(); return; }
                if (key === 'CONTROL' || key === 'SHIFT' || key === 'ALT' || key === 'META') { let tempCombo = ''; if (e.ctrlKey) tempCombo += 'CTRL+'; if (e.altKey) tempCombo += 'ALT+'; if (e.shiftKey) tempCombo += 'SHIFT+'; if (e.metaKey) tempCombo += 'GUI+'; combo.value = tempCombo; return; }
                let comboStr = ''; if (e.ctrlKey) comboStr += 'CTRL+'; if (e.altKey) comboStr += 'ALT+'; if (e.shiftKey) comboStr += 'SHIFT+'; if (e.metaKey) tempCombo += 'GUI+';
                if (key === ' ') comboStr += 'SPACE';
                else if (key.length === 1) comboStr += key;
                else comboStr += key;
                combo.value = comboStr; stopCapture();
            };
        }
    };

    // --- TOGGLE BUTTON LOGIC (COMPACT & WITH PRESETS) ---
    const toggleOffInput = el('#toggleOffCombo');
    const toggleOnInput = el('#toggleOnCombo');
    const toggleColorInput = el('#toggleOnColor');         // Active BG Color
    const toggleIconColorInput = el('#toggleOnIconColor'); // NEW: Active Icon Color

    const toggleOnIconInput = el('#toggleOnIconPath');
    const toggleOnIconResults = el('#toggleOnIconResults');
    const toggleOnIconPreview = el('#toggleOnIconPreview');
    const toggleOnIconBox = el('#toggleOnIconPreviewBox');
    const toggleSoundCheckbox = el('#toggleUseDefaultSound');

    // NEW: Preset Dropdowns
    const toggleOffPreset = el('#toggleOffPreset');
    const toggleOnPreset = el('#toggleOnPreset');

    // Load Data
    tmp.toggleData = tmp.toggleData || { offCombo: '', onCombo: '', onColor: '#2ecc71', iconOn: '', useSound: false };

    toggleOffInput.value = tmp.toggleData.offCombo || '';
    toggleOnInput.value = tmp.toggleData.onCombo || '';
    toggleColorInput.value = tmp.toggleData.onColor || '#2ecc71';
    toggleIconColorInput.value = tmp.toggleData.onIconColor || '#ffffff';
    toggleOnIconInput.value = tmp.toggleData.iconOn || '';
    toggleSoundCheckbox.checked = tmp.toggleData.useSound || false;
    const fillPresets = (selectEl, targetInput) => {
        selectEl.innerHTML = `<option value="">${t('editor.toggle.preset')}</option>`;
        TOGGLE_PRESETS.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.val;
            opt.textContent = p.name;
            if (p.val === "") {
                opt.disabled = true; // Disable header line
                opt.style.fontWeight = "bold";
                opt.style.color = "#aaa";
            }
            selectEl.appendChild(opt);
        });
        // Write to input when selection is made
        selectEl.onchange = () => {
            if (selectEl.value) {
                targetInput.value = selectEl.value;
                // Update state (based on Off or On input)
                if (targetInput === toggleOffInput) tmp.toggleData.offCombo = selectEl.value;
                else tmp.toggleData.onCombo = selectEl.value;
                selectEl.value = ""; // Reset selection
            }
        };
    };

    fillPresets(toggleOffPreset, toggleOffInput);
    fillPresets(toggleOnPreset, toggleOnInput);
    // ---------------------------------------

    // NEW: State B Icon Preview Function
    const updateToggleOnPreview = () => {
        const val = toggleOnIconInput.value;
        tmp.toggleData.iconOn = val;

        // 1. Set box background color (Active BG Color)
        toggleOnIconBox.style.backgroundColor = toggleColorInput.value;

        const url = getIconUrl(val);
        if (url) {
            toggleOnIconPreview.style.display = 'block';

            // 2. Set icon color (Active Icon Color)
            const activeIconColor = toggleIconColorInput.value;

            // Cleanup
            toggleOnIconPreview.style.backgroundImage = 'none';
            toggleOnIconPreview.style.webkitMaskImage = 'none';
            toggleOnIconPreview.style.maskImage = 'none';
            toggleOnIconPreview.style.backgroundColor = 'transparent';

            // Masking (Coloring) Logic
            if (activeIconColor && !url.startsWith('data:')) {
                toggleOnIconPreview.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; // Transparent
                toggleOnIconPreview.style.backgroundColor = activeIconColor; // Color the icon with this color
                toggleOnIconPreview.style.webkitMaskImage = `url("${url}")`;
                toggleOnIconPreview.style.maskImage = `url("${url}")`;
                toggleOnIconPreview.style.webkitMaskSize = 'contain';
                toggleOnIconPreview.style.maskSize = 'contain';
                toggleOnIconPreview.style.webkitMaskPosition = 'center';
                toggleOnIconPreview.style.maskPosition = 'center';
                toggleOnIconPreview.style.webkitMaskRepeat = 'no-repeat';
                toggleOnIconPreview.style.maskRepeat = 'no-repeat';
            } else {
                // Normal Mode (Colorless or local image)
                toggleOnIconPreview.src = url;
            }
        } else {
            toggleOnIconPreview.style.display = 'none';
            toggleOnIconPreview.src = '';
        }
    };
    updateToggleOnPreview();

    // Listeners
    toggleColorInput.oninput = () => {
        tmp.toggleData.onColor = toggleColorInput.value;
        updateToggleOnPreview(); // Update small box
    };

    toggleIconColorInput.oninput = () => {
        tmp.toggleData.onIconColor = toggleIconColorInput.value;
        updateToggleOnPreview(); // Update icon color
    };

    toggleSoundCheckbox.onchange = () => {
        tmp.toggleData.useSound = toggleSoundCheckbox.checked;
    };

    let toggleSearchTimer = null;
    toggleOnIconInput.oninput = () => {
        updateToggleOnPreview();
        clearTimeout(toggleSearchTimer);
        toggleSearchTimer = setTimeout(() => {
            searchOnlineInline(toggleOnIconInput.value, toggleOnIconResults, toggleOnIconInput, () => {
                tmp.toggleData.iconOn = toggleOnIconInput.value;
                updateToggleOnPreview();
            });
        }, 300);
    };

    // Click outside
    editorDialog.onclick = (e) => {
        if (inlineResults.style.display !== 'none' && !iconPathInput.contains(e.target) && !inlineResults.contains(e.target)) {
            inlineResults.style.display = 'none';
        }
        if (toggleOnIconResults.style.display !== 'none' && !toggleOnIconInput.contains(e.target) && !toggleOnIconResults.contains(e.target)) {
            toggleOnIconResults.style.display = 'none';
        }
    };

    // Capture Logic (Same)
    let activeCaptureTarget = null;
    const startToggleCapture = (targetId) => {
        if (isCapturing) stopCapture();
        const targetInput = el('#' + targetId);
        activeCaptureTarget = targetInput;
        isCapturing = true;
        captureBtn.textContent = t('editor.capture.listening');
        captureBtn.classList.add('capturing');
        targetInput.classList.add('capturing-input');
        targetInput.value = t('editor.capture.pressKeys');

        editorDialog.focus();
        editorDialog.onkeydown = (e) => {
            e.preventDefault(); e.stopPropagation();
            const key = e.key.toUpperCase();
            if (key === 'ESCAPE') {
                targetInput.value = (targetId === 'toggleOffCombo' ? tmp.toggleData.offCombo : tmp.toggleData.onCombo);
                stopToggleCapture(); return;
            }
            let comboStr = '';
            if (e.ctrlKey) comboStr += 'CTRL+'; if (e.altKey) comboStr += 'ALT+'; if (e.shiftKey) comboStr += 'SHIFT+'; if (e.metaKey) comboStr += 'GUI+';
            if (key === 'CONTROL' || key === 'SHIFT' || key === 'ALT' || key === 'META') { targetInput.value = comboStr; return; }
            if (key === ' ') comboStr += 'SPACE';
            else if (key.length === 1) comboStr += key;
            else comboStr += key;

            targetInput.value = comboStr;
            if (targetId === 'toggleOffCombo') tmp.toggleData.offCombo = comboStr;
            else tmp.toggleData.onCombo = comboStr;
            stopToggleCapture();
        };
    };

    const stopToggleCapture = () => {
        if (activeCaptureTarget) activeCaptureTarget.classList.remove('capturing-input');
        activeCaptureTarget = null;
        isCapturing = false;
        captureBtn.textContent = t('editor.capture.start');
        captureBtn.classList.remove('capturing');
        editorDialog.onkeydown = null;
    };

    document.querySelectorAll('.small-capture-btn').forEach(btn => btn.onclick = () => startToggleCapture(btn.dataset.target));
    document.querySelectorAll('.small-clear-btn').forEach(btn => btn.onclick = () => {
        const id = btn.dataset.target;
        el('#' + id).value = '';
        if (id === 'toggleOffCombo') tmp.toggleData.offCombo = '';
        else tmp.toggleData.onCombo = '';
    });
    // --- TOGGLE LOGIC END ---


    const presetActionsSelect = el('#presetActionsSelect');
    if (presetActionsSelect.options.length <= 1) {
        for (const [category, actions] of Object.entries(PRESET_ACTIONS)) {
            if (typeof actions === 'object') {
                const optgroup = document.createElement('optgroup');
                optgroup.label = getPresetCategoryName(category);
                for (const [name, comboVal] of Object.entries(actions)) {
                    const option = document.createElement('option');
                    option.value = comboVal;
                    option.textContent = name;
                    optgroup.appendChild(option);
                }
                presetActionsSelect.appendChild(optgroup);
            } else {
                const option = document.createElement('option');
                option.value = actions;
                option.textContent = getPresetCategoryName(category);
                presetActionsSelect.appendChild(option);
            }
        }
    }
    presetActionsSelect.value = "";
    presetActionsSelect.onchange = () => {
        const selectedCombo = presetActionsSelect.value;
        if (selectedCombo) {
            combo.value = selectedCombo;
            tmp.combo = selectedCombo;
            updateHotkeyPills(selectedCombo);
            updatePreviewEl(tmp);
            presetActionsSelect.selectedIndex = 0;
        }
    };

    document.querySelectorAll('.quick-chip-btn').forEach(chip => {
        chip.onclick = () => {
            const qCombo = chip.dataset.quickCombo;
            const qLabel = chip.dataset.quickLabel;
            if (qCombo) {
                combo.value = qCombo;
                tmp.combo = qCombo;
                updateHotkeyPills(qCombo);
                const labelInput = el('#labelText');
                if (labelInput && (!labelInput.value || labelInput.value === 'Sample text' || labelInput.value.trim() === '')) {
                    labelInput.value = qLabel || qCombo;
                    tmp.label = qLabel || qCombo;
                }
                updatePreviewEl(tmp);
            }
        };
    });

    const pageChooser = el('#gotoPages');
    pageChooser.innerHTML = '';
    for (let i = 0; i < cfg.pageCount; i++) { const b = document.createElement('button'); b.type = 'button'; b.className = 'page-pill'; const pageName = cfg.pageNames[i]; b.textContent = (pageName || `Page ${i + 1}`); b.classList.toggle('active', i === tmp.gotoPage); b.onclick = () => { tmp.gotoPage = i; pageChooser.querySelectorAll('.page-pill').forEach(pb => pb.classList.remove('active')); b.classList.add('active'); }; pageChooser.appendChild(b); }

    const folderChooser = el('#folderPages');
    const updateFolderChooser = () => {
        if (!folderChooser) return;
        folderChooser.innerHTML = '';
        for (let i = 0; i < cfg.pageCount; i++) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'page-pill';
            const pageName = cfg.pageNames[i];
            b.textContent = (pageName || `Page ${i + 1}`);
            b.classList.toggle('active', i === tmp.gotoPage);
            b.onclick = () => {
                tmp.gotoPage = i;
                folderChooser.querySelectorAll('.page-pill').forEach(pb => pb.classList.remove('active'));
                b.classList.add('active');
            };
            folderChooser.appendChild(b);
        }
    };
    updateFolderChooser();

    const btnNewFolder = el('#btnCreateNewFolder');
    if (btnNewFolder) {
        btnNewFolder.onclick = async () => {
            const defaultName = (tmp.label && tmp.label.trim() && tmp.label !== 'Folder') ? tmp.label.trim() : `Folder ${cfg.pageCount + 1}`;
            const folderName = prompt('Podaj nazwę nowego folderu:', defaultName);
            if (!folderName || !folderName.trim()) return;

            // Create new page for folder
            const newPageIndex = cfg.pageCount;
            cfg.pageCount++;
            const newPage = Array.from({ length: GRID_COLS * GRID_ROWS }, () => emptyBtn());

            // Add back button at cell 0
            const backBtn = emptyBtn();
            backBtn.type = 'goto';
            backBtn.gotoPage = currentPage;
            backBtn.label = 'Wróć';
            backBtn.labelV = 'bottom';
            backBtn.labelSize = 14;
            backBtn.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
            newPage[0] = backBtn;

            cfg.pages.push(newPage);
            cfg.pageNames.push(`📁 ${folderName.trim()}`);

            // Link this button to the new folder page
            tmp.type = 'folder';
            tmp.gotoPage = newPageIndex;
            tmp.label = folderName.trim();
            tmp.labelV = 'bottom';
            tmp.labelSize = 14;
            if (!tmp.icon) {
                tmp.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
            }

            labelText.value = tmp.label;
            iconPathInput.value = tmp.icon;
            updatePreviewEl(tmp);
            updateFolderChooser();
            saveConfig(false);
            renderPageBar();
            showToast(`Utworzono podstronę folderu: ${folderName}`, 'success');
        };
    }

    el('#textMacro').value = tmp.textMacro || '';
    el('#textMacro').oninput = () => { tmp.textMacro = el('#textMacro').value; };

    const textMacroInput = el('#textMacro');
    const simulateCheckbox = el('#simulateTypingCheckbox');
    textMacroInput.value = tmp.textMacro || '';
    simulateCheckbox.checked = tmp.textSimulateTyping || false;
    textMacroInput.oninput = () => { tmp.textMacro = textMacroInput.value; };
    simulateCheckbox.onchange = () => { tmp.textSimulateTyping = simulateCheckbox.checked; };

    const customScriptText = el('#customScript');
    customScriptText.value = tmp.customScript || '';
    customScriptText.oninput = () => { tmp.customScript = customScriptText.value; };

    el('#websiteUrl').value = tmp.websiteUrl || '';
    el('#websiteUrl').oninput = () => { tmp.websiteUrl = el('#websiteUrl').value; };

    const mediaButtons = el('#rowMedia').querySelectorAll('.seg-btn[data-media]');
    mediaButtons.forEach(b => {
        b.classList.toggle('active', b.dataset.media === tmp.mediaAction);
        b.onclick = () => {
            mediaButtons.forEach(other => other.classList.remove('active'));
            b.classList.add('active');
            tmp.mediaAction = b.dataset.media;
        };
    });

    const soundPathInput = el('#soundPath');
    const soundVolumeInput = el('#soundVolume');
    const soundVolLabel = el('#soundVolLabel');
    const hiddenSoundInput = el('#hiddenSoundInput');

    soundPathInput.value = tmp.soundPath || '';
    soundVolumeInput.value = (tmp.soundVolume !== undefined) ? tmp.soundVolume : 100;
    soundVolLabel.textContent = soundVolumeInput.value + '%';
    el('#browseSoundBtn').onclick = () => {
        hiddenSoundInput.value = null;
        hiddenSoundInput.onchange = (e) => { const file = e.target.files[0]; if (file && file.path) { tmp.soundPath = file.path; soundPathInput.value = file.path; } };
        hiddenSoundInput.click();
    };
    soundVolumeInput.oninput = () => { tmp.soundVolume = Number(soundVolumeInput.value); soundVolLabel.textContent = tmp.soundVolume + '%'; };

    const presetScriptSelect = el('#presetScriptSelect');
    if (presetScriptSelect.options.length <= 1) {
        for (const [category, actions] of Object.entries(PRESET_SCRIPTS)) {
            if (typeof actions === 'object') {
                const optgroup = document.createElement('optgroup');
                optgroup.label = getPresetCategoryName(category);
                for (const [name, script] of Object.entries(actions)) {
                    const option = document.createElement('option');
                    option.value = script;
                    option.textContent = name;
                    optgroup.appendChild(option);
                }
                presetScriptSelect.appendChild(optgroup);
            } else {
                const option = document.createElement('option');
                option.value = actions;
                option.textContent = getPresetCategoryName(category);
                presetScriptSelect.appendChild(option);
            }
        }
    }
    presetScriptSelect.value = "";
    presetScriptSelect.onchange = () => { const selectedScript = presetScriptSelect.value; if (selectedScript) { const currentText = customScriptText.value; const newText = (currentText ? currentText + '\n' : '') + selectedScript; customScriptText.value = newText; tmp.customScript = newText; presetScriptSelect.selectedIndex = 0; } };

    const mouseEventSelect = el('#mouseEventSelect');
    const mouseButtonSelectDiv = el('#mouseButtonSelectDiv');
    const mouseButtonSelect = el('#mouseButtonSelect');
    const mouseMoveOptions = el('#mouseMoveOptions');
    const mouseDragOptions = el('#mouseDragOptions');
    const mouseX1 = el('#mouseX1');
    const mouseY1 = el('#mouseY1');
    const mouseDragX1 = el('#mouseDragX1');
    const mouseDragY1 = el('#mouseDragY1');
    const mouseDragX2 = el('#mouseDragX2');
    const mouseDragY2 = el('#mouseDragY2');

    const mCfg = tmp.mouseConfig || emptyBtn().mouseConfig;
    mouseEventSelect.value = mCfg.event;
    mouseButtonSelect.value = mCfg.button;
    mouseX1.value = mCfg.x1;
    mouseY1.value = mCfg.y1;
    mouseDragX1.value = mCfg.x1;
    mouseDragY1.value = mCfg.y1;
    mouseDragX2.value = mCfg.x2;
    mouseDragY2.value = mCfg.y2;

    const updateMousePanels = () => {
        const event = mouseEventSelect.value;
        mouseMoveOptions.classList.toggle('active', event === 'click' || event === 'double_click' || event === 'move');
        mouseDragOptions.classList.toggle('active', event === 'drag');
        mouseButtonSelectDiv.style.display = (event === 'click' || event === 'double_click' || event === 'drag') ? 'block' : 'none';
        tmp.mouseConfig.event = event;
    };
    updateMousePanels();

    mouseEventSelect.onchange = updateMousePanels;
    mouseButtonSelect.onchange = () => tmp.mouseConfig.button = mouseButtonSelect.value;
    mouseX1.oninput = () => tmp.mouseConfig.x1 = parseNum(mouseX1.value);
    mouseY1.oninput = () => tmp.mouseConfig.y1 = parseNum(mouseY1.value);
    mouseDragX1.oninput = () => tmp.mouseConfig.x1 = parseNum(mouseDragX1.value);
    mouseDragY1.oninput = () => tmp.mouseConfig.y1 = parseNum(mouseDragY1.value);
    mouseDragX2.oninput = () => tmp.mouseConfig.x2 = parseNum(mouseDragX2.value);
    mouseDragY2.oninput = () => tmp.mouseConfig.y2 = parseNum(mouseDragY2.value);

    const counterStartInput = el('#counterStartValue');
    const counterActionSeg = el('#counterActionSeg');
    counterStartInput.value = tmp.counterStartValue || 0;
    counterStartInput.oninput = () => {
        const newVal = parseNum(counterStartInput.value);
        tmp.counterStartValue = newVal;
        const labelInput = el('#labelText');
        labelInput.value = String(newVal);
        tmp.label = String(newVal);
        updatePreviewEl(tmp);
        counterStartInput.value = newVal;
    };
    const defaultAction = tmp.counterAction || 'increment';
    counterActionSeg.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.val === defaultAction);
        b.onclick = () => {
            counterActionSeg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            tmp.counterAction = b.dataset.val;
        };
    });

    const mouseCapture = async (xInput, yInput) => {
        if (!window.electronAPI || !window.electronAPI.robot) return;
        await window.electronAPI.robot.enterCaptureMode();
        document.body.classList.add('in-capture-mode');
        const captureClickListener = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.removeEventListener('click', captureClickListener, { capture: true });
            document.body.classList.remove('in-capture-mode');
            const pos = await window.electronAPI.robot.getMousePos();
            await window.electronAPI.robot.exitCaptureMode();
            if (pos.success) {
                xInput.value = pos.x;
                yInput.value = pos.y;
                xInput.dispatchEvent(new Event('input'));
                yInput.dispatchEvent(new Event('input'));
            }
        };
        document.addEventListener('click', captureClickListener, { capture: true, once: true });
    };

    el('#mouseCaptureBtnStart').onclick = () => mouseCapture(mouseX1, mouseY1);
    el('#mouseCaptureBtnDragStart').onclick = () => mouseCapture(mouseDragX1, mouseDragY1);
    el('#mouseCaptureBtnDragEnd').onclick = () => mouseCapture(mouseDragX2, mouseDragY2);

    const appPathInput = el('#appPath');
    const hiddenAppInput = el('#hiddenAppInput');
    const appQuickSelect = el('#appQuickSelect');
    appPathInput.value = tmp.appPath || '';
    loadInstalledApps();
    appQuickSelect.onchange = () => { if (appQuickSelect.value) { appPathInput.value = appQuickSelect.value; tmp.appPath = appQuickSelect.value; } };
    appPathInput.oninput = () => { tmp.appPath = appPathInput.value; };
    el('#browseAppBtn').onclick = () => { hiddenAppInput.value = null; hiddenAppInput.click(); };
    hiddenAppInput.onchange = (e) => { const file = e.target.files[0]; if (file && file.path) { tmp.appPath = file.path; appPathInput.value = file.path; appQuickSelect.value = ""; } };

    const closeEditor = () => {
        stopSmartRecording();
        stopCapture();
        stopToggleCapture();
        clearInterval(mousePosInterval);
        inlineResults.style.display = 'none';
        editorDialog.close();
    };

    el('#clearBtn').onclick = () => {
        tmp = emptyBtn();
        iconPathInput.value = ''; inlineResults.style.display = 'none'; labelText.value = ''; el('#labelColor').value = '#ffffff'; btnBgColorInput.value = '#000000'; btnBgColorInput.classList.add('unset'); iconColorInput.value = '#ffffff'; iconColorInput.classList.add('unset'); el('#labelSizeRange').value = 18; el('#labelSize').value = 18; el('#iconScale').value = 0; el('#iconScaleRange').value = 0; document.querySelectorAll('[data-val]').forEach(b => { b.classList.toggle('active', b.dataset.val === 'middle'); });
        showActionPanel(null);
        el('#combo').value = ''; pageChooser.querySelectorAll('.page-pill').forEach(pb => pb.classList.remove('active')); el('#textMacro').value = ''; appPathInput.value = ''; appQuickSelect.value = '';

        el('#customScript').value = '';
        el('#websiteUrl').value = '';
        mediaButtons.forEach(b => b.classList.remove('active'));
        presetActionsSelect.value = "";
        presetScriptSelect.value = "";

        mouseEventSelect.value = 'click';
        mouseButtonSelect.value = 'left';
        mouseX1.value = 0; mouseY1.value = 0;
        mouseDragX1.value = 0; mouseDragY1.value = 0;
        mouseDragX2.value = 0; mouseDragY2.value = 0;
        updateMousePanels();

        counterStartInput.value = 0;
        counterActionSeg.querySelectorAll('.seg-btn').forEach(b => { b.classList.remove('active'); });
        counterActionSeg.querySelector('[data-val="increment"]').classList.add('active');

        // Toggle Reset
        toggleOffInput.value = '';
        toggleOnInput.value = '';
        toggleColorInput.value = '#2ecc71';
        toggleOnIconInput.value = '';
        toggleIconColorInput.value = '#ffffff';
        toggleSoundCheckbox.checked = false;
        updateToggleOnPreview();

        const minTop = (minCenterIndex - 2) * ITEM_HEIGHT + MANUAL_SCROLL_OFFSET;
        const secTop = (secCenterIndex - 2) * ITEM_HEIGHT + MANUAL_SCROLL_OFFSET;
        timerMinutes.scrollTo({ top: minTop, behavior: 'instant' });
        timerSeconds.scrollTo({ top: secTop, behavior: 'instant' });
        labelText.value = "00:00";
        tmp.label = "00:00";

        updatePreviewEl(tmp);
    };

    el('#cancel').onclick = closeEditor;
    el('#editorCloseBtn').onclick = closeEditor;

    el('#copyBtn').onclick = () => { clipboardButton = Object.assign({}, tmp, { combo: combo.value }); el('#pasteBtn').classList.add('primary'); el('#pasteBtn').disabled = false; };
    el('#pasteBtn').onclick = () => { if (!clipboardButton) { alert("Clipboard empty."); return; } closeEditor(); openEditor(idx, clipboardButton); };
    el('#pasteBtn').classList.toggle('primary', !!clipboardButton);
    el('#pasteBtn').disabled = !clipboardButton;

    el('#apply').onclick = (e) => {
        e.preventDefault();
        const finalCombo = combo.value;

        // --- 1. Timer Hesaplama ---
        if (tmp.type === 'timer') {
            const minIndex = Math.round((timerMinutes.scrollTop - MANUAL_SCROLL_OFFSET) / ITEM_HEIGHT) + 2;
            const secIndex = Math.round((timerSeconds.scrollTop - MANUAL_SCROLL_OFFSET) / ITEM_HEIGHT) + 2;
            const minVal = Math.min(MAX_MIN, Math.abs(minIndex - minCenterIndex));
            const secVal = Math.min(MAX_SEC, Math.abs(secIndex - secCenterIndex));
            tmp.timerDuration = (minVal * 60) + secVal;
            tmp.label = `${String(minVal).padStart(2, '0')}:${String(secVal).padStart(2, '0')}`;
        }

        // --- 2. Config Güncelleme ---
        const newButtonData = Object.assign(emptyBtn(), tmp, {
            combo: finalCombo,
            timerDuration: tmp.timerDuration,
            label: tmp.label,
            customScript: tmp.customScript,
            websiteUrl: tmp.websiteUrl,
            mediaAction: tmp.mediaAction,
            mouseConfig: tmp.mouseConfig,
            counterStartValue: tmp.counterStartValue,
            counterAction: tmp.counterAction,
            toggleData: tmp.toggleData,
            toggleState: tmp.toggleState
        });

        cfg.pages[currentPage][idx] = newButtonData;

        // --- 3. Cihaza Gönderim ---
        if (connectedSerialPort) {
            // Buton silindiyse (type yok veya boş) CLEAR_BTN gönder
            if (!newButtonData.type || newButtonData.type === '') {
                sendSerialCommand(`CLEAR_BTN:${currentPage}:${idx}`);
            } else if (newButtonData.type === 'timer' || newButtonData.type === 'counter') {
                // Sadece timer ve counter için SET_BTN_DATA gönder
                // Diğer buton türleri Upload ile sync olur (icon sorunu önlenir)
                const payloadObj = JSON.parse(JSON.stringify(newButtonData));

                // A) TIMER DÜZELTMESİ (Arduino 'duration' bekler)
                if (payloadObj.timerDuration !== undefined) {
                    payloadObj.duration = payloadObj.timerDuration;
                }

                // B) RENK DÜZELTMESİ (# işaretini kaldır)
                if (payloadObj.btnBgColor) {
                    payloadObj.btnColor = payloadObj.btnBgColor.replace('#', '');
                }
                payloadObj.labelColor = (payloadObj.labelColor || '#ffffff').replace('#', '');

                // C) ICON BUFFER KORUMASI
                if (payloadObj.icon) {
                    if (payloadObj.icon.startsWith('data:') || payloadObj.icon.length > 100) {
                        payloadObj.icon = "";
                    } else {
                        const parts = payloadObj.icon.split(/[\\/]/);
                        payloadObj.icon = parts[parts.length - 1].split('?')[0];
                    }
                }

                const jsonString = JSON.stringify(payloadObj);
                sendSerialCommand(`SET_BTN_DATA:${currentPage}:${idx}:${jsonString}`);
            } else {
                // Diğer buton türleri için ESP'ye veri gönderme - Upload ile sync olacak
            }
        }

        // --- 4. Arayüzü Yenile ---
        drawGrid();
        closeEditor();
        saveConfig();
    };

    // Setup 2-Column Inspector Tabs
    const navTabs = document.querySelectorAll('.editor-nav-tab-btn');
    const tabSections = {
        action: el('#tabSectionAction'),
        style: el('#tabSectionStyle'),
        advanced: el('#tabSectionAdvanced')
    };
    navTabs.forEach(tabBtn => {
        tabBtn.onclick = () => {
            navTabs.forEach(b => b.classList.remove('active'));
            tabBtn.classList.add('active');
            const target = tabBtn.dataset.editorTab;
            Object.entries(tabSections).forEach(([k, section]) => {
                if (section) section.style.display = (k === target) ? 'flex' : 'none';
            });
        };
    });
    navTabs.forEach(b => b.classList.toggle('active', b.dataset.editorTab === 'action'));
    if (tabSections.action) tabSections.action.style.display = 'flex';
    if (tabSections.style) tabSections.style.display = 'none';
    if (tabSections.advanced) tabSections.advanced.style.display = 'none';

    // Setup Quick Theme Color Swatches
    document.querySelectorAll('.color-swatch-dot').forEach(dot => {
        dot.onclick = () => {
            const color = dot.dataset.color;
            if (!color) return;
            tmp.btnBgColor = color;
            const bgInput = el('#btnBgColor');
            if (bgInput) {
                bgInput.value = color;
                bgInput.classList.remove('unset');
            }
            updatePreviewEl(tmp);
        };
    });

    const actionTag = el('#editorActionTag');
    if (actionTag) {
        actionTag.textContent = (tmp.type || 'KEY').toUpperCase();
    }

    updatePreviewEl(tmp);
    editorDialog.showModal();
}


// ...

// Preset category translation mapping
const PRESET_CATEGORY_KEYS = {
    "--- Select Preset ---": "presets.selectPreset",
    "--- Select Preset Script ---": "presets.selectPresetScript",
    "Editing": "presets.categories.editing",
    "Window Management": "presets.categories.windowManagement",
    "Virtual Desktops (Win)": "presets.categories.virtualDesktops",
    "General (Windows)": "presets.categories.generalWindows",
    "Screenshots": "presets.categories.screenshots",
    "Browser / Tabs": "presets.categories.browserTabs",
    "Task Management": "presets.categories.taskManagement",
    "System Tools": "presets.categories.systemTools",
    "Audio Control (Requires NirCmd)": "presets.categories.mediaControls"
};

function getPresetCategoryName(category) {
    const key = PRESET_CATEGORY_KEYS[category];
    if (key) {
        const translated = t(key);
        return translated !== key ? translated : category;
    }
    return category;
}

// UPDATED: Preset Actions List
const PRESET_ACTIONS = {
    "--- Select Preset ---": "",
    "Discord Voice & Calls": {
        "Answer Call (Odbierz)": "CTRL+ALT+A",
        "Decline Call (Odrzuć)": "CTRL+ALT+D",
        "Toggle Mute (Wycisz mikrofon)": "CTRL+SHIFT+M",
        "Toggle Deafen (Wycisz dźwięk/ogłusz)": "CTRL+SHIFT+D",
        "Disconnect Voice (Rozłącz)": "CTRL+SHIFT+E",
        "Toggle Push-to-Talk": "CTRL+SHIFT+P"
    },
    "Spotify & Media Controls": {
        "Play / Pause": "AUDIO_PLAY",
        "Next Track": "AUDIO_NEXT",
        "Previous Track": "AUDIO_PREV",
        "Volume Up": "AUDIO_VOL_UP",
        "Volume Down": "AUDIO_VOL_DOWN",
        "Mute Audio": "AUDIO_MUTE",
        "Like Current Song": "ALT+SHIFT+B",
        "Toggle Shuffle": "CTRL+S",
        "Toggle Repeat": "CTRL+R"
    },
    "OBS Studio & Streaming": {
        "OBS: Start / Stop Stream": "CTRL+F9",
        "OBS: Start / Stop Recording": "CTRL+F10",
        "OBS: Save Replay Buffer": "CTRL+F11",
        "OBS: Mute Microphone": "CTRL+SHIFT+F12"
    },
    "Gaming & Tools": {
        "Game Bar: Record That (30s)": "GUI+ALT+G",
        "Game Bar: Open Overlay": "GUI+G",
        "Snip & Sketch (Screenshot)": "GUI+SHIFT+S",
        "Screenshot to Clipboard": "PRINT_SCREEN",
        "Task Manager": "CTRL+SHIFT+ESC"
    },
    "Editing": {
        "Cut": "CTRL+X",
        "Copy": "CTRL+C",
        "Paste": "CTRL+V",
        "Undo": "CTRL+Z",
        "Redo": "CTRL+Y",
        "Save": "CTRL+S",
        "Find": "CTRL+F",
        "Select All": "CTRL+A",
        "Print": "CTRL+P"
    },
    "Window Management": {
        "Switch App (Forward)": "ALT+TAB",
        "Switch App (Backward)": "ALT+SHIFT+TAB",
        "Snap Window Left": "GUI+LEFT",
        "Snap Window Right": "GUI+RIGHT",
        "Minimize Window": "GUI+DOWN",
        "Maximize Window": "GUI+UP",
        "Minimize all Windows": "GUI+M",
        "Restore all Windows": "GUI+SHIFT+M"
    },
    "Virtual Desktops (Win)": {
        "New Desktop": "CTRL+GUI+D",
        "Switch to Next Desktop": "CTRL+GUI+RIGHT",
        "Switch to Prev Desktop": "CTRL+GUI+LEFT",
        "Close Current Desktop": "CTRL+GUI+F4"
    },
    "General (Windows)": {
        "Open File Explorer": "GUI+E",
        "Open Settings": "GUI+I",
        "Open Run dialog": "GUI+R",
        "Open Task Manager": "CTRL+SHIFT+ESC",
        "Emoji Picker": "GUI+.",
        "Clipboard History": "GUI+V",
        "Connect (Project) Menu": "GUI+K"
    },
    "Browser / Tabs": {
        "New Tab": "CTRL+T",
        "Close Tab": "CTRL+W",
        "Re-open Closed Tab": "CTRL+SHIFT+T",
        "Next Tab": "CTRL+TAB",
        "Previous Tab": "CTRL+SHIFT+TAB",
        "New Window": "CTRL+N"
    }
};

// UPDATED: Preset Scripts List
const PRESET_SCRIPTS = {
    "--- Select Preset Script ---": "",
    "Discord Control (NirCmd)": {
        "Mute Discord Audio": "nircmd.exe muteappvolume discord.exe 2",
        "Unmute Discord Audio": "nircmd.exe setappvolume discord.exe 1",
        "Kill Discord (Force)": "taskkill /f /im Discord.exe"
    },
    "Spotify Control (NirCmd)": {
        "Mute Spotify Audio": "nircmd.exe muteappvolume spotify.exe 2",
        "Unmute Spotify Audio": "nircmd.exe setappvolume spotify.exe 1",
        "Kill Spotify (Force)": "taskkill /f /im Spotify.exe"
    },
    "Microphone Control (NirCmd)": {
        "Toggle System Mic Mute": "nircmd.exe mutesysvolume 2 microphone",
        "Mute System Mic": "nircmd.exe mutesysvolume 1 microphone",
        "Unmute System Mic": "nircmd.exe mutesysvolume 0 microphone"
    },
    "Task Management": {
        "Kill Chrome": "taskkill /f /im chrome.exe",
        "Kill Spotify": "taskkill /f /im Spotify.exe",
        "Kill Teams": "taskkill /f /im msteams.exe",
        "Kill Discord": "taskkill /f /im Discord.exe",
        "Open Task Manager": "taskmgr"
    },
    "System Tools": {
        "Open Notepad": "notepad",
        "Open Calculator": "calc",
        "Open Control Panel": "control",
        "Open Command Prompt": "cmd",
        "Open Explorer": "explorer",
        "Open Snipping Tool": "snippingtool"
    },
    "System Audio (NirCmd)": {
        "Mute System": "nircmd.exe mutesysvolume 1",
        "Unmute System": "nircmd.exe mutesysvolume 0",
        "Toggle Mute System": "nircmd.exe mutesysvolume 2",
        "Volume Up (+10%)": "nircmd.exe changesysvolume 6553",
        "Volume Down (-10%)": "nircmd.exe changesysvolume -6553",
        "Set System Volume to 50%": "nircmd.exe setsysvolume 32768"
    },
    "App Audio (NirCmd)": {
        "Mute Chrome": "nircmd.exe setappvolume chrome.exe 0",
        "Unmute Chrome": "nircmd.exe setappvolume chrome.exe 1",
        "Toggle Mute Chrome": "nircmd.exe muteappvolume chrome.exe 2",
        "Mute Spotify": "nircmd.exe setappvolume spotify.exe 0",
        "Unmute Spotify": "nircmd.exe setappvolume spotify.exe 1",
        "Mute Discord": "nircmd.exe setappvolume discord.exe 0",
        "Unmute Discord": "nircmd.exe setappvolume discord.exe 1"
    },
    "Power Options": {
        "Sleep": "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
        "Restart PC (Force)": "shutdown /r /f /t 0",
        "Shutdown PC (Force)": "shutdown /s /f /t 0",
        "Lock Screen": "rundll32.exe user32.dll,LockWorkStation"
    }
};

// ... (kodun geri kalanı)

// ... (kodun geri kalanı)


// ... (kodun geri kalanı)

// ... (kodun geri kalanı)

// We can keep ICON_MAP only for very special cases or caching but
// let it stay as an empty Map for now so old codes don't break.
let ICON_MAP = new Map();
// ...
let availableSerialPorts = []; // This line already exists

// Global değişkenler dosyanın başında tanımlı (connectedSerialPort, portReader, vb.)

let scanRetryTimer = null; // Must be defined in global scope

// Icon sets that should remain colored (won't be painted white)
const COLORED_ICON_SETS = [
    'logos', 'noto', 'twemoji', 'emojione', 'flat-color-icons',
    'vscode-icons', 'circle-flags', 'openmoji', 'fxemoji', 'skill-icons',
    'devicon', 'devicon-plain', 'skill-icons', 'logos', 'streamline-color', 'material-icon-theme'// NEW ONES ADDED
];

/**
 * Shows a custom, theme-compliant confirmation window.
 * @param {string} message - Main message to show to the user.
 * @param {string} [title='Confirmation'] - Window title.
 * @param {string} [okText='OK'] - Confirmation button text.
 * @param {string} [cancelText='Cancel'] - Cancel button text.
 * @returns {Promise<boolean>} - Returns true if user clicks 'OK', false if 'Cancel'.
 */
function showCustomConfirm(message, title = 'Onay', okText = 'OK', cancelText = 'İptal') {
    return new Promise((resolve) => {
        const dialog = el('#customConfirm');
        const titleEl = el('#confirmTitle');
        const messageEl = el('#confirmMessage');
        const okBtn = el('#confirmOkBtn');
        const cancelBtn = el('#confirmCancelBtn');

        // Set texts
        titleEl.textContent = title;
        // Convert \n (newline) characters in message to <br> tags
        messageEl.innerHTML = message.replace(/\n/g, '<br>');
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;

        // Determine what happens when buttons are clicked
        // Clone and replace to clear previous listeners (safer)
        const newOkBtn = okBtn.cloneNode(true);
        const newCancelBtn = cancelBtn.cloneNode(true);
        okBtn.parentNode.replaceChild(newOkBtn, okBtn);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

        // Assign new listeners
        newOkBtn.onclick = () => {
            dialog.close();
            resolve(true); // Confirmed
        };

        newCancelBtn.onclick = () => {
            dialog.close();
            resolve(false); // Cancelled
        };

        // Count closing with 'Escape' key as 'cancel' too
        dialog.onclose = () => resolve(false);

        // Show window
        dialog.showModal();
    });
}
function executeButtonAction(pageIdx, btnIdx) {
    if (!cfg || !cfg.pages[pageIdx]) return;
    const btn = cfg.pages[pageIdx][btnIdx];
    if (!btn) return;

    if (!window.electronAPI) {
        console.error("ElectronAPI is not available!");
        return;
    }

    // --- TOGGLE BUTTON ---
    if (btn.type === 'toggle') {
        const currentState = btn.toggleState || false;
        const tData = btn.toggleData || {};

        // 1. Play Sound
        if (tData.useSound) {
            const soundUrl = getToggleSoundPath();
            const audio = new Audio(soundUrl);
            audio.volume = 0.5;
            audio.play().catch(e => console.error("Switch sound error:", e));
        }

        // 2. Execute Command
        let actionToRun = '';
        if (currentState) { // If state is ON, run OFF (onCombo) command
            actionToRun = tData.onCombo;
        } else { // If state is OFF, run ON (offCombo) command
            actionToRun = tData.offCombo;
        }

        if (actionToRun) {
            const cmd = actionToRun.trim();
            // Is it a command containing Nircmd or .exe, or a keyboard shortcut?
            const isScript = cmd.toLowerCase().includes("nircmd") || cmd.toLowerCase().includes(".exe") || (cmd.includes(" ") && !cmd.includes("+"));

            if (isScript) {
                // --- FIX: runCommand USED ---
                const nircmdPath = `"${ASSETS_PATH}/nircmd.exe"`;
                let finalCmd = cmd.replace(/nircmd(\.exe)?/gi, nircmdPath);

                if (window.electronAPI.system && window.electronAPI.system.runCommand) {
                    window.electronAPI.system.runCommand(finalCmd)
                        .catch(err => {
                            console.error("Toggle Script Exec Error:", err);
                        });
                }
                // --- FIX END ---
            } else {
                // This is a keyboard shortcut (e.g. "AUDIO_PLAY")
                parseAndExecuteKeyCombo(cmd);
            }
        }

        // 3. Change State
        btn.toggleState = !currentState;
        updateButtonVisuals(btnIdx); // Refresh only this button
        saveConfig(false);
    }

    // --- SOUND (SOUND EFFECT) ---
    else if (btn.type === 'sound' && btn.soundPath) {
        let fileUrl = btn.soundPath.replace(/\\/g, '/');
        if (!fileUrl.startsWith('file:') && !fileUrl.startsWith('http')) {
            fileUrl = 'file:///' + fileUrl;
        }
        try {
            const audio = new Audio(fileUrl);
            const vol = (btn.soundVolume !== undefined ? btn.soundVolume : 100) / 100;
            audio.volume = Math.min(Math.max(vol, 0), 1);
            audio.play().catch(e => console.error("Audio playback failed:", e));
        } catch (e) { console.error("Error creating Audio object:", e); }
    }

    // --- APP LAUNCH ---
    else if (btn.type === 'app' && btn.appPath) {
        if (window.electronAPI.shell) {
            window.electronAPI.shell.openPath(btn.appPath);
        }
    }

    // --- HOTKEY ---
    else if (btn.type === 'key' && btn.combo) {
        parseAndExecuteKeyCombo(btn.combo);
    }

    // --- GOTO PAGE / FOLDER ---
    else if (btn.type === 'goto' || btn.type === 'folder') {
        if (btn.gotoPage !== undefined && btn.gotoPage >= 0 && btn.gotoPage < cfg.pageCount) {
            currentPage = btn.gotoPage;
            drawGrid();
            renderPageBar();
            saveConfig(false);
            if (connectedSerialPort) {
                deviceCurrentPage = btn.gotoPage;
                sendSerialCommand(`SET_PAGE:${btn.gotoPage}`);
            }
        }
    }

    // --- SCRIPT ---
    else if (btn.type === 'script' && btn.customScript) {
        let cmd = btn.customScript.trim();

        // --- FIX: NIRCMD PATH ADDED ---
        // If Nircmd is used, correct its path to assets folder
        if (cmd.toLowerCase().includes("nircmd")) {
            const nircmdPath = `"${ASSETS_PATH}/nircmd.exe"`;
            cmd = cmd.replace(/nircmd(\.exe)?/gi, nircmdPath);
        }
        // --- FIX END ---

        // Run via main.js
        if (window.electronAPI.system && window.electronAPI.system.runCommand) {
            window.electronAPI.system.runCommand(cmd)
                .then(res => {
                    if (res && res.success === false) {
                        console.warn("Script run error:", res.error);
                    }
                })
                .catch(err => {
                    console.error("Script Exec Error:", err);
                });
        }
    }


    // --- WEBSITE ---
    else if (btn.type === 'website' && btn.websiteUrl) {
        let url = btn.websiteUrl;
        if (!url.startsWith('http://') && !url.startsWith('https://')) { url = 'http://' + url; }
        if (window.electronAPI.shell) { window.electronAPI.shell.openPath(url); }
    }

    // --- COUNTER ---
    else if (btn.type === 'counter') {
        const startVal = btn.counterStartValue || 0;
        const action = btn.counterAction || 'increment';
        const command = `COUNTER:${pageIdx}:${btnIdx}:${startVal}:${action}\n`;
        if (connectedSerialPort) { sendData(connectedSerialPort, command); }
        else { showCustomAlert(t('alerts.counterNotConnected'), t('alerts.connectionError')); }
    }

    // --- MEDIA ---
    else if (btn.type === 'media' && btn.mediaAction) {
        const mediaKeyMap = { 'play_pause': 'audio_play', 'next_track': 'audio_next', 'prev_track': 'audio_prev', 'vol_up': 'audio_vol_up', 'vol_down': 'audio_vol_down', 'mute': 'audio_mute' };
        const robotKey = mediaKeyMap[btn.mediaAction];
        if (robotKey) {
            window.electronAPI.robot.keyTap(robotKey).catch(err => console.error("Error sending media key:", err.message));
        }
    }

    // --- TEXT ---
    else if (btn.type === 'text') {
        if (btn.textSimulateTyping) {
            window.electronAPI.robot.typeStringSimulated(btn.textMacro).catch(err => console.error("Error sending simulated text:", err.message));
        } else {
            window.electronAPI.robot.typeString(btn.textMacro).catch(err => console.error("Error sending text macro:", err.message));
        }
    }

    // --- MOUSE ---
    else if (btn.type === 'mouse' && btn.mouseConfig) {
        const mCfg = btn.mouseConfig;
        const btnKey = mCfg.button || 'left';
        try {
            if (mCfg.event === 'click') {
                window.electronAPI.robot.mouseMove(mCfg.x1, mCfg.y1);
                window.electronAPI.robot.mouseClick(btnKey, false);
            } else if (mCfg.event === 'double_click') {
                window.electronAPI.robot.mouseMove(mCfg.x1, mCfg.y1);
                window.electronAPI.robot.mouseClick(btnKey, true);
            } else if (mCfg.event === 'move') {
                window.electronAPI.robot.mouseMove(mCfg.x1, mCfg.y1);
            } else if (mCfg.event === 'drag') {
                window.electronAPI.robot.mouseMove(mCfg.x1, mCfg.y1);
                window.electronAPI.robot.mouseToggle('down', btnKey);
                window.electronAPI.robot.mouseMove(mCfg.x2, mCfg.y2);
                window.electronAPI.robot.mouseToggle('up', btnKey);
            }
        } catch (e) {
            console.error("RobotJS Mouse Error:", e.message);
            showCustomAlert(t('alerts.mouseError') + `\n${e.message}`, t('alerts.robotError'));
        }
    }
    
    // --- MULTI-ACTION ---
    else if (btn.type === 'multi' && btn.multiActions && btn.multiActions.length > 0) {
        executeMultiActions(btn.multiActions);
    }
}

// ============================================
// SERIAL MESSAGE HANDLER
// ============================================
function handleSerialMessage(line) {
    if (!line || line.length === 0) return;
    
    // Debug log panel
    if (cfg?.developerMode) addSerialLog('IN', line);

    // --- 1. BUTTON CLICK ---
    if (line.startsWith('BTN:')) {
        const parts = line.split(':');
        if (parts.length >= 3) {
            const pageIdx = parseInt(parts[1]);
            const btnIdx = parseInt(parts[2]);

            if (parts.length === 4) {
                const deviceState = parseInt(parts[3]) === 1;
                if (cfg.pages[pageIdx] && cfg.pages[pageIdx][btnIdx]) {
                    const btn = cfg.pages[pageIdx][btnIdx];
                    if (btn.type === 'toggle') {
                        if (btn.toggleState === deviceState) {
                            btn.toggleState = !deviceState;
                            updateButtonVisuals(btnIdx);
                        }
                    }
                }
            }
            executeButtonAction(pageIdx, btnIdx);
        }
    }
    // --- KNOB RAW ANGLE ---
    else if (line.startsWith('KNOB_RAW:')) {
        const rawAngle = parseInt(line.substring(9).trim());
        if (!isNaN(rawAngle)) {
            handleKnobRaw(rawAngle);
        }
    }
    // --- 2. TIMER FINISHED (TIMER_DONE) ---
    else if (line.startsWith('TIMER_DONE:')) {
        const parts = line.split(':');
        if (parts.length === 3) {
            const pageIdx = parseInt(parts[1]);
            const btnIdx = parseInt(parts[2]);
            const timerKey = `${pageIdx}_${btnIdx}`;
            
            // Background checker zaten notification gönderdiyse tekrar gönderme
            if (timerNotificationSent[timerKey]) {
                console.log(`[Timer] TIMER_DONE received but notification already sent for ${timerKey}`);
                return;
            }
            
            // Mark as sent to prevent background checker and future TIMER_DONE
            timerNotificationSent[timerKey] = true;

            const btn = cfg.pages[pageIdx]?.[btnIdx];
            const label = btn?.originalLabel || btn?.label || `Button ${btnIdx + 1}`;
            const title = `Timer Finished`;
            const body = `Your timer "${label}" is complete.`;

            // Sound
            try {
                const notifUrl = getNotificationSoundPath();
                if (notifUrl) {
                    const audio = new Audio(notifUrl);
                    audio.volume = 0.8;
                    audio.play().catch(e => console.error("Notification playback failed:", e));
                }
            } catch (e) {
                console.error("Error playing notification sound:", e);
            }

            if (window.electronAPI && window.electronAPI.showNotification) {
                window.electronAPI.showNotification(title, body);
            }
            
            // DON'T delete flags here - wait for timer reset (state === 2)
        }
    }
    // --- 3. TIMER UPDATE ---
    else if (line.startsWith('TIMER_UPDATE:')) {
        const parts = line.split(':');
        const pIdx = parseInt(parts[1]);
        const bIdx = parseInt(parts[2]);
        const state = parseInt(parts[3]);
        const remSec = parseInt(parts[4]);
        handlePcTimer(pIdx, bIdx, state, remSec);
    }
    else if (line.startsWith('TIMER_DONE')) {
        try {
            AudioHaptic.click();
            if (window.electronAPI && window.electronAPI.invoke) {
                window.electronAPI.invoke('app:showNotification', {
                    title: 'SmartDeck Studio - Timer',
                    body: 'Czas sesji minął! Odliczanie zakończone.'
                });
            }
            showToast('⏱️ Timer zakończony!', 'success');
        } catch (e) {
            console.error('Error handling TIMER_DONE:', e);
        }
    }
    // --- 4. COUNTER UPDATE ---
    else if (line.startsWith('COUNTER_UPDATE:')) {
        const parts = line.split(':');
        if (parts.length === 4) {
            const pIdx = parseInt(parts[1]);
            const bIdx = parseInt(parts[2]);
            const newVal = parseInt(parts[3]);
            if (currentPage === pIdx) {
                handlePcCounter(bIdx, newVal);
            }
        }
    }
    // --- 5. CONNECTION (Handshake) ---
    else if (line.startsWith('PONG_DECK:')) {
        const deviceName = line.substring(10);
        connectedDeviceName = deviceName;
        connectionState = ConnectionState.CONNECTED;
        
        // Update UI
        updateConnectionUI(true, deviceName);
    }
    // --- 6. PAGE CHANGE ---
    else if (line.startsWith('PAGE_CHANGED:')) {
        const espPage = parseInt(line.split(':')[1]);
        if (!isNaN(espPage) && espPage >= 0) {
            deviceCurrentPage = espPage;
            if (currentPage !== espPage && espPage < cfg.pageCount) {
                currentPage = espPage;
                drawGrid();
                renderPageBar();
                saveConfig(false);
            }
            sendKnobSettingsForPage(deviceCurrentPage);
            const newSettings = getKnobPageSettings(deviceCurrentPage);
            updateKnobLeds(knobRotationAngle, newSettings.ledColor, newSettings.tailLength);
            updateKnobInfoText(deviceCurrentPage);
        }
    }
    // --- SYNC_PAGE ---
    else if (line.startsWith('SYNC_PAGE:')) {
        const p = parseInt(line.split(':')[1]);
        if (!isNaN(p) && p >= 0) {
            deviceCurrentPage = p;
            if (currentPage !== p && p < cfg.pageCount) {
                currentPage = p;
                drawGrid();
                renderPageBar();
                saveConfig(false);
            }
            sendKnobSettingsForPage(p);
            const syncedSettings = getKnobPageSettings(deviceCurrentPage);
            updateKnobLeds(knobRotationAngle, syncedSettings.ledColor, syncedSettings.tailLength);
            updateKnobInfoText(deviceCurrentPage);
        }
    }
    // --- SYNC_STATE ---
    else if (line.startsWith('SYNC_STATE:')) {
        const parts = line.split(':');
        const btnIdx = parseInt(parts[1]);
        const stateVal = parseInt(parts[2]);

        if (!isNaN(btnIdx) && !isNaN(stateVal) && cfg.pages[currentPage]) {
            const btn = cfg.pages[currentPage][btnIdx];
            if (btn && btn.type === 'toggle') {
                const newState = (stateVal === 1);
                if (btn.toggleState !== newState) {
                    btn.toggleState = newState;
                    updateButtonVisuals(btnIdx);
                    saveConfig(false);
                }
            }
        }
    }
    // --- GET_TIME ---
    else if (line === 'GET_TIME') {
        syncTimeWithDevice();
    }
    // --- CONFIG DUMP ---
    else if (line === 'CONFIG_START') {
        if (window.configDumpCapture) {
            window.configDumpCapture.started = true;
            window.configDumpCapture.data = '';
        }
    }
    else if (line === 'CONFIG_END') {
        if (window.configDumpCapture && window.configDumpCapture.started) {
            showConfigDumpDialog(window.configDumpCapture.data);
            window.configDumpCapture = null;
        }
    }
    else if (line.startsWith('CONFIG_ERROR:')) {
        if (window.configDumpCapture) {
            showToast('Failed to read config: ' + line.substring(13), 'error');
            window.configDumpCapture = null;
        }
    }
    else if (window.configDumpCapture && window.configDumpCapture.started) {
        window.configDumpCapture.data += line;
    }
}

// ============================================
// SERIAL LISTENER
// ============================================
async function startSerialListener(port) {
    if (!port || !port.readable) return;
    if (isListening) return;
    
    console.log('[Serial] Starting listener...');
    isListening = true;
    
    // Sync settings after 1 second
    setTimeout(() => {
        syncTimeWithDevice();
        syncSleepSettingsWithDevice();
        sendSerialCommand("GET_SYNC");
        
        // Start weather auto-refresh (sends weather immediately if enabled)
        startWeatherAutoRefresh();
    }, 1000);
    
    let disconnectedDuringRead = false;
    
    try {
        // Get reader directly (no pipe)
        portReader = port.readable.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (isListening && portReader) {
            try {
                const { value, done } = await portReader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.trim()) {
                        handleSerialMessage(line.trim());
                    }
                }
            } catch (e) {
                // USB disconnected or other fatal error
                if (e.message.includes('disconnected') || 
                    e.message.includes('device has been lost') ||
                    e.message.includes('The device has been lost')) {
                    console.log('[Serial] Device disconnected during read');
                    disconnectedDuringRead = true;
                    break;
                }
                if (e.message.includes('cancelled') || e.message.includes('closed')) {
                    break;
                }
                console.warn('[Serial] Read error:', e.message);
                disconnectedDuringRead = true;
                break;
            }
        }
    } catch (e) {
        console.error('[Serial] Listener error:', e.message);
        disconnectedDuringRead = true;
    } finally {
        isListening = false;
        portReader = null;
        console.log('[Serial] Listener stopped');
        
        // Eğer okuma sırasında disconnect olduysa, state'i temizle ve auto-connect başlat
        if (disconnectedDuringRead && connectedSerialPort) {
            console.log('[Serial] Triggering disconnect due to read failure');
            connectedSerialPort = null;
            connectedDeviceName = '';
            connectionState = ConnectionState.DISCONNECTED;
            handleDisconnectUI('Disconnected', 'Connection lost');
            startAutoConnect();
        }
    }
}

// UPDATED: Changes 'Connect' Button Text
async function connectSerial() {
    if (connectedSerialPort) {
        console.warn("Already connected.");
        return;
    }

    const selectEl = el('#serialPortSelect');
    const connectBtn = el('#connectSerialBtn');
    const disconnectBtn = el('#disconnectSerialBtn');
    // const statusEl = el('#connectStatus'); // NO LONGER USED
    const selectedIndex = parseInt(selectEl.value);

    if (isNaN(selectedIndex) || !availableSerialPorts[selectedIndex]) {
        // Instead of showing error message, make button 'Error' for 1 second
        const originalText = connectBtn.textContent;
        connectBtn.textContent = t('connection.selectPort');
        connectBtn.classList.add('danger');
        setTimeout(() => {
            connectBtn.textContent = originalText;
            connectBtn.classList.remove('danger');
        }, 1500);
        return;
    }

    try {
        const port = availableSerialPorts[selectedIndex];
        // statusEl.textContent = 'Connecting...'; // NO LONGER USED
        connectBtn.textContent = t('connection.connecting'); // NEW
        // statusEl.className = 'upload-status-message'; // NO LONGER USED
        connectBtn.disabled = true;

        await port.open({ baudRate: 115200 });
        connectedSerialPort = port;
        lastKnobRawAngle = null;
        knobActionAccumulator = 0;
        // Save port info for auto-reconnect
        lastConnectedPortInfo = port.getInfo();

        // statusEl.textContent = 'Connected. Identifying device...'; // NO LONGER USED
        // statusEl.classList.add('success'); // NO LONGER USED
        connectBtn.textContent = t('connection.identifying'); // NEW
        connectBtn.style.display = 'none';
        disconnectBtn.style.display = 'block';

        startSerialListener(port);

        const writer = port.writable.getWriter();
        await writer.write(new TextEncoder().encode("PING_DECK\n"));
        writer.releaseLock();

    } catch (e) {
        console.error(`Failed to open port: ${e.message}`);

        // Better error messages based on error type
        let errorMsg = t('alerts.connectionError');
        let toastMsg = t('alerts.connectionError');

        if (e.message.includes('already open') || e.message.includes('in use')) {
            errorMsg = t('connection.portBusy');
            toastMsg = t('connection.portBusy');
        } else if (e.message.includes('access denied') || e.message.includes('Access denied')) {
            errorMsg = t('connection.accessDenied');
            toastMsg = t('connection.accessDenied');
        } else if (e.message.includes('not found')) {
            errorMsg = t('connection.notFound');
            toastMsg = t('connection.notFound');
        }

        showToast(toastMsg, 'error', 5000);

        connectBtn.textContent = errorMsg;
        connectBtn.classList.add('danger');
        connectBtn.disabled = false;

        setTimeout(() => {
            connectBtn.textContent = t('connection.connect');
            connectBtn.classList.remove('danger');
        }, 2000);
    }
}

// UPDATED: Changes 'Connect' Button Text
async function disconnectSerial(intentional = true) {
    console.log('[Serial] Disconnecting...');
    
    // Stop listener
    isListening = false;
    
    // Release reader
    if (portReader) {
        try {
            await portReader.cancel();
            portReader.releaseLock();
        } catch (e) {}
        portReader = null;
    }
    
    // Close port
    if (connectedSerialPort) {
        try {
            if (connectedSerialPort.readable && !connectedSerialPort.readable.locked) {
                await connectedSerialPort.close();
            }
        } catch (e) {
            console.warn('[Serial] Close error:', e.message);
        }
    }
    
    // Reset state
    connectedSerialPort = null;
    connectedDeviceName = '';
    connectionState = ConnectionState.DISCONNECTED;
    
    // Update UI
    handleDisconnectUI('Disconnected', intentional ? 'Manual disconnect' : 'Connection lost');
    
    // Restart auto-connect if not intentional
    if (!intentional) {
        startAutoConnect();
    }
}

// Force disconnect - USB çıkarıldığında kullanılır
function forceDisconnect() {
    console.log('[Serial] Force disconnecting...');
    
    // Stop listener immediately
    isListening = false;
    
    // Don't try to cancel/release - port is already gone
    portReader = null;
    
    // Reset state
    connectedSerialPort = null;
    connectedDeviceName = '';
    connectionState = ConnectionState.DISCONNECTED;
    
    // Update UI
    handleDisconnectUI('Disconnected', 'USB disconnected');
    
    // Start auto-connect to find device when plugged back
    startAutoConnect();
}

// === AUTO-RECONNECT ===
async function attemptAutoReconnect() {
    if (!connectedSerialPort) {
        startAutoConnect();
    }
}

// --- NEW: Listing Installed Apps (Windows Only) ---
let cachedAppList = [];
let isAppListLoading = false;
async function loadInstalledApps() {
    if (!navigator.platform.toLowerCase().includes('win')) return;
    if (cachedAppList.length > 0 || isAppListLoading) return;

    const selectEl = el('#appQuickSelect');
    if (!selectEl) return;

    // SECURITY CHECK: Is there a new API?
    if (!window.electronAPI || !window.electronAPI.system) {
        console.error("API Error: electronAPI.system missing.");
        return;
    }

    isAppListLoading = true;
    selectEl.innerHTML = '<option>Loading apps...</option>';

    try {
        // --- NEW METHOD: Request from Main process ---
        let apps = await window.electronAPI.system.scanInstalledApps();

        cachedAppList = apps.filter(app => app.P && app.N);
        selectEl.innerHTML = '<option value="">Select app...</option>';
        cachedAppList.forEach(app => {
            const o = document.createElement('option');
            o.value = app.P;
            o.textContent = app.N;
            selectEl.appendChild(o);
        });
    } catch (e) {
        console.error("App scan failed:", e);
        selectEl.innerHTML = '<option value="">Error loading apps</option>';
    } finally {
        isAppListLoading = false;
    }
}


// --- UI Update When Connected to Device ---
async function connectToDevice(port) {
    console.log('[Serial] Connecting to device...');
    
    try {
        // Open port if not open
        if (!port.readable) {
            await port.open({ baudRate: 115200 });
        }
        
        // Wait for boot
        await new Promise(r => setTimeout(r, 500));
        
        // Send PING
        const writer = port.writable.getWriter();
        await writer.write(new TextEncoder().encode("PING_DECK\n"));
        writer.releaseLock();
        
        // Wait for PONG
        const pongReceived = await waitForPong(port, 1500);
        
        if (pongReceived) {
            connectedSerialPort = port;
            lastConnectedPortInfo = port.getInfo();
            connectionState = ConnectionState.CONNECTED;
            isAutoConnected = true;
            
            // Start listening
            startSerialListener(port);
            updateConnectionUI(true, connectedDeviceName);
            
            // Start active window monitoring
            startActiveWindowMonitoring();
            
            // Start weather auto-refresh
            startWeatherAutoRefresh();
            
            // ESP hazır, bekleyen komutları gönder
            isEspReady = true;
            flushPendingCommands();
            
            return true;
        } else {
            await safeClosePort(port);
            return false;
        }
    } catch (e) {
        console.error('[Serial] Connect error:', e.message);
        try { await port.close(); } catch (x) {}
        return false;
    }
}

// === ACTIVE WINDOW MONITORING SYSTEM ===
// Monitors the active window and automatically switches ESP32 page
// when a monitored application gets focus

function matchAppProcess(activeProcess, activePath, configuredApp, activeTitle) {
    if (!configuredApp) return false;

    const confLower = configuredApp.toLowerCase().replace(/\\/g, '/');
    const procLower = (activeProcess || '').toLowerCase().replace(/\\/g, '/');
    const pathLower = (activePath || '').toLowerCase().replace(/\\/g, '/');
    const titleLower = (activeTitle || '').toLowerCase();

    // 1. Direct keywords / directory matches for common apps (Discord, Spotify, etc.)
    const knownApps = ['discord', 'spotify', 'chrome', 'firefox', 'msedge', 'code', 'obs64', 'obs32', 'steam', 'photoshop', 'premiere'];
    for (const app of knownApps) {
        if (confLower.includes(app)) {
            if (procLower.includes(app) || pathLower.includes(app) || titleLower.includes(app)) {
                return true;
            }
        }
    }

    // 2. Resolve Squirrel installer (Update.exe) if present in configuredApp
    let cleanConfig = confLower.split('/').pop().replace(/\.exe$/i, '').trim();
    if (cleanConfig === 'update') {
        const parts = confLower.split('/').filter(p => p && p !== 'update.exe');
        if (parts.length > 0) {
            cleanConfig = parts[parts.length - 1]; // e.g. "discord" from ".../discord/update.exe"
        }
    }

    const cleanProc = procLower.split('/').pop().replace(/\.exe$/i, '').trim();
    const cleanPath = pathLower.split('/').pop().replace(/\.exe$/i, '').trim();

    if (!cleanConfig) return false;

    // 3. Direct match
    if (cleanProc === cleanConfig || cleanPath === cleanConfig) return true;

    // 4. Substring containment
    if (cleanProc && (cleanProc.includes(cleanConfig) || cleanConfig.includes(cleanProc))) return true;
    if (cleanPath && (cleanPath.includes(cleanConfig) || cleanConfig.includes(cleanPath))) return true;

    // 5. Window title check
    if (cleanConfig.length >= 3 && titleLower.includes(cleanConfig)) return true;

    return false;
}

/**
 * Start monitoring the active window for auto page switching
 */
function startActiveWindowMonitoring() {
    if (activeWindowMonitorInterval) return;

    if (!window.electronAPI || !window.electronAPI.system || !window.electronAPI.system.getActiveWindowInfo) {
        console.warn("[ActiveWindow] API not available for window monitoring");
        return;
    }

    console.log("[ActiveWindow] Monitoring started");

    activeWindowMonitorInterval = setInterval(async () => {
        if (!cfg.pageApps || Object.keys(cfg.pageApps).length === 0) {
            return;
        }

        try {
            const windowInfo = await window.electronAPI.system.getActiveWindowInfo();
            if (!windowInfo || !windowInfo.success || (!windowInfo.process && !windowInfo.title)) {
                return;
            }

            const currentProcess = (windowInfo.process || '').toLowerCase();
            const currentProcessPath = (windowInfo.processPath || '').toLowerCase();

            // Ignore Smart Deck itself
            const cleanProc = currentProcess.split('\\').pop().split('/').pop().replace(/\.exe$/i, '').trim();
            if (cleanProc === 'smart deck' || cleanProc === 'smartdeck' || cleanProc === 'electron') {
                return;
            }

            const procKey = currentProcessPath || currentProcess;
            if (procKey === lastActiveProcessName) return;
            lastActiveProcessName = procKey;

            console.log("[ActiveWindow] Process changed:", currentProcess, "Path:", currentProcessPath);

            let matched = false;
            // Find matching page for this process
            for (const [pageIndexStr, appPath] of Object.entries(cfg.pageApps)) {
                if (!appPath) continue;

                const pageIndex = parseInt(pageIndexStr);
                const autoFocusEnabled = !cfg.pageAutoFocus || cfg.pageAutoFocus[pageIndex] !== false;
                if (!autoFocusEnabled) {
                    continue;
                }

                if (matchAppProcess(currentProcess, currentProcessPath, appPath, windowInfo.title)) {
                    matched = true;
                    const targetPage = pageIndex;
                    console.log(`[ActiveWindow] Matched page ${targetPage} for app ${appPath}`);

                    // 1. Switch UI page in desktop app
                    if (currentPage !== targetPage && targetPage >= 0 && targetPage < cfg.pageCount) {
                        currentPage = targetPage;
                        drawGrid();
                        renderPageBar();
                        saveConfig(false);
                    }

                    // 2. Switch physical device page via Serial if connected
                    if (connectedSerialPort && deviceCurrentPage !== targetPage && targetPage >= 0 && targetPage < cfg.pageCount) {
                        deviceCurrentPage = targetPage;
                        console.log(`[ActiveWindow] Sending SET_PAGE:${targetPage}`);
                        sendSerialCommand(`SET_PAGE:${targetPage}`);
                    }
                    break;
                }
            }

            // Auto-revert to Panel 1 (Page 0) when unmapped window is active (e.g. app closed, minimized, desktop focused)
            if (!matched) {
                const shouldRevert = cfg.appSettings?.autoRevertPage !== false;
                if (shouldRevert) {
                    const defaultPage = 0; // Panel 1 (0-indexed)
                    if (currentPage !== defaultPage && defaultPage < cfg.pageCount) {
                        console.log(`[ActiveWindow] Unmapped window (${currentProcess}), reverting to Panel 1`);
                        currentPage = defaultPage;
                        drawGrid();
                        renderPageBar();
                        saveConfig(false);
                    }
                    if (connectedSerialPort && deviceCurrentPage !== defaultPage && defaultPage < cfg.pageCount) {
                        deviceCurrentPage = defaultPage;
                        console.log(`[ActiveWindow] Sending SET_PAGE:${defaultPage} (revert)`);
                        sendSerialCommand(`SET_PAGE:${defaultPage}`);
                    }
                }
            }
        } catch (e) {
            console.warn("[ActiveWindow] Check error:", e.message);
        }
    }, ACTIVE_WINDOW_CHECK_INTERVAL);
}

/**
 * Stop monitoring the active window
 */
function stopActiveWindowMonitoring() {
    if (activeWindowMonitorInterval) {
        clearInterval(activeWindowMonitorInterval);
        activeWindowMonitorInterval = null;
    }
    lastActiveProcessName = null;
}

// --- UI Update When Disconnected ---
function handleDisconnectUI(status, detail) {
    // Stop active window monitoring when disconnected
    stopActiveWindowMonitoring();
    
    // Stop weather auto-refresh when disconnected
    stopWeatherAutoRefresh();

    const statusText = el('#deviceStatusText');
    const detailText = el('#deviceDetailText');
    const dot = el('#connectionDot');
    const uploadBtn = el('#uploadViaUsbBtn');

    if (statusText) {
        statusText.textContent = status || "Disconnected";
        statusText.style.color = "var(--text)";
    }
    if (detailText) detailText.textContent = detail || "Searching...";
    if (dot) dot.className = "status-dot searching"; // Yellow/Blinking dot

    // Deactivate Upload Button
    if (uploadBtn) {
        uploadBtn.classList.remove('primary');
        uploadBtn.classList.add('ghost');
        uploadBtn.title = "Please connect device first";
        uploadBtn.style.cursor = "not-allowed";
    }
}

async function updateSerialPortList(isFromRefreshButton = false) {
    console.log('[Serial] Updating port list...');
    
    if (connectedSerialPort) {
        updateConnectionUI(true, connectedDeviceName);
        return;
    }
    
    // Manuel tarama isteği
    if (isFromRefreshButton) {
        await scanForDevice();
    }
}

// New device finding/adding function (For Magnifier button)
async function findNewSerialPort() {
    if (!navigator.serial) return;
    try {
        // Open standard browser selection window
        await navigator.serial.requestPort();
        // Yeni port eklendi, hemen tara
        await scanForDevice();
    } catch (e) {
        // Runs if user cancels, no problem.
    }
}
/**
 * Shows a custom, theme-compliant text input window (prompt).
 * @param {string} title - Window title.
 * @param {string} label - Label above input box.
 * @param {string} [defaultValue=''] - Default text to appear in input box.
 * @returns {Promise<string|null>} - Returns entered text or null if cancelled.
 */
function showCustomPrompt(title, label, defaultValue = '') {
    return new Promise((resolve) => {
        const dialog = el('#customPrompt');
        const titleEl = el('#promptTitle');
        const labelEl = el('#promptLabel');
        const inputEl = el('#promptInput');
        const okBtn = el('#promptOkBtn');
        const cancelBtn = el('#promptCancelBtn');

        // Set texts
        titleEl.textContent = title;
        labelEl.textContent = label;
        inputEl.value = defaultValue;

        // Function to run when dialog closes (with OK, Cancel or Esc)
        const closeHandler = (e) => {
            // If 'submit' event (Enter or OK button) and dialog return value is 'ok'
            if (dialog.returnValue === 'ok') {
                resolve(inputEl.value);
            } else {
                resolve(null); // Cancelled
            }
            // Cleanup: Remove event listener so it doesn't accumulate on next open
            dialog.removeEventListener('close', closeHandler);
        };

        // Listen for 'close' event (triggered automatically thanks to <form method="dialog">)
        dialog.addEventListener('close', closeHandler);

        // Set button 'value's (affects dialog.returnValue)
        okBtn.value = 'ok';
        cancelBtn.value = 'cancel';

        // Manually close when cancel button pressed (might be needed if not in form, just to be safe)
        cancelBtn.onclick = () => dialog.close('cancel');

        // Show window and focus input
        dialog.showModal();
        inputEl.focus();
        inputEl.select(); // Select existing text
    });
}

/**
 * Shows a page settings dialog with name and optional app association.
 * @param {number|null} pageIndex - Page index for editing, null for new page
 * @param {string} defaultName - Default page name
 * @returns {Promise<{name: string, app: string}|null>} - Returns settings or null if cancelled
 */
async function showPageSettingsDialog(pageIndex = null, defaultName = '') {
    return new Promise(async (resolve) => {
        // Create dialog HTML
        const isEdit = pageIndex !== null;
        const title = isEdit
            ? t('prompt.renamePage.title', { pageNum: pageIndex + 1 })
            : t('prompt.addPage.title');

        const currentApp = isEdit && cfg.pageApps ? (cfg.pageApps[pageIndex] || '') : '';
        const currentAutoFocus = isEdit && cfg.pageAutoFocus ? (cfg.pageAutoFocus[pageIndex] !== false) : true; // Default true

        const dialogHTML = `
            <dialog id="pageSettingsDialog" class="page-settings-dialog">
                <form method="dialog" class="picker" style="min-width: 420px; max-width: 90vw;">
                    <h3 style="margin-top: 0; margin-bottom: 15px;">${title}</h3>
                    
                    <div class="row" style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; color: var(--muted);">
                            ${isEdit ? t('prompt.renamePage.label') : t('prompt.addPage.label')}
                        </label>
                        <input type="text" id="pageNameInput" class="text" style="width: 100%;" 
                               value="${defaultName}" autocomplete="off" />
                    </div>
                    
                    <div class="row" style="margin-bottom: 8px;">
                        <label style="display: block; margin-bottom: 8px; color: var(--muted);">
                            ${t('prompt.pageApp')}
                        </label>
                        <select id="pageAppSelect" class="text" style="width: 100%; padding: 10px;">
                            <option value="">${t('prompt.noApp')}</option>
                        </select>
                    </div>
                    
                    <div class="row" style="margin-bottom: 8px;">
                        <label style="display: block; margin-bottom: 8px; color: var(--muted);">
                            ${t('prompt.appPath')}
                        </label>
                        <div style="display: flex; gap: 8px;">
                            <input type="text" id="pageAppPathInput" class="text" style="flex: 1;" 
                                   value="${currentApp}" placeholder="${t('prompt.appPathPlaceholder')}" />
                            <button type="button" id="pageAppBrowseBtn" class="ghost" style="padding: 8px 12px; white-space: nowrap;">
                                📁 ${t('prompt.browse')}
                            </button>
                        </div>
                    </div>
                    
                    <div class="row" style="margin-bottom: 8px; padding: 12px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border);">
                        <label style="display: flex; align-items: flex-start; gap: 12px; cursor: pointer;">
                            <input type="checkbox" id="pageAutoFocusToggle" ${currentAutoFocus ? 'checked' : ''} 
                                   style="width: 18px; height: 18px; margin-top: 2px; accent-color: var(--accent);">
                            <div style="flex: 1;">
                                <span style="color: var(--text); font-weight: 500;">${t('prompt.autoFocus')}</span>
                                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">
                                    ${t('prompt.autoFocusHint')}
                                </div>
                            </div>
                        </label>
                    </div>
                    
                    <div class="row actions" style="margin-top: 25px;">
                        <div class="spacer"></div>
                        <button id="pageSettingsCancelBtn" class="ghost" type="button">${t('editor.cancel')}</button>
                        <button id="pageSettingsOkBtn" class="primary" type="submit">${t('editor.apply') || 'Apply'}</button>
                    </div>
                </form>
            </dialog>
        `;

        // Remove old dialog if exists
        const oldDialog = document.getElementById('pageSettingsDialog');
        if (oldDialog) oldDialog.remove();

        // Add dialog to DOM
        document.body.insertAdjacentHTML('beforeend', dialogHTML);
        const dialog = document.getElementById('pageSettingsDialog');
        const nameInput = document.getElementById('pageNameInput');
        const appSelect = document.getElementById('pageAppSelect');
        const appPathInput = document.getElementById('pageAppPathInput');
        const browseBtn = document.getElementById('pageAppBrowseBtn');
        const autoFocusToggle = document.getElementById('pageAutoFocusToggle');
        const okBtn = document.getElementById('pageSettingsOkBtn');
        const cancelBtn = document.getElementById('pageSettingsCancelBtn');

        // Populate app dropdown
        if (window.electronAPI && window.electronAPI.system) {
            try {
                const apps = await window.electronAPI.system.scanInstalledApps();
                apps.filter(app => app.P && app.N).forEach(app => {
                    const opt = document.createElement('option');
                    opt.value = app.P;
                    opt.textContent = app.N;
                    if (app.P === currentApp) opt.selected = true;
                    appSelect.appendChild(opt);
                });
            } catch (e) {
                console.error('Failed to load apps:', e);
            }
        }

        // Sync select with path input
        appSelect.onchange = () => {
            appPathInput.value = appSelect.value;
        };

        // Sync path input with select (if matches)
        appPathInput.oninput = () => {
            const pathValue = appPathInput.value;
            // Try to find matching option
            let found = false;
            for (let opt of appSelect.options) {
                if (opt.value === pathValue) {
                    appSelect.value = pathValue;
                    found = true;
                    break;
                }
            }
            if (!found) {
                appSelect.value = ''; // Reset to "None" if no match
            }
        };

        // Browse button - open file dialog
        browseBtn.onclick = async () => {
            const hiddenInput = document.getElementById('hiddenAppInput');
            if (hiddenInput) {
                hiddenInput.value = null;
                hiddenInput.onchange = (e) => {
                    const file = e.target.files[0];
                    if (file && file.path) {
                        appPathInput.value = file.path;
                        // Try to match with select
                        appPathInput.dispatchEvent(new Event('input'));
                    }
                };
                hiddenInput.click();
            }
        };

        // Handle close
        const closeHandler = () => {
            if (dialog.returnValue === 'ok') {
                resolve({
                    name: nameInput.value.trim(),
                    app: appPathInput.value.trim(), // Use path input instead of select
                    autoFocus: autoFocusToggle.checked
                });
            } else {
                resolve(null);
            }
            dialog.remove();
        };

        dialog.addEventListener('close', closeHandler);

        okBtn.value = 'ok';
        cancelBtn.onclick = () => dialog.close('cancel');

        dialog.showModal();
        nameInput.focus();
        nameInput.select();
    });
}


/**
 * Shows a custom, theme-compliant alert window.
 * @param {string} message - Main message to show to the user.
 * @param {string} [title='Info'] - Window title.
 * @param {string} [okText='Dismiss'] - Confirmation button text.
 * @returns {Promise<void>} - Resolves when user clicks 'OK'.
 */
function showCustomAlert(message, title = 'Info', okText = 'Dismiss') {
    return new Promise((resolve) => {
        const dialog = el('#customAlert');
        // Check in case HTML is not added yet
        if (!dialog) {
            console.error("Custom Alert dialog (#customAlert) not found in HTML.");
            // Use standard alert for backward compatibility
            alert(message);
            resolve();
            return;
        }

        const titleEl = el('#alertTitle');
        const messageEl = el('#alertMessage');
        const okBtn = el('#alertOkBtn');
        const closeBtn = el('#alertCloseBtn'); // Close (X) button

        // Set texts
        titleEl.textContent = title;
        // Convert \n (newline) characters in message to <br> tags
        messageEl.innerHTML = message.replace(/\n/g, '<br>');
        okBtn.textContent = okText;

        // Clear event listeners (cloning method)
        const newOkBtn = okBtn.cloneNode(true);
        okBtn.parentNode.replaceChild(newOkBtn, okBtn);

        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

        // Assign new listeners (OK, X and ESC key do the same thing)
        const closeHandler = () => {
            dialog.close();
            // Clear listeners (optional but good practice)
            dialog.onclose = null;
            resolve();
        };

        newOkBtn.onclick = closeHandler;
        newCloseBtn.onclick = closeHandler;
        dialog.onclose = closeHandler; // Close with Esc key

        dialog.showModal();
    });
}


// -----------------------------------------------------------------
// 2. REPLACE EXISTING resetAllSettings FUNCTION WITH THIS
// -----------------------------------------------------------------
// NEW: Function to reset all settings (Uses custom confirmation window)
async function resetAllSettings() {

    // ----- LANGUAGE CHANGE HERE -----
    const confirmed = await showCustomConfirm(
        t('alerts.reset.message'),    // "WARNING: This will delete..."
        t('alerts.reset.title'),      // "Reset All Settings"
        t('header.buttons.reset'),    // "Reset"
        t('editor.cancel')            // "Cancel"
    );
    // ---------------------------------

    if (confirmed) {
        try {
            // 1. Clear local storage
            localStorage.removeItem(CONFIG_STORAGE_KEY);

            // 2. Load default settings
            cfg = ensureDefaults({});
            currentPage = 0;

            // 2.5 Revert language to default (Optional, but logical)
            await loadLanguage(DEFAULT_LANG);

            // 3. Update inputs in UI with defaults
            el('#deviceName').value = cfg.deviceName;
            el('#bgColor').value = '#' + cfg.theme.bg;
            el('#btnColor').value = '#' + cfg.theme.btn;
            el('#txtColor').value = '#' + cfg.theme.text;
            el('#strokeColor').value = '#' + cfg.theme.stroke;
            el('#shadowColor').value = '#' + cfg.theme.shadow;
            el('#resolutionSelect').value = cfg.device.resolution;

            // 4. Redraw application
            applyTheme();
            applyDeviceProfile(cfg.device.resolution); // This also calls drawGrid
            renderPageBar();

            // 5. Update web interface title
            const webTitleEl = el('#web-title-text');
            if (webTitleEl) {
                // ----- LANGUAGE CHANGE HERE -----
                webTitleEl.textContent = cfg.deviceName || t('device.frame.title');
            }

            // 6. Save new defaults
            saveConfig();

        } catch (e) {
            console.error("Reset error:", e);
            // We can translate the error message too, but logging to console is enough for now.
        }
    }
}

const ICONIFY_MIRRORS = [
    'https://api.iconify.design',
    'https://api.simplesvg.com',
    'https://api.unisvg.com'
];

const ICON_SEARCH_CACHE = new Map();

async function fetchIconifySearch(query, limit = 50) {
    const cacheKey = `${query.toLowerCase().trim()}_${limit}`;
    if (ICON_SEARCH_CACHE.has(cacheKey)) {
        return ICON_SEARCH_CACHE.get(cacheKey);
    }

    for (const mirror of ICONIFY_MIRRORS) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const resp = await fetch(`${mirror}/search?query=${encodeURIComponent(query)}&limit=${limit}`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (resp.ok) {
                const data = await resp.json();
                ICON_SEARCH_CACHE.set(cacheKey, data);
                return data;
            }
        } catch (e) {
            console.warn(`[Iconify] Mirror ${mirror} failed:`, e.message);
        }
    }
    throw new Error('All icon search mirrors failed');
}

async function searchOnlineInline(query, resultsEl, inputEl, callback) {
    if (!query || query.length < 2) {
        resultsEl.style.display = 'none';
        return;
    }
    if (query.startsWith('http') || query.startsWith('data:') || query.startsWith('online:')) {
        resultsEl.style.display = 'none';
        return;
    }

    try {
        const limit = 30;
        const data = await fetchIconifySearch(query, limit);
        resultsEl.innerHTML = '';

        if (data.icons && data.icons.length > 0) {
            data.icons.forEach(iconStr => {
                const li = document.createElement('li');
                li.title = iconStr;
                const img = document.createElement('img');

                // NEW: Use smart URL function
                img.src = getSmartPreviewUrl(iconStr);

                li.appendChild(img);
                li.onclick = (e) => {
                    e.stopPropagation();
                    const [set, ...rest] = iconStr.split(':');
                    inputEl.value = `online:${set}:${rest.join('-')}`;
                    resultsEl.style.display = 'none';
                    if (callback) callback();
                };
                resultsEl.appendChild(li);
            });
            resultsEl.style.display = 'grid';
        } else {
            resultsEl.style.display = 'none';
        }
    } catch (e) {
        console.error("Inline search error:", e);
        resultsEl.style.display = 'none';
    }
}

const el = (q, r = document) => r.querySelector(q);


// Find convertToJpgBlob function in app.js and replace with this:

function convertToJpgBlob(iconUrl, btnData = {}, exportSize, overrideBgColor = null) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = exportSize;
        canvas.height = exportSize;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // 1. Determine background color
        let bgColor = '#' + (cfg.theme.btn || '202020');

        if (overrideBgColor) {
            bgColor = overrideBgColor;
        } else {
            if (btnData && btnData.btnBgColor) {
                bgColor = btnData.btnBgColor;
            }
            if (btnData.type === 'toggle' && btnData.toggleState === true && btnData.toggleData?.onColor) {
                bgColor = btnData.toggleData.onColor;
            }
        }

        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, exportSize, exportSize);

        // 1b. Clean, matte border without overexposed specular glare
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, exportSize - 1, exportSize - 1);

        const hasIcon = Boolean(iconUrl && iconUrl.length > 0);
        const hasLabel = Boolean(btnData && btnData.label && btnData.label.trim().length > 0 && btnData.type !== 'counter');

        const drawContent = () => {
            // Draw text
            if (hasLabel) {
                const text = btnData.label.trim();
                const padding = Math.max(3, Math.round(exportSize * 0.05));
                const maxWidth = (exportSize * 0.92) - (padding * 2);

                let fontPx = safeFont(exportSize, btnData.labelSize);

                // Smart auto-fit: Check if words fit without breaking into arbitrary syllables
                const words = text.split(/\s+/);
                for (let testSize = fontPx; testSize >= 8; testSize--) {
                    ctx.font = `700 ${testSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
                    let allWordsFit = true;
                    for (const w of words) {
                        if (ctx.measureText(w).width > maxWidth) {
                            allWordsFit = false;
                            break;
                        }
                    }
                    fontPx = testSize;
                    if (allWordsFit) break;
                }

                ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const lineHeight = Math.round(fontPx * 1.18);

                // Build lines without ugly breaks
                let lines = [];
                let currentLine = '';
                for (let i = 0; i < words.length; i++) {
                    const w = words[i];
                    const testLine = currentLine ? (currentLine + ' ' + w) : w;
                    if (ctx.measureText(testLine).width <= maxWidth) {
                        currentLine = testLine;
                    } else {
                        if (currentLine) lines.push(currentLine);
                        if (ctx.measureText(w).width > maxWidth) {
                            let sub = '';
                            for (let ch of w) {
                                if (ctx.measureText(sub + ch + '…').width <= maxWidth) {
                                    sub += ch;
                                } else break;
                            }
                            lines.push(sub ? (sub + '…') : w.slice(0, 4));
                            currentLine = '';
                        } else {
                            currentLine = w;
                        }
                    }
                }
                if (currentLine) lines.push(currentLine);
                if (lines.length > 2) lines = lines.slice(0, 2);

                const totalTextHeight = lines.length * lineHeight;
                let y;
                const vPos = btnData.labelV || (hasIcon ? 'bottom' : 'middle');

                if (vPos === 'top') {
                    y = padding + (lineHeight / 2);
                    if (hasIcon) {
                        const scrimH = Math.min(exportSize * 0.45, totalTextHeight + padding * 2);
                        const scrimGrad = ctx.createLinearGradient(0, 0, 0, scrimH);
                        scrimGrad.addColorStop(0, 'rgba(0, 0, 0, 0.85)');
                        scrimGrad.addColorStop(0.6, 'rgba(0, 0, 0, 0.5)');
                        scrimGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                        ctx.fillStyle = scrimGrad;
                        ctx.fillRect(0, 0, exportSize, scrimH);
                    }
                } else if (vPos === 'bottom') {
                    y = (exportSize - padding) - totalTextHeight + (lineHeight / 2);
                    if (hasIcon) {
                        const scrimY = Math.max(0, y - (lineHeight / 2) - 4);
                        const scrimGrad = ctx.createLinearGradient(0, scrimY, 0, exportSize);
                        scrimGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
                        scrimGrad.addColorStop(0.4, 'rgba(0, 0, 0, 0.55)');
                        scrimGrad.addColorStop(1, 'rgba(0, 0, 0, 0.88)');
                        ctx.fillStyle = scrimGrad;
                        ctx.fillRect(0, scrimY, exportSize, exportSize - scrimY);
                    }
                } else {
                    y = (exportSize - totalTextHeight) / 2 + (lineHeight / 2);
                }

                // Dual-stroke rendering for razor-sharp legibility on TFT displays
                const centerX = exportSize / 2;
                ctx.lineJoin = 'round';
                ctx.miterLimit = 2;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
                ctx.lineWidth = Math.max(2, Math.round(fontPx * 0.22));

                for (let k = 0; k < lines.length; k++) {
                    const lineY = Math.round(y + (k * lineHeight));
                    ctx.strokeText(lines[k].trim(), centerX, lineY);
                }

                ctx.fillStyle = btnData.labelColor || '#FFFFFF';
                for (let k = 0; k < lines.length; k++) {
                    const lineY = Math.round(y + (k * lineHeight));
                    ctx.fillText(lines[k].trim(), centerX, lineY);
                }
            }

            // Draw folder indicator badge directly on hardware canvas
            if (btnData.type === 'folder') {
                const tabW = Math.round(exportSize * 0.28);
                const tabH = Math.round(exportSize * 0.16);
                const rX = exportSize - tabW - 3;
                const rY = 3;
                ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(rX, rY, tabW, tabH, 3);
                else ctx.rect(rX, rY, tabW, tabH);
                ctx.fill();
                ctx.fillStyle = '#FFFFFF';
                ctx.font = `bold ${Math.round(exportSize * 0.085)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('DIR', rX + tabW / 2, rY + tabH / 2);
            }

            // Draw toggle status LED indicator directly on hardware canvas
            if (btnData.type === 'toggle') {
                const ledR = Math.max(3, Math.round(exportSize * 0.045));
                const ledX = exportSize - ledR - 6;
                const ledY = ledR + 6;
                const isStateOn = Boolean(btnData.toggleState);
                ctx.beginPath();
                ctx.arc(ledX, ledY, ledR * 1.8, 0, Math.PI * 2);
                ctx.fillStyle = isStateOn ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.25)';
                ctx.fill();
                ctx.beginPath();
                ctx.arc(ledX, ledY, ledR, 0, Math.PI * 2);
                ctx.fillStyle = isStateOn ? '#22c55e' : '#64748b';
                ctx.fill();
                ctx.beginPath();
                ctx.arc(ledX - ledR * 0.3, ledY - ledR * 0.3, ledR * 0.35, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fill();
            }

            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('Canvas toBlob (JPG) failed'));
            }, 'image/jpeg', 1.0);
        };

        if (hasIcon) {
            const img = new Image();
            // Only use crossOrigin for remote http/https URLs, NEVER for file: or data:
            if (/^https?:\/\//i.test(iconUrl)) {
                img.crossOrigin = 'anonymous';
            }
            img.onload = () => {
                try {
                    const scalePercent = (btnData.iconScale || 0);
                    const scaleValue = 1 + (scalePercent / 100.0);
                    const finalScale = Math.max(0.1, scaleValue);

                    let iconAreaRatio = 1.0;
                    let yOffset = 0;
                    if (hasLabel) {
                        const vPos = btnData.labelV || 'bottom';
                        if (vPos === 'bottom') {
                            iconAreaRatio = 0.64;
                            yOffset = -Math.round(exportSize * 0.12);
                        } else if (vPos === 'top') {
                            iconAreaRatio = 0.64;
                            yOffset = Math.round(exportSize * 0.12);
                        } else {
                            iconAreaRatio = 0.70;
                        }
                    }

                    // Safeguard against naturalWidth === 0 in SVGs with 1em or viewBox only
                    let imgWidth = img.naturalWidth || img.width || exportSize;
                    let imgHeight = img.naturalHeight || img.height || exportSize;
                    if (imgWidth <= 0) imgWidth = exportSize;
                    if (imgHeight <= 0) imgHeight = exportSize;

                    const maxBoxSize = exportSize * iconAreaRatio * finalScale;

                    let sW, sH;
                    if (imgWidth > imgHeight) {
                        sW = maxBoxSize;
                        sH = (imgHeight / imgWidth) * sW;
                    } else {
                        sH = maxBoxSize;
                        sW = (imgWidth / imgHeight) * sH;
                    }

                    if (isNaN(sW) || !isFinite(sW) || sW <= 0) sW = maxBoxSize;
                    if (isNaN(sH) || !isFinite(sH) || sH <= 0) sH = maxBoxSize;

                    const dX = Math.round((exportSize - sW) / 2);
                    const dY = Math.round((exportSize - sH) / 2 + yOffset);

                    // If monochrome icon on dark button has no color specified, default to white
                    let effectiveIconColor = btnData.iconColor;
                    if (!effectiveIconColor && (iconUrl.includes('iconify.design') || iconUrl.includes('simplesvg.com') || iconUrl.includes('unisvg.com'))) {
                        const isColored = typeof COLORED_ICON_SETS !== 'undefined' && COLORED_ICON_SETS.some(s => iconUrl.toLowerCase().includes(s));
                        if (!isColored) {
                            effectiveIconColor = '#ffffff';
                        }
                    }

                    if (effectiveIconColor) {
                        const tintCanvas = document.createElement('canvas');
                        tintCanvas.width = exportSize;
                        tintCanvas.height = exportSize;
                        const tintCtx = tintCanvas.getContext('2d');
                        tintCtx.drawImage(img, dX, dY, sW, sH);
                        tintCtx.globalCompositeOperation = 'source-in';
                        tintCtx.fillStyle = effectiveIconColor;
                        tintCtx.fillRect(0, 0, exportSize, exportSize);
                        ctx.drawImage(tintCanvas, 0, 0);
                    } else {
                        ctx.drawImage(img, dX, dY, sW, sH);
                    }
                    drawContent();
                } catch (e) {
                    console.warn(`[convertToJpgBlob] Error rendering icon for button:`, e);
                    drawContent();
                }
            };
            img.onerror = (err) => {
                console.warn(`[convertToJpgBlob] Failed to load icon image ${iconUrl}:`, err);
                drawContent();
            };

            // Only append cache-busting v= on http/https URLs, NEVER on data: or file:
            if (iconUrl.startsWith('data:') || iconUrl.startsWith('file:')) {
                img.src = iconUrl;
            } else {
                img.src = iconUrl + (iconUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
            }
        } else {
            drawContent();
        }
    });
}


/* Device Profiles (FIXED) */
const DEVICE_PROFILES = {
    "800x480_7": { w: 800, h: 480, cell: 90, maxCols: 8, maxRows: 4, name: "800x480 (7 inch)", hasKnob: true },
    "800x480": { w: 800, h: 480, cell: 110, maxCols: 6, maxRows: 3, name: "800x480 (5 inch)", hasKnob: true },
    "480x320": { w: 480, h: 320, cell: 70, maxCols: 5, maxRows: 3, name: "480x320 (3.5 inch)", hasKnob: true },
    "320x240": { w: 320, h: 240, cell: 70, maxCols: 4, maxRows: 2, name: "320x240 (2.8 inch CYD)", hasKnob: false }
};


// NEW: Central function to find icon URL
function getIconUrl(name) {
    if (!name) return null;

    // 0) If already full URL or data/file URL, do not touch
    if (name.startsWith('data:') || name.startsWith('file:') || /^https?:\/\//i.test(name)) {
        return name;
    }

    // 1) If plain file path (C:\... , \\server\..., /home/..., etc.) comes, make it file://
    const looksLikePath =
        name.includes(':\\') ||              // C:\icons\...
        name.startsWith('\\\\') ||           // \\server\share\...
        name.startsWith('/') ||              // /home/user/...
        /^[A-Za-z]:\//.test(name);           // C:/icons/...

    if (looksLikePath) {
        const normalized = name.replace(/\\/g, '/');
        return `file://${normalized}`;
    }

    // 2) Check local map first (manifest / user icon folder)
    if (ICON_MAP.has(name)) return ICON_MAP.get(name);

    // 3) If starts with 'online:', create Iconify URL
    // Format: online:set-name:icon-name (e.g. online:mdi:home)
    if (name.startsWith('online:')) {
        const parts = name.split(':');
        if (parts.length >= 3) {
            const iconSet = parts[1];
            const iconName = parts.slice(2).join('-'); // name may contain hyphens
            return `https://api.iconify.design/${iconSet}/${iconName}.svg`;
        }
    }

    // If unrecognized, null
    return null;
}


// NEW: Smart function creating preview URL based on icon set
function getSmartPreviewUrl(iconStr) {
    const [set, ...rest] = iconStr.split(':');
    const name = rest.join('-');

    // Check from main list
    if (COLORED_ICON_SETS.some(s => set.toLowerCase().includes(s))) {
        return `https://api.iconify.design/${set}/${name}.svg`;
    }

    // Force white color for others
    return `https://api.iconify.design/${set}/${name}.svg?color=white`;
}


function autoSetIconColor(iconName, currentBtnData, colorInputEl) {
    if (!iconName || !iconName.startsWith('online:')) return;

    const parts = iconName.split(':');
    if (parts.length < 2) return;

    const set = parts[1].toLowerCase();

    // Check from main list
    if (COLORED_ICON_SETS.some(s => set.includes(s))) {
        currentBtnData.iconColor = '';
        colorInputEl.value = '#ffffff';
        colorInputEl.classList.add('unset');
    } else {
        if (!currentBtnData.iconColor) {
            currentBtnData.iconColor = '#ffffff';
            colorInputEl.value = '#ffffff';
            colorInputEl.classList.remove('unset');
        }
    }
}

let DEV_W, DEV_H, CELL, MAX_COLS, MAX_ROWS;
let GRID_COLS, GRID_ROWS;

let cfg = null, currentPage = 0;
let ICON_FOLDERS = {};
let clipboardButton = null;

const CONFIG_STORAGE_KEY = 'deckConfig';
// const HOST_STORAGE_KEY = 'deviceHost'; // Key to save IP address

function emptyBtn() {
    return {
        type: '', combo: '', gotoPage: 0, icon: '', label: '',
        labelColor: '', labelSize: 18, labelV: 'middle',
        btnBgColor: '',
        iconScale: 0,
        iconColor: '',
        textMacro: '',
        appPath: '',
        timerDuration: 0,
        customScript: '',
        websiteUrl: '',
        mediaAction: '',
        soundPath: '',
        soundVolume: 100,
        textSimulateTyping: false,
        counterStartValue: 0,
        counterAction: 'increment',

        // --- TOGGLE CONFIG ---
        toggleState: false, // false = OFF (A), true = ON (B)
        toggleData: {
            offCombo: '',
            onCombo: '',
            onColor: '#2ecc71' // Default Green
        },
        // ---------------------

        mouseConfig: {
            event: 'click', button: 'left', x1: 0, y1: 0, x2: 0, y2: 0
        }
    };
}


function saveConfig(shouldSaveHistory = true) {
    if (!cfg) return;
    try {
        cfg.theme.bg = el('#bgColor').value.replace('#', '');
        cfg.theme.btn = el('#btnColor').value.replace('#', '');
        cfg.theme.text = el('#txtColor').value.replace('#', '');
        cfg.theme.stroke = el('#strokeColor').value.replace('#', '');
        cfg.theme.shadow = el('#shadowColor').value.replace('#', '');
        cfg.grid.cols = GRID_COLS;
        cfg.grid.rows = GRID_ROWS;
        cfg.currentPage = currentPage;
        cfg.deviceName = el('#deviceName').value;
        cfg.pageNames = cfg.pageNames || [];

        cfg.device = cfg.device || {};

        // --- FIX HERE ---
        const resSelect = el('#resolutionSelect');
        // Get value ONLY if <select> exists in DOM AND options are loaded (options.length > 0)
        // Otherwise DO NOT TOUCH existing cfg value
        if (resSelect && resSelect.options.length > 0) {
            cfg.device.resolution = resSelect.value;
        }
        // --- FIX END ---

        // === CONFIG AUTO-BACKUP ===
        const configString = JSON.stringify(cfg);
        localStorage.setItem(CONFIG_STORAGE_KEY, configString);
        localStorage.setItem(CONFIG_STORAGE_KEY + '_backup', configString);
        localStorage.setItem(CONFIG_STORAGE_KEY + '_timestamp', Date.now().toString());

        if (shouldSaveHistory) {
            saveHistory();
        }

    } catch (e) {
        console.error("Error saving config to LocalStorage:", e);
        showToast(t('toast.configSaveFailed'), 'error');
    }
}

function loadConfig() {
    try {
        const savedConfig = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (savedConfig) {
            try {
                const parsedConfig = JSON.parse(savedConfig);
                return ensureDefaults(parsedConfig);
            } catch (parseError) {
                console.error("Config corrupted, trying backup...");
                // Try backup
                const backupConfig = localStorage.getItem(CONFIG_STORAGE_KEY + '_backup');
                if (backupConfig) {
                    try {
                        const parsedBackup = JSON.parse(backupConfig);
                        showToast(t('toast.configRestoredBackup'), 'warning', 5000);
                        return ensureDefaults(parsedBackup);
                    } catch (backupError) {
                        console.error("Backup also corrupted!");
                    }
                }
                localStorage.removeItem(CONFIG_STORAGE_KEY);
                showToast(t('toast.configResetCorruption'), 'error', 5000);
            }
        }
    } catch (e) {
        console.error("Error loading config from LocalStorage:", e);
        localStorage.removeItem(CONFIG_STORAGE_KEY);
    }
    return ensureDefaults({});
}

// --- NEW: Serial Command Sending Helper with QUEUE and ESP Ready System ---
async function sendSerialCommand(command) {
    // ESP hazır değilse (upload sırasında) komutu beklet
    if (!isEspReady) {
        console.log("[Serial] ESP not ready, queuing command:", command);
        pendingSerialCommands.push(command);
        return;
    }
    
    // Normal kuyruğa ekle
    serialCommandQueue.push(command);
    processSerialQueue();
}

// Pending komutları gönder (ESP hazır olduğunda çağrılır)
function flushPendingCommands() {
    if (pendingSerialCommands.length === 0) return;
    
    console.log(`[Serial] Flushing ${pendingSerialCommands.length} pending commands`);
    
    // Pending komutları normal kuyruğa aktar
    while (pendingSerialCommands.length > 0) {
        const cmd = pendingSerialCommands.shift();
        serialCommandQueue.push(cmd);
    }
    
    // Kuyruğu işle
    processSerialQueue();
}

// ============================================
// WEATHER API FUNCTIONS
// ============================================

/**
 * Fetch weather from Open-Meteo API
 * @returns {Promise<{temp: number, code: number, isDay: boolean}|null>}
 */
async function fetchWeather() {
    // Weather defaults to Łódź if not configured
    if (!cfg.weather) cfg.weather = {};
    if (!cfg.weather.lat || !cfg.weather.lon) {
        cfg.weather.city = cfg.weather.city || 'Łódź';
        cfg.weather.lat = 51.7592;
        cfg.weather.lon = 19.4560;
        cfg.weather.units = cfg.weather.units || 'celsius';
        cfg.weather.country = cfg.weather.country || 'Poland';
        cfg.weather.admin = cfg.weather.admin || 'Łódzkie';
    }
    
    try {
        const units = cfg.weather.units === 'fahrenheit' ? '&temperature_unit=fahrenheit' : '';
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${cfg.weather.lat}&longitude=${cfg.weather.lon}&current_weather=true${units}`;
        
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Weather API error');
        
        const data = await resp.json();
        const weather = data.current_weather;
        
        return {
            temp: Math.round(weather.temperature), // Tam sayıya yuvarla
            code: weather.weathercode,
            isDay: weather.is_day === 1
        };
    } catch (e) {
        console.error('Weather fetch error:', e);
        return null;
    }
}

/**
 * Get icon name from WMO weather code
 * @param {number} code - WMO weather code
 * @param {boolean} isDay - Is it daytime
 * @returns {string} - Icon name
 */
function getWeatherIconName(code, isDay) {
    if (code === 0) return isDay ? 'sun' : 'moon';
    if (code >= 1 && code <= 3) return isDay ? 'partly_cloudy_day' : 'partly_cloudy_night';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'snow';
    if (code >= 95 && code <= 99) return 'thunder';
    return 'cloudy';
}

/**
 * Get weather description key for i18n
 * @param {number} code - WMO weather code
 * @returns {string} - Translation key
 */
function getWeatherDescriptionKey(code) {
    if (code === 0) return 'weather.clearSky';
    if (code === 1) return 'weather.mainlyClear';
    if (code === 2) return 'weather.partlyCloudy';
    if (code === 3) return 'weather.overcast';
    if (code === 45 || code === 48) return 'weather.foggy';
    if (code >= 51 && code <= 55) return 'weather.drizzle';
    if (code >= 56 && code <= 57) return 'weather.freezingDrizzle';
    if (code >= 61 && code <= 65) return 'weather.rain';
    if (code >= 66 && code <= 67) return 'weather.freezingRain';
    if (code >= 71 && code <= 75) return 'weather.snow';
    if (code === 77) return 'weather.snowGrains';
    if (code >= 80 && code <= 82) return 'weather.rainShowers';
    if (code >= 85 && code <= 86) return 'weather.snowShowers';
    if (code === 95) return 'weather.thunderstorm';
    if (code >= 96 && code <= 99) return 'weather.thunderstormHail';
    return 'weather.unknown';
}

/**
 * Convert special characters to ASCII for ESP32 compatibility
 * ESP32 font doesn't support extended characters (ö, ü, ş, ğ, etc.)
 */
function toAsciiForEsp(str) {
    if (!str) return '';
    const map = {
        // Turkish
        'ö': 'o', 'Ö': 'O', 'ü': 'u', 'Ü': 'U', 'ş': 's', 'Ş': 'S',
        'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I', 'ç': 'c', 'Ç': 'C',
        // German
        'ä': 'a', 'Ä': 'A', 'ß': 'ss',
        // French
        'é': 'e', 'É': 'E', 'è': 'e', 'È': 'E', 'ê': 'e', 'Ê': 'E', 'ë': 'e', 'Ë': 'E',
        'à': 'a', 'À': 'A', 'â': 'a', 'Â': 'A', 'ô': 'o', 'Ô': 'O',
        'û': 'u', 'Û': 'U', 'ù': 'u', 'Ù': 'U', 'î': 'i', 'Î': 'I', 'ï': 'i', 'Ï': 'I',
        // Spanish
        'ñ': 'n', 'Ñ': 'N', 'á': 'a', 'Á': 'A', 'í': 'i', 'Í': 'I', 'ó': 'o', 'Ó': 'O', 'ú': 'u', 'Ú': 'U'
    };
    return str.split('').map(c => map[c] || c).join('');
}

/**
 * Send weather data to ESP32 before sleep
 * Format: WEATHER:temp:code:isDay:isCelsius:description:city
 * Example: WEATHER:22:0:1:1:Clear Sky:Istanbul
 */
async function sendWeatherToDevice() {
    const weather = await fetchWeather();
    if (weather && connectedSerialPort) {
        const isCelsius = cfg.weather?.units !== 'fahrenheit' ? 1 : 0;
        const descKey = getWeatherDescriptionKey(weather.code);
        
        // For Japanese/Chinese, use English (ESP32 can't display these characters)
        let description;
        if (currentLang === 'ja' || currentLang === 'zh') {
            // Get English translation
            const enTranslations = translations['en'];
            const keys = descKey.split('.');
            let val = enTranslations;
            for (const k of keys) {
                val = val?.[k];
            }
            description = val || 'Unknown';
        } else {
            description = toAsciiForEsp(t(descKey) || 'Unknown');
        }
        
        const city = toAsciiForEsp(cfg.weather?.city || '');
        const cmd = `WEATHER:${weather.temp}:${weather.code}:${weather.isDay ? 1 : 0}:${isCelsius}:${description}:${city}`;
        sendSerialCommand(cmd);
        console.log('[Weather] Sent to device:', cmd);
    }
}

// ============================================
// WEATHER AUTO-REFRESH (Her 1 saatte bir güncelle)
// ============================================

let weatherRefreshInterval = null;
const WEATHER_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 saat (ms)

/**
 * Start weather auto-refresh timer
 * Sends weather data every hour while device is connected
 * Weather is always enabled when sleep is on and city is selected
 */
function startWeatherAutoRefresh() {
    stopWeatherAutoRefresh(); // Önce varsa temizle
    
    // Sleep açık mı ve şehir seçili mi kontrol et
    const hasCity = cfg.weather?.lat && cfg.weather?.lon;
    const sleepEnabled = cfg.deviceSettings?.sleepEnabled;
    
    if (!sleepEnabled || !hasCity) {
        console.log('[Weather] Auto-refresh not started (sleep disabled or no city selected)');
        return;
    }
    
    // İlk gönderim
    sendWeatherToDevice();
    
    // Her 1 saatte bir gönder
    weatherRefreshInterval = setInterval(async () => {
        if (connectedSerialPort && cfg.weather?.lat && cfg.weather?.lon) {
            await sendWeatherToDevice();
            console.log('[Weather] Auto-refresh sent');
        }
    }, WEATHER_REFRESH_INTERVAL);
    
    console.log('[Weather] Auto-refresh started (1 hour interval)');
}

/**
 * Stop weather auto-refresh timer
 */
function stopWeatherAutoRefresh() {
    if (weatherRefreshInterval) {
        clearInterval(weatherRefreshInterval);
        weatherRefreshInterval = null;
        console.log('[Weather] Auto-refresh stopped');
    }
}

/**
 * Restart weather auto-refresh (call when settings change)
 */
function restartWeatherAutoRefresh() {
    stopWeatherAutoRefresh();
    if (connectedSerialPort) {
        startWeatherAutoRefresh();
    }
}

// ============================================
// HEADER WEATHER WIDGET (Live Weather Capsule)
// ============================================

function getWeatherEmoji(code, isDay) {
    if (code === 0) return isDay ? '☀️' : '🌙';
    if (code >= 1 && code <= 3) return isDay ? '⛅' : '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️';
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '❄️';
    if (code >= 95 && code <= 99) return '⛈️';
    return '⛅';
}

function getWeatherFriendlyDesc(code) {
    if (code === 0) return 'Czyste niebo';
    if (code === 1) return 'Przeważnie słonecznie';
    if (code === 2) return 'Częściowe zachmurzenie';
    if (code === 3) return 'Pochmurno';
    if (code === 45 || code === 48) return 'Mgła';
    if (code >= 51 && code <= 55) return 'Mżawka';
    if (code >= 56 && code <= 57) return 'Marznąca mżawka';
    if (code >= 61 && code <= 65) return 'Deszcz';
    if (code >= 66 && code <= 67) return 'Marznący deszcz';
    if (code >= 71 && code <= 75) return 'Śnieg';
    if (code === 77) return 'Ziarnisty śnieg';
    if (code >= 80 && code <= 82) return 'Przelotny deszcz';
    if (code >= 85 && code <= 86) return 'Przelotny śnieg';
    if (code >= 95 && code <= 99) return 'Burza z piorunami';
    return 'Umiarkowanie';
}

let lastWeatherUpdateTime = 0;
let isUpdatingWeather = false;

async function updateHeaderWeather(force = false) {
    const now = Date.now();
    if (!force && (now - lastWeatherUpdateTime < 15 * 60 * 1000)) {
        return;
    }
    if (isUpdatingWeather) return;
    isUpdatingWeather = true;

    const widget = el('#headerWeatherWidget');
    const iconEl = el('#headerWeatherIcon');
    const cityEl = el('#headerWeatherCity');
    const tempEl = el('#headerWeatherTemp');
    const descEl = el('#headerWeatherDesc');

    if (!widget) {
        isUpdatingWeather = false;
        return;
    }

    widget.classList.add('refreshing');

    try {
        const weather = await fetchWeather();
        if (weather) {
            lastWeatherUpdateTime = now;
            const emoji = getWeatherEmoji(weather.code, weather.isDay);
            const friendlyDesc = getWeatherFriendlyDesc(weather.code);
            const city = (cfg?.weather?.city) || 'Łódź';
            const unit = (cfg?.weather?.units === 'fahrenheit') ? '°F' : '°C';

            if (iconEl) iconEl.textContent = emoji;
            if (cityEl) cityEl.textContent = city;
            if (tempEl) tempEl.textContent = `${weather.temp}${unit}`;
            if (descEl) descEl.textContent = friendlyDesc;
            widget.title = `Pogoda dla Łodzi: ${friendlyDesc}, ${weather.temp}${unit}\n(Kliknij, aby odświeżyć)`;
        } else {
            if (descEl) descEl.textContent = 'Łódź (offline)';
        }
    } catch (e) {
        console.warn('[HeaderWeather] Failed to update:', e);
        if (descEl) descEl.textContent = 'Brak danych';
    } finally {
        setTimeout(() => {
            widget.classList.remove('refreshing');
            isUpdatingWeather = false;
        }, 500);
    }
}

// ============================================================================
// SYSTEM TELEMETRY & HARDWARE SIMULATOR CONTROLS
// ============================================================================
window._lastCpuVal = 0;
window._lastRamVal = 0;

function initSystemTelemetry() {
    const cpuEl = el('#telemetryCpuVal');
    const ramEl = el('#telemetryRamVal');

    async function pollStats() {
        try {
            if (window.electronAPI && window.electronAPI.invoke) {
                const stats = await window.electronAPI.invoke('app:getSystemStats');
                if (stats) {
                    window._lastCpuVal = stats.cpu;
                    window._lastRamVal = stats.ram;
                    if (cpuEl) cpuEl.textContent = `${stats.cpu}%`;
                    if (ramEl) ramEl.textContent = `${stats.ram}%`;

                    // Send to CYD hardware if connected
                    if (connectedSerialPort && isEspReady) {
                        sendSerialCommand(`SYS_STATS:${stats.cpu}:${stats.ram}`);
                    }
                }
            }
        } catch (err) {
            // Silently handle
        }
    }

    pollStats();
    setInterval(pollStats, 2000);

    // Sync system time every 60s
    function syncTime() {
        if (connectedSerialPort && isEspReady) {
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const mo = String(now.getMonth() + 1).padStart(2, '0');
            const yyyy = now.getFullYear();
            sendSerialCommand(`SET_TIME:${hh}:${mm}:${dd}.${mo}.${yyyy}`);
        }
    }
    setTimeout(syncTime, 3000);
    setInterval(syncTime, 60000);
}

function initSimulatorHeaderControls() {
    const prevBtn = el('#simPrevPageBtn');
    const nextBtn = el('#simNextPageBtn');
    const timerBtn = el('#simTimerBtn');

    if (prevBtn) {
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            AudioHaptic.click();
            const total = cfg.pageCount || 1;
            let target = deviceCurrentPage > 0 ? deviceCurrentPage - 1 : total - 1;
            deviceCurrentPage = target;
            drawGrid();
            renderPageBar();
            if (connectedSerialPort) sendSerialCommand(`SET_PAGE:${target}`);
        };
    }

    if (nextBtn) {
        nextBtn.onclick = (e) => {
            e.stopPropagation();
            AudioHaptic.click();
            const total = cfg.pageCount || 1;
            let target = (deviceCurrentPage < total - 1) ? deviceCurrentPage + 1 : 0;
            deviceCurrentPage = target;
            drawGrid();
            renderPageBar();
            if (connectedSerialPort) sendSerialCommand(`SET_PAGE:${target}`);
        };
    }

    if (timerBtn) {
        timerBtn.onclick = (e) => {
            e.stopPropagation();
            AudioHaptic.click();
            showToast('CYD: Dotknij środkowego przycisku na ekranie urządzenia, aby włączyć Timer / Stoper na pełnym ekranie!', 'info');
        };
    }
}

// Kuyruğu işleyen asenkron fonksiyon
async function processSerialQueue() {
    // Eğer zaten yazıyorsak veya kuyruk boşsa çık
    if (isSerialWriting || serialCommandQueue.length === 0) return;

    // Port bağlı değilse veya ESP hazır değilse bekle
    if (!connectedSerialPort || !connectedSerialPort.writable) {
        console.warn("[Serial] Port not connected, commands will wait");
        return;
    }
    
    if (!isEspReady) {
        console.log("[Serial] ESP not ready, commands will wait");
        return;
    }

    isSerialWriting = true; // Kilidi kapat
    const cmd = serialCommandQueue.shift(); // İlk komutu al

    try {
        const writer = connectedSerialPort.writable.getWriter();
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(cmd + "\n"));
        writer.releaseLock();

        console.log("[Serial] Sent:", cmd);
        if (cfg?.developerMode) addSerialLog('OUT', cmd);

    } catch (e) {
        console.error("Serial write error:", e);
        // Bağlantı kopmuş olabilir
        if (e.message.includes('disconnected') || e.message.includes('closed')) {
            disconnectSerial(false);
        }
    } finally {
        isSerialWriting = false; // Kilidi aç

        // Kuyrukta başka komut varsa hemen işle (Recursive call gibi ama güvenli)
        if (serialCommandQueue.length > 0) {
            processSerialQueue();
        }
    }
}
// --- KNOB MANAGEMENT ---

// --- KNOB MANAGEMENT ---

// Current knob settings page (null = main, 0+ = per-page)
let currentKnobPage = null;

// Get knob settings for a specific page
// Page 0 = main/default settings (stored in cfg.knob)
// Pages 1+ = custom settings if set, otherwise fall back to main
// Get knob settings for a specific page
function getKnobPageSettings(pageIdx) {
    const k = cfg.knob || {};

    // Varsayılanlar (Global)
    const defaults = {
        ledColor: k.ledColor || '#d946ef',
        tailLength: k.tailLength ?? 5,
        sensitivity: k.sensitivity ?? 10,
        ledBrightness: k.ledBrightness ?? 100,
        ledOffset: k.ledOffset ?? 0,  // Global - fiziksel hizalama
        cwAction: k.cwAction || '',
        ccwAction: k.ccwAction || '',
        clickSound: k.clickSound !== false // Varsayılan: Açık
    };

    if (pageIdx === 0) {
        // Page 1 (Main Settings)
        return defaults;
    } else {
        // Pages 2+ (Per-Page Override)
        const pageSettings = k.pages?.[pageIdx] || {};

        return {
            ledColor: pageSettings.ledColor || defaults.ledColor,
            tailLength: pageSettings.tailLength ?? defaults.tailLength,
            sensitivity: pageSettings.sensitivity ?? defaults.sensitivity,
            ledBrightness: pageSettings.ledBrightness ?? defaults.ledBrightness,
            ledOffset: defaults.ledOffset,  // Her zaman global değeri kullan
            cwAction: pageSettings.cwAction ?? defaults.cwAction,
            ccwAction: pageSettings.ccwAction ?? defaults.ccwAction,
            // --- DÜZELTME: Click Sound sayfa ayarı varsa onu al, yoksa globali al ---
            clickSound: pageSettings.clickSound ?? defaults.clickSound
        };
    }
}

// Check if page has custom knob settings (only pages 1+ can have custom)
function hasCustomKnobSettings(pageIdx) {
    return pageIdx > 0 && cfg.knob?.pages?.[pageIdx] !== undefined;
}

// Render knob page tabs
function renderKnobPageTabs() {
    const tabsContainer = document.getElementById('knobPageTabs');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = '';

    // Page tabs - page 1 is the default/main settings
    for (let i = 0; i < cfg.pageCount; i++) {
        const tab = document.createElement('button');
        const pageName = cfg.pageNames[i] || `Page ${i + 1}`;
        const hasCustom = i > 0 && hasCustomKnobSettings(i); // Only pages 2+ can have custom
        const isActive = currentKnobPage === i;

        // Active tabs override has-custom styling (blue > orange)
        tab.className = 'knob-page-tab' + (isActive ? ' active' : '') + (hasCustom && !isActive ? ' has-custom' : '');
        tab.innerHTML = `<span class="tab-label">${pageName}</span>`;

        // Clear button for custom settings (only for pages 2+)
        if (hasCustom) {
            const clearBtn = document.createElement('span');
            clearBtn.className = 'knob-tab-clear';
            clearBtn.textContent = '×';
            clearBtn.title = t('knob.clearCustom') || 'Clear custom settings';
            clearBtn.onclick = (e) => {
                e.stopPropagation();
                if (cfg.knob?.pages?.[i]) {
                    delete cfg.knob.pages[i];
                    saveConfig();
                    showToast(t('knob.customCleared') || 'Custom settings cleared', 'info');
                    renderKnobPageTabs();
                    if (currentKnobPage === i) {
                        loadKnobPageSettings();
                    }
                    // Only update UI preview, don't send to ESP32
                    updateKnobPreviewForCurrentPage();
                }
            };
            tab.appendChild(clearBtn);
        }

        tab.onclick = () => {
            currentKnobPage = i;
            renderKnobPageTabs();
            loadKnobPageSettings();
        };
        tabsContainer.appendChild(tab);
    }

    // Scroll buttons
    const scrollLeft = document.getElementById('knobPageScrollLeft');
    const scrollRight = document.getElementById('knobPageScrollRight');
    if (scrollLeft) scrollLeft.onclick = () => tabsContainer.scrollBy({ left: -100, behavior: 'smooth' });
    if (scrollRight) scrollRight.onclick = () => tabsContainer.scrollBy({ left: 100, behavior: 'smooth' });
}

// Auto-save knob settings for current page
// Page 0 = save to main (cfg.knob)
// Pages 1+ = save to pages[] only if different from main
// Auto-save knob settings for current page
function autoSaveKnobPageSettings() {
    const ledColorInput = document.getElementById('knobLedColor');
    const tailInput = document.getElementById('knobTailRange');

    // --- DÜZELTME: Click Sound değerini inputtan al ---
    const clickSoundState = document.getElementById('knobClickSoundToggle')?.checked ?? true;

    const newSettings = {
        ledColor: ledColorInput.value,
        tailLength: parseInt(document.getElementById('knobTailVal').value) || 5,
        sensitivity: parseInt(document.getElementById('knobSensitivityRange').value),
        ledBrightness: parseInt(document.getElementById('ledBrightnessRange').value),
        cwAction: document.getElementById('knobCwAction').value,
        ccwAction: document.getElementById('knobCcwAction').value,
        clickSound: clickSoundState // <--- EKLENDİ
    };

    if (currentKnobPage === 0) {
        // Page 1: Ana ayarları güncelle
        cfg.knob = { ...cfg.knob, ...newSettings };
    } else {
        // Pages 2+: Ana ayarlarla karşılaştır, farklıysa kaydet
        const mainSettings = {
            ledColor: cfg.knob?.ledColor || '#d946ef',
            tailLength: cfg.knob?.tailLength ?? 5,
            sensitivity: cfg.knob?.sensitivity ?? 10,
            ledBrightness: cfg.knob?.ledBrightness ?? 100,
            cwAction: cfg.knob?.cwAction ?? '',
            ccwAction: cfg.knob?.ccwAction ?? '',
            clickSound: cfg.knob?.clickSound !== false
        };

        const isDifferent =
            newSettings.ledColor !== mainSettings.ledColor ||
            newSettings.tailLength !== mainSettings.tailLength ||
            newSettings.sensitivity !== mainSettings.sensitivity ||
            newSettings.ledBrightness !== mainSettings.ledBrightness ||
            newSettings.cwAction !== mainSettings.cwAction ||
            newSettings.ccwAction !== mainSettings.ccwAction ||
            newSettings.clickSound !== mainSettings.clickSound; // <--- KARŞILAŞTIRMAYA EKLENDİ

        if (isDifferent) {
            if (!cfg.knob.pages) cfg.knob.pages = {};
            cfg.knob.pages[currentKnobPage] = newSettings;
        } else {
            // Eğer her şey ana ayarlarla aynıysa, bu sayfa için özel kaydı sil (temizlik)
            if (cfg.knob?.pages?.[currentKnobPage]) {
                delete cfg.knob.pages[currentKnobPage];
            }
        }
    }

    saveConfig();
    renderKnobPageTabs();

    // Eğer o an cihaz bu sayfadaysa, ayarları uygula (Ses hariç, o PC tarafında)
    if (currentKnobPage === deviceCurrentPage) {
        const activeSettings = getKnobPageSettings(deviceCurrentPage);
        updateKnobLeds(knobRotationAngle, activeSettings.ledColor, activeSettings.tailLength);

        const hex = activeSettings.ledColor.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        sendSerialCommand(`SET_KNOB:${r}:${g}:${b}:${activeSettings.tailLength}`);
        
        // LED Brightness gönder
        const brightness255 = Math.round(((activeSettings.ledBrightness ?? 100) / 100) * 255);
        sendSerialCommand(`SET_LED_BRIGHTNESS:${brightness255}`);
    }
}
// Helper: Knob Bilgi Kutusunu Güncelle (Metin ve Renk)
function updateKnobInfoText(pageIdx) {
    const settings = getKnobPageSettings(pageIdx);

    const labelCCW = document.getElementById('knobTextCCW');
    const labelCW = document.getElementById('knobTextCW');
    const infoBox = document.querySelector('.knob-info-box');

    if (labelCCW && labelCW) {
        labelCCW.textContent = formatActionName(settings.ccwAction);
        labelCW.textContent = formatActionName(settings.cwAction);

        // Parlama rengini aktif sayfa rengine ayarla
        if (infoBox) {
            infoBox.style.setProperty('--accent-glow', settings.ledColor);
        }
    }
}
// Load knob settings for current page into UI
function loadKnobPageSettings() {
    const settings = getKnobPageSettings(currentKnobPage);

    const ledColorInput = document.getElementById('knobLedColor');
    const tailInput = document.getElementById('knobTailRange');

    if (ledColorInput) ledColorInput.value = settings.ledColor;
    if (tailInput) {
        // Text input shows real value, slider limited to its max
        document.getElementById('knobTailVal').value = settings.tailLength;
        tailInput.value = Math.min(settings.tailLength, parseInt(tailInput.max) || 16);
    }

    const sensitivityRange = document.getElementById('knobSensitivityRange');
    if (sensitivityRange) {
        sensitivityRange.value = settings.sensitivity;
        document.getElementById('knobSensitivityVal').textContent = settings.sensitivity;
    }

    // LED Brightness
    const ledBrightnessRange = document.getElementById('ledBrightnessRange');
    if (ledBrightnessRange) {
        const brightness = settings.ledBrightness ?? 100;
        ledBrightnessRange.value = brightness;
        document.getElementById('ledBrightnessVal').textContent = brightness + '%';
    }

    // LED Offset (global setting)
    const ledOffsetRange = document.getElementById('knobLedOffsetRange');
    if (ledOffsetRange) {
        const offset = cfg.knob?.ledOffset ?? 0;
        ledOffsetRange.value = offset;
        document.getElementById('knobLedOffsetVal').textContent = offset + '°';
    }

    // --- DÜZELTME: Click Sound Toggle Durumunu Güncelle ---
    const clickSoundToggle = document.getElementById('knobClickSoundToggle');
    if (clickSoundToggle) {
        // Eğer undefined ise true varsay, değilse değeri al
        clickSoundToggle.checked = (settings.clickSound !== false);
    }

    const cwAction = document.getElementById('knobCwAction');
    const ccwAction = document.getElementById('knobCcwAction');
    if (cwAction) cwAction.value = settings.cwAction;
    if (ccwAction) ccwAction.value = settings.ccwAction;

    // Update preview
    if (typeof updateDialogKnobLeds === 'function') {
        const currentRot = typeof knobRotationAngle !== 'undefined' ? knobRotationAngle : 0;
        const offset = cfg.knob?.ledOffset ?? 0;
        updateDialogKnobLeds(currentRot, settings.ledColor, settings.tailLength, offset);
    }
}

function openKnobSettings() {
    const dialog = document.getElementById('knobSettingsDialog');
    const saveBtn = document.getElementById('knobSaveBtn');
    const ledColorInput = document.getElementById('knobLedColor');
    const tailInput = document.getElementById('knobTailRange');

    // Start with page 1 (index 0) - the main/default page
    currentKnobPage = 0;

    // Render page tabs
    renderKnobPageTabs();

    // Load settings for current page
    loadKnobPageSettings();

    // --- LIVE PREVIEW FOR DIALOG KNOB ---
    const updateDialogPreview = () => {
        // Use global rotation angle for LED position
        const currentRot = typeof knobRotationAngle !== 'undefined' ? knobRotationAngle : 0;

        // Update dialog LEDs
        updateDialogKnobLeds(currentRot, ledColorInput.value, parseInt(document.getElementById('knobTailVal').value) || 5);
    };

    // Auto-save for all pages (realtime)
    const handleAutoSave = () => {
        autoSaveKnobPageSettings();
        updateDialogPreview();
    };

    // Slider Listeners with live preview and auto-save
    const tailValInput = document.getElementById('knobTailVal');
    
    tailInput.oninput = (e) => {
        tailValInput.value = e.target.value;
        handleAutoSave();
    };
    
    // Manual tail value input (allows values beyond slider max)
    tailValInput.onchange = (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 99) val = 99;
        e.target.value = val;
        // Update slider only if within its range
        if (val <= parseInt(tailInput.max)) {
            tailInput.value = val;
        }
        handleAutoSave();
    };

    ledColorInput.oninput = handleAutoSave;

    document.getElementById('knobSensitivityRange').oninput = (e) => {
        document.getElementById('knobSensitivityVal').textContent = e.target.value;
        autoSaveKnobPageSettings();
    };

    // LED Brightness slider - sends to ESP32 in real-time
    document.getElementById('ledBrightnessRange').oninput = (e) => {
        const val = e.target.value;
        document.getElementById('ledBrightnessVal').textContent = val + '%';
        // Send to ESP32 immediately (0-100 -> 0-255)
        const brightness255 = Math.round((val / 100) * 255);
        sendSerialCommand(`SET_LED_BRIGHTNESS:${brightness255}`);
        autoSaveKnobPageSettings();
    };

    // LED Offset slider - updates preview in real-time
    const ledOffsetRange = document.getElementById('knobLedOffsetRange');
    const ledOffsetVal = document.getElementById('knobLedOffsetVal');
    if (ledOffsetRange) {
        ledOffsetRange.oninput = (e) => {
            const val = parseInt(e.target.value);
            ledOffsetVal.textContent = val + '°';
            // Save to global config immediately
            if (!cfg.knob) cfg.knob = {};
            cfg.knob.ledOffset = val;
            saveConfig();
            // Update both previews
            const settings = getKnobPageSettings(currentKnobPage);
            const currentRot = typeof knobRotationAngle !== 'undefined' ? knobRotationAngle : 0;
            updateDialogKnobLeds(currentRot, settings.ledColor, settings.tailLength, val);
            updateKnobLeds(currentRot, settings.ledColor, settings.tailLength, val);
        };
    }

    // Click sound toggle auto-save
    const clickSoundToggle = document.getElementById('knobClickSoundToggle');
    if (clickSoundToggle) {
        clickSoundToggle.onchange = () => {
            autoSaveKnobPageSettings();
        };
    }

    // Action inputs auto-save
    const cwAction = document.getElementById('knobCwAction');
    const ccwAction = document.getElementById('knobCcwAction');
    if (cwAction) cwAction.onchange = () => { autoSaveKnobPageSettings(); };
    if (ccwAction) ccwAction.onchange = () => { autoSaveKnobPageSettings(); };

    // Preset Select Listeners with auto-save
    document.getElementById('knobCwPreset').onchange = (e) => {
        if (e.target.value) {
            document.getElementById('knobCwAction').value = e.target.value;
            autoSaveKnobPageSettings();
        }
        e.target.value = "";
    };
    document.getElementById('knobCcwPreset').onchange = (e) => {
        if (e.target.value) {
            document.getElementById('knobCcwAction').value = e.target.value;
            autoSaveKnobPageSettings();
        }
        e.target.value = "";
    };

    // Knob Modifier Buttons (CTRL, ALT, SHIFT, etc.)
    const addKeyToKnobInput = (targetId, key) => {
        const input = document.getElementById(targetId);
        if (!input) return;
        const cv = input.value.trim();
        if (cv.length === 0) {
            input.value = key;
        } else if (cv.endsWith('+')) {
            input.value += key;
        } else {
            input.value += '+' + key;
        }
        input.focus();
        autoSaveKnobPageSettings();
    };

    // Attach event listeners to knob modifier buttons
    document.querySelectorAll('.knob-mods .mod[data-mod]').forEach(btn => {
        btn.onclick = () => addKeyToKnobInput(btn.dataset.target, btn.dataset.mod);
    });
    document.querySelectorAll('.knob-mods .mod[data-key]').forEach(btn => {
        btn.onclick = () => addKeyToKnobInput(btn.dataset.target, btn.dataset.key);
    });

    // --- CAPTURE LOGIC START ---
    let isKnobCapturing = false;
    let activeKnobCaptureBtn = null;

    const stopKnobCapture = () => {
        if (activeKnobCaptureBtn) {
            activeKnobCaptureBtn.textContent = t('editor.capture.start');
            activeKnobCaptureBtn.classList.remove('capturing');
            activeKnobCaptureBtn = null;
        }
        isKnobCapturing = false;
        dialog.onkeydown = null;
    };

    const handleCapture = (targetId, btnEl) => {
        const inputEl = document.getElementById(targetId);

        if (isKnobCapturing) {
            stopKnobCapture();
            return;
        }

        isKnobCapturing = true;
        activeKnobCaptureBtn = btnEl;
        btnEl.textContent = t('knob.pressKey');
        btnEl.classList.add('capturing');
        inputEl.value = t('editor.capture.listening');

        dialog.focus();

        dialog.onkeydown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const key = e.key.toUpperCase();

            if (key === 'ESCAPE') {
                inputEl.value = '';
                stopKnobCapture();
                return;
            }

            // Modifier logic
            let comboStr = '';
            if (e.ctrlKey) comboStr += 'CTRL+';
            if (e.altKey) comboStr += 'ALT+';
            if (e.shiftKey) comboStr += 'SHIFT+';
            if (e.metaKey) comboStr += 'GUI+';

            // Just modifiers pressed?
            if (key === 'CONTROL' || key === 'SHIFT' || key === 'ALT' || key === 'META') {
                inputEl.value = comboStr;
                return;
            }

            if (key === ' ') comboStr += 'SPACE';
            else if (key.length === 1) comboStr += key;
            else comboStr += key; // ENTER, TAB, etc.

            inputEl.value = comboStr;
            stopKnobCapture();

            // Auto-save after capture
            autoSaveKnobPageSettings();
        };
    };

    // Bind capture buttons
    dialog.querySelectorAll('.knob-capture-btn').forEach(btn => {
        // Remove old listeners to be safe (cloning trick)
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.onclick = () => {
            handleCapture(newBtn.dataset.target, newBtn);
        };
    });
    // --- CAPTURE LOGIC END ---

    // Apply Button - saves settings and closes dialog
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    newSaveBtn.onclick = () => {
        // Get current settings from UI
        const newSettings = {
            ledColor: ledColorInput.value,
            tailLength: parseInt(document.getElementById('knobTailVal').value) || 5,
            sensitivity: parseInt(document.getElementById('knobSensitivityRange').value),
            ledBrightness: parseInt(document.getElementById('ledBrightnessRange').value),
            cwAction: document.getElementById('knobCwAction').value,
            ccwAction: document.getElementById('knobCcwAction').value,
            clickSound: document.getElementById('knobClickSoundToggle')?.checked ?? true
        };

        if (currentKnobPage === 0) {
            // Page 1 (index 0) = save to main settings
            cfg.knob = { ...cfg.knob, ...newSettings };
        } else {
            // Pages 2+ - check if different from main before saving
            const mainSettings = {
                ledColor: cfg.knob?.ledColor || '#d946ef',
                tailLength: cfg.knob?.tailLength ?? 5,
                sensitivity: cfg.knob?.sensitivity ?? 10,
                ledBrightness: cfg.knob?.ledBrightness ?? 100,
                cwAction: cfg.knob?.cwAction ?? '',
                ccwAction: cfg.knob?.ccwAction ?? '',
                clickSound: cfg.knob?.clickSound ?? true
            };

            const isDifferent =
                newSettings.ledColor !== mainSettings.ledColor ||
                newSettings.tailLength !== mainSettings.tailLength ||
                newSettings.sensitivity !== mainSettings.sensitivity ||
                newSettings.ledBrightness !== mainSettings.ledBrightness ||
                newSettings.cwAction !== mainSettings.cwAction ||
                newSettings.ccwAction !== mainSettings.ccwAction ||
                newSettings.clickSound !== mainSettings.clickSound;

            if (isDifferent) {
                if (!cfg.knob.pages) cfg.knob.pages = {};
                cfg.knob.pages[currentKnobPage] = newSettings;
            } else if (cfg.knob?.pages?.[currentKnobPage]) {
                delete cfg.knob.pages[currentKnobPage];
            }
        }

        // Sync main LED color picker (only when on page 1)
        const mainLedPicker = document.getElementById('ledColor');
        if (mainLedPicker && currentKnobPage === 0) {
            mainLedPicker.value = ledColorInput.value;
        }

        saveConfig(); // Save to local storage
        applyKnobSettingsToDevice(); // Send to Arduino
        updateKnobForCurrentPage(); // Update main preview

        stopKnobCapture(); // Ensure capture stops
        showToast(t('knob.saved') || 'Knob settings saved', 'success');
        dialog.close(); // Close dialog after saving
    };

    // Close Button (X)
    const closeBtn = document.getElementById('knobCloseBtn');
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

    newCloseBtn.onclick = () => {
        stopKnobCapture();
        dialog.close();
    };

    // Cancel Button
    const cancelBtn = document.getElementById('knobCancelBtn');
    if (cancelBtn) {
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.onclick = () => {
            stopKnobCapture();
            dialog.close();
        };
    }

    // Apply translations to the dialog elements (Specifically the button text)
    applyTranslations();

    dialog.showModal();
    updateDialogPreview(); // Initial update
}

// Send Knob LED configuration to Arduino & Update UI Visuals
function applyKnobSettingsToDevice() {
    if (!cfg.knob) return;

    // 1. Send to Arduino
    const hex = cfg.knob.ledColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const tail = cfg.knob.tailLength;
    sendSerialCommand(`SET_KNOB:${r}:${g}:${b}:${tail}`);
    
    // LED Brightness gönder
    const brightness255 = Math.round(((cfg.knob.ledBrightness ?? 100) / 100) * 255);
    sendSerialCommand(`SET_LED_BRIGHTNESS:${brightness255}`);

    // 2. Update main knob LED visuals immediately
    updateKnobLeds(knobRotationAngle);
}

// Update knob preview based on current page settings
// Update knob LED preview only (no ESP32 command)
function updateKnobPreviewForCurrentPage() {
    const settings = getKnobPageSettings(currentPage);
    updateKnobLeds(knobRotationAngle, settings.ledColor, settings.tailLength);
}

function updateKnobForCurrentPage() {
    if (currentPage !== deviceCurrentPage) return;

    const settings = getKnobPageSettings(currentPage);

    // Update UI preview
    updateKnobLeds(knobRotationAngle, settings.ledColor, settings.tailLength);

    // --- DÜZELTME: Metni de anında güncelle ---
    updateKnobInfoText(currentPage);

    // Send to ESP32
    const hex = settings.ledColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    sendSerialCommand(`SET_KNOB:${r}:${g}:${b}:${settings.tailLength}`);
    
    // LED Brightness gönder
    const brightness255 = Math.round(((settings.ledBrightness ?? 100) / 100) * 255);
    sendSerialCommand(`SET_LED_BRIGHTNESS:${brightness255}`);
}

// Send knob settings for a specific page to ESP32 (without changing app's UI)
// Used when ESP32 changes page independently
function sendKnobSettingsForPage(pageIdx) {
    const settings = getKnobPageSettings(pageIdx);

    // Only send to ESP32, don't update app UI
    const hex = settings.ledColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    sendSerialCommand(`SET_KNOB:${r}:${g}:${b}:${settings.tailLength}`);
    
    // LED Brightness gönder
    const brightness255 = Math.round(((settings.ledBrightness ?? 100) / 100) * 255);
    sendSerialCommand(`SET_LED_BRIGHTNESS:${brightness255}`);
}

// Sync time with ESP32
function syncTimeWithDevice() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const cmd = `SET_TIME:${hours}:${minutes}:${seconds}`;
    sendSerialCommand(cmd);
}

// Sync sleep settings with ESP32 (called on connection)
function syncSleepSettingsWithDevice() {
    if (!cfg || !cfg.deviceSettings) return;

    const isOn = cfg.deviceSettings.sleepEnabled || false;
    const mins = cfg.deviceSettings.sleepMinutes || 5;
    const cmdVal = isOn ? mins : 0;

    sendSerialCommand(`SET_SLEEP:${cmdVal}`);
    
    // Sync deep sleep settings
    const isDeepSleepOn = cfg.deviceSettings.deepSleepEnabled || false;
    const deepSleepMins = cfg.deviceSettings.deepSleepMinutes || 30;
    const deepSleepCmdVal = (isOn && isDeepSleepOn) ? deepSleepMins : 0;
    sendSerialCommand(`SET_DEEP_SLEEP:${deepSleepCmdVal}`);

    // Also sync brightness
    const brightness = cfg.deviceSettings.brightness || 100;
    sendSerialCommand(`SET_BRIGHTNESS:${brightness}`);
}

// Send current page to ESP32 (for manual sync if needed)
// Note: This does NOT send knob settings - knob settings are only sent when ESP32 reports page change
function syncPageWithDevice() {
    sendSerialCommand(`SET_PAGE:${currentPage}`);
}
// ============================================================
// ULTRA SNAPPY KNOB LOGIC (ASYNC LOOP)
// ============================================================
// KNOB ACTION EXECUTION
// ============================================================

// Internal rotation tracking for LED position
let knobRotationAngle = 0;

// NEW: Raw angle tracking for smooth animation
let lastKnobRawAngle = null;
let knobActionAccumulator = 0;
const KNOB_FINE_TUNE = 15; // Higher = more sensitive at max setting

// Knob click sound audio element
let knobClickAudio = null;

// Play knob click sound
function playKnobClickSound() {
    // Note: clickSound check is done at call site with deviceActiveSettings
    try {
        if (!knobClickAudio) {
            knobClickAudio = new Audio('assets/knob.wav');
            knobClickAudio.volume = 0.5;
        }
        knobClickAudio.currentTime = 0;
        knobClickAudio.play().catch(() => { }); // Ignore errors
    } catch (e) {
        // Ignore audio errors
    }
}

// Flash zamanlayıcıları için global değişkenler
window.flashTimerCW = null;
window.flashTimerCCW = null;

function formatActionName(action) {
    // Eğer komut yoksa çizgi koy, varsa olduğu gibi döndür
    if (!action) return "-";
    return action;
}

function handleKnobRaw(rawAngle) {
    const deviceActiveSettings = getKnobPageSettings(deviceCurrentPage);

    // İlk okuma - başlatma
    if (lastKnobRawAngle === null) {
        lastKnobRawAngle = rawAngle;
        knobRotationAngle = (rawAngle / 4096) * 360;
        updateKnobLeds(knobRotationAngle, deviceActiveSettings.ledColor, deviceActiveSettings.tailLength);
        return;
    }

    // Açı farkı
    let delta = rawAngle - lastKnobRawAngle;
    if (delta > 2048) delta -= 4096;
    else if (delta < -2048) delta += 4096;

    lastKnobRawAngle = rawAngle;

    if (delta === 0) return;

    // Görsel Animasyon
    knobRotationAngle = (rawAngle / 4096) * 360;
    updateKnobLeds(knobRotationAngle, deviceActiveSettings.ledColor, deviceActiveSettings.tailLength);

    // Dialog güncellemesi
    const dialog = document.getElementById('knobSettingsDialog');
    if (dialog && dialog.open) {
        const ledColorInput = document.getElementById('knobLedColor');
        const tailValInput = document.getElementById('knobTailVal');
        if (ledColorInput && tailValInput) {
            updateDialogKnobLeds(knobRotationAngle, ledColorInput.value, parseInt(tailValInput.value) || 5);
        }
    }

    // Aksiyon Tetikleme
    knobActionAccumulator += delta;
    const sensitivity = deviceActiveSettings.sensitivity || 5;
    const threshold = 4096 / (sensitivity * KNOB_FINE_TUNE);

    if (Math.abs(knobActionAccumulator) >= threshold) {
        const isCw = knobActionAccumulator > 0;
        const action = isCw ? deviceActiveSettings.cwAction : deviceActiveSettings.ccwAction;

        // --- FLASH EFEKTİ (Burası handleKnobRaw'a özgü kalmalı) ---
        const labelCCW = document.getElementById('knobTextCCW');
        const labelCW = document.getElementById('knobTextCW');

        if (isCw && labelCW) {
            labelCW.classList.add('flash');
            if (window.flashTimerCW) clearTimeout(window.flashTimerCW);
            window.flashTimerCW = setTimeout(() => labelCW.classList.remove('flash'), 200);
        }
        else if (!isCw && labelCCW) {
            labelCCW.classList.add('flash');
            if (window.flashTimerCCW) clearTimeout(window.flashTimerCCW);
            window.flashTimerCCW = setTimeout(() => labelCCW.classList.remove('flash'), 200);
        }
        // --------------------------

        if (deviceActiveSettings.clickSound !== false) {
            playKnobClickSound();
        }

        if (action) {
            executeKnobCommand(action, isCw ? '+' : '-');
        }

        knobActionAccumulator = knobActionAccumulator % threshold;
    }
}

// NEW: Update LED Ring based on rotation (main knob only)
function updateKnobLeds(rotation, overrideColor = null, overrideTail = null, overrideOffset = null) {
    const arc = document.querySelector('#knobTriggerBtn .arc-active');
    if (!arc) return;

    const circumference = 584.34; // 2 * π * 93

    const tailLength = overrideTail !== null ? overrideTail : (cfg?.knob?.tailLength || 5);
    const ledColor = overrideColor !== null ? overrideColor : (cfg?.knob?.ledColor || '#d946ef');
    const ledOffset = overrideOffset !== null ? overrideOffset : (cfg?.knob?.ledOffset ?? 0);

    // Base offset (physical alignment) + user offset
    const BASE_OFFSET = 110;
    const totalOffset = BASE_OFFSET + ledOffset;

    // SMOOTH: Use rotation directly
    let normalizedRot = rotation % 360;
    if (normalizedRot < 0) normalizedRot += 360;

    // Arc length based on tail - each LED covers 22.5 degrees (360/16)
    const segmentSize = 36.52; // circumference / 16
    const arcLength = tailLength * segmentSize;

    // HEAD pozisyonu: rotation'ın gösterdiği yer
    const headAngle = normalizedRot + totalOffset;
    const tailAngle = tailLength * 22.5;
    const startAngle = headAngle - tailAngle - 90;  // -90 çünkü SVG saat 3'ten başlar

    // Set the arc - smooth rotation
    arc.style.stroke = ledColor;
    arc.style.strokeDasharray = `${arcLength} ${circumference - arcLength}`;
    arc.style.strokeDashoffset = 0;
    arc.style.transform = `rotate(${startAngle}deg)`;
    arc.style.transformOrigin = '100px 100px';
    arc.style.filter = `url(#glow) drop-shadow(0 0 8px ${ledColor})`;

    // Update indicator line - hizalı olması için headAngle kullan
    const indicator = document.querySelector('#knobTriggerBtn .knob-indicator');
    if (indicator) {
        indicator.style.setProperty('--indicator-color', ledColor);
        indicator.style.background = ledColor;
        indicator.style.boxShadow = `0 0 10px ${ledColor}, 0 0 20px ${ledColor}, 0 0 30px ${ledColor}`;
        // Rotate knob-body - indicator arc head ile hizalı
        const knobBody = document.querySelector('#knobTriggerBtn .knob-body');
        if (knobBody) {
            knobBody.style.transform = `rotate(${headAngle}deg)`;
        }
    }
}

// NEW: Update dialog LED Ring based on rotation
function updateDialogKnobLeds(rotation, overrideColor = null, overrideTail = null, overrideOffset = null) {
    const arc = document.querySelector('#dialogKnobLeds .arc-active');
    if (!arc) return;

    const circumference = 584.34; // 2 * π * 93

    const tailLength = overrideTail !== null ? overrideTail : (cfg?.knob?.tailLength || 5);
    const ledColor = overrideColor !== null ? overrideColor : (cfg?.knob?.ledColor || '#d946ef');
    const ledOffset = overrideOffset !== null ? overrideOffset : (cfg?.knob?.ledOffset ?? 0);

    // Base offset (physical alignment) + user offset
    const BASE_OFFSET = 110;
    const totalOffset = BASE_OFFSET + ledOffset;

    // SMOOTH: Use rotation directly
    let normalizedRot = rotation % 360;
    if (normalizedRot < 0) normalizedRot += 360;

    // Arc length based on tail
    const segmentSize = 36.52;
    const arcLength = tailLength * segmentSize;

    // HEAD pozisyonu - ESP ile hizalı
    const headAngle = normalizedRot + totalOffset;
    const tailAngle = tailLength * 22.5;
    const startAngle = headAngle - tailAngle - 90;

    // Set the arc - smooth rotation
    arc.style.stroke = ledColor;
    arc.style.strokeDasharray = `${arcLength} ${circumference - arcLength}`;
    arc.style.strokeDashoffset = 0;
    arc.style.transform = `rotate(${startAngle}deg)`;
    arc.style.transformOrigin = '100px 100px';
    arc.style.filter = `url(#glowDialog) drop-shadow(0 0 6px ${ledColor})`;

    // Update indicator line - hizalı
    const indicator = document.querySelector('#knobPreviewInDialog .knob-indicator');
    if (indicator) {
        indicator.style.setProperty('--indicator-color', ledColor);
        indicator.style.background = ledColor;
        indicator.style.boxShadow = `0 0 8px ${ledColor}, 0 0 16px ${ledColor}`;
        const knobBody = document.querySelector('#knobPreviewInDialog .knob-body');
        if (knobBody) {
            knobBody.style.transform = `rotate(${headAngle}deg)`;
        }
    }
}

// openKnobSettings is defined earlier - this duplicate was removed

// Asıl Komut Çalıştırıcı (Promise Döndürür)
async function executeKnobCommand(action, direction) {
    if (!action) return;

    const nircmdPath = `"${ASSETS_PATH}/nircmd.exe"`;

    // --- ÖZEL DURUM: SES (NirCmd ile) ---
    // Seste "çöpe atma" yapmak istemeyiz, ama üst üste binmesin diye buradayız.
    // Tek seferde büyük birim gönderelim.
    if (action === 'VOL_UP' || action === 'VOL_DOWN') {
        if (window.electronAPI.system) {
            // Sinyal başına ses değişimi (2000 = ~%3)
            const change = (action === 'VOL_UP') ? 2500 : -2500;
            // Await kullanmıyoruz, sistem komutu ateşleyip geçsin
            // NirCmd hızlıdır, üst üste binse de Windows halleder.
            window.electronAPI.system.runCommand(`${nircmdPath} changesysvolume ${change}`);
        } else {
            window.electronAPI.robot.keyTap(action === 'VOL_UP' ? 'audio_vol_up' : 'audio_vol_down');
        }
        return; // Hızlı çıkış
    }

    // --- ÖZEL DURUM: SCROLL (with optional modifiers like ALT+SCROLL_DOWN) ---
    const upperAction = action.toUpperCase();
    if (upperAction.includes('SCROLL_UP') || upperAction.includes('SCROLL_DOWN')) {
        const isScrollUp = upperAction.includes('SCROLL_UP');

        // Check for modifiers before SCROLL
        const parts = action.split('+').map(k => k.trim());
        const modifierMap = {
            'CTRL': 'control', 'ALT': 'alt', 'SHIFT': 'shift', 'WIN': 'command', 'GUI': 'command'
        };

        let modifiers = [];
        for (let i = 0; i < parts.length - 1; i++) {
            const partUpper = parts[i].toUpperCase();
            if (modifierMap[partUpper]) {
                modifiers.push(modifierMap[partUpper]);
            }
        }

        // Use NirCmd for scroll (better compatibility with Adobe apps)
        const nircmdPath = `"${ASSETS_PATH}/nircmd.exe"`;
        // NirCmd wheel: positive = up, negative = down
        const wheelAmount = isScrollUp ? 120 : -120;

        if (modifiers.length > 0) {
            // Hold modifier with RobotJS, scroll with NirCmd
            for (const mod of modifiers) {
                window.electronAPI.robot.keyToggle(mod, 'down');
            }
            await new Promise(r => setTimeout(r, 50));
            await window.electronAPI.system.runCommand(`${nircmdPath} sendmouse wheel ${wheelAmount}`);
            await new Promise(r => setTimeout(r, 50));
            for (const mod of modifiers) {
                window.electronAPI.robot.keyToggle(mod, 'up');
            }
        } else {
            // Plain scroll with NirCmd
            await window.electronAPI.system.runCommand(`${nircmdPath} sendmouse wheel ${wheelAmount}`);
        }
        return;
    }

    // --- ÖZEL DURUM: PARLAKLIK ---
    if (action === 'BRIGHT_UP' || action === 'BRIGHT_DOWN') {
        let b = cfg.deviceSettings.brightness;
        const change = (action === 'BRIGHT_UP') ? 5 : -5;
        b += change;
        if (b > 100) b = 100; if (b < 5) b = 5;

        // Serial komutu çok hızlıdır, beklemeye gerek yok
        sendSerialCommand(`SET_BRIGHTNESS:${b}`);
        cfg.deviceSettings.brightness = b;
        saveConfig(false);
        return;
    }

    // --- GENEL KLAVYE VE SCRIPTLER ---
    const isScript = action.toLowerCase().includes("nircmd") || action.toLowerCase().includes(".exe") || (action.includes(" ") && !action.includes("+"));

    if (isScript) {
        let finalCmd = action;
        if (finalCmd.toLowerCase().includes("nircmd")) {
            finalCmd = finalCmd.replace(/nircmd(\.exe)?/gi, nircmdPath);
        }
        // Scriptin bitmesini BEKLE (await)
        // Böylece script bitene kadar yeni knob hareketi gelirse yoksayılır.
        // Bu, "hayalet basışları" engelleyen kısımdır.
        await window.electronAPI.system.runCommand(finalCmd);
    } else {
        // Klavye Kısayolu (RobotJS)
        // RobotJS senkrondur ama biz yine de minik bir gecikme koyup
        // "insani" hız sınırında tutalım.
        parseAndExecuteKeyCombo(action);

        // 50ms yapay gecikme ekle. 
        // Bu sayede saniyede max 20 tuş basılabilir.
        // Bilgisayarı dondurmaz ve kuyruk oluşturmaz.
        await new Promise(r => setTimeout(r, 50));
    }
}


function ensureDefaults(data) {
    if (!data || typeof data !== 'object') data = {};
    // NEW: shadow added
    data.theme = data.theme || { bg: '101010', btn: '202020', text: 'FFFFFF', stroke: '555555', shadow: '000000' };

    // --- NEW ADDED BLOCK: Device Settings ---
    data.deviceSettings = data.deviceSettings || {};
    if (typeof data.deviceSettings.brightness === 'undefined') data.deviceSettings.brightness = 100; // Default 100%
    if (typeof data.deviceSettings.sleepEnabled === 'undefined') data.deviceSettings.sleepEnabled = false; // Default off
    if (typeof data.deviceSettings.sleepMinutes === 'undefined') data.deviceSettings.sleepMinutes = 5; // Default 5 min
    if (typeof data.deviceSettings.deepSleepEnabled === 'undefined') data.deviceSettings.deepSleepEnabled = false;
    if (typeof data.deviceSettings.deepSleepMinutes === 'undefined') data.deviceSettings.deepSleepMinutes = 30;
    // ------------------------------------------
    
    // --- Weather Settings ---
    data.weather = data.weather || {};
    if (typeof data.weather.city === 'undefined') data.weather.city = '';
    if (typeof data.weather.lat === 'undefined') data.weather.lat = null;
    if (typeof data.weather.lon === 'undefined') data.weather.lon = null;
    if (typeof data.weather.units === 'undefined') data.weather.units = 'celsius';
    // ------------------------
    
    data.knob = data.knob || {};
    data.knob.ledColor = data.knob.ledColor || '#d946ef';
    data.knob.tailLength = data.knob.tailLength || 5;
    data.knob.cwAction = data.knob.cwAction || 'VOL_UP';
    data.knob.ccwAction = data.knob.ccwAction || 'VOL_DOWN';

    if (!data.theme.stroke) data.theme.stroke = '555555';
    if (data.theme.shadow === undefined) data.theme.shadow = '000000'; // NEW

    data.device = data.device || { resolution: "800x480" };
    const currentProfile = DEVICE_PROFILES[data.device.resolution] || DEVICE_PROFILES["800x480"];

    data.grid = data.grid || { cols: currentProfile.maxCols, rows: currentProfile.maxRows };
    data.grid.cols = Math.min(data.grid.cols, currentProfile.maxCols);
    data.grid.rows = Math.min(data.grid.rows, currentProfile.maxRows);

    data.pageCount = Math.max(1, Number(data.pageCount || 1));
    data.pages = Array.isArray(data.pages) ? data.pages : [[]];
    data.currentPage = Math.max(0, Math.min(Number(data.currentPage || 0), data.pageCount - 1));
    data.iconSource = data.iconSource || 'default';
    data.userIconFolderName = data.userIconFolderName || null;

    data.deviceName = data.deviceName || '';
    data.pageNames = Array.isArray(data.pageNames) ? data.pageNames : [];

    while (data.pageNames.length < data.pageCount) {
        data.pageNames.push('');
    }
    data.pageNames = data.pageNames.slice(0, data.pageCount);


    if (data.pages) {
        data.pages.forEach(page => {
            if (Array.isArray(page)) {
                page.forEach(btn => {
                    if (btn && btn.icon && typeof btn.icon === 'string' && btn.icon.startsWith('blob:')) {
                        btn.icon = '';
                    }
                    if (btn && typeof btn.iconScale === 'undefined') {
                        btn.iconScale = 0;
                    }
                    if (btn && typeof btn.iconColor === 'undefined') {
                        btn.iconColor = '';
                    }
                });
            }
        });
    }

    el('#bgColor').value = '#' + data.theme.bg;
    el('#btnColor').value = '#' + data.theme.btn;
    el('#txtColor').value = '#' + data.theme.text;
    el('#strokeColor').value = '#' + data.theme.stroke;
    el('#shadowColor').value = '#' + data.theme.shadow; // NEW
    el('#deviceName').value = data.deviceName;
    document.title = data.deviceName || 'Deck Config';

    // Set title bar in web interface
    const webTitleEl = el('#web-title-text');
    if (webTitleEl) {
        webTitleEl.textContent = data.deviceName || 'Device Name';
    }

    GRID_COLS = data.grid.cols;
    GRID_ROWS = data.grid.rows;
    currentPage = data.currentPage;

    // --- NEW ADDED BLOCK: App Settings ---
    data.appSettings = data.appSettings || {};
    // 'showConfirm' = Always ask. 'minimize' = Minimize to Tray. 'exit' = Close directly.
    data.appSettings.defaultCloseAction = data.appSettings.defaultCloseAction || 'showConfirm';
    // --- NEW END ---


    return data;
}

// NEW: shadow added
function applyTheme() {
    document.documentElement.style.setProperty('--c-bg', '#' + cfg.theme.bg);
    document.documentElement.style.setProperty('--c-btn', '#' + cfg.theme.btn);
    document.documentElement.style.setProperty('--c-text', '#' + cfg.theme.text);
    document.documentElement.style.setProperty('--c-stroke', '#' + cfg.theme.stroke);
    document.documentElement.style.setProperty('--c-shadow', '#' + cfg.theme.shadow); // NEW
}

// === THEME SERIAL SYNC ===
// Debounced function to send theme to device
let themeSerialSyncTimeout = null;
function sendThemeToDevice() {
    if (!connectedSerialPort) return;

    const ledColor = cfg.knob?.ledColor || '#d946ef';
    // Convert hex to RGB
    const r = parseInt(ledColor.slice(1, 3), 16);
    const g = parseInt(ledColor.slice(3, 5), 16);
    const b = parseInt(ledColor.slice(5, 7), 16);

    const cmd = `SET_THEME:${cfg.theme.bg}:${cfg.theme.btn}:${cfg.theme.text}:${cfg.theme.stroke}:${cfg.theme.shadow}:${r}:${g}:${b}`;
    sendSerialCommand(cmd);
}

function debouncedThemeSync() {
    clearTimeout(themeSerialSyncTimeout);
    themeSerialSyncTimeout = setTimeout(sendThemeToDevice, 500);
}

function wireTheme() {
    const bg = el('#bgColor'), bn = el('#btnColor'), tx = el('#txtColor'), sk = el('#strokeColor'), sh = el('#shadowColor'), led = el('#ledColor');

    const upd = () => {
        cfg.theme.bg = bg.value.replace('#', '');
        cfg.theme.btn = bn.value.replace('#', '');
        cfg.theme.text = tx.value.replace('#', '');
        cfg.theme.stroke = sk.value.replace('#', '');
        cfg.theme.shadow = sh.value.replace('#', '');
        applyTheme();
        debounceSave();
        debouncedThemeSync(); // Send to device
    };
    [bg, bn, tx, sk, sh].forEach(i => i && i.addEventListener('input', upd));

    // LED color picker (syncs with knob settings)
    if (led) {
        led.value = cfg.knob?.ledColor || '#d946ef';
        led.addEventListener('input', () => {
            cfg.knob = cfg.knob || {};
            cfg.knob.ledColor = led.value;

            // Update knob visuals in app
            updateKnobLeds(knobRotationAngle, led.value);

            // Also update knob settings dialog if open
            const knobColorInput = document.getElementById('knobLedColor');
            if (knobColorInput) knobColorInput.value = led.value;

            debounceSave();
            debouncedThemeSync(); // Send to device with LED color
        });
    }

    el('#deviceName').addEventListener('input', (e) => {
        document.title = e.target.value || 'Deck Config';

        const webTitleEl = el('#web-title-text');
        if (webTitleEl) {
            // --- FIX (PROBLEM 1) ---
            // If box is empty, show translated title (e.g. Device Name)
            webTitleEl.textContent = e.target.value || t('device.frame.title');
            // --- FIX END ---
        }
        debounceSave();
    });

    // Send device name to ESP32 when input loses focus
    el('#deviceName').addEventListener('blur', (e) => {
        const newName = e.target.value.trim();
        if (newName && connectedSerialPort) {
            sendSerialCommand(`SET_DEVICE_NAME:${newName}`);
        }
    });

    const knobCheckbox = document.getElementById('showKnobCheckbox');
    if (knobCheckbox) {
        knobCheckbox.addEventListener('change', (e) => {
            if (!cfg.device) cfg.device = {};
            cfg.device.showKnob = e.target.checked;
            const knobLeft = document.querySelector('.knob-section-left');
            if (knobLeft) {
                knobLeft.style.display = e.target.checked ? 'flex' : 'none';
            }
            debounceSave();
        });
    }
}

function applyDeviceProfile(profileKey) {
    const profile = DEVICE_PROFILES[profileKey] || DEVICE_PROFILES["800x480"];

    DEV_W = profile.w;
    DEV_H = profile.h;
    CELL = profile.cell;
    MAX_COLS = profile.maxCols;
    MAX_ROWS = profile.maxRows;

    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--dev-w', DEV_W + 'px');
    rootStyle.setProperty('--dev-h', DEV_H + 'px');
    rootStyle.setProperty('--cell-w', CELL + 'px');

    // --- Radius Setting ---
    let radius = 24;
    if (profileKey === "480x320") {
        radius = 20;
    } else if (profileKey === "320x240") {
        radius = 12;
    }
    rootStyle.setProperty('--btn-radius', radius + 'px');

    // Update data-res attribute on device frame for CSS styling
    const frame = document.querySelector('.device-frame');
    if (frame) {
        frame.setAttribute('data-res', profileKey);
    }

    // Show/hide knob section based on profile or user toggle
    const knobLeft = document.querySelector('.knob-section-left');
    const knobCheckbox = document.getElementById('showKnobCheckbox');
    const shouldShowKnob = (cfg?.device?.showKnob !== undefined) ? cfg.device.showKnob : (profile.hasKnob !== false);
    if (knobLeft) {
        knobLeft.style.display = shouldShowKnob ? 'flex' : 'none';
    }
    if (knobCheckbox) {
        knobCheckbox.checked = shouldShowKnob;
    }

    if (!cfg) cfg = {};
    if (!cfg.device) cfg.device = {};
    cfg.device.resolution = profileKey;

    if (profileKey === "320x240" && (!cfg.grid || !cfg.grid.cols || cfg.grid.cols > 4)) {
        if (!cfg.grid) cfg.grid = {};
        cfg.grid.cols = 4;
        cfg.grid.rows = 2;
    }

    if (cfg.grid.cols > MAX_COLS) cfg.grid.cols = MAX_COLS;
    if (cfg.grid.rows > MAX_ROWS) cfg.grid.rows = MAX_ROWS;
    GRID_COLS = cfg.grid.cols;
    GRID_ROWS = cfg.grid.rows;

    applyGeometry(GRID_COLS, GRID_ROWS);
    populateGridControls();
    drawGrid();
    renderPageBar();
    saveConfig();
}


// FIXED: Function using special math for 480x320 & 320x240
function applyGeometry(cols, rows) {
    GRID_COLS = cols; GRID_ROWS = rows;
    document.documentElement.style.setProperty('--cols', GRID_COLS);
    document.documentElement.style.setProperty('--rows', GRID_ROWS);

    // --- Y (vertical) calculations ---
    const gridAvailableHeight = (DEV_H === 240) ? 150 : (DEV_H - 90);
    const totalCellHeight = GRID_ROWS * CELL;
    const remainingSpace = gridAvailableHeight - totalCellHeight;

    let gapY, padY_top, padY_bottom;
    const numGaps = GRID_ROWS - 1;

    if (remainingSpace < 0) {
        gapY = -2;
        padY_top = 0;
        padY_bottom = 0;
    } else if (numGaps > 0) {
        padY_top = 2;
        padY_bottom = 2;
        let space_for_gaps = remainingSpace - padY_top - padY_bottom;
        gapY = Math.floor(space_for_gaps / numGaps);
        let remainder = space_for_gaps % numGaps;
        padY_bottom += remainder;
    } else {
        gapY = 0;
        padY_top = Math.floor(remainingSpace / 2);
        padY_bottom = remainingSpace - padY_top;
    }

    // --- X (horizontal) calculations (NEW SHADOW CALCULATION) ---

    // 1. We know shadow offset from style.css (5px)
    const SHADOW_OFFSET_X = 5;

    // 2. Calculate gap between buttons (gapX) (Old logic)
    // (Finds a base value distributing all gaps (gap+pad) equally)
    let gapX = GRID_COLS > 1 ? Math.floor((DEV_W - GRID_COLS * CELL) / (GRID_COLS + 1)) : Math.floor((DEV_W - CELL) / 2);

    // 3. Calculate total padding space
    // (Total width - Cells - Gaps in between)
    const totalPaddingSpace = DEV_W - (GRID_COLS * CELL) - ((GRID_COLS - 1) * gapX);

    // 4. Calculate asymmetric padding (To balance shadow)
    // Left padding = (Total Padding - Shadow Margin) / 2
    // Right padding = (Total Padding + Shadow Margin) / 2
    let padX_left = Math.floor((totalPaddingSpace - SHADOW_OFFSET_X) / 2);
    let padX_right = Math.floor((totalPaddingSpace + SHADOW_OFFSET_X) / 2);

    // 5. Fix rounding errors (add drifting 1px to right)
    const remainderX = totalPaddingSpace - (padX_left + padX_right);
    padX_right += remainderX;

    // 6. Set CSS Variables
    document.documentElement.style.setProperty('--gapx', gapX + 'px');
    document.documentElement.style.setProperty('--gapy', gapY + 'px');

    // NEW: Set padding separately
    document.documentElement.style.setProperty('--padx-left', Math.max(0, padX_left) + 'px');
    document.documentElement.style.setProperty('--padx-right', Math.max(0, padX_right) + 'px');

    document.documentElement.style.setProperty('--pady-top', Math.max(0, padY_top) + 'px');
    document.documentElement.style.setProperty('--pady-bottom', Math.max(0, padY_bottom) + 'px');
}
function repartition(all, cap) { const pages = []; const count = Math.max(1, Math.ceil(all.length / cap) || 1); let i = 0; for (let p = 0; p < count; p++) { const arr = []; for (let j = 0; j < cap; j++) { arr.push(all[i++] || emptyBtn()); } pages.push(arr); } return pages; }

// Replace existing 'onGridChanged' function with this:

// Replace existing 'onGridChanged' function with this:

// Add this helper function IMMEDIATELY BEFORE previous 'onGridChanged' function:

/**
 * Extracts "Main" base name from a page name like "Main 2".
 */
function getBasePageName(name) {
    if (!name) return ""; // Empty names are not grouped
    // "Main 2" -> "Main"
    // "Main" -> "Main"
    // "Photoshop" -> "Photoshop"
    const match = name.match(/^(.*?)(\s\d+)?$/);
    // Return match [1] (main group) or name itself if no match
    return match ? match[1] : name;
}


// Now replace existing 'onGridChanged' function (line 904)
// COMPLETELY with this:

function onGridChanged(cols, rows) {
    const newCap = cols * rows; // New capacity per page
    const oldPages = cfg.pages;
    const oldPageNames = cfg.pageNames;

    const newPages = [];
    const newPageNames = [];
    const processedOldIndices = new Set(); // Track which old pages we processed

    for (let i = 0; i < oldPages.length; i++) {
        if (processedOldIndices.has(i)) continue; // This page already merged with a group

        const originalName = oldPageNames[i] || "";
        const baseName = getBasePageName(originalName);
        const buttonsToConsolidate = []; // All buttons to be consolidated

        // 1. Collect buttons of this page (i)
        const currentButtons = (oldPages[i] || []).filter(isFilled);
        buttonsToConsolidate.push(...currentButtons);
        processedOldIndices.add(i);

        // 2. Check if this page is empty
        const isThisPageOriginallyEmpty = currentButtons.length === 0;

        // 3. Find related other pages (IF not empty AND has a name)
        // (Those named "" are not grouped, preserved like "Empty Page")
        if (!isThisPageOriginallyEmpty && baseName !== "") {
            for (let j = i + 1; j < oldPages.length; j++) {
                if (processedOldIndices.has(j)) continue;

                const otherBaseName = getBasePageName(oldPageNames[j] || "");
                if (otherBaseName === baseName) {
                    // Matching page found (e.g. "Main 2" found)
                    const relatedButtons = (oldPages[j] || []).filter(isFilled);
                    buttonsToConsolidate.push(...relatedButtons);
                    processedOldIndices.add(j); // Mark this page as processed
                }
            }
        }

        // 4. Distribute collected buttons to new pages (or single page)
        if (buttonsToConsolidate.length === 0) {
            // This was an empty page, keep as empty
            newPages.push(Array.from({ length: newCap }, () => emptyBtn()));
            newPageNames.push(originalName); // Preserve original name ("" or "Empty Page")
        } else {
            // Resplit (or merge) filled pages according to new capacity
            let chunkCount = 0;
            for (let j = 0; j < buttonsToConsolidate.length; j += newCap) {
                chunkCount++;
                const chunk = buttonsToConsolidate.slice(j, j + newCap);
                const newPageArray = Array.from({ length: newCap }, () => emptyBtn());
                chunk.forEach((btn, idx) => newPageArray[idx] = btn);

                newPages.push(newPageArray);

                // Name the page
                const finalBaseName = (baseName === "") ? `Page ${i + 1}` : baseName;

                if (chunkCount === 1) {
                    // First part always takes the original base name
                    newPageNames.push(finalBaseName); // "Main" veya "Page 1"
                } else {
                    // Subsequent parts (if overflow) take name "Main 2"
                    newPageNames.push(`${finalBaseName} ${chunkCount}`);
                }
            }
        }
    }

    // Apply changes
    cfg.pages = newPages;
    cfg.pageNames = newPageNames;
    cfg.pageCount = newPages.length;
    cfg.grid = { cols, rows };

    // Update UI
    currentPage = Math.max(0, Math.min(currentPage, cfg.pageCount - 1));
    applyGeometry(cols, rows);
    populateGridControls();
    drawGrid();
    renderPageBar();
    saveConfig();

    // Send grid change to device
    sendSerialCommand(`SET_GRID:${cols}:${rows}`);
}


function shouldMultiLine(t) { if (!t) return false; t = String(t); return t.includes(' ') || t.length >= 8; }
function safeFont(cellPx, user) {
    const scale = (cellPx || 110) / 110.0;
    const base = user || 16;
    const scaled = Math.round(base * scale);
    return Math.min(Math.max(8, scaled), Math.round(26 * scale));
}

function applyLabelStyle(lab, btn) {
    lab.classList.remove('top', 'bottom', 'multi');
    if (btn.labelV === 'top') lab.classList.add('top');
    if (btn.labelV === 'bottom') lab.classList.add('bottom');

    const finalFontSize = safeFont(CELL, btn.labelSize);

    lab.style.fontSize = finalFontSize + 'px';
    lab.style.color = btn.labelColor || '';
    if (shouldMultiLine(btn.label)) lab.classList.add('multi');
}


// Replace existing 'isFilled' function with this:

// Replace existing 'isFilled' function with this (if not done already):

function isFilled(btn) {
    if (!btn) return false;
    // 1. If it has appearance, it is filled (icon or label)
    if (btn.icon || btn.label) return true;

    // 2. If it has action, it is filled (old ones)
    if (btn.type === 'goto' || btn.type === 'folder') return true; // goto/folder is always filled
    if (btn.type === 'key' && btn.combo) return true;
    if (btn.type === 'text' && btn.textMacro) return true;
    if (btn.type === 'app' && btn.appPath) return true;

    // --- NEW ADDED CHECKS ---
    if (btn.type === 'script' && btn.customScript) return true;
    if (btn.type === 'website' && btn.websiteUrl) return true;
    if (btn.type === 'media' && btn.mediaAction) return true;
    if (btn.type === 'timer' && btn.timerDuration > 0) return true;
    if (btn.type === 'counter') return true;
    // 'mouse' action is filled if it has settings other than default (click at 0,0)
    if (btn.type === 'mouse' && (
        btn.mouseConfig.event !== 'click' ||
        btn.mouseConfig.button !== 'left' ||
        btn.mouseConfig.x1 != 0 ||
        btn.mouseConfig.y1 != 0 ||
        btn.mouseConfig.x2 != 0 ||
        btn.mouseConfig.y2 != 0
    )) return true;
    
    // Multi-action is filled if it has at least one action
    if (btn.type === 'multi' && btn.multiActions && btn.multiActions.length > 0) return true;

    return false; // Everything else is empty
}

// --- SYNTHESIZED MECHANICAL HAPTIC SOUND (Web Audio API) ---
const AudioHaptic = {
    ctx: null,
    enabled: true,
    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) this.ctx = new AudioContext();
        }
    },
    playClick() {
        if (!this.enabled) return;
        try {
            this.init();
            if (!this.ctx) return;
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }
            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(1350, now);
            osc.frequency.exponentialRampToValueAtTime(110, now + 0.024);
            gain.gain.setValueAtTime(0.16, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.024);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(now);
            osc.stop(now + 0.025);
        } catch(e) {}
    }
};

function initActionPalette() {
    const collapseBtn = el('#collapsePaletteBtn');
    const panel = el('#actionPalettePanel');
    if (collapseBtn && panel) {
        collapseBtn.onclick = () => {
            panel.classList.toggle('collapsed');
            collapseBtn.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
        };
    }

    document.querySelectorAll('.action-chip[data-action]').forEach(chip => {
        chip.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', 'action-palette:' + chip.dataset.action);
            e.dataTransfer.effectAllowed = 'copy';
        });
    });

    const soundToggle = el('#mechanicalSoundToggle');
    if (soundToggle) {
        soundToggle.onchange = () => {
            AudioHaptic.enabled = soundToggle.checked;
        };
    }
}

function cellTemplate(i, incomingBtnData) {
    const div = document.createElement('div');
    div.className = 'cell';
    div.dataset.index = i;
    const currentBtn = cfg.pages[currentPage]?.[i];

    // --- DRAG & DROP LOGIC ---
    div.draggable = true;

    div.addEventListener('dragstart', e => {
        div.classList.add('dragging');
        const dragData = JSON.stringify({ sourcePage: currentPage, sourceIndex: i });
        e.dataTransfer.setData('application/json', dragData);
        e.dataTransfer.effectAllowed = 'move';
    });

    div.addEventListener('dragend', () => {
        document.querySelectorAll('.cell.dragover').forEach(c => c.classList.remove('dragover'));
        div.classList.remove('dragging');
    });

    div.addEventListener('dragenter', e => {
        document.querySelectorAll('.cell.dragover').forEach(c => c.classList.remove('dragover'));
        if (e.dataTransfer.types.includes('application/json') || e.dataTransfer.types.includes('text/plain')) {
            div.classList.add('dragover');
        }
    });

    div.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('application/json') || e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
        }
    });

    div.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        div.classList.remove('dragover');

        // Check for Action Palette drag
        const textPayload = e.dataTransfer.getData('text/plain');
        if (textPayload && textPayload.startsWith('action-palette:')) {
            const actionType = textPayload.replace('action-palette:', '');
            AudioHaptic.playClick();
            const existingBtn = Object.assign({}, emptyBtn(), cfg.pages[currentPage]?.[i]);
            existingBtn.type = actionType;
            if (!existingBtn.label || existingBtn.label.trim() === '') {
                existingBtn.label = actionType.charAt(0).toUpperCase() + actionType.slice(1);
            }
            openEditor(i, existingBtn);
            return;
        }

        const dragDataRaw = e.dataTransfer.getData('application/json');
        if (!dragDataRaw) return;
        const data = JSON.parse(dragDataRaw);

        // SCENARIO 1: Plugin veya Preset'ten Sürükleme
        if (data.sourceType === 'plugin-btn' || data.sourceType === 'preset-btn') {
            const incomingData = data.btnData;
            const basePath = data.basePath;
            const sourceId = data.pluginId || data.presetId;
            const buttonIndex = data.buttonIndex;

            const resolvePath = (p) => {
                if (!p || typeof p !== 'string') return p;
                if (p.match(/^(http|https|online:|data:|file:)/)) return p;
                if (basePath) {
                    const cleanBase = basePath.replace(/\\/g, '/');
                    const cleanPath = p.replace(/\\/g, '/').replace(/^\//, '');
                    return `file:///${cleanBase}/${cleanPath}`;
                }
                return p;
            };

            if (incomingData.icon) incomingData.icon = resolvePath(incomingData.icon);
            if (incomingData.soundPath) incomingData.soundPath = resolvePath(incomingData.soundPath);
            if (incomingData.appPath && !incomingData.appPath.includes(':')) incomingData.appPath = resolvePath(incomingData.appPath);

            if (incomingData.toggleData && incomingData.toggleData.iconOn) {
                incomingData.toggleData.iconOn = resolvePath(incomingData.toggleData.iconOn);
            }

            if (incomingData.combos) {
                const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                const selectedCombo = isMac
                    ? (incomingData.combos.mac || incomingData.combos.win)
                    : (incomingData.combos.win || incomingData.combos.mac);
                if (selectedCombo) incomingData.combo = selectedCombo;
            }

            const newBtn = Object.assign(emptyBtn(), incomingData);

            if (data.sourceType === 'plugin-btn') newBtn._pluginId = sourceId;
            if (data.sourceType === 'preset-btn') newBtn._presetId = sourceId;
            newBtn._buttonIndex = buttonIndex;

            cfg.pages[currentPage][i] = newBtn;

            // Not: Plugin sürükleyince de cihaza göndermek istersen buraya SET_BTN_DATA ekleyebilirsin.
            // Şimdilik sadece kaydetme yapıyoruz.
            drawGrid();
            saveConfig();
            return;
        }

        // SCENARIO 2: Yer Değiştirme (Swap)
        const fromPage = data.sourcePage;
        const fromIndex = data.sourceIndex;
        const toPage = currentPage;
        const toIndex = i;

        if (fromPage === toPage && fromIndex === toIndex) return;

        const pFrom = cfg.pages[fromPage];
        const pTo = cfg.pages[toPage];

        // Swap işlemi
        [pFrom[fromIndex], pTo[toIndex]] = [pTo[toIndex], pFrom[fromIndex]];

        drawGrid();
        saveConfig();

        if (fromPage === toPage) {
            sendSerialCommand(`SWAP_BTN:${toPage}:${fromIndex}:${toIndex}`);
        }
    });

    // --- BUTTON CONTENT ---
    if (currentBtn && isFilled(currentBtn)) {
        // CLOSE (DELETE) BUTTON
        const x = document.createElement('div');
        x.className = 'close';
        x.textContent = '×';
        x.title = 'Clear Button';

        x.onclick = (e) => {
            e.stopPropagation();

            // 1. Config'i Temizle (Lokal)
            cfg.pages[currentPage][i] = emptyBtn();

            // 2. Cihaza "Boşalt" Emri Gönder (Remote)
            if (connectedSerialPort) {
                sendSerialCommand(`CLEAR_BTN:${currentPage}:${i}`);
            }

            drawGrid();
            saveConfig();
        };
        div.appendChild(x);

        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';

        // --- APPEARANCE LOGIC ---
        let finalBgColor = currentBtn.btnBgColor || '';
        let finalIconName = currentBtn.icon;
        let finalIconColor = currentBtn.iconColor || '';

        // Toggle State Check
        if (currentBtn.type === 'toggle') {
            const isStateOn = currentBtn.toggleState === true;
            if (isStateOn) {
                finalBgColor = currentBtn.toggleData?.onColor || '#2ecc71';
                if (currentBtn.toggleData?.iconOn) {
                    finalIconName = currentBtn.toggleData.iconOn;
                }
                if (currentBtn.toggleData?.onIconColor) {
                    finalIconColor = currentBtn.toggleData.onIconColor;
                } else {
                    finalIconColor = '#ffffff';
                }
            }
        }

        if (finalBgColor) b.style.backgroundColor = finalBgColor;
        else b.style.backgroundColor = '';

        // Icon Elements
        const iconI = document.createElement('i');
        iconI.className = 'icon-img';
        iconI.style.display = 'none';

        const iconImg = document.createElement('img');
        iconImg.className = 'icon-img';
        iconImg.style.display = 'none';

        if (finalIconName && currentBtn.type !== 'timer') {
            const imgUrl = getIconUrl(finalIconName);
            if (imgUrl) {
                const isRawImage = imgUrl.startsWith('data:') || imgUrl.startsWith('file:');
                const scaleValue = 1 + ((currentBtn.iconScale || 0) / 100.0);
                const transformStyle = `scale(${Math.max(0.1, scaleValue)})`;

                if (isRawImage) {
                    iconImg.src = imgUrl;
                    iconImg.style.display = 'block';
                    iconImg.style.transform = transformStyle;
                } else {
                    iconI.style.display = 'block';
                    iconI.style.transform = transformStyle;

                    const isColored = typeof COLORED_ICON_SETS !== 'undefined' && COLORED_ICON_SETS.some(s => imgUrl.toLowerCase().includes(s));
                    let effectiveColor = finalIconColor;
                    if (!effectiveColor && !isColored) {
                        // Monochrome icons default to white on dark buttons so they are visible
                        effectiveColor = '#ffffff';
                    }

                    if (effectiveColor && !isColored) {
                        iconI.style.backgroundColor = effectiveColor;
                        iconI.style.webkitMaskImage = `url("${imgUrl}")`;
                        iconI.style.maskImage = `url("${imgUrl}")`;
                        iconI.style.backgroundImage = 'none';
                    } else {
                        iconI.style.backgroundColor = 'transparent';
                        iconI.style.webkitMaskImage = 'none';
                        iconI.style.maskImage = 'none';
                        iconI.style.backgroundImage = `url("${imgUrl}")`;
                    }
                }
            }
        }

        b.appendChild(iconI);
        b.appendChild(iconImg);

        // Label / Counter / Timer
        let labelText = currentBtn.label;
        if (currentBtn.type === 'counter') {
            // counterCurrentValue > label > counterStartValue
            if (currentBtn.counterCurrentValue !== undefined) {
                labelText = String(currentBtn.counterCurrentValue);
            } else {
                labelText = currentBtn.label || String(currentBtn.counterStartValue || 0);
            }
        } else if (currentBtn.type === 'timer') {
            // Check if timer is running in activeTimerTargets
            const timerKey = `${currentPage}_${i}`;
            const targetTime = activeTimerTargets[timerKey];
            if (targetTime) {
                const remaining = Math.ceil((targetTime - Date.now()) / 1000);
                if (remaining > 0) {
                    const min = Math.floor(remaining / 60);
                    const sec = remaining % 60;
                    labelText = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
                } else {
                    // Timer expired, clean up
                    delete activeTimerTargets[timerKey];
                }
            }
        }

        if (labelText) {
            const lab = document.createElement('div');
            lab.className = 'label';
            lab.textContent = labelText;
            applyLabelStyle(lab, currentBtn);
            b.appendChild(lab);
        }

        if (currentBtn.type === 'folder') {
            b.classList.add('is-folder');
        }

        b.onclick = () => {
            AudioHaptic.playClick();
            openEditor(i, currentBtn);
        };

        if (currentBtn.type === 'goto' || currentBtn.type === 'folder') {
            b.ondblclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (currentBtn.gotoPage !== undefined && currentBtn.gotoPage < cfg.pageCount) {
                    currentPage = currentBtn.gotoPage;
                    drawGrid();
                    renderPageBar();
                    saveConfig(false);
                }
            };
        }

        // Right-click context menu
        b.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, i, currentBtn);
        });

        div.appendChild(b);
    } else {
        // EMPTY CELL
        const plus = document.createElement('button');
        plus.className = 'plus';
        plus.textContent = '+';
        plus.onclick = () => {
            AudioHaptic.playClick();
            openEditor(i, emptyBtn());
        };

        plus.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, i, null);
        });

        div.appendChild(plus);
    }
    return div;
}

// ============================================
// CONTEXT MENU (Right-click on buttons)
// ============================================

let contextMenuClipboard = null;

function showContextMenu(x, y, btnIndex, btnData) {
    // Remove existing menu if any
    hideContextMenu();

    const menu = document.createElement('div');
    menu.id = 'contextMenu';
    menu.className = 'context-menu';

    const hasData = btnData && isFilled(btnData);
    const hasClipboard = contextMenuClipboard !== null;

    // --- COPY ---
    const copyItem = document.createElement('div');
    copyItem.className = `context-menu-item ${!hasData ? 'disabled' : ''}`;
    copyItem.innerHTML = `<span>${t('contextMenu.copy') || 'Copy'}</span>`;

    if (hasData) {
        copyItem.onclick = () => {
            contextMenuClipboard = JSON.parse(JSON.stringify(btnData));
            showToast(t('contextMenu.copied') || 'Button copied', 'success');
            hideContextMenu();
        };
    }
    menu.appendChild(copyItem);

    // --- PASTE (SYNC ADDED) ---
    const pasteItem = document.createElement('div');
    pasteItem.className = `context-menu-item ${!hasClipboard ? 'disabled' : ''}`;
    pasteItem.innerHTML = `<span>${t('contextMenu.paste') || 'Paste'}</span>`;

    if (hasClipboard) {
        pasteItem.onclick = () => {
            // 1. Veriyi Kopyala (Lokal)
            const newBtnData = JSON.parse(JSON.stringify(contextMenuClipboard));
            cfg.pages[currentPage][btnIndex] = newBtnData;

            // 2. Cihaza Gönder (Remote)
            if (connectedSerialPort) {
                const payloadObj = JSON.parse(JSON.stringify(newBtnData));

                // A) Renk Düzeltmeleri (# işaretini kaldır)
                if (payloadObj.btnBgColor) payloadObj.btnColor = payloadObj.btnBgColor.replace('#', '');
                if (payloadObj.labelColor) payloadObj.labelColor = payloadObj.labelColor.replace('#', '');
                if (payloadObj.toggleData && payloadObj.toggleData.onColor) {
                    payloadObj.toggleData.onColor = payloadObj.toggleData.onColor.replace('#', '');
                }

                // B) Timer Düzeltmesi
                if (payloadObj.timerDuration !== undefined) payloadObj.duration = payloadObj.timerDuration;

                // C) İkon temizliği (Base64/Path koruması)
                if (payloadObj.icon) {
                    if (payloadObj.icon.startsWith('data:') || payloadObj.icon.length > 100) {
                        payloadObj.icon = "";
                    } else {
                        const parts = payloadObj.icon.split(/[\\/]/);
                        payloadObj.icon = parts[parts.length - 1].split('?')[0];
                    }
                }
                // Toggle ikon temizliği
                if (payloadObj.toggleData && payloadObj.toggleData.iconOn) {
                    if (payloadObj.toggleData.iconOn.startsWith('data:') || payloadObj.toggleData.iconOn.length > 100) {
                        payloadObj.toggleData.iconOn = "";
                    } else {
                        const parts = payloadObj.toggleData.iconOn.split(/[\\/]/);
                        payloadObj.toggleData.iconOn = parts[parts.length - 1].split('?')[0];
                    }
                }

                const jsonString = JSON.stringify(payloadObj);
                sendSerialCommand(`SET_BTN_DATA:${currentPage}:${btnIndex}:${jsonString}`);
            }

            drawGrid();
            saveConfig();
            showToast(t('contextMenu.pasted') || 'Button pasted', 'success');
            hideContextMenu();
        };
    }
    menu.appendChild(pasteItem);

    // --- PREVIEW/TEST (Butonu çalıştır) ---
    if (hasData) {
        const previewItem = document.createElement('div');
        previewItem.className = 'context-menu-item';
        previewItem.innerHTML = `<span>▶ ${t('contextMenu.preview') || 'Test'}</span>`;
        
        previewItem.onclick = () => {
            hideContextMenu();
            // Kısa bir gecikme ile çalıştır (menü kapansın)
            setTimeout(() => {
                executeButtonAction(currentPage, btnIndex);
                showToast(t('contextMenu.previewExecuted') || 'Action executed', 'success', 1500);
            }, 50);
        };
        menu.appendChild(previewItem);
    }

    // --- SEPARATOR ---
    if (hasData) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        menu.appendChild(sep);

        // --- DELETE (SYNC ADDED) ---
        const deleteItem = document.createElement('div');
        deleteItem.className = 'context-menu-item danger';
        deleteItem.innerHTML = `<span>${t('contextMenu.delete') || 'Delete'}</span>`;

        deleteItem.onclick = () => {
            // 1. Config'i Temizle (Lokal)
            cfg.pages[currentPage][btnIndex] = emptyBtn();

            // 2. Cihaza "Boşalt" Emri Gönder (Remote)
            if (connectedSerialPort) {
                sendSerialCommand(`CLEAR_BTN:${currentPage}:${btnIndex}`);
            }

            drawGrid();
            saveConfig();
            showToast(t('contextMenu.deleted') || 'Button deleted', 'info');
            hideContextMenu();
        };
        menu.appendChild(deleteItem);
    }

    // --- CREATE / OPEN / GROUP FOLDER ---
    if (!hasData) {
        const folderItem = document.createElement('div');
        folderItem.className = 'context-menu-item';
        folderItem.innerHTML = `<span>📁 ${t('contextMenu.createFolder') || 'Utwórz folder'}</span>`;
        folderItem.onclick = () => {
            hideContextMenu();
            createFolderAtCell(currentPage, btnIndex);
        };
        menu.appendChild(folderItem);
    } else if (btnData.type === 'folder' || btnData.type === 'goto') {
        const openFolderItem = document.createElement('div');
        openFolderItem.className = 'context-menu-item';
        openFolderItem.innerHTML = `<span>📂 ${t('contextMenu.openFolder') || 'Otwórz ten folder'}</span>`;
        openFolderItem.onclick = () => {
            hideContextMenu();
            const targetPage = Number(btnData.gotoPage) || 0;
            if (targetPage >= 0 && targetPage < cfg.pageCount) {
                currentPage = targetPage;
                drawGrid();
                renderPageBar();
                saveConfig(false);
                if (connectedSerialPort) {
                    sendSerialCommand(`SET_PAGE:${targetPage}`);
                }
            }
        };
        menu.appendChild(openFolderItem);
    } else {
        const groupItem = document.createElement('div');
        groupItem.className = 'context-menu-item';
        groupItem.innerHTML = `<span>📁 ${t('contextMenu.groupInFolder') || 'Zgrupuj w nowy folder'}</span>`;
        groupItem.onclick = () => {
            hideContextMenu();
            groupIntoFolder(currentPage, btnIndex);
        };
        menu.appendChild(groupItem);
    }

    document.body.appendChild(menu);

    // Get menu dimensions after adding to DOM
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Position menu logic
    let finalX = x;
    let finalY = y;

    if (x + menuRect.width > viewportWidth) finalX = x - menuRect.width;
    if (y + menuRect.height > viewportHeight) finalY = y - menuRect.height;

    finalX = Math.max(5, Math.min(finalX, viewportWidth - menuRect.width - 5));
    finalY = Math.max(5, Math.min(finalY, viewportHeight - menuRect.height - 5));

    menu.style.left = finalX + 'px';
    menu.style.top = finalY + 'px';

    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', hideContextMenu, { once: true });
        document.addEventListener('contextmenu', hideContextMenu, { once: true });
    }, 10);
}

function hideContextMenu() {
    const menu = document.getElementById('contextMenu');
    if (menu) menu.remove();
}

function createFolderAtCell(sourcePage, cellIndex, defaultName = '') {
    const defaultVal = defaultName || `Folder ${cfg.pageCount + 1}`;
    const folderName = prompt('Podaj nazwę nowego folderu:', defaultVal);
    if (!folderName || !folderName.trim()) return;

    const trimmedName = folderName.trim();
    const newPageIndex = cfg.pageCount;
    cfg.pageCount++;

    if (!cfg.pages[newPageIndex]) {
        cfg.pages[newPageIndex] = Array.from({ length: GRID_COLS * GRID_ROWS }, () => emptyBtn());
    }
    if (!cfg.pageNames) cfg.pageNames = [];
    cfg.pageNames[newPageIndex] = `📁 ${trimmedName}`;

    // Slot 0 in new page: "⬅️ Wróć"
    const backBtn = emptyBtn();
    backBtn.type = 'goto';
    backBtn.gotoPage = sourcePage;
    backBtn.label = 'Wróć';
    backBtn.labelV = 'bottom';
    backBtn.labelSize = 12;
    backBtn.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
    backBtn.btnBgColor = '#1e293b';
    backBtn.labelColor = '#ffffff';
    cfg.pages[newPageIndex][0] = backBtn;

    // Slot at cellIndex in sourcePage: folder button
    const folderBtn = emptyBtn();
    folderBtn.type = 'folder';
    folderBtn.gotoPage = newPageIndex;
    folderBtn.label = trimmedName;
    folderBtn.labelV = 'bottom';
    folderBtn.labelSize = 12;
    folderBtn.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    folderBtn.btnBgColor = '#1e293b';
    folderBtn.labelColor = '#ffffff';
    cfg.pages[sourcePage][cellIndex] = folderBtn;

    saveConfig();
    drawGrid();
    renderPageBar();
    showToast(`Utworzono folder "${trimmedName}"!`, 'success');
}

function groupIntoFolder(sourcePage, cellIndex) {
    const currentBtn = cfg.pages[sourcePage][cellIndex];
    if (!currentBtn || !isFilled(currentBtn)) return;

    const defaultVal = currentBtn.label ? `${currentBtn.label} Folder` : `Folder ${cfg.pageCount + 1}`;
    const folderName = prompt('Podaj nazwę nowego folderu:', defaultVal);
    if (!folderName || !folderName.trim()) return;

    const trimmedName = folderName.trim();
    const newPageIndex = cfg.pageCount;
    cfg.pageCount++;

    if (!cfg.pages[newPageIndex]) {
        cfg.pages[newPageIndex] = Array.from({ length: GRID_COLS * GRID_ROWS }, () => emptyBtn());
    }
    if (!cfg.pageNames) cfg.pageNames = [];
    cfg.pageNames[newPageIndex] = `📁 ${trimmedName}`;

    // Slot 0 in new page: "⬅️ Wróć"
    const backBtn = emptyBtn();
    backBtn.type = 'goto';
    backBtn.gotoPage = sourcePage;
    backBtn.label = 'Wróć';
    backBtn.labelV = 'bottom';
    backBtn.labelSize = 12;
    backBtn.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
    backBtn.btnBgColor = '#1e293b';
    backBtn.labelColor = '#ffffff';
    cfg.pages[newPageIndex][0] = backBtn;

    // Slot 1 in new page: copy of current button
    cfg.pages[newPageIndex][1] = JSON.parse(JSON.stringify(currentBtn));

    // The cell in sourcePage becomes folder button
    const folderBtn = emptyBtn();
    folderBtn.type = 'folder';
    folderBtn.gotoPage = newPageIndex;
    folderBtn.label = trimmedName;
    folderBtn.labelV = 'bottom';
    folderBtn.labelSize = 12;
    folderBtn.icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%233B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    folderBtn.btnBgColor = '#1e293b';
    folderBtn.labelColor = '#ffffff';
    cfg.pages[sourcePage][cellIndex] = folderBtn;

    saveConfig();
    drawGrid();
    renderPageBar();
    showToast(`Przeniesiono do folderu "${trimmedName}"!`, 'success');
}

function drawGrid() {
    // 1. Stop old visual timers (CPU saving)
    clearAllActiveTimers();

    const root = el('#grid');
    root.innerHTML = '';
    const pageData = cfg.pages[currentPage] || [];
    const totalCells = GRID_COLS * GRID_ROWS;

    for (let i = 0; i < totalCells; i++) {
        root.appendChild(cellTemplate(i, pageData[i] || emptyBtn()));
    }

    

    // ... (previous codes) ...

    // 2. NEW: Check if there is a timer running in background on this page and restore
    for (const key in activeTimerTargets) {
        const parts = key.split('_');
        const pIdx = parseInt(parts[0]);
        const bIdx = parseInt(parts[1]);

        // Restore only timers of this page and those not expired
        if (pIdx === currentPage) {
            const targetTime = activeTimerTargets[key];
            if (targetTime > Date.now()) {
                startVisualTimer(bIdx, targetTime);
            } else {
                // If expired, clear from memory (Garbage collection)
                delete activeTimerTargets[key];
            }
        }
    }

    // Update knob preview based on current page settings (UI only)
    const activeDeviceSettings = getKnobPageSettings(deviceCurrentPage);

    updateKnobLeds(
        knobRotationAngle,
        activeDeviceSettings.ledColor,
        activeDeviceSettings.tailLength
    );
} // drawGrid End
function updatePreviewEl(tmp) {
    const lab = el('#previewLabel');
    lab.textContent = tmp.label || '';
    applyLabelStyle(lab, {
        ...tmp,
        labelSize: safeFont(110, tmp.labelSize)
    });

    const imgUrl = getIconUrl(tmp.icon);
    const iconEl = el('#previewIcon');     // <i>
    const rawImgEl = el('#previewImgRaw'); // <img>

    // Hide by default
    iconEl.style.display = 'none';
    if (rawImgEl) rawImgEl.style.display = 'none';

    if (imgUrl && imgUrl.length > 5) {
        const isRawImage = imgUrl.startsWith('data:') || imgUrl.startsWith('file:');
        const scaleValue = 1 + ((tmp.iconScale || 0) / 100.0);
        const transformStyle = `scale(${Math.max(0.1, scaleValue)})`;

        if (isRawImage) {
            // --- LOCAL IMAGE MODE ---
            if (rawImgEl) {
                rawImgEl.style.display = 'block';
                // Src assignment (Cache breaking with Timestamp)
                // Note: Since there is instant change in editor, adding timestamp every time might cause flickering.
                // Let's add only if 'file:' and URL changed.
                const newSrc = imgUrl.startsWith('file:') ? (imgUrl + '?t=' + Date.now()) : imgUrl;

                // Update only if source really changed (to prevent flicker)
                // Since query string changes in file:// urls, we can check this via base path
                const currentSrcBase = rawImgEl.src.split('?')[0];
                const newSrcBase = imgUrl.split('?')[0];

                if (currentSrcBase !== newSrcBase || !rawImgEl.src) {
                    rawImgEl.src = newSrc;
                }

                rawImgEl.style.transform = transformStyle;
            }
        } else {
            // --- ONLINE ICON MODE ---
            iconEl.style.display = 'block';

            iconEl.style.webkitMaskImage = 'none';
            iconEl.style.maskImage = 'none';
            iconEl.style.backgroundImage = 'none';
            iconEl.style.backgroundColor = 'transparent';

            const isColored = typeof COLORED_ICON_SETS !== 'undefined' && COLORED_ICON_SETS.some(s => imgUrl.toLowerCase().includes(s));
            let effectiveColor = tmp.iconColor || '';
            if (!effectiveColor && !isColored) {
                effectiveColor = '#ffffff';
            }

            if (effectiveColor && !isColored) {
                iconEl.style.backgroundColor = effectiveColor;
                iconEl.style.webkitMaskImage = `url("${imgUrl}")`;
                iconEl.style.maskImage = `url("${imgUrl}")`;
            } else {
                iconEl.style.backgroundImage = `url("${imgUrl}")`;
            }
            iconEl.style.transform = transformStyle;
        }
    }

    const previewBtn = el('#editor .previewBtn');
    if (previewBtn) {
        previewBtn.style.backgroundColor = tmp.btnBgColor || '';
    }

    // Live 1:1 Hardware LCD Simulation Render
    renderEditorLiveHardware(tmp);
}

function renderEditorLiveHardware(tmp) {
    const canvas = el('#editorLiveHardwareCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width || 128;
    ctx.clearRect(0, 0, size, size);

    // 1. Background
    let bgColor = '#' + (cfg.theme.btn || '161D2B');
    if (tmp && tmp.btnBgColor) {
        bgColor = tmp.btnBgColor;
    }
    if (tmp.type === 'toggle' && tmp.toggleState === true && tmp.toggleData?.onColor) {
        bgColor = tmp.toggleData.onColor;
    }

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);

    // 2. Specular glass sheen highlight
    const glassGrad = ctx.createLinearGradient(0, 0, 0, Math.round(size * 0.45));
    glassGrad.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
    glassGrad.addColorStop(0.15, 'rgba(255, 255, 255, 0.08)');
    glassGrad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = glassGrad;
    ctx.fillRect(0, 0, size, Math.round(size * 0.45));

    // Inner bevel border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);

    const hasIcon = Boolean(tmp.icon && tmp.icon.length > 0);
    const hasLabel = Boolean(tmp.label && tmp.label.trim().length > 0 && tmp.type !== 'counter');

    const drawTextAndBadges = () => {
        if (hasLabel) {
            const text = tmp.label.trim();
            const padding = Math.max(3, Math.round(size * 0.05));
            const maxWidth = (size * 0.92) - (padding * 2);
            let fontPx = safeFont(size, tmp.labelSize);

            const words = text.split(/\s+/);
            for (let testSize = fontPx; testSize >= 8; testSize--) {
                ctx.font = `700 ${testSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
                let allWordsFit = true;
                for (const w of words) {
                    if (ctx.measureText(w).width > maxWidth) {
                        allWordsFit = false;
                        break;
                    }
                }
                fontPx = testSize;
                if (allWordsFit) break;
            }

            ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const lineHeight = Math.round(fontPx * 1.18);

            let lines = [];
            let currentLine = '';
            for (let i = 0; i < words.length; i++) {
                const w = words[i];
                const testLine = currentLine ? (currentLine + ' ' + w) : w;
                if (ctx.measureText(testLine).width <= maxWidth) {
                    currentLine = testLine;
                } else {
                    if (currentLine) lines.push(currentLine);
                    currentLine = w;
                }
            }
            if (currentLine) lines.push(currentLine);
            if (lines.length > 2) lines = lines.slice(0, 2);

            const totalTextHeight = lines.length * lineHeight;
            let y;
            const vPos = tmp.labelV || (hasIcon ? 'bottom' : 'middle');
            if (vPos === 'top') {
                y = padding + (lineHeight / 2);
            } else if (vPos === 'bottom') {
                y = (size - padding) - totalTextHeight + (lineHeight / 2);
            } else {
                y = (size - totalTextHeight) / 2 + (lineHeight / 2);
            }

            const centerX = size / 2;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
            ctx.lineWidth = Math.max(2, Math.round(fontPx * 0.22));

            for (let k = 0; k < lines.length; k++) {
                const lineY = Math.round(y + (k * lineHeight));
                ctx.strokeText(lines[k].trim(), centerX, lineY);
            }

            ctx.fillStyle = tmp.labelColor || '#FFFFFF';
            for (let k = 0; k < lines.length; k++) {
                const lineY = Math.round(y + (k * lineHeight));
                ctx.fillText(lines[k].trim(), centerX, lineY);
            }
        }

        // Folder badge
        if (tmp.type === 'folder') {
            const tabW = Math.round(size * 0.28);
            const tabH = Math.round(size * 0.16);
            const rX = size - tabW - 3;
            const rY = 3;
            ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(rX, rY, tabW, tabH, 3);
            else ctx.rect(rX, rY, tabW, tabH);
            ctx.fill();
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `bold ${Math.round(size * 0.085)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('DIR', rX + tabW / 2, rY + tabH / 2);
        }

        // Toggle LED
        if (tmp.type === 'toggle') {
            const ledR = Math.max(3, Math.round(size * 0.045));
            const ledX = size - ledR - 6;
            const ledY = ledR + 6;
            const isStateOn = Boolean(tmp.toggleState);
            ctx.beginPath();
            ctx.arc(ledX, ledY, ledR * 1.8, 0, Math.PI * 2);
            ctx.fillStyle = isStateOn ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.25)';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(ledX, ledY, ledR, 0, Math.PI * 2);
            ctx.fillStyle = isStateOn ? '#22c55e' : '#64748b';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(ledX - ledR * 0.3, ledY - ledR * 0.3, ledR * 0.35, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();
        }
    };

    if (hasIcon) {
        const iconUrl = getIconUrl(tmp.icon);
        const img = new Image();
        if (/^https?:\/\//i.test(iconUrl)) img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const scalePercent = (tmp.iconScale || 0);
                const scaleValue = 1 + (scalePercent / 100.0);
                const finalScale = Math.max(0.1, scaleValue);
                let iconAreaRatio = 0.65;
                let yOffset = 0;
                if (hasLabel) {
                    const vPos = tmp.labelV || 'bottom';
                    if (vPos === 'bottom') {
                        iconAreaRatio = 0.60;
                        yOffset = -Math.round(size * 0.12);
                    } else if (vPos === 'top') {
                        iconAreaRatio = 0.60;
                        yOffset = Math.round(size * 0.12);
                    }
                }
                const imgW = img.naturalWidth || img.width || size;
                const imgH = img.naturalHeight || img.height || size;
                const maxBox = size * iconAreaRatio * finalScale;
                let sW = (imgW > imgH) ? maxBox : (imgW / imgH) * maxBox;
                let sH = (imgW > imgH) ? (imgH / imgW) * maxBox : maxBox;
                const dX = Math.round((size - sW) / 2);
                const dY = Math.round((size - sH) / 2 + yOffset);

                let effectiveIconColor = tmp.iconColor;
                if (!effectiveIconColor && (iconUrl.includes('iconify.design') || iconUrl.includes('simplesvg.com') || iconUrl.includes('unisvg.com'))) {
                    effectiveIconColor = '#ffffff';
                }

                if (effectiveIconColor) {
                    const tintCanvas = document.createElement('canvas');
                    tintCanvas.width = size;
                    tintCanvas.height = size;
                    const tintCtx = tintCanvas.getContext('2d');
                    tintCtx.drawImage(img, dX, dY, sW, sH);
                    tintCtx.globalCompositeOperation = 'source-in';
                    tintCtx.fillStyle = effectiveIconColor;
                    tintCtx.fillRect(0, 0, size, size);
                    ctx.drawImage(tintCanvas, 0, 0);
                } else {
                    ctx.drawImage(img, dX, dY, sW, sH);
                }
                drawTextAndBadges();
            } catch(e) {
                drawTextAndBadges();
            }
        };
        img.onerror = () => drawTextAndBadges();
        img.src = iconUrl;
    } else {
        drawTextAndBadges();
    }
}


function updateIconStatusIndicator() {
    const indicator = el('#iconStatusIndicator'); if (!indicator) return;
    if (cfg.iconSource === 'default') {
        if (ICON_MAP.size > 0) { indicator.textContent = t('icons.loaded'); indicator.className = 'status-ok'; }
        else { indicator.textContent = t('icons.loadFailed'); indicator.className = 'status-error'; }
    } else if (cfg.iconSource === 'user') {
        if (ICON_MAP.size > 0) { indicator.textContent = `User icons active: '${cfg.userIconFolderName}'.`; indicator.className = 'status-ok'; }
        else { indicator.textContent = `Requires re-selection: '${cfg.userIconFolderName}'.`; indicator.className = 'status-warning'; }
    } else { indicator.textContent = t('icons.noSource'); indicator.className = 'status-warning'; }
}


// --- Icon Loading Functions ---
async function apiIconsManifest() {
    ICON_FOLDERS = {}; ICON_MAP.clear(); let manifestFound = false;
    try {
        const r = await fetch(`icons/manifest.json?v=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j.icons)) {
                manifestFound = true;
                j.icons.forEach(p => {
                    const parts = String(p).split('/'); const name = parts.pop(); const folder = parts.length > 0 ? parts.join('/') : 'Default';
                    const url = ('icons/' + String(p).replace(/^\//, '')).replace(/\/+/g, '/');
                    if (!ICON_FOLDERS[folder]) ICON_FOLDERS[folder] = [];
                    ICON_FOLDERS[folder].push({ url, name }); ICON_MAP.set(name, url);
                });
            } else { console.warn("manifest.json found but 'icons' array missing/invalid."); }
        } else { console.warn(`Could not fetch icons/manifest.json: ${r.status} ${r.statusText}`); }
    } catch (e) { console.error("Error loading/parsing manifest.json:", e); }
    return false;
}

async function loadIconsFromFSDir() {
    try {
        const dirHandle = await window.showDirectoryPicker({ id: 'icons-dir', mode: 'read' });
        ICON_FOLDERS = {}; ICON_MAP.clear(); const workItems = [];
        for await (const [entryName, entryHandle] of dirHandle.entries()) {
            if (entryHandle.kind === 'directory') {
                const folderName = entryName; ICON_FOLDERS[folderName] = [];
                for await (const [iconName, iconHandle] of entryHandle.entries()) {
                    if (iconHandle.kind === 'file') {
                        const ext = iconName.toLowerCase().split('.').pop();
                        if (['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(ext)) { workItems.push({ handle: iconHandle, name: iconName, folder: folderName }); }
                    }
                }
            } else if (entryHandle.kind === 'file') {
                const iconName = entryName; const ext = iconName.toLowerCase().split('.').pop();
                if (['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(ext)) {
                    if (!ICON_FOLDERS['Default']) ICON_FOLDERS['Default'] = [];
                    workItems.push({ handle: entryHandle, name: iconName, folder: 'Default' });
                }
            }
        }
        const allPromises = workItems.map(async (item) => { const file = await item.handle.getFile(); const url = await readFileAsDataURL(file); ICON_FOLDERS[item.folder].push({ url, name: item.name }); ICON_MAP.set(item.name, url); });
        await Promise.all(allPromises);
        Object.keys(ICON_FOLDERS).forEach(folderName => { if (ICON_FOLDERS[folderName].length === 0) { delete ICON_FOLDERS[folderName]; } });
        if (Object.keys(ICON_FOLDERS).length === 0 || !Object.values(ICON_FOLDERS).some(arr => arr.length > 0)) { alert('No valid icons found.'); updateIconStatusIndicator(); return false; }
        cfg.iconSource = 'user'; cfg.userIconFolderName = dirHandle.name; saveConfig();
        renderIconsSidebar(); drawGrid(); updateIconStatusIndicator(); return true;
    } catch (e) {
        if (e.name !== 'AbortError') { console.warn("Could not load icons from directory:", e); alert("Error loading icons."); }
        updateIconStatusIndicator(); return false;
    }
}


async function reloadIcons(showAlerts = true) {
    ICON_MAP.clear();
    ICON_FOLDERS = {};
    const source = cfg?.iconSource || 'default';

    if (source === 'default') {
        await apiIconsManifest();
    }
    else if (source === 'user') {
        if (showAlerts) {
            alert("To refresh icons from a user-selected folder, please click 'Select icon folder...' again.");
        }
    }
    else {
    }

    if (!ICON_FOLDERS['Default']) ICON_FOLDERS['Default'] = [];

    renderIconsSidebar();
    drawGrid();
    updateIconStatusIndicator();
}

async function ensureIcons() {
    await reloadIcons(false);
}

function renderFolderView(parentElement, onIconClickCallback, searchQuery = '') {
    parentElement.innerHTML = ''; const query = searchQuery.toLowerCase().trim();
    const folderNames = Object.keys(ICON_FOLDERS).sort();
    if (ICON_FOLDERS['Default']) { folderNames.splice(folderNames.indexOf('Default'), 1); folderNames.unshift('Default'); }
    folderNames.forEach(folderName => {
        if (!ICON_FOLDERS[folderName] || ICON_FOLDERS[folderName].length === 0) return;
        const details = document.createElement('details'); details.className = 'icon-folder';
        const summary = document.createElement('summary');
        const displayName = folderName.length > 20 ? folderName.substring(0, 17) + '...' : folderName;
        summary.textContent = displayName; summary.title = folderName; details.appendChild(summary);
        const iconList = document.createElement('ul'); iconList.className = 'icon-list-inner';
        ICON_FOLDERS[folderName].forEach(it => {
            if (query.length > 0 && !it.name.toLowerCase().includes(query)) { return; }
            const li = document.createElement('li'); const img = document.createElement('img');
            img.className = 'thumb'; img.src = it.url; img.title = it.name; li.appendChild(img);
            if (onIconClickCallback) { li.onclick = () => onIconClickCallback(it); }
            iconList.appendChild(li);
        });
        if (iconList.children.length > 0) { if (query.length > 0) { details.open = true; } details.appendChild(iconList); parentElement.appendChild(details); }
    });
}


function renderIconsSidebar() { renderFolderView(el('#icons'), null, ''); }

async function openPicker() {
    const dlg = el('#iconPicker'), list = el('#pickerList'), searchInput = el('#iconSearchInput');
    list.innerHTML = ''; searchInput.value = '';
    if (Object.keys(ICON_FOLDERS).length === 0 || !Object.values(ICON_FOLDERS).some(arr => arr.length > 0)) {
        if (cfg.iconSource === 'default') { await ensureIcons(); }
    }
    if (Object.keys(ICON_FOLDERS).length === 0 || !Object.values(ICON_FOLDERS).some(arr => arr.length > 0)) { alert('No icons loaded.'); return; }
    const iconClickHandlerForPicker = (iconData) => { el('#iconPath').value = iconData.name; el('#iconPath').dispatchEvent(new Event('input')); dlg.close(); };
    renderFolderView(list, iconClickHandlerForPicker, '');
    searchInput.oninput = () => { renderFolderView(list, iconClickHandlerForPicker, searchInput.value); };
    el('#pickerClose').onclick = () => dlg.close(); el('#iconPickerCloseBtn').onclick = () => dlg.close();
    dlg.showModal();
}


// --- Import/Export Functions ---
function exportSettings() {
    saveConfig(); const data = localStorage.getItem(CONFIG_STORAGE_KEY); if (!data) { alert("No settings."); return; }
    const blob = new Blob([data], { type: 'application/json' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'deck_settings.json'; a.click(); URL.revokeObjectURL(a.href);
}

async function importSettingsFile(file) {
    const fr = new FileReader();
    fr.onload = async () => {
        try {
            const importedCfgString = fr.result;

            // 1. Validate JSON
            try { JSON.parse(importedCfgString); }
            catch (e) { throw new Error("Invalid JSON file format."); }

            // 2. Save to LocalStorage and load
            localStorage.setItem(CONFIG_STORAGE_KEY, importedCfgString);
            cfg = loadConfig();

            // --- FIX HERE ---
            // Always go to page 1 (index 0) after import
            currentPage = 0;
            cfg.currentPage = 0; // Apply to config too
            // -----------------------

            // 3. Update UI
            applyDeviceProfile(cfg.device.resolution); // Also calls drawGrid
            applyTheme();

            // Force update page bar and grid (applyDeviceProfile might not be enough sometimes)
            renderPageBar();
            drawGrid();

            updateIconStatusIndicator();
            //alert("Settings imported successfully!"); 

        } catch (e) {
            console.error("Error importing settings:", e);
            alert(`Could not process file: ${e.message}`);
        }
        // Clear input
        el('#importFile').value = '';
    };
    fr.readAsText(file);
}

// Find generateEspFiles function in app.js and replace with this:

async function generateEspFiles() {
    if (!cfg) {
        alert("Config not loaded.");
        return null;
    }

    const currentProfileKey = cfg.device.resolution || "800x480";
    const currentProfile = DEVICE_PROFILES[currentProfileKey] || DEVICE_PROFILES["800x480"];
    let exportCellSize = currentProfile.cell;

    if (currentProfileKey === "480x320") {
        exportCellSize = 80;
    } else if (currentProfileKey === "320x240") {
        exportCellSize = 70;
    }


    const espConfig = {
        title: cfg.deviceName || null,
        theme: {
            bg_color: cfg.theme.bg, btn_color: cfg.theme.btn, text_color: cfg.theme.text,
            stroke_color: cfg.theme.stroke, shadow_color: cfg.theme.shadow
        },
        grid: { cols: cfg.grid.cols, rows: cfg.grid.rows },
        pages: []
    };

    const itemsToRender = new Map();
    let generatedIconCounter = 0;

    cfg.pages.forEach((page, pageIndex) => {
        const pageName = cfg.pageNames[pageIndex] || `Page ${pageIndex + 1}`;
        const espPage = { name: pageName, buttons: [] };

        page.forEach(btn => {
            if (btn && isFilled(btn)) {
                let iconName = btn.icon || null;
                let espIconBaseName = null;

                generatedIconCounter++;

                if (iconName) {
                    if (iconName.startsWith('data:')) {
                        espIconBaseName = `local_${generatedIconCounter}`;
                    } else {
                        const lastDot = iconName.lastIndexOf('.');
                        let baseName = (lastDot > -1) ? iconName.substring(0, lastDot) : iconName;
                        baseName = baseName.replace(/[:/\\?%*|"<>]/g, '_');
                        espIconBaseName = `${baseName}_${generatedIconCounter}`;
                    }
                } else if (btn.label && btn.label.length > 0) {
                    espIconBaseName = `text_${generatedIconCounter}`;
                } else {
                    espIconBaseName = null;
                }

                if (espIconBaseName) {
                    if (btn.type === 'toggle') {
                        const offName = `${espIconBaseName}_0.jpg`;
                        const onName = `${espIconBaseName}_1.jpg`;

                        // 1. OFF Image (State A)
                        // Uses default icon and user selected normal colors.
                        itemsToRender.set(offName, {
                            btnData: btn,
                            finalFileName: offName,
                            forcedColor: btn.btnBgColor || ('#' + cfg.theme.btn),
                            forcedIconUrl: null // Use main icon
                        });

                        // 2. ON Image (State B)
                        // SPECIAL LOGIC: 
                        // - URL: "active icon" if exists, else "main icon".
                        // - BG Color: "active bg color"
                        // - Icon Color: "active icon color"

                        const stateBIconUrl = btn.toggleData?.iconOn ? getIconUrl(btn.toggleData.iconOn) : null;

                        // Create a temporary data object and manipulate color so it doesn't break main data
                        const onBtnData = Object.assign({}, btn);
                        if (btn.toggleData?.onIconColor) {
                            onBtnData.iconColor = btn.toggleData.onIconColor;
                        } else {
                            // If active icon color not selected, make white by default (for visibility)
                            onBtnData.iconColor = '#ffffff';
                        }

                        itemsToRender.set(onName, {
                            btnData: onBtnData,
                            finalFileName: onName,
                            forcedColor: btn.toggleData?.onColor || '#2ecc71',
                            forcedIconUrl: stateBIconUrl // Use custom icon if exists
                        });

                        const espBtn = {
                            icon: offName,
                            type: btn.type,
                            toggleData: {
                                iconOff: offName,
                                iconOn: onName,
                                onColor: (btn.toggleData?.onColor || '').replace('#', '')
                            },
                            btnColor: (btn.btnBgColor || cfg.theme.btn).replace('#', ''),
                            labelColor: (btn.labelColor || '').replace('#', '')
                        };
                        if (btn.type === 'key') espBtn.combo = btn.combo;

                        espPage.buttons.push(espBtn);

                    } else {
                        const normalName = `${espIconBaseName}.jpg`;
                        itemsToRender.set(normalName, {
                            btnData: btn,
                            finalFileName: normalName,
                            forcedColor: null
                        });

                        const espBtn = { icon: normalName, type: (btn.type === 'folder' ? 'goto' : (btn.type || 'normal')) };
                        if (btn.type === 'key') espBtn.combo = btn.combo;
                        else if (btn.type === 'goto' || btn.type === 'folder') espBtn.page = btn.gotoPage + 1;
                        else if (btn.type === 'counter') { espBtn.counterStartValue = btn.counterStartValue; espBtn.counterAction = btn.counterAction; }
                        else if (btn.type === 'timer') {
                            espBtn.duration = btn.timerDuration;
                            espBtn.btnColor = (btn.btnBgColor ? btn.btnBgColor.replace('#', '') : cfg.theme.btn);
                            if (btn.labelColor) espBtn.labelColor = btn.labelColor.replace('#', '');
                        }
                        espPage.buttons.push(espBtn);
                    }
                } else {
                    espPage.buttons.push(null);
                }
            } else {
                espPage.buttons.push(null);
            }
        });
        espConfig.pages.push(espPage);
    });

    const configFileName = 'esp_config.json';
    const configBlob = new Blob([JSON.stringify(espConfig, null, 2)], { type: 'application/json' });

    const imageFiles = [];
    const errors = [];

    for (const [fileName, item] of itemsToRender.entries()) {
        const btnData = item.btnData;
        // If forcedIconUrl exists (State B icon) use it, otherwise use main icon
        const iconUrl = item.forcedIconUrl || getIconUrl(btnData.icon);

        // BUG FIX: If no URL and no label, skip creation (Prevents red square)
        if (!iconUrl && (!btnData.label || btnData.label.length === 0)) {
            continue;
        }

        try {
            const iconBlob = await convertToJpgBlob(iconUrl, btnData, exportCellSize, item.forcedColor);
            imageFiles.push({ blob: iconBlob, fileName: fileName });
        } catch (error) {
            console.error(`Error generating JPG for ${fileName}:`, error);
            errors.push(`Failed to generate ${fileName}: ${error.message}`);
        }
    }

    return { configBlob, configFileName, imageFiles, errors };
}

// -----------------------------------------------------------------
// 3. REPLACE EXISTING uploadConfigToDevice FUNCTION WITH THIS
// -----------------------------------------------------------------
async function uploadConfigToDevice() {
    const btn = el('#uploadToDeviceBtn');
    const originalBtnText = btn.textContent;
    const statusEl = el('#uploadStatus');

    statusEl.textContent = '';
    statusEl.className = 'upload-status-message';

    let host = el('#deviceHost').value.trim();
    if (host.length === 0) {
        host = 'http://smartdeck.local';
        el('#deviceHost').value = host;
    }

    if (!host.startsWith('http://') && !host.startsWith('https://')) {
        host = 'http://' + host;
    }
    host = host.replace(/\/$/, '');

    localStorage.setItem(HOST_STORAGE_KEY, host);

    // --- CHANGE HERE ---
    // Using new showCustomConfirm() instead of old confirm().
    const confirmed = await showCustomConfirm(
        t('upload.message', { host: host }),
        t('upload.title'),
        t('upload.confirm'),
        t('editor.cancel')
    );

    if (!confirmed) {
        return; // User clicked 'Cancel'
    }
    // --- CHANGE END ---

    try {
        btn.disabled = true;
        btn.textContent = t('upload.generating');

        const generatedData = await generateEspFiles();
        if (!generatedData) {
            btn.disabled = false;
            btn.textContent = originalBtnText;
            return;
        }

        const { configBlob, configFileName, imageFiles, errors } = generatedData;

        if (errors.length > 0) {
            statusEl.textContent = t('upload.generationError') + `\n- ${errors.join('\n- ')}`;
            statusEl.classList.add('error');
            btn.disabled = false;
            btn.textContent = originalBtnText;
            return;
        }

        // STEP 2: /upload (Upload all files)
        const allFiles = [{ blob: configBlob, fileName: configFileName }, ...imageFiles];
        let uploadedCount = 0;

        // First upload config file
        btn.textContent = t('upload.uploadingConfig');
        const configFile = allFiles[0];
        let formData = new FormData();
        formData.append('file', configFile.blob, configFile.fileName);

        let response = await fetch(`${host}/upload`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Failed to upload ${configFile.fileName}. Status: ${response.statusText}`);
        }
        uploadedCount++;

        // Now upload icons
        for (let i = 1; i < allFiles.length; i++) {
            const file = allFiles[i];
            btn.textContent = t('upload.uploadingIcon', { current: i, total: imageFiles.length });
            formData = new FormData();
            formData.append('file', file.blob, file.fileName);

            response = await fetch(`${host}/upload`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`Failed to upload ${file.fileName}. Status: ${response.statusText}`);
            }
            uploadedCount++;
        }

        // STEP 3: /reboot (Restart)
        btn.textContent = t('upload.rebooting');
        await fetch(`${host}/reboot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: "reboot" })
        });

        statusEl.textContent = t('upload.success', { count: uploadedCount, host: host });
        statusEl.classList.add('success');

    } catch (error) {
        console.error("Upload process failed:", error);

        statusEl.textContent = t('upload.error', { host: host, error: error.message });
        statusEl.classList.add('error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalBtnText;

        // Clear message after a few seconds
        setTimeout(() => {
            if (statusEl) {
                statusEl.textContent = '';
                statusEl.className = 'upload-status-message';
            }
        }, 8000); // After 8 seconds
    }
}


// HTML stringinin içine ilgili bölümü ekleyip, JS kısmını fonksiyonun altına yapıştırın.

async function openSettings() {
    // --- KORUMA 1: Açılışta Kurtarma Operasyonu ---
    // Eğer halihazırda açık bir dialog varsa ve Debug Panel içindeyse,
    // dialog silinmeden önce paneli body'e taşı.
    const existingDebugPanel = document.getElementById('debugLogPanel');
    if (existingDebugPanel && existingDebugPanel.parentNode !== document.body) {
        document.body.appendChild(existingDebugPanel);
    }

    // 1. Create basic HTML structure for settings
    const settingsHTML = `
        <dialog id="appSettingsDialog" style="width: 1000px; max-width: 90vw; border: none; border-radius: 16px; background: #161616; color: #fff; padding: 0; box-shadow: 0 10px 40px rgba(0,0,0,0.6);">
            <div class="editor" style="padding: 20px; width: 100%; box-sizing: border-box;"> 
                
                <div class="hstack" style="justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">
                    <h3 style="margin: 0; font-size: 18px;" data-i18n="settings.title">Application Settings</h3>
                    <button type="button" id="settingsCloseX" class="dialog-close-btn" style="position: static;">×</button>
                </div>
                
                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.startupLabel">Startup</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 0;">
                        <div class="hstack settings-row-stretch" style="justify-content: space-between; align-items: center;">
                            <div style="flex: 1;">
                                <span style="color: var(--text); font-weight: 500;" data-i18n="settings.startup">Start with Windows</span>
                                <div class="muted" style="font-size: 12px; margin-top: 4px;" data-i18n="settings.startupDesc">Automatically start minimized to tray on login.</div>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="startupCheckbox">
                                <span class="slider round"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.windowBehavior">Window Behavior</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 0;">
                        <label for="defaultCloseAction" style="color: var(--text); font-weight: 500; margin-bottom: 8px; display: block;" data-i18n="settings.closeAction">When clicking 'X' (Close) button</label>
                        <select id="defaultCloseAction" class="text" style="width: 100%;">
                            <option value="showConfirm" data-i18n="settings.closeOptions.ask">Always Ask (Show Confirmation)</option>
                            <option value="minimize" data-i18n="settings.closeOptions.minimize">Minimize to Tray (Keep Running)</option>
                            <option value="exit" data-i18n="settings.closeOptions.exit">Exit Application Immediately</option>
                        </select>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Auto Profile Switching</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 0;">
                        <div class="hstack settings-row-stretch" style="justify-content: space-between; align-items: center;">
                            <div style="flex: 1;">
                                <span style="color: var(--text); font-weight: 500;">Powrót do panelu 1 po wyjściu z aplikacji</span>
                                <div class="muted" style="font-size: 12px; margin-top: 4px;">Automatycznie powraca do Panelu 1, gdy przypisana aplikacja zostanie zminimalizowana lub zamknięta.</div>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="autoRevertPageCheckbox">
                                <span class="slider round"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.language">Language</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 0;">
                        <select id="languageSelect" class="text" style="width: 100%;">
                            <option value="en">🇬🇧 English (English)</option>
                            <option value="tr">🇹🇷 Türkçe (Turkish)</option>
                            <option value="de">🇩🇪 Deutsch (German)</option>
                            <option value="es">🇪🇸 Español (Spanish)</option>
                            <option value="fr">🇫🇷 Français (French)</option>
                            <option value="ja">🇯🇵 日本語 (Japanese)</option>
                            <option value="zh">🇨🇳 简体中文 (Simplified Chinese)</option>
                        </select>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.sounds">Sound Settings</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 15px;">
                        <label style="color: var(--text); font-weight: 500; margin-bottom: 8px; display: block;" data-i18n="settings.soundsToggle">Default Toggle Sound</label>
                        <div class="hstack">
                            <input type="text" id="customToggleSoundInput" class="text" style="flex: 1;" data-i18n-placeholder="settings.soundsTogglePlaceholder" placeholder="Default (switch.wav)" readonly />
                            <button id="browseToggleSoundGlobal" class="ghost" type="button" data-i18n="settings.browse">Browse</button>
                            <button id="resetToggleSoundGlobal" class="ghost" type="button" data-i18n="settings.reset_sound" title="Reset">↺</button>
                        </div>
                    </div>
                    <div class="row" style="margin-bottom: 0;">
                        <label style="color: var(--text); font-weight: 500; margin-bottom: 8px; display: block;" data-i18n="settings.soundsTimer">Timer Notification Sound</label>
                        <div class="hstack">
                            <input type="text" id="customNotificationSoundInput" class="text" style="flex: 1;" data-i18n-placeholder="settings.soundsTimerPlaceholder" placeholder="Default (notification.wav)" readonly />
                            <button id="browseNotificationSoundGlobal" class="ghost" type="button" data-i18n="settings.browse">Browse</button>
                            <button id="resetNotificationSoundGlobal" class="ghost" type="button" data-i18n="settings.reset_sound" title="Reset">↺</button>
                        </div>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.screen">Screen & Device Settings</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 15px;">
                        <div class="hstack" style="justify-content: space-between; margin-bottom: 5px;">
                            <label style="color: var(--text); font-weight: 500;" data-i18n="settings.brightness">Screen Brightness</label>
                            <span id="brightnessValueLabel" style="font-size: 13px; color: var(--accent);">100%</span>
                        </div>
                        <input type="range" id="screenBrightnessRange" min="5" max="100" step="5" value="100" style="width: 100%; accent-color: var(--accent);">
                    </div>
                    <div class="row" style="padding-top: 15px; border-top: 1px dashed var(--border); margin-bottom: 0;">
                        <div class="hstack settings-row-stretch" style="justify-content: space-between; align-items: center;">
                            <div style="flex: 1;">
                                <span style="color: var(--text); font-weight: 500;" data-i18n="settings.sleep">Screen Sleep (Dim)</span>
                                <div class="muted" style="font-size: 12px; margin-top: 4px;" data-i18n="settings.sleepDesc">Dim screen after inactivity to save power.</div>
                            </div>
                            <select id="sleepDurationSelect" class="text" style="width: 100px; margin-right: 10px; display: none;">
                                <option value="1">1 min</option>
                                <option value="5">5 min</option>
                                <option value="10">10 min</option>
                                <option value="30">30 min</option>
                                <option value="60">60 min</option>
                            </select>
                            <label class="switch">
                                <input type="checkbox" id="screenSleepToggle">
                                <span class="slider round"></span>
                            </label>
                        </div>
                        
                        <!-- Deep Sleep Settings (Sleep açıkken görünür) -->
                        <div id="deepSleepSettingsWrapper" style="display: none; margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--border);">
                            <div class="hstack settings-row-stretch" style="justify-content: space-between; align-items: center;">
                                <div style="flex: 1;">
                                    <span style="color: var(--text); font-weight: 500;" data-i18n="settings.deepSleep">Deep Sleep</span>
                                    <div class="muted" style="font-size: 12px; margin-top: 4px;" data-i18n="settings.deepSleepDesc">Turn off screen and LEDs completely after dim period.</div>
                                </div>
                                <select id="deepSleepDurationSelect" class="text" style="width: 120px; margin-right: 10px; display: none;">
                                    <option value="30">30 min</option>
                                    <option value="60">1 hour</option>
                                    <option value="120">2 hours</option>
                                    <option value="240">4 hours</option>
                                    <option value="480">8 hours</option>
                                </select>
                                <label class="switch">
                                    <input type="checkbox" id="deepSleepToggle">
                                    <span class="slider round"></span>
                                </label>
                            </div>
                            <div class="muted" style="font-size: 11px; margin-top: 8px; font-style: italic;" data-i18n="settings.deepSleepHint">Rotate the knob to wake up from deep sleep.</div>
                        </div>
                    </div>
                </div>

                <!-- Weather Settings - Ayrı Kutu -->
                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.weatherSettings">Weather Settings</label>
                <div class="group-box" id="weatherSettingsWrapper" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 15px;">
                        <label style="color: var(--text); font-weight: 500; margin-bottom: 8px; display: block;" data-i18n="settings.weatherCity">City</label>
                        <div style="position: relative;">
                            <input type="text" id="weatherCityInput" class="text" style="width: 100%;" data-i18n-placeholder="settings.weatherCityPlaceholder" placeholder="Search city..." autocomplete="off" />
                            <div id="weatherCityDropdown" style="position: absolute; top: 100%; left: 0; right: 0; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 9999; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5);"></div>
                        </div>
                        <div id="weatherCitySelected" class="muted" style="font-size: 12px; margin-top: 6px;"></div>
                    </div>
                    <div class="row" style="margin-bottom: 0;">
                        <label style="color: var(--text); font-weight: 500; margin-bottom: 8px; display: block;" data-i18n="settings.weatherUnits">Temperature Unit</label>
                        <select id="weatherUnitsSelect" class="text" style="width: 100%;">
                            <option value="celsius">°C (Celsius)</option>
                            <option value="fahrenheit">°F (Fahrenheit)</option>
                        </select>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.developer">Developer Tools</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 0;">
                        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                            <button id="openDebugLogBtn" class="ghost" type="button" style="flex: 1;" data-i18n="settings.serialMonitor">Serial Monitor</button>
                            <button id="resetEspBtn" class="ghost" type="button" style="flex: 1;" data-i18n="settings.resetEsp">Reset ESP32</button>
                            <button id="espInfoBtn" class="ghost" type="button" style="flex: 1;" data-i18n="settings.espInfo">ESP32 Info</button>
                            <button id="dumpConfigBtn" class="ghost" type="button" style="flex: 1;">Dump Config</button>
                        </div>
                    </div>
                </div>

                <label style="font-size: 12px; color: var(--muted); font-weight: 600; display: block; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;" data-i18n="settings.about">About & Updates</label>
                <div class="group-box" style="margin-bottom: 20px;">
                    <div class="row" style="margin-bottom: 0;">
                        <div class="hstack" style="justify-content: space-between; align-items: center;">
                            <div>
                                <span style="color: var(--text); font-weight: 500;" data-i18n="settings.appName">Smart Deck App</span>
                                <div id="settingsVersionDisplay" class="muted" style="font-size: 12px; margin-top: 4px;"></div>
                            </div>
                            <button id="btnCheckUpdates" class="ghost" type="button">
                                <span>↻</span> <span data-i18n="settings.checkUpdates">Check for Updates</span>
                            </button>
                        </div>
                        
                        <div id="settingsUpdateResult" style="margin-top: 15px; padding-top: 15px; border-top: 1px dashed var(--border); display: none;">
                            <div class="hstack" style="align-items: center; justify-content: space-between;">
                                <div style="flex:1;">
                                    <span style="display:block; font-weight:600; color:#2ecc71;" data-i18n="settings.newVersionAvailable">New version available!</span>
                                    <span id="newVersionNumber" style="font-size:12px; color:var(--muted);">v1.x.x</span>
                                </div>
                                <button id="btnDownloadUpdate" class="primary" type="button" data-i18n="settings.downloadUpdate">Download</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="row actions" style="margin-top: 25px;">
                    <div class="spacer"></div>
                    <button id="settingsOkBtn" class="primary" type="button" style="min-width: 100px;" data-i18n="settings.done">Done</button>
                </div>
            </div>
        </dialog>
        <input type="file" id="settingsHiddenSoundInput" accept="audio/*" hidden />
    `;

    // 2. Cleanup and Add
    const oldDialog = el('#appSettingsDialog');
    if (oldDialog) oldDialog.remove();
    const oldInput = el('#settingsHiddenSoundInput');
    if (oldInput) oldInput.remove();

    document.body.insertAdjacentHTML('beforeend', settingsHTML);
    const dialog = el('#appSettingsDialog');

    // --- KORUMA 2: Kapanma (Close) Event Listener ---
    // Bu, hem ESC tuşunu, hem butonları, hem de dialog.close() çağrılarını yakalar.
    // Dialog DOM'dan görsel olarak kalkmadan hemen önce çalışır.
    dialog.addEventListener('close', () => {
        // Varsa capture modunu durdur
        if (typeof stopKnobCapture === 'function') stopKnobCapture();

        // Serial Monitor'ü kontrol et ve kurtar
        const panel = document.getElementById('debugLogPanel');
        // Eğer panel varsa ve şu an dialog'un içindeyse
        if (panel && dialog.contains(panel)) {
            const logContent = panel.querySelector('#debugLogContent');

            document.body.appendChild(panel);

            // Always scroll to bottom after DOM update
            requestAnimationFrame(() => {
                if (logContent) {
                    logContent.scrollTop = logContent.scrollHeight;
                }
            });
        }
    });

    applyTranslations();

    // --- LOAD VALUES & LOGIC (Kalan kısımlar aynı) ---
    // (Buradan aşağısı sizin mevcut kodunuzdaki logic ile aynıdır, 
    // sadece close butonlarına dialog.close() atayacağız, özel fonksiyon değil.)

    const verLabel = el('#settingsVersionDisplay', dialog);
    const checkBtn = el('#btnCheckUpdates', dialog);
    const resultArea = el('#settingsUpdateResult', dialog);
    const newVerLabel = el('#newVersionNumber', dialog);
    const dlBtn = el('#btnDownloadUpdate', dialog);

    let currentVersion = '1.0.0';
    if (window.electronAPI && window.electronAPI.app) {
        currentVersion = await window.electronAPI.app.getVersion();
        verLabel.textContent = t('settings.version', { version: currentVersion });
    } else {
        verLabel.textContent = t('settings.loadingVersion');
    }

    function isNewerVersion(localVer, remoteVer) {
        const cleanLocal = localVer.replace('v', '').trim();
        const cleanRemote = remoteVer.replace('v', '').trim();
        const v1parts = cleanLocal.split('.').map(Number);
        const v2parts = cleanRemote.split('.').map(Number);
        for (let i = 0; i < v1parts.length; i++) {
            const l = v1parts[i] || 0;
            const r = v2parts[i] || 0;
            if (r > l) return true;
            if (r < l) return false;
        }
        return false;
    }

    checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = "Checking...";
        resultArea.style.display = 'none';
        try {
            const response = await fetch('https://api.github.com/repos/pankrasnal4-dot/smartdeck/releases/latest');
            if (!response.ok) throw new Error("Network error");
            const data = await response.json();
            const remoteTag = data.tag_name;
            if (isNewerVersion(currentVersion, remoteTag)) {
                checkBtn.textContent = "Update Found!";
                checkBtn.disabled = false;
                resultArea.style.display = 'block';
                newVerLabel.textContent = `Version ${data.tag_name} is available on GitHub.`;
                dlBtn.onclick = () => {
                    if (window.electronAPI && window.electronAPI.shell) {
                        window.electronAPI.shell.openExternal(data.html_url);
                    }
                };
            } else {
                checkBtn.textContent = "Up to date ✔";
                setTimeout(() => {
                    checkBtn.disabled = false;
                    checkBtn.innerHTML = "<span>↻</span> Check for Updates";
                }, 3000);
            }
        } catch (e) {
            console.error("Update check failed:", e);
            checkBtn.textContent = "Check Failed";
            checkBtn.classList.add('danger');
            setTimeout(() => {
                checkBtn.disabled = false;
                checkBtn.classList.remove('danger');
                checkBtn.innerHTML = "<span>↻</span> Check for Updates";
            }, 3000);
        }
    };

    el('#defaultCloseAction', dialog).value = (cfg.appSettings && cfg.appSettings.defaultCloseAction) ? cfg.appSettings.defaultCloseAction : 'showConfirm';
    const checkbox = el('#startupCheckbox', dialog);
    const autoRevertCheckbox = el('#autoRevertPageCheckbox', dialog);
    
    // State'i config'den oku (daha güvenilir)
    checkbox.checked = cfg.appSettings?.startWithWindows || false;
    if (autoRevertCheckbox) {
        autoRevertCheckbox.checked = cfg.appSettings?.autoRevertPage !== false;
    }
    console.log('[Settings] Startup checkbox loaded from config:', checkbox.checked);

    const langSelect = el('#languageSelect', dialog);
    langSelect.value = currentLang;

    const toggleSoundInput = el('#customToggleSoundInput', dialog);
    if (cfg.appSettings && cfg.appSettings.customToggleSound) toggleSoundInput.value = cfg.appSettings.customToggleSound;
    const notifSoundInput = el('#customNotificationSoundInput', dialog);
    if (cfg.appSettings && cfg.appSettings.customNotificationSound) notifSoundInput.value = cfg.appSettings.customNotificationSound;

    const brRange = el('#screenBrightnessRange', dialog);
    const brLabel = el('#brightnessValueLabel', dialog);
    const sleepToggle = el('#screenSleepToggle', dialog);
    const sleepSelect = el('#sleepDurationSelect', dialog);

    const currentBr = cfg.deviceSettings.brightness || 100;
    brRange.value = currentBr;
    brLabel.textContent = currentBr + '%';

    const isSleepOn = cfg.deviceSettings.sleepEnabled || false;
    sleepToggle.checked = isSleepOn;
    sleepSelect.value = cfg.deviceSettings.sleepMinutes || 5;
    sleepSelect.style.display = isSleepOn ? 'block' : 'none';

    brRange.oninput = () => {
        const val = brRange.value;
        brLabel.textContent = val + '%';
        sendSerialCommand(`SET_BRIGHTNESS:${val}`);
        cfg.deviceSettings.brightness = parseInt(val);
        saveConfig();
    };

    // Deep Sleep settings wrapper (sleep toggle altında)
    const deepSleepSettingsWrapper = el('#deepSleepSettingsWrapper', dialog);
    const deepSleepToggle = el('#deepSleepToggle', dialog);
    const deepSleepSelect = el('#deepSleepDurationSelect', dialog);
    
    // Initialize deep sleep config if not exists
    if (!cfg.deviceSettings.deepSleepEnabled) {
        cfg.deviceSettings.deepSleepEnabled = false;
        cfg.deviceSettings.deepSleepMinutes = 30; // Default 30 min
    }
    
    const isDeepSleepOn = cfg.deviceSettings.deepSleepEnabled || false;
    deepSleepToggle.checked = isDeepSleepOn;
    deepSleepSelect.value = cfg.deviceSettings.deepSleepMinutes || 30;
    deepSleepSelect.style.display = isDeepSleepOn ? 'block' : 'none';

    const updateSleepSettings = () => {
        const isOn = sleepToggle.checked;
        sleepSelect.style.display = isOn ? 'block' : 'none';
        // Deep Sleep wrapper'ını sleep açıkken göster
        if (deepSleepSettingsWrapper) {
            deepSleepSettingsWrapper.style.display = isOn ? 'block' : 'none';
        }
        const mins = parseInt(sleepSelect.value);
        cfg.deviceSettings.sleepEnabled = isOn;
        cfg.deviceSettings.sleepMinutes = mins;
        saveConfig();
        const cmdVal = isOn ? mins : 0;
        sendSerialCommand(`SET_SLEEP:${cmdVal}`);
        restartWeatherAutoRefresh(); // Sleep değişince weather timer'ı güncelle
        
        // Sleep kapatılınca deep sleep'i de kapat
        if (!isOn && cfg.deviceSettings.deepSleepEnabled) {
            sendSerialCommand('SET_DEEP_SLEEP:0');
        }
    };
    
    const updateDeepSleepSettings = () => {
        const isOn = deepSleepToggle.checked;
        deepSleepSelect.style.display = isOn ? 'block' : 'none';
        const mins = parseInt(deepSleepSelect.value);
        cfg.deviceSettings.deepSleepEnabled = isOn;
        cfg.deviceSettings.deepSleepMinutes = mins;
        saveConfig();
        const cmdVal = isOn ? mins : 0;
        sendSerialCommand(`SET_DEEP_SLEEP:${cmdVal}`);
    };

    sleepToggle.onchange = updateSleepSettings;
    sleepSelect.onchange = updateSleepSettings;
    deepSleepToggle.onchange = updateDeepSleepSettings;
    deepSleepSelect.onchange = updateDeepSleepSettings;

    // İlk yüklemede sleep durumuna göre wrapper'ları ayarla
    if (deepSleepSettingsWrapper) {
        deepSleepSettingsWrapper.style.display = isSleepOn ? 'block' : 'none';
    }

    // --- WEATHER SETTINGS ---
    const weatherCityInput = el('#weatherCityInput', dialog);
    const weatherCityDropdown = el('#weatherCityDropdown', dialog);
    const weatherCitySelected = el('#weatherCitySelected', dialog);
    const weatherUnitsSelect = el('#weatherUnitsSelect', dialog);

    // Initialize weather config if not exists or missing fields
    if (!cfg.weather) {
        cfg.weather = {
            city: '',
            lat: null,
            lon: null,
            units: 'celsius'
        };
    } else {
        // Ensure all fields exist (for older configs)
        if (cfg.weather.city === undefined) cfg.weather.city = '';
        if (cfg.weather.lat === undefined) cfg.weather.lat = null;
        if (cfg.weather.lon === undefined) cfg.weather.lon = null;
        if (cfg.weather.units === undefined) cfg.weather.units = 'celsius';
    }

    // Load weather values
    weatherUnitsSelect.value = cfg.weather.units || 'celsius';
    weatherCityInput.value = cfg.weather.city || '';

    // Show selected city info
    if (cfg.weather.city && cfg.weather.lat) {
        weatherCitySelected.textContent = `📍 ${cfg.weather.city} (${cfg.weather.lat.toFixed(2)}, ${cfg.weather.lon.toFixed(2)})`;
    }

    weatherUnitsSelect.onchange = () => {
        cfg.weather.units = weatherUnitsSelect.value;
        saveConfig();
        sendWeatherToDevice(); // Birim değişince hemen güncelle
    };

    // City autocomplete with debounce
    let citySearchTimeout = null;
    weatherCityInput.addEventListener('input', (e) => {
        clearTimeout(citySearchTimeout);
        const query = e.target.value.trim();
        
        if (query.length < 2) {
            weatherCityDropdown.style.display = 'none';
            return;
        }
        
        citySearchTimeout = setTimeout(async () => {
            try {
                const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=${currentLang}`;
                const resp = await fetch(url);
                const data = await resp.json();
                
                if (data.results && data.results.length > 0) {
                    weatherCityDropdown.innerHTML = data.results.map(city => `
                        <div class="weather-city-option" 
                             data-lat="${city.latitude}" 
                             data-lon="${city.longitude}"
                             data-name="${city.name}"
                             data-country="${city.country || ''}"
                             data-admin="${city.admin1 || ''}"
                             style="padding: 10px 12px; cursor: pointer; background: #1a1a1a; border-bottom: 1px solid #333;">
                            <div style="font-weight: 500; color: #fff;">${city.name}</div>
                            <div style="font-size: 11px; color: #888; margin-top: 2px;">${city.admin1 || ''} ${city.country || ''}</div>
                        </div>
                    `).join('');
                    weatherCityDropdown.style.display = 'block';
                    
                    // City selection handlers
                    weatherCityDropdown.querySelectorAll('.weather-city-option').forEach(opt => {
                        opt.onmouseenter = () => opt.style.background = '#2a2a2a';
                        opt.onmouseleave = () => opt.style.background = '#1a1a1a';
                        opt.onclick = () => {
                            cfg.weather.city = opt.dataset.name;
                            cfg.weather.lat = parseFloat(opt.dataset.lat);
                            cfg.weather.lon = parseFloat(opt.dataset.lon);
                            cfg.weather.country = opt.dataset.country;
                            cfg.weather.admin = opt.dataset.admin;
                            
                            console.log('[Weather] City selected:', opt.dataset.name);
                            console.log('[Weather] cfg.weather after selection:', JSON.stringify(cfg.weather));
                            
                            weatherCityInput.value = opt.dataset.name;
                            weatherCitySelected.textContent = `📍 ${opt.dataset.name}, ${opt.dataset.admin} ${opt.dataset.country} (${cfg.weather.lat.toFixed(2)}, ${cfg.weather.lon.toFixed(2)})`;
                            weatherCityDropdown.style.display = 'none';
                            saveConfig();
                            
                            // Şehir seçilince hemen weather gönder (test için)
                            sendWeatherToDevice();
                            
                            showToast(t('settings.weatherCitySaved') || `Weather location set to ${opt.dataset.name}`, 'success');
                        };
                    });
                } else {
                    weatherCityDropdown.innerHTML = `<div style="padding: 10px 12px; color: #888; background: #1a1a1a;">${t('settings.weatherNoResults') || 'No cities found'}</div>`;
                    weatherCityDropdown.style.display = 'block';
                }
            } catch (e) {
                console.error('City search error:', e);
                weatherCityDropdown.innerHTML = `<div style="padding: 10px 12px; color: #e74c3c; background: #1a1a1a;">${t('settings.weatherSearchError') || 'Search failed'}</div>`;
                weatherCityDropdown.style.display = 'block';
            }
        }, 300);
    });

    // Close dropdown on outside click
    weatherCityInput.addEventListener('blur', () => {
        setTimeout(() => {
            weatherCityDropdown.style.display = 'none';
        }, 200);
    });
    // --- END WEATHER SETTINGS ---

    const applySettings = async () => {
        // Önce config'e kaydet
        if (!cfg.appSettings) cfg.appSettings = {};
        cfg.appSettings.startWithWindows = checkbox.checked;
        if (autoRevertCheckbox) {
            cfg.appSettings.autoRevertPage = autoRevertCheckbox.checked;
        }
        cfg.appSettings.defaultCloseAction = el('#defaultCloseAction', dialog).value;
        const tSound = toggleSoundInput.value.trim();
        cfg.appSettings.customToggleSound = tSound.length > 0 ? tSound : null;
        const nSound = notifSoundInput.value.trim();
        cfg.appSettings.customNotificationSound = nSound.length > 0 ? nSound : null;
        saveConfig();
        
        // Sonra Windows startup'a kaydet (arka planda)
        if (window.electronAPI && window.electronAPI.app) {
            try {
                await window.electronAPI.app.setStartupStatus(checkbox.checked);
                console.log('[Settings] Windows startup set to:', checkbox.checked);
            } catch (e) {
                console.error('[Settings] Error setting startup status:', e);
            }
        }
    };

    el('#startupCheckbox', dialog).onchange = applySettings;
    if (autoRevertCheckbox) autoRevertCheckbox.onchange = applySettings;
    el('#defaultCloseAction', dialog).onchange = applySettings;

    langSelect.onchange = async () => {
        const newLang = langSelect.value;
        await loadLanguage(newLang);
        // Update version label after language change
        if (currentVersion) {
            verLabel.textContent = t('settings.version', { version: currentVersion });
        }
    };

    const hiddenInput = el('#settingsHiddenSoundInput');
    const bindBrowse = (btnId, inputEl) => {
        el(btnId, dialog).onclick = () => {
            hiddenInput.value = null;
            hiddenInput.onchange = (e) => {
                const file = e.target.files[0];
                if (file && file.path) {
                    inputEl.value = file.path;
                    applySettings();
                }
            };
            hiddenInput.click();
        };
    };
    const bindReset = (btnId, inputEl) => {
        el(btnId, dialog).onclick = () => {
            inputEl.value = "";
            applySettings();
        };
    };
    bindBrowse('#browseToggleSoundGlobal', toggleSoundInput);
    bindReset('#resetToggleSoundGlobal', toggleSoundInput);
    bindBrowse('#browseNotificationSoundGlobal', notifSoundInput);
    bindReset('#resetNotificationSoundGlobal', notifSoundInput);

    const openDebugLogBtn = el('#openDebugLogBtn', dialog);
    const resetEspBtn = el('#resetEspBtn', dialog);
    const espInfoBtn = el('#espInfoBtn', dialog);

    if (openDebugLogBtn) {
        openDebugLogBtn.onclick = () => {
            openDebugLogPanel();
        };
    }

    if (resetEspBtn) {
        resetEspBtn.onclick = () => {
            sendSerialCommand('DEV_RESET');
            showToast(t('settings.resetSent') || 'Reset command sent', 'info');
        };
    }

    if (espInfoBtn) {
        espInfoBtn.onclick = () => {
            sendSerialCommand('DEV_INFO');
            showToast(t('settings.infoRequested') || 'Info requested', 'info');
            // Open Serial Monitor to see the info
            openDebugLogPanel();
        };
    }

    const dumpConfigBtn = el('#dumpConfigBtn', dialog);
    if (dumpConfigBtn) {
        dumpConfigBtn.onclick = () => {
            if (!connectedSerialPort) {
                showToast(t('toast.notConnected'), 'error');
                return;
            }
            // Start capturing config
            window.configDumpCapture = {
                active: true,
                data: '',
                started: false
            };
            sendSerialCommand('DUMP_CONFIG');
            showToast(t('toast.requestingConfig'), 'info');
        };
    }

    // --- BUTTON ACTIONS ---
    // Artık özel bir closeDialog fonksiyonuna ihtiyacımız yok.
    // Doğrudan dialog.close() çağırıyoruz. 
    // Yukarıdaki 'close' event listener işi halledecek.
    el('#settingsOkBtn', dialog).onclick = () => dialog.close();
    el('#settingsCloseX', dialog).onclick = () => dialog.close();

    dialog.showModal();
}

// ============================================
// CONFIG DUMP DIALOG
// ============================================

function showConfigDumpDialog(jsonString) {
    // Varsa eski dialog'u kaldır
    const existing = document.getElementById('configDumpDialog');
    if (existing) existing.remove();

    // JSON'u formatla
    let formattedJson = '';
    try {
        const parsed = JSON.parse(jsonString);
        formattedJson = JSON.stringify(parsed, null, 2);
    } catch (e) {
        formattedJson = jsonString; // Parse edilemezse olduğu gibi göster
    }

    const dialog = document.createElement('dialog');
    dialog.id = 'configDumpDialog';
    dialog.style.cssText = `
        width: 800px;
        height: 500px;
        max-width: 90vw;
        max-height: 80vh;
        padding: 0;
        border: 1px solid var(--stroke);
        border-radius: 12px;
        background: var(--bg);
        color: var(--text);
    `;

    dialog.innerHTML = `
        <div style="display: flex; flex-direction: column; height: 100%;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--stroke);">
                <h3 style="margin: 0; font-size: 16px;">ESP32 Config (esp_config.json)</h3>
                <div style="display: flex; gap: 10px;">
                    <button id="copyConfigBtn" class="ghost" style="padding: 6px 12px; font-size: 13px;">📋 Copy</button>
                    <button id="downloadConfigBtn" class="ghost" style="padding: 6px 12px; font-size: 13px;">💾 Download</button>
                    <button id="closeConfigDumpBtn" class="ghost" style="padding: 6px 12px; font-size: 16px;">×</button>
                </div>
            </div>
            <div style="flex: 1; overflow: auto; padding: 16px;">
                <pre id="configDumpContent" style="
                    margin: 0;
                    padding: 16px;
                    background: var(--bg2);
                    border-radius: 8px;
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    font-size: 12px;
                    line-height: 1.5;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    color: var(--text);
                    border: 1px solid var(--stroke);
                ">${escapeHtml(formattedJson)}</pre>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    // Close button
    dialog.querySelector('#closeConfigDumpBtn').onclick = () => dialog.close();

    // Copy button
    dialog.querySelector('#copyConfigBtn').onclick = () => {
        navigator.clipboard.writeText(formattedJson).then(() => {
            showToast(t('toast.configCopied'), 'success');
        }).catch(() => {
            showToast(t('toast.configCopyFailed'), 'error');
        });
    };

    // Download button
    dialog.querySelector('#downloadConfigBtn').onclick = () => {
        const blob = new Blob([formattedJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'esp_config.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast(t('toast.configDownloaded'), 'success');
    };

    // ESC to close
    dialog.onkeydown = (e) => {
        if (e.key === 'Escape') dialog.close();
    };

    // Backdrop click to close
    dialog.onclick = (e) => {
        if (e.target === dialog) dialog.close();
    };

    // Remove from DOM when closed
    dialog.onclose = () => dialog.remove();

    dialog.showModal();
}

// ============================================
// DEBUG LOG PANEL
// ============================================

function addSerialLog(direction, message) {
    const timestamp = new Date().toLocaleTimeString();
    serialLogHistory.push({ timestamp, direction, message });
    if (serialLogHistory.length > MAX_LOG_ENTRIES) {
        serialLogHistory.shift();
    }

    // Update panel if open
    const logContent = document.getElementById('debugLogContent');
    if (logContent) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${direction}`;
        entry.innerHTML = `<span class="log-time">${timestamp}</span> <span class="log-dir">[${direction}]</span> ${escapeHtml(message)}`;
        logContent.appendChild(entry);
        logContent.scrollTop = logContent.scrollHeight;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function openDebugLogPanel() {
    // Enable developer mode to start logging serial data
    if (cfg) cfg.developerMode = true;
    
    const existingPanel = document.getElementById('debugLogPanel');
    if (existingPanel) {
        existingPanel.style.display = 'flex';

        // --- DÜZELTME: Zaten varsa ve Settings açıksa, oraya taşı ---
        // Bu sayede önceden body'de açılmışsa bile settings açılınca üstte kalır.
        const settingsDialog = document.getElementById('appSettingsDialog');
        if (settingsDialog && settingsDialog.open && existingPanel.parentNode !== settingsDialog) {
            const logContent = existingPanel.querySelector('#debugLogContent');

            settingsDialog.appendChild(existingPanel);

            // Always scroll to bottom after DOM update
            requestAnimationFrame(() => {
                if (logContent) {
                    logContent.scrollTop = logContent.scrollHeight;
                }
            });
        }
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'debugLogPanel';
    panel.className = 'debug-log-panel';
    panel.innerHTML = `
        <div class="debug-log-header">
            <span>🔍 Serial Log Viewer</span>
            <div class="debug-log-controls">
                <button id="clearDebugLog" class="ghost" title="Clear">🗑️</button>
                <button id="closeDebugLog" class="ghost" title="Close">×</button>
            </div>
        </div>
        <div id="debugLogContent" class="debug-log-content"></div>
    `;

    // --- DÜZELTME: NEREYE EKLENECEK? ---
    // Eğer Ayarlar penceresi açıksa ONUN İÇİNE ekle.
    // Değilse BODY'e ekle.
    const settingsDialog = document.getElementById('appSettingsDialog');
    if (settingsDialog && settingsDialog.open) {
        settingsDialog.appendChild(panel);
    } else {
        document.body.appendChild(panel);
    }
    // -----------------------------------

    // Populate with existing logs
    const logContent = panel.querySelector('#debugLogContent'); // document.getElementById yerine panel.querySelector daha güvenli
    serialLogHistory.forEach(log => {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${log.direction}`;
        entry.innerHTML = `<span class="log-time">${log.timestamp}</span> <span class="log-dir">[${log.direction}]</span> ${escapeHtml(log.message)}`;
        logContent.appendChild(entry);
    });
    logContent.scrollTop = logContent.scrollHeight;

    panel.querySelector('#closeDebugLog').onclick = () => panel.style.display = 'none';
    panel.querySelector('#clearDebugLog').onclick = () => {
        serialLogHistory = [];
        logContent.innerHTML = '';
        showToast(t('toast.logCleared'), 'info');
    };

    // Make draggable
    let isDragging = false;
    let offsetX, offsetY;
    panel.querySelector('.debug-log-header').onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        panel.style.cursor = 'grabbing';

        // Sürüklerken seçimi engelle
        e.preventDefault();
    };

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        // Panel fixed olduğu için ekran koordinatlarını kullanabiliriz
        let newLeft = e.clientX - offsetX;
        let newTop = e.clientY - offsetY;

        panel.style.left = newLeft + 'px';
        panel.style.top = newTop + 'px';
        panel.style.bottom = 'auto';
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        panel.style.cursor = '';
    });
}

async function exportForEsp32() {
    try {
        // 1. Generate files first
        const generatedData = await generateEspFiles();
        if (!generatedData) {
            await showCustomAlert(t('export.generationError'), t('export.errorTitle'));
            return;
        }

        const { configBlob, configFileName, imageFiles, errors } = generatedData;

        // 2. Show folder picker
        let outputDirHandle;
        try {
            outputDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (pickerError) {
            if (pickerError.name === 'AbortError') {
                // User cancelled - silent return
                return;
            }
            throw pickerError;
        }

        // 3. Verify we have a valid directory handle
        if (!outputDirHandle) {
            await showCustomAlert(t('export.noFolder'), t('export.errorTitle'));
            return;
        }

        // 4. Write config file
        const configFileHandle = await outputDirHandle.getFileHandle(configFileName, { create: true });
        let writableConfig = await configFileHandle.createWritable();
        await writableConfig.write(configBlob);
        await writableConfig.close();

        // 5. Write image files
        let iconsCopied = 0;
        for (const file of imageFiles) {
            try {
                const iconFileHandle = await outputDirHandle.getFileHandle(file.fileName, { create: true });
                const writableIcon = await iconFileHandle.createWritable();
                await writableIcon.write(file.blob);
                await writableIcon.close();
                iconsCopied++;
            } catch (imgError) {
                console.error(`Failed to write ${file.fileName}:`, imgError);
                errors.push(`Failed to save ${file.fileName}`);
            }
        }

        // 6. Show success message
        let message = t('export.success', { configFile: configFileName, imageCount: iconsCopied });
        if (errors.length > 0) {
            message += `\n\n${t('export.warnings')}\n- ${errors.join('\n- ')}`;
        }
        await showCustomAlert(message, t('export.title'));

    } catch (e) {
        console.error("Local Export error:", e);
        if (e.name !== 'AbortError') {
            await showCustomAlert(t('export.failed', { error: e.message }), t('export.errorTitle'));
        }
    }
}


// Define timer outside function (or in global scope)
let pageSwitchTimer = null;

// Replace existing 'renderPageBar' function with this:

function renderPageBar() {
    const bar = el('#pagebar'); bar.innerHTML = '';

    // To update page name in bottom bar of web interface
    const webPageNameEl = el('#web-page-name');

    // ----- LANGUAGE CHANGE HERE -----
    let defaultPageName = t('device.frame.page', { pageNum: currentPage + 1 }); // "Page X"
    let currentActivePageName = defaultPageName;
    // ---------------------------------

    for (let i = 0; i < cfg.pageCount; i++) {
        const b = document.createElement('button'); b.className = 'page-pill' + (i === currentPage ? ' active' : '');

        // ----- LANGUAGE CHANGE HERE -----
        const pageName = cfg.pageNames[i];
        // Translate default name
        const defaultNameForThis = t('device.frame.page', { pageNum: i + 1 });
        b.textContent = (pageName || String(i + 1)); // Show number if no page name (not translated name)
        if (pageName) b.title = defaultNameForThis; // Put translated name in title
        // ---------------------------------

        // Capture active page name
        if (i === currentPage) {
            currentActivePageName = (pageName || defaultNameForThis);
        }

        b.onclick = () => {
            currentPage = i;
            drawGrid();
            renderPageBar();
            saveConfig(false);
            if (connectedSerialPort && deviceCurrentPage !== i) {
                deviceCurrentPage = i;
                sendSerialCommand(`SET_PAGE:${i}`);
            }
        };

        // --- PAGE REORDER DRAG EVENTS ---
        b.draggable = true;
        b.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/page-reorder', String(i));
            e.dataTransfer.effectAllowed = 'move';
            b.classList.add('dragging');
        });
        b.addEventListener('dragend', () => {
            b.classList.remove('dragging');
            document.querySelectorAll('.page-pill.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        // --- BUTTON-TO-PAGE DRAG EVENTS ---
        b.addEventListener('dragenter', (e) => {
            // Check if it's a page reorder
            if (e.dataTransfer.types.includes('text/page-reorder')) {
                e.preventDefault();
                b.classList.add('drag-over');
                return;
            }
            // Button drag
            if (!e.dataTransfer.types.includes('application/json')) return;
            e.preventDefault();
            if (i === currentPage || pageSwitchTimer) return;
            pageSwitchTimer = setTimeout(() => {
                currentPage = i;
                drawGrid();
                renderPageBar();
                saveConfig();
                // Only update local knob preview, don't sync to ESP32
                updateKnobPreviewForCurrentPage();
                pageSwitchTimer = null;
            }, 500);
        });
        b.addEventListener('dragleave', (e) => {
            b.classList.remove('drag-over');
            clearTimeout(pageSwitchTimer);
            pageSwitchTimer = null;
        });
        b.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/json') || e.dataTransfer.types.includes('text/page-reorder')) {
                e.preventDefault();
            }
        });
        b.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            b.classList.remove('drag-over');
            clearTimeout(pageSwitchTimer);
            pageSwitchTimer = null;

            // Check if page reorder
            const pageReorderData = e.dataTransfer.getData('text/page-reorder');
            if (pageReorderData !== '') {
                const fromPageIdx = parseInt(pageReorderData);
                const toPageIdx = i;
                if (fromPageIdx !== toPageIdx) {
                    // Reorder pages
                    const [movedPage] = cfg.pages.splice(fromPageIdx, 1);
                    cfg.pages.splice(toPageIdx, 0, movedPage);

                    const [movedName] = cfg.pageNames.splice(fromPageIdx, 1);
                    cfg.pageNames.splice(toPageIdx, 0, movedName);

                    // Update pageApps indices
                    if (cfg.pageApps) {
                        const newPageApps = {};
                        Object.keys(cfg.pageApps).forEach(key => {
                            let idx = parseInt(key);
                            if (idx === fromPageIdx) {
                                idx = toPageIdx;
                            } else if (fromPageIdx < toPageIdx) {
                                if (idx > fromPageIdx && idx <= toPageIdx) idx--;
                            } else {
                                if (idx >= toPageIdx && idx < fromPageIdx) idx++;
                            }
                            newPageApps[idx] = cfg.pageApps[key];
                        });
                        cfg.pageApps = newPageApps;
                    }

                    // Update pageAutoFocus indices
                    if (cfg.pageAutoFocus) {
                        const newPageAutoFocus = {};
                        Object.keys(cfg.pageAutoFocus).forEach(key => {
                            let idx = parseInt(key);
                            if (idx === fromPageIdx) {
                                idx = toPageIdx;
                            } else if (fromPageIdx < toPageIdx) {
                                if (idx > fromPageIdx && idx <= toPageIdx) idx--;
                            } else {
                                if (idx >= toPageIdx && idx < fromPageIdx) idx++;
                            }
                            newPageAutoFocus[idx] = cfg.pageAutoFocus[key];
                        });
                        cfg.pageAutoFocus = newPageAutoFocus;
                    }

                    // Update pageAutoFocus indices
                    if (cfg.pageAutoFocus) {
                        const newPageAutoFocus = {};
                        Object.keys(cfg.pageAutoFocus).forEach(key => {
                            let idx = parseInt(key);
                            if (idx === fromPageIdx) {
                                idx = toPageIdx;
                            } else if (fromPageIdx < toPageIdx) {
                                if (idx > fromPageIdx && idx <= toPageIdx) idx--;
                            } else {
                                if (idx >= toPageIdx && idx < fromPageIdx) idx++;
                            }
                            newPageAutoFocus[idx] = cfg.pageAutoFocus[key];
                        });
                        cfg.pageAutoFocus = newPageAutoFocus;
                    }

                    // Adjust currentPage if needed
                    if (currentPage === fromPageIdx) {
                        currentPage = toPageIdx;
                    } else if (fromPageIdx < toPageIdx && currentPage > fromPageIdx && currentPage <= toPageIdx) {
                        currentPage--;
                    } else if (fromPageIdx > toPageIdx && currentPage >= toPageIdx && currentPage < fromPageIdx) {
                        currentPage++;
                    }

                    drawGrid();
                    renderPageBar();
                    saveConfig();
                }
                return;
            }

            // Button drag handling
            const dragData = e.dataTransfer.getData('application/json');
            if (!dragData) return;
            const data = JSON.parse(dragData);
            const fromPage = data.sourcePage;
            const fromIndex = data.sourceIndex;

            const toPage = i;
            if (fromPage === toPage) return;
            const targetPageButtons = cfg.pages[toPage];
            const emptySlotIndex = targetPageButtons.findIndex(btn => !isFilled(btn));
            if (emptySlotIndex !== -1) {
                cfg.pages[toPage][emptySlotIndex] = cfg.pages[fromPage][fromIndex];
                cfg.pages[fromPage][fromIndex] = emptyBtn();
                currentPage = toPage;
                drawGrid();
                renderPageBar();
                saveConfig();
            } else {
                // ----- DİL DEĞİŞİKLİĞİ BURADA -----
                showCustomAlert(t('alerts.pageFull.message'), t('alerts.pageFull.title'));
            }
        });
        // --- DRAG EVENTS END ---

        const edit = document.createElement('i');
        edit.className = 'edit-name page-edit-btn';
        edit.textContent = '✎';
        edit.title = t('page.settings');
        edit.onclick = async (e) => {
            e.stopPropagation();
            const currentName = cfg.pageNames[i] || '';

            const result = await showPageSettingsDialog(i, currentName);

            if (result !== null) {
                cfg.pageNames[i] = result.name || currentName;

                // Update app association
                if (!cfg.pageApps) cfg.pageApps = {};
                if (!cfg.pageAutoFocus) cfg.pageAutoFocus = {};

                if (result.app) {
                    cfg.pageApps[i] = result.app;
                    cfg.pageAutoFocus[i] = result.autoFocus;
                } else {
                    delete cfg.pageApps[i];
                    delete cfg.pageAutoFocus[i];
                }

                saveConfig();
                renderPageBar();

                // Send to ESP32
                sendSerialCommand(`SET_PAGE_NAME:${i}:${cfg.pageNames[i]}`);
            }
        };
        b.appendChild(edit);

        const x = document.createElement('div'); x.className = 'close'; x.textContent = '×'; x.title = t('page.deletePage');
        x.onclick = async (e) => {
            e.stopPropagation();
            if (cfg.pageCount <= 1) {
                // ----- DİL DEĞİŞİKLİĞİ BURADA -----
                await showCustomAlert(t('alerts.deletePage.error_min_pages'), t('alerts.deleteError'));
                return;
            }

            // ----- DİL DEĞİŞİKLİĞİ BURADA -----
            const pageDisplayName = cfg.pageNames[i] || t('device.frame.page', { pageNum: i + 1 });
            const confirmed = await showCustomConfirm(
                t('alerts.deletePage.message', { pageName: pageDisplayName }),
                t('alerts.deletePage.title'),
                t('dialogs.delete'),
                t('editor.cancel')
            );
            // ---------------------------------

            if (!confirmed) return;

            cfg.pages.splice(i, 1);
            cfg.pageNames.splice(i, 1);
            cfg.pageCount--;
            currentPage = Math.max(0, Math.min(currentPage, cfg.pageCount - 1));
            drawGrid();
            renderPageBar();
            saveConfig();
        };
        b.appendChild(x); bar.appendChild(b);
    }

    const add = document.createElement('button'); add.className = 'page-pill add'; add.textContent = '+';

    add.onclick = async () => {
        const defaultName = t('prompt.addPage.default', { pageNum: cfg.pageCount + 1 });
        const result = await showPageSettingsDialog(null, defaultName);

        if (result === null) {
            return;
        }

        cfg.pageCount++;
        cfg.pages.push(Array.from({ length: GRID_COLS * GRID_ROWS }, () => emptyBtn()));
        cfg.pageNames.push(result.name || defaultName);

        // Store app association
        if (!cfg.pageApps) cfg.pageApps = {};
        if (!cfg.pageAutoFocus) cfg.pageAutoFocus = {};

        if (result.app) {
            cfg.pageApps[cfg.pageCount - 1] = result.app;
            cfg.pageAutoFocus[cfg.pageCount - 1] = result.autoFocus;
        }

        currentPage = cfg.pageCount - 1;
        drawGrid();
        renderPageBar();
        saveConfig();
    };

    bar.appendChild(add);

    // Update page name in bottom bar of web interface
    if (webPageNameEl) {
        webPageNameEl.textContent = currentActivePageName;
    }
}

function populateGridControls() {
    const csel = el('#cols'), rsel = el('#rows'); csel.innerHTML = ''; rsel.innerHTML = '';
    for (let i = 1; i <= MAX_COLS; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i; csel.appendChild(o); }
    for (let i = 1; i <= MAX_ROWS; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i; rsel.appendChild(o); }
    csel.value = Math.min(GRID_COLS, MAX_COLS); rsel.value = Math.min(GRID_ROWS, MAX_ROWS);
    GRID_COLS = Number(csel.value); GRID_ROWS = Number(rsel.value);
    csel.onchange = () => onGridChanged(Number(csel.value), GRID_ROWS); rsel.onchange = () => onGridChanged(GRID_COLS, Number(rsel.value));
}


// --- NEW: Function to force free port ---
async function forceFreePort(port) {
    if (!port) return;

    // 1. Is port readable (i.e. open)?
    if (port.readable) {
        // 2. Is it locked? (Is a reader attached?)
        if (port.readable.locked) {
            try {
                // If this port is connected to current global reader (portReader), cancel reader
                if (portReader && connectedSerialPort === port) {
                    await portReader.cancel();
                    portReader.releaseLock();
                    portReader = null;
                }
                // If not global but still locked somehow, we can't unlock it (API limitation),
                // but usually the above step is enough.
            } catch (e) {
                console.warn("Reader unlock error (insignificant):", e);
            }
        }

        // 3. Close port
        try {
            await port.close();
        } catch (e) {
            console.warn("Port close error:", e);
        }
    }
}

function parseAndExecuteKeyCombo(combo) {
    if (!window.electronAPI || !window.electronAPI.robot) {
        console.warn("RobotJS API not found.");
        return;
    }

    const cleanCombo = combo.trim();
    if (cleanCombo.length === 0) return;

    // 0. Scroll Commands with optional modifiers (e.g., ALT+SCROLL_DOWN, CTRL+SCROLL_UP)
    const upperCombo = cleanCombo.toUpperCase();
    if (upperCombo.includes('SCROLL_UP') || upperCombo.includes('SCROLL_DOWN')) {
        const isScrollUp = upperCombo.includes('SCROLL_UP');

        // Check for modifiers before SCROLL
        const parts = cleanCombo.split('+').map(k => k.trim());
        const modifierMap = {
            'CTRL': 'control', 'ALT': 'alt', 'SHIFT': 'shift', 'WIN': 'command', 'GUI': 'command'
        };

        let modifiers = [];
        for (let i = 0; i < parts.length - 1; i++) {
            const partUpper = parts[i].toUpperCase();
            if (modifierMap[partUpper]) {
                modifiers.push(modifierMap[partUpper]);
            }
        }

        // Use NirCmd for scroll (better compatibility with Adobe apps)
        const nircmdPath = `"${ASSETS_PATH}/nircmd.exe"`;
        const wheelAmount = isScrollUp ? 120 : -120;

        if (modifiers.length > 0) {
            // Hold modifier with RobotJS, scroll with NirCmd
            (async () => {
                for (const mod of modifiers) {
                    window.electronAPI.robot.keyToggle(mod, 'down');
                }
                await new Promise(r => setTimeout(r, 50));
                await window.electronAPI.system.runCommand(`${nircmdPath} sendmouse wheel ${wheelAmount}`);
                await new Promise(r => setTimeout(r, 50));
                for (const mod of modifiers) {
                    window.electronAPI.robot.keyToggle(mod, 'up');
                }
            })();
        } else {
            // Plain scroll with NirCmd
            window.electronAPI.system.runCommand(`${nircmdPath} sendmouse wheel ${wheelAmount}`);
        }
        return;
    }

    // 1. Media Keys & Special Commands
    const mediaKeys = {
        'AUDIO_MUTE': 'audio_mute', 'AUDIO_PLAY': 'audio_play',
        'AUDIO_NEXT': 'audio_next', 'AUDIO_PREV': 'audio_prev',
        'AUDIO_STOP': 'audio_stop', 'AUDIO_VOL_UP': 'audio_vol_up',
        'AUDIO_VOL_DOWN': 'audio_vol_down'
    };
    if (mediaKeys[cleanCombo.toUpperCase()]) {
        try { window.electronAPI.robot.keyTap(mediaKeys[cleanCombo.toUpperCase()]); } catch (e) { console.error(e); }
        return;
    }

    // 2. Parse Shortcut
    // "+" ile ayır, boşlukları temizle
    const parts = cleanCombo.split('+').map(k => k.trim());

    const modifierMap = {
        'CTRL': 'control', 'ALT': 'alt', 'SHIFT': 'shift', 'WIN': 'command', 'GUI': 'command'
    };

    let modifiers = [];
    // Son parça hariç hepsi modifier (örn: CTRL+ALT+DEL -> CTRL, ALT modifier, DEL tuş)
    for (let i = 0; i < parts.length - 1; i++) {
        const partUpper = parts[i].toUpperCase();
        if (modifierMap[partUpper]) {
            modifiers.push(modifierMap[partUpper]);
        }
    }

    // Asıl Tuş (Son Parça)
    let rawKey = parts[parts.length - 1];

    // --- TR -> US Klavye & Özel Tuş Çevirisi ---
    const trMap = {
        'ö': ',', 'Ö': ',',
        'ç': '.', 'Ç': '.',
        'ş': ';', 'Ş': ';',
        'ğ': '[', 'Ğ': '[',
        'ü': ']', 'Ü': ']',
        'i': "'", 'İ': "'",
        'ı': 'i', 'I': 'i',
        ',': ',', '.': '.', ';': ';', '/': '/', '\\': '\\',
        '-': '-', '=': '=', '[': '[', ']': ']', "'": "'"
    };

    let finalKey;

    if (trMap[rawKey]) {
        finalKey = trMap[rawKey];
    } else {
        finalKey = rawKey.toLowerCase();

        // --- DÜZELTME BURADA: YÖN TUŞLARI ---
        // Gelen: ARROW_DOWN, ARROWDOWN -> Giden: down
        if (finalKey.includes('arrow')) {
            if (finalKey.includes('up')) finalKey = 'up';
            else if (finalKey.includes('down')) finalKey = 'down';
            else if (finalKey.includes('left')) finalKey = 'left';
            else if (finalKey.includes('right')) finalKey = 'right';
        }

        // Diğer özel tuşlar
        if (finalKey === 'esc') finalKey = 'escape';
        if (finalKey === 'return') finalKey = 'enter';
        if (finalKey === 'ins') finalKey = 'insert';
        if (finalKey === 'del') finalKey = 'delete';
        if (finalKey === 'delete') finalKey = 'delete';
        if (finalKey === 'caps') finalKey = 'capslock';
        if (finalKey === 'pgup') finalKey = 'pageup';
        if (finalKey === 'pgdn') finalKey = 'pagedown';
        if (finalKey === 'page_up') finalKey = 'pageup';
        if (finalKey === 'page_down') finalKey = 'pagedown';
        if (finalKey === 'home') finalKey = 'home';
        if (finalKey === 'end') finalKey = 'end';
        if (finalKey === 'space' || finalKey === ' ') finalKey = 'space';
        if (finalKey === 'backspace' || finalKey === 'bksp') finalKey = 'backspace';
        if (finalKey === 'printscreen' || finalKey === 'prtsc') finalKey = 'printscreen';
        if (finalKey === 'num0') finalKey = 'numpad_0';
        if (finalKey === 'num1') finalKey = 'numpad_1';
        if (finalKey === 'num2') finalKey = 'numpad_2';
        if (finalKey === 'num3') finalKey = 'numpad_3';
        if (finalKey === 'num4') finalKey = 'numpad_4';
        if (finalKey === 'num5') finalKey = 'numpad_5';
        if (finalKey === 'num6') finalKey = 'numpad_6';
        if (finalKey === 'num7') finalKey = 'numpad_7';
        if (finalKey === 'num8') finalKey = 'numpad_8';
        if (finalKey === 'num9') finalKey = 'numpad_9';
    }


    try {
        window.electronAPI.robot.keyTap(finalKey, modifiers);
    } catch (e) {
        console.error(`RobotJS Error on key "${finalKey}": ${e.message}`);
    }
}

document.addEventListener('DOMContentLoaded', async () => {

    if (window.electronAPI && window.electronAPI.app) {
        const ver = await window.electronAPI.app.getVersion();
        const verText = document.querySelector('.app-version-text');
        if (verText) verText.textContent = `Smart Deck v${ver}`;
    }
    const knobBtn = document.getElementById('knobTriggerBtn');
    if (knobBtn) knobBtn.addEventListener('click', openKnobSettings);
    // --- MANUAL UPDATE LOGIC (Github Redirect) ---
    const updateContainer = el('#update-container');
    const updateBtn = el('#updateBtn');

    if (window.electronAPI && window.electronAPI.app) {

        // Sadece 'update-available' olayını dinliyoruz.
        // Çünkü indirme yapmayacağız, var olduğunu bilmemiz yeterli.
        window.electronAPI.app.onUpdateAvailable(() => {

            if (updateContainer && updateBtn) {
                // 1. Şeridi Göster
                updateContainer.style.display = 'block';
                updateBtn.classList.remove('hidden');

                // 2. Butonu Yeşil Yap (Hazır Modu)
                updateBtn.classList.add('ready');

                // 3. Metni Ayarla (Spin ikonuna gerek yok artık)
                // "Yeni Güncelleme Mevcut (İndir)"
                updateBtn.innerHTML = `<span>⬇</span> ${t('update.available')}`;

                // 4. Tıklayınca GitHub Releases Sayfasına Git
                updateBtn.onclick = () => {
                    // Tarayıcıda açar
                    if (window.electronAPI.shell) {
                        window.electronAPI.shell.openExternal('https://github.com/pankrasnal4-dot/smartdeck/releases/latest');
                    }
                };
            }
        });
    }

    initCropSystem();
    initActionPalette();
    // DOMContentLoaded içinde uygun bir yere ekle:
    el('#openFlasherBtn').addEventListener('click', openFirmwareDialog);
    // 1. Learn Asset Path
    if (window.electronAPI && window.electronAPI.app) {
        ASSETS_PATH = await window.electronAPI.app.getAssetsPath();
        ASSETS_PATH = ASSETS_PATH.replace(/\\/g, '/');
    }

    loadPlugins(); // Load plugins
    el('#refreshPluginsBtn').addEventListener('click', loadPlugins);
    el('#openPluginsFolderBtn').addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.app && window.electronAPI.app.openPluginsFolder) {
            window.electronAPI.app.openPluginsFolder();
        }
    });

    // 2. Bind Event Listeners
    el('#settingsBtn').addEventListener('click', openSettings);
    el('#undoBtn').addEventListener('click', undoAction);
    el('#redoBtn').addEventListener('click', redoAction);
    el('#refreshSerialBtn').addEventListener('click', () => updateSerialPortList(true));

    el('#uploadViaUsbBtn').onclick = async () => {
        if (!connectedSerialPort) {
            await showCustomAlert(t('alerts.deviceNotConnected'), t('alerts.connectionError'));
            return;
        }
        uploadConfigViaUsb();
    };

    el('#exportSettingsBtn').addEventListener('click', exportSettings);
    el('#exportEspBtn').addEventListener('click', exportForEsp32);
    el('#importSettingsBtn').addEventListener('click', () => { el('#importFile').value = null; el('#importFile').click(); });
    el('#importFile').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importSettingsFile(f); });
    el('#resetSettingsBtn').addEventListener('click', resetAllSettings);

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undoAction(); }
            else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); redoAction(); }
        }
    });

    // 3. Load Config and Draw UI
    try {
        cfg = loadConfig(); // Load config

        // --- NEW SAFETY CHECK ---
        // If saved resolution setting is broken (e.g. ""), return to default
        if (!cfg.device.resolution || !DEVICE_PROFILES[cfg.device.resolution]) {
            console.warn("Broken resolution setting detected. Resetting to default.");
            cfg.device.resolution = "800x480"; // Return to default profile
        }
        // --- CHECK END ---


        // ----- LANGUAGE LOADING START -----
        let initialLang = (cfg.appSettings && cfg.appSettings.language) ? cfg.appSettings.language : DEFAULT_LANG;

        if (!cfg.appSettings.language) {
            const browserLang = (navigator.language || navigator.userLanguage).split('-')[0];
            if (['en', 'tr', 'de', 'es', 'fr', 'ja', 'zh'].includes(browserLang)) {
                initialLang = browserLang;
            }
        }

        // Start translation engine
        await loadLanguage(initialLang);
        // ----- LANGUAGE LOADING END -----

        // Load Profile and Grid settings
        const resSelect = el('#resolutionSelect');
        for (const [key, profile] of Object.entries(DEVICE_PROFILES)) {
            const o = document.createElement('option');
            o.value = key;
            o.textContent = profile.name;
            resSelect.appendChild(o);
        }

        // This line will now work thanks to cfg.device.resolution having a valid value
        resSelect.value = cfg.device.resolution;

        resSelect.addEventListener('change', (e) => {
            if (cfg.device) delete cfg.device.showKnob;
            applyDeviceProfile(e.target.value);
        });

        applyTheme();
        wireTheme();

        applyDeviceProfile(cfg.device.resolution);

        saveHistory(); // Save initial state

        // Initialize knob LEDs after config is loaded
        if (typeof updateKnobLeds === 'function' && cfg.knob) {
            updateKnobLeds(knobRotationAngle);
        }

    } catch (e) {
        console.error("Fatal error during DOMContentLoaded:", e);
    }

    // 4. Start Background Timer Checker (for notifications on other pages)
    startBackgroundTimerChecker();
    
    // 4b. Start Active Window Monitoring (for automatic app profile switching)
    startActiveWindowMonitoring();

    // 4c. Init System Telemetry & Simulator Controls
    initSystemTelemetry();
    initSimulatorHeaderControls();
    
    // 5. Start Auto-Connect
    if (navigator.serial) {
        // USB event listeners
        let usbConnectDebounce = null;
        navigator.serial.addEventListener('connect', (event) => {
            console.log('[Serial] USB device connected event');
            if (!connectedSerialPort) {
                if (usbConnectDebounce) clearTimeout(usbConnectDebounce);
                usbConnectDebounce = setTimeout(() => scanForDevice(), 800);
            }
        });
        
        navigator.serial.addEventListener('disconnect', (event) => {
            console.log('[Serial] USB device disconnected event');
            
            // Bağlı port mu koptu kontrol et
            if (connectedSerialPort) {
                // Port'un hala geçerli olup olmadığını kontrol et
                try {
                    // Eğer port artık kullanılamıyorsa disconnect yap
                    if (!connectedSerialPort.readable || !connectedSerialPort.writable) {
                        console.log('[Serial] Connected port is no longer valid');
                        forceDisconnect();
                    } else {
                        // Port'u test et - readable locked olabilir
                        forceDisconnect();
                    }
                } catch (e) {
                    console.log('[Serial] Port check failed, forcing disconnect');
                    forceDisconnect();
                }
            }
        });
        
        // Start auto-connect
        startAutoConnect();
    }
});
// --- UPDATED: "Handshake" function to learn device name ---
// ============================================
// LEGACY SERIAL FUNCTIONS
// ============================================
async function identifyPort(port) {
    // Try to connect to device
    return await connectToDevice(port);
}

function startAutoConnectLoop() {
    startAutoConnect();
}

function stopAutoConnectLoop() {
    stopAutoConnect();
}

// State tracking
let isSearchingLoopActive = false;

// --- NEW: For new device find button (Magnifying glass) ---

async function uploadConfigViaUsb() {
    // --- CONCURRENT UPLOAD PROTECTION ---
    if (isUploading) {
        console.warn('[Upload] Already uploading, ignoring request');
        showToast(t('serialUpload.alreadyUploading') || 'Upload already in progress...', 'warning');
        return;
    }
    isUploading = true;
    // --- END PROTECTION ---

    const btn = el('#uploadViaUsbBtn');
    const originalBtnText = btn.textContent;
    const statusEl = el('#uploadStatus');
    statusEl.textContent = '';
    statusEl.className = 'upload-status-message';

    // --- NEW: Track if upload really started ---
    let isUploadStarted = false;
    // ------------------------------------------------------

    let uploadSuccess = false;
    let portToUse = connectedSerialPort;

    // 1. Port Check
    if (!portToUse) {
        try {
            statusEl.textContent = t('serialUpload.selectDevice');
            statusEl.classList.add('warning');
            portToUse = await navigator.serial.requestPort({});
        } catch (e) {
            if (e.message.includes('No port selected') || e.name === 'NotFoundError') {
                statusEl.textContent = t('serialUpload.noDeviceSelected');
            } else {
                statusEl.textContent = t('serialUpload.error', { message: e.message });
            }
            statusEl.classList.add('error');
            btn.disabled = false;
            btn.textContent = originalBtnText;

            // If we return here, finally won't run because try block hasn't started yet.
            // But if port connection is lost, we may want to refresh UI.
            setTimeout(async () => {
                connectedSerialPort = null;
                connectedDeviceName = ''; // Clear device name
                isAutoConnected = false;
                statusEl.textContent = '';
                await updateSerialPortList(true);
            }, 500);
            return;
        }
    }

    let uploadReader;
    let writer;

    try {
        btn.disabled = true;
        statusEl.textContent = t('upload.generating');

        // 2. Generate Files
        let generatedData;
        try {
            generatedData = await generateEspFiles();
            if (!generatedData || generatedData.errors.length > 0) {
                throw new Error(generatedData?.errors.join(', ') || "Gen failed");
            }
        } catch (e) { throw e; }

        const { configBlob, configFileName, imageFiles } = generatedData;
        const allFiles = [{ blob: configBlob, fileName: configFileName }, ...imageFiles];

        // 3. Manifest Checks and Hash Calculation
        let oldManifest = {};
        try { oldManifest = JSON.parse(localStorage.getItem(MANIFEST_STORAGE_KEY) || '{}'); } catch (e) { }

        const filesToUpload = [];
        const newManifest = {};

        statusEl.textContent = t('serialUpload.calculatingChanges');

        for (const file of allFiles) {
            const hash = await calculateBlobHash(file.blob);
            newManifest[file.fileName] = hash;
            if (oldManifest[file.fileName] !== hash) {
                filesToUpload.push(file);
            }
        }

        const skippedCount = allFiles.length - filesToUpload.length;

        // 4. User Confirmation
        let confirmMsg = "";
        if (filesToUpload.length === 0) {
            confirmMsg = t('serialUpload.noChanges');
        } else {
            confirmMsg = t('serialUpload.smartUpload', { changed: filesToUpload.length, skipped: skippedCount });
        }

        const confirmResult = await showCustomConfirm(
            `${confirmMsg}\n\n<label style="display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--text);"><input type="checkbox" id="forceFullUpload" style="width: 16px; height: 16px;"> ${t('serialUpload.forceUpload')}</label>`,
            t('serialUpload.title'),
            t('serialUpload.confirm'),
            t('editor.cancel')
        );

        if (!confirmResult) {
            // --- CANCEL STATE ---
            // isUploadStarted is still false so finally block won't disconnect.
            btn.disabled = false;
            btn.textContent = originalBtnText;
            statusEl.textContent = '';
            return;
        }

        // --- CRITICAL POINT: User CONFIRMED, no turning back now ---

        // -------------------------------------------------------------

        const forceUpload = document.getElementById('forceFullUpload')?.checked || false;
        let finalUploadList = forceUpload ? allFiles : filesToUpload;

        if (finalUploadList.length === 0 && !forceUpload) {
            statusEl.textContent = t('serialUpload.upToDate');
            statusEl.classList.add('success');
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
            btn.disabled = false;
            btn.textContent = originalBtnText;
            // Here we didn't upload but process is considered complete, 
            // isUploadStarted=true so finally will reset port. 
            // In this case resetting is not a problem, it's a clean start.
            return;
        }
        isUploadStarted = true;
        isEspReady = false; // ESP reboot olacak, komutları beklet
        // --- UPLOAD OPERATIONS ---
        statusEl.textContent = '';

        // Port Preparation - Close everything and reopen fresh
        if (portToUse === connectedSerialPort) {
            // Stop listener
            isListening = false;
            
            // Cancel and release reader
            if (portReader) {
                try {
                    await portReader.cancel();
                    portReader.releaseLock();
                } catch (e) { console.warn('Reader cleanup:', e.message); }
                portReader = null;
            }
            
            // Close port completely
            try {
                await portToUse.close();
            } catch (e) { console.warn('Port close:', e.message); }
            
            // Small delay
            await new Promise(r => setTimeout(r, 200));
            
            // Reopen port fresh
            await portToUse.open({ baudRate: 115200 });
        } else {
            // New port - just open it
            if (!portToUse.readable) await portToUse.open({ baudRate: 115200 });
        }
        
        // Now get fresh writer and reader
        writer = portToUse.writable.getWriter();
        uploadReader = portToUse.readable.getReader();

        // Serial Helpers
        let serialBuffer = '';
        const uploadDecoder = new TextDecoder();
        const READ_TIMEOUT = 15000; // 15 second timeout for each read
        
        async function readUploadLine() {
            const startTime = Date.now();
            while (true) {
                // Check timeout
                if (Date.now() - startTime > READ_TIMEOUT) {
                    throw new Error('Read timeout - no response from device');
                }
                
                const n = serialBuffer.indexOf('\n');
                if (n !== -1) { 
                    const l = serialBuffer.substring(0, n).trim(); 
                    serialBuffer = serialBuffer.substring(n + 1); 
                    return l; 
                }
                
                // Use Promise.race to add timeout to read operation
                const readPromise = uploadReader.read();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Read timeout')), READ_TIMEOUT - (Date.now() - startTime))
                );
                
                try {
                    const { value, done } = await Promise.race([readPromise, timeoutPromise]);
                    if (done) throw new Error('Port closed');
                    if (value) serialBuffer += uploadDecoder.decode(value, { stream: true });
                } catch (e) {
                    if (e.message.includes('timeout')) throw e;
                    throw e;
                }
            }
        }
        async function writeSerial(d) { 
            const enc = new TextEncoder(); 
            await writer.write(typeof d === 'string' ? enc.encode(d) : d); 
        }

        // Protocol Start
        btn.textContent = t('serialUpload.handshake');
        await writeSerial("START_UPLOAD\n");

        let response = await readUploadLine();
        // Wait for READY with retry limit
        let readyAttempts = 0;
        const MAX_READY_ATTEMPTS = 20;
        while (response && !response.includes("READY")) { 
            if (++readyAttempts > MAX_READY_ATTEMPTS) {
                throw new Error("Device not responding - no READY signal");
            }
            response = await readUploadLine(); 
        }
        if (!response || !response.includes("READY")) throw new Error("Device not ready");

        // Send Files
        for (let i = 0; i < finalUploadList.length; i++) {
            const f = finalUploadList[i];
            btn.textContent = `File ${i + 1}/${finalUploadList.length}`;
            statusEl.textContent = `Uploading: ${f.fileName} (${Math.ceil(f.blob.size / 1024)}KB)`;

            const buf = await f.blob.arrayBuffer();
            await writeSerial(`FILE:${f.fileName}:${buf.byteLength}\n`);
            const fileResponse = await readUploadLine();
            if (fileResponse !== "OK_FILE") {
                throw new Error(`Init failed: ${f.fileName} (${fileResponse})`);
            }
            
            // Small delay to ensure ESP32 is ready to receive data
            await new Promise(r => setTimeout(r, 50));
            
            // Send data in chunks to avoid buffer overflow
            const CHUNK_SIZE = 4096;
            const data = new Uint8Array(buf);
            for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
                const chunk = data.slice(offset, Math.min(offset + CHUNK_SIZE, data.length));
                await writeSerial(chunk);
                // Small delay between chunks for ESP32 to process
                if (offset + CHUNK_SIZE < data.length) {
                    await new Promise(r => setTimeout(r, 5));
                }
            }
            
            const dataResponse = await readUploadLine();
            if (dataResponse !== "OK_DATA") {
                // Include the actual error response for debugging
                throw new Error(`Data failed: ${f.fileName} (${dataResponse})`);
            }
        }

        btn.textContent = t('serialUpload.finishing');
        statusEl.textContent = t('serialUpload.finalizing');
        await writeSerial("END_UPLOAD\n");

        response = await readUploadLine();
        if (!response.includes("DONE_REBOOT")) {
            throw new Error(`Finalize failed: ${response}`);
        }

        statusEl.textContent = t('upload.rebooting');

        localStorage.setItem(MANIFEST_STORAGE_KEY, JSON.stringify(newManifest));

        let setupDone = false;
        const rebootTimer = setTimeout(() => { if (!setupDone) console.warn("Reboot timeout."); }, 15000);

        while (!setupDone) {
            try {
                response = await readUploadLine();
                if (response && response.includes("SETUP_DONE")) {
                    setupDone = true;
                    clearTimeout(rebootTimer);
                }
            } catch (e) { setupDone = true; clearTimeout(rebootTimer); }
        }

        if (setupDone) {
            statusEl.textContent = `Success! (${finalUploadList.length} uploaded, ${skippedCount} skipped)`;
            statusEl.classList.add('success');
            uploadSuccess = true;
        }

    } catch (error) {
        console.error("USB Upload failed:", error);
        statusEl.textContent = `Error: ${error.message}`;
        statusEl.classList.add('error');
    } finally {
        // --- CHANGE HERE: Reset port only if upload started ---
        if (isUploadStarted) {
            if (writer) try { writer.releaseLock(); } catch (e) { }
            if (uploadReader) try { uploadReader.releaseLock(); } catch (e) { }

            // Save port reference before closing
            const portToReconnect = portToUse;

            // Clean and close port
            if (portToUse) {
                try {
                    if (portToUse.readable && !portToUse.readable.locked) await portToUse.close();
                } catch (err) { console.warn("Port close error:", err); }
            }

            // Reset connection state (but don't show disconnected UI)
            connectedSerialPort = null;
            portReader = null;
            isListening = false;
            
            // Show subtle reconnecting status (not full disconnect UI)
            // Keep UI as "connected" - don't disturb user

            // Device is rebooting, wait a bit
            await new Promise(resolve => setTimeout(resolve, 2500));
            
            // Try to reconnect to same port silently
            try {
                await portToReconnect.open({ baudRate: 115200 });
                await new Promise(r => setTimeout(r, 500));
                
                // Send PING
                const w = portToReconnect.writable.getWriter();
                await w.write(new TextEncoder().encode("PING_DECK\n"));
                w.releaseLock();
                
                // Wait for PONG
                const pongOk = await waitForPong(portToReconnect, 2000);
                
                if (pongOk) {
                    // Reconnected successfully!
                    connectedSerialPort = portToReconnect;
                    connectionState = ConnectionState.CONNECTED;
                    isAutoConnected = true;
                    
                    startSerialListener(portToReconnect);
                    updateConnectionUI(true, connectedDeviceName);
                    startActiveWindowMonitoring();
                    startWeatherAutoRefresh();
                    
                    // ESP hazır, bekleyen komutları gönder
                    isEspReady = true;
                    flushPendingCommands();
                    
                    console.log('[Upload] Reconnected successfully');
                } else {
                    // PONG failed, start auto-connect
                    isEspReady = true; // Reset flag anyway
                    pendingSerialCommands.length = 0; // Clear pending - device may have changed
                    await safeClosePort(portToReconnect);
                    handleDisconnectUI('Disconnected', 'Searching...');
                    startAutoConnect();
                }
            } catch (e) {
                console.warn('[Upload] Reconnect failed:', e.message);
                // Fall back to auto-connect
                isEspReady = true; // Reset flag
                pendingSerialCommands.length = 0; // Clear pending
                handleDisconnectUI('Disconnected', 'Searching...');
                startAutoConnect();
            }
        } else {
            // If cancelled (isUploadStarted = false), don't touch anything!
            // Just fix button state.
        }

        btn.disabled = false;
        btn.textContent = originalBtnText;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, uploadSuccess ? 5000 : 8000);
        
        // --- RESET UPLOAD FLAG ---
        isUploading = false;
    }
}


async function searchOnlineIcons(query) {
    const statusEl = el('#onlineStatus');
    const listEl = el('#onlineList');

    if (!query || query.length < 2) {
        listEl.innerHTML = '';
        statusEl.textContent = t('editor.picker.minChars');
        statusEl.style.display = 'block';
        return;
    }

    statusEl.textContent = t('editor.picker.searching');
    statusEl.style.display = 'block';

    try {
        const limit = 100;
        const data = await fetchIconifySearch(query, limit);

        listEl.innerHTML = '';
        if (data.icons && data.icons.length > 0) {
            statusEl.style.display = 'none';
            data.icons.forEach(iconStr => {
                const li = document.createElement('li');
                li.title = iconStr;

                const img = document.createElement('img');
                // NEW: Use smart URL function
                img.src = getSmartPreviewUrl(iconStr);
                img.loading = 'lazy';

                li.appendChild(img);

                li.onclick = () => {
                    const [set, ...nameParts] = iconStr.split(':');
                    const name = nameParts.join('-');
                    el('#iconPath').value = `online:${set}:${name}`;
                    el('#iconPath').dispatchEvent(new Event('input'));
                    el('#iconPicker').close();
                };

                listEl.appendChild(li);
            });
        } else {
            statusEl.textContent = t('editor.picker.noResults');
        }
    } catch (e) {
        console.error("Online search error:", e);
        statusEl.textContent = t('editor.picker.error');
    }
}

let searchDebounceTimer = null;

function openPicker() {
    const dlg = el('#iconPicker');
    const searchInput = el('#iconSearchInput');
    const statusEl = el('#onlineStatus');
    const listEl = el('#onlineList');

    // Make a clean start every time dialog opens
    searchInput.value = '';
    listEl.innerHTML = '';
    statusEl.textContent = t('editor.picker.status');
    statusEl.style.display = 'block';

    // Auto focus
    setTimeout(() => searchInput.focus(), 100);

    // Search listener
    searchInput.oninput = () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            searchOnlineIcons(searchInput.value);
        }, 300); // 300ms wait
    };

    el('#pickerClose').onclick = () => dlg.close();
    el('#iconPickerCloseBtn').onclick = () => dlg.close();
    dlg.showModal();
}
// --- REQUIRED FUNCTIONS FOR MAIN PROCESS INTEGRATION ---
// Add to BOTTOM of app.js file

window.getCloseAction = function () {
    // If cfg not loaded yet, return 'showConfirm' as default
    return (typeof cfg !== 'undefined' && cfg && cfg.appSettings) ? cfg.appSettings.defaultCloseAction : 'showConfirm';
};

window.setCloseAction = function (action) {
    if (typeof cfg === 'undefined' || !cfg) return;

    if (!cfg.appSettings) cfg.appSettings = {};
    cfg.appSettings.defaultCloseAction = action;

    // Save setting
    saveConfig();
};

// --- AUTO-SCALING ---
// Scales everything proportionally when window shrinks.

function fitToWindow() {
    // Original dimensions design is based on (your values in main.js)
    const baseWidth = 1200;
    const baseHeight = 1200;

    // Current window dimensions
    const currentWidth = window.innerWidth;
    const currentHeight = window.innerHeight;

    // Calculate ratio for both width and height
    const widthRatio = currentWidth / baseWidth;
    const heightRatio = currentHeight / baseHeight;

    // Use whichever ratio is smaller (So no overflow, "fit" logic)
    // If you want only width-based, use 'widthRatio' directly.
    const newZoom = Math.min(widthRatio, heightRatio);

    // Apply zoom level
    document.body.style.zoom = newZoom;
}

// 1. Run when application opens
window.addEventListener('DOMContentLoaded', fitToWindow);

// 2. Run every time window resizes
window.addEventListener('resize', fitToWindow);
function handlePcTimer(pIdx, bIdx, state, remainingSeconds) {
    const timerKey = `${pIdx}_${bIdx}`;
    
    console.log(`[Timer] handlePcTimer: page=${pIdx}, btn=${bIdx}, state=${state}, remaining=${remainingSeconds}`);

    // 1. MEMORY MANAGEMENT
    if (state === 2 || state === 0) {
        delete activeTimerTargets[timerKey];
        delete timerNotificationSent[timerKey]; // Clear notification flag on reset/pause
        
        // For RESET (state 2): If remainingSeconds is 0, get original duration from config
        if (state === 2 && remainingSeconds === 0) {
            const btn = cfg.pages[pIdx]?.[bIdx];
            if (btn && btn.timerDuration) {
                remainingSeconds = btn.timerDuration;
                console.log(`[Timer] Reset: Using timerDuration from config: ${remainingSeconds}`);
            }
        }
    }
    else if (state === 1) {
        // Save original label before overwriting with time (for notification)
        if (cfg.pages[pIdx] && cfg.pages[pIdx][bIdx]) {
            const btn = cfg.pages[pIdx][bIdx];
            // Only save if not already a time format
            if (!btn.originalLabel && btn.label && !/^\d{2}:\d{2}$/.test(btn.label)) {
                btn.originalLabel = btn.label;
            }
        }
        
        // Always update targetTime with latest from ESP32
        activeTimerTargets[timerKey] = Date.now() + (remainingSeconds * 1000);
        // Clear notification flag when timer starts/restarts
        delete timerNotificationSent[timerKey];
    }

    // 2. Update cfg label (so page change shows correct value)
    if (cfg.pages[pIdx] && cfg.pages[pIdx][bIdx]) {
        const min = Math.floor(remainingSeconds / 60);
        const sec = remainingSeconds % 60;
        cfg.pages[pIdx][bIdx].label = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    // 3. VISUAL MANAGEMENT (Only if on active page)
    if (pIdx !== currentPage) {
        return;
    }

    const cellDiv = document.querySelector(`.cell[data-index="${bIdx}"]`);
    if (!cellDiv) return;
    const labelEl = cellDiv.querySelector('.label');
    if (!labelEl) return;

    // --- RESET (2) veya PAUSE (0) ---
    if (state === 2 || state === 0) {
        // Clear interval if exists
        if (activePcTimers[bIdx]) {
            clearInterval(activePcTimers[bIdx]);
            delete activePcTimers[bIdx];
        }
        
        const min = Math.floor(remainingSeconds / 60);
        const sec = remainingSeconds % 60;
        labelEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

        // --- COLOR FIX ---
        // When resetting: Restore button's original color from settings
        const originalBtn = cfg.pages[pIdx] ? cfg.pages[pIdx][bIdx] : null;

        if (originalBtn && originalBtn.labelColor) {
            // If user has custom color, apply it
            labelEl.style.color = originalBtn.labelColor;
        } else {
            // Otherwise return to theme default (remove style)
            labelEl.style.color = '';
        }
        // -----------------------
    }
    // --- RUN (1) ---
    else if (state === 1) {
        // Only start visual timer if not already running
        if (!activePcTimers[bIdx] && activeTimerTargets[timerKey]) {
            startVisualTimer(bIdx, activeTimerTargets[timerKey]);
        }
        // If already running, just update the label with current value from ESP32
        else if (labelEl) {
            const min = Math.floor(remainingSeconds / 60);
            const sec = remainingSeconds % 60;
            labelEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }
    }
}

// --- PC Side Live Counter Management ---
function handlePcCounter(btnIndex, newValue) {
    // 1. Update config (persist the value)
    if (cfg.pages[currentPage] && cfg.pages[currentPage][btnIndex]) {
        cfg.pages[currentPage][btnIndex].counterCurrentValue = newValue;
        cfg.pages[currentPage][btnIndex].label = String(newValue);
        saveConfig(false); // Save without history
    }

    // 2. Update DOM
    const cellDiv = document.querySelector(`.cell[data-index="${btnIndex}"]`);
    if (!cellDiv) return;

    const labelEl = cellDiv.querySelector('.label');
    if (labelEl) {
        labelEl.textContent = String(newValue);
    }
}

// --- NEW: Get Sound File Path (Fixed .wav) ---
function getToggleSoundPath() {
    // 1. Did user select custom sound? (If setting is filled)
    if (cfg.appSettings && cfg.appSettings.customToggleSound && cfg.appSettings.customToggleSound.trim() !== "") {
        let customPath = cfg.appSettings.customToggleSound.replace(/\\/g, '/');

        if (customPath.startsWith('file:') || customPath.startsWith('http')) {
            return customPath;
        }
        return 'file:///' + encodeURI(customPath);
    }

    // 2. If setting is EMPTY, use default
    if (!ASSETS_PATH) return "";

    const cleanAssetsPath = ASSETS_PATH.replace(/\\/g, '/');

    // FIX: Updated to switch.wav
    const defaultPath = `file:///${cleanAssetsPath}/switch.wav`;

    return encodeURI(defaultPath);
}

// --- NEW: Get Notification Sound Path (For Timer) ---
function getNotificationSoundPath() {
    // 1. Did user select custom sound?
    if (cfg.appSettings && cfg.appSettings.customNotificationSound) {
        const s = cfg.appSettings.customNotificationSound.trim();
        if (s.length > 0) {
            let customPath = s.replace(/\\/g, '/');
            // Don't touch if protocol already exists
            if (customPath.startsWith('file:') || customPath.startsWith('http')) {
                return customPath;
            }
            // Otherwise convert to file path format
            return 'file:///' + encodeURI(customPath);
        }
    }

    // 2. If no custom sound, use default
    if (!ASSETS_PATH) {
        console.warn("Warning: ASSETS_PATH is empty. Cannot find default sound.");
        return "";
    }

    const cleanAssetsPath = ASSETS_PATH.replace(/\\/g, '/');

    // Default file: notification.wav (Make sure file name matches exactly in assets folder!)
    return encodeURI(`file:///${cleanAssetsPath}/notification.wav`);
}

// --- NEW: Updates only single button visually (Without breaking Grid) ---
function updateButtonVisuals(index) {
    // 1. Find existing button (Cell)
    const oldCell = document.querySelector(`.cell[data-index="${index}"]`);
    if (!oldCell) return; // Exit if not found

    // 2. Get new data for that index
    const btnData = cfg.pages[currentPage][index];

    // 3. Create new cell (cellTemplate is our existing logic)
    const newCell = cellTemplate(index, btnData || emptyBtn());

    // 4. Replace old cell with new one (DOM Replacement)
    // This operation doesn't touch other cells (Timer etc.)!
    oldCell.replaceWith(newCell);
}


function updateConnectionUI(isConnected, deviceName = "") {
    const statusEl = el('#connStatus');
    const dotEl = el('#connectionDot');
    const uploadBtn = el('#uploadViaUsbBtn');

    if (isConnected) {
        // --- DÜZELTME: İsim kontrolü ---
        // 1. Parametre olarak gelen ismi kullan.
        // 2. Yoksa global değişkeni (connectedDeviceName) kullan.
        // 3. O da yoksa "Smart Deck" varsayılanını kullan.
        const finalName = deviceName || connectedDeviceName || "Smart Deck";

        statusEl.textContent = t('connection.connected', { deviceName: finalName });
        statusEl.className = "conn-connected";
        dotEl.className = "status-dot connected";

        uploadBtn.textContent = t('device.buttons.upload'); // Use translation
        uploadBtn.classList.remove('ghost', 'danger');
        uploadBtn.classList.add('primary');
        uploadBtn.disabled = false;
        uploadBtn.title = ""; // Clear tooltip
        uploadBtn.style.cursor = "pointer"; // Reset cursor
    } else {
        // --- DÜZELTME (PROBLEM 2) ---
        statusEl.textContent = t('connection.disconnected');
        statusEl.className = "conn-disconnected";
        dotEl.className = "status-dot disconnected";

        uploadBtn.textContent = t('device.buttons.upload'); // Use translation
        uploadBtn.classList.remove('primary', 'danger');
        uploadBtn.classList.add('ghost');
        uploadBtn.disabled = false;
        uploadBtn.title = "Please connect device first";
        uploadBtn.style.cursor = "not-allowed";
    }
}
// Paste the following function somewhere and call initCropSystem() in DOMContentLoaded.
function initCropSystem() {
    const browseBtn = el('#browseLocalIconBtn');
    const fileInput = el('#hiddenLocalIconInput');
    const dialog = el('#cropDialog');
    cropImgEl = el('#cropImageToEdit');
    const wrapper = el('#cropWrapper');
    const zoomSlider = el('#cropZoomSlider');
    const saveBtn = el('#cropSaveBtn');
    const cancelBtn = el('#cropCancelBtn');

    if (browseBtn) browseBtn.onclick = () => {
        fileInput.value = null;
        fileInput.click();
    };

    if (fileInput) fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            cropImgEl.src = evt.target.result;
            cropImgEl.onload = () => {
                const initialScale = 0.7; // start a bit more zoomed out

                cropState.scale = initialScale;
                cropState.x = 0;
                cropState.y = 0;
                cropState.imgWidth = cropImgEl.naturalWidth;
                cropState.imgHeight = cropImgEl.naturalHeight;

                if (zoomSlider) {
                    // Let's narrow the range a bit, make it precise
                    zoomSlider.min = 0.01;
                    zoomSlider.max = 3.0;
                    zoomSlider.step = 0.01;
                    zoomSlider.value = initialScale;
                }

                updateCropTransform();
                dialog.showModal();
            };

        };
        reader.readAsDataURL(file);
    };

    if (zoomSlider) zoomSlider.oninput = () => {
        cropState.scale = parseFloat(zoomSlider.value);
        updateCropTransform();
    };

    if (wrapper) {
        wrapper.onmousedown = (e) => {
            cropState.isDragging = true;
            cropState.startX = e.clientX - cropState.x;
            cropState.startY = e.clientY - cropState.y;
            wrapper.style.cursor = 'grabbing';
        };
        window.addEventListener('mousemove', (e) => {
            if (!cropState.isDragging) return;
            e.preventDefault();
            cropState.x = e.clientX - cropState.startX;
            cropState.y = e.clientY - cropState.startY;
            updateCropTransform();
        });
        window.addEventListener('mouseup', () => {
            cropState.isDragging = false;
            if (wrapper) wrapper.style.cursor = 'grab';
        });
    }

    if (cancelBtn) cancelBtn.onclick = () => dialog.close();

    // --- FIXED SAVE SECTION ---
    // ... in initCropSystem ...
    // 5. SAVE BUTTON (DIRECT DOM INTERVENTION)
    if (saveBtn) saveBtn.onclick = async () => {
        const base64Data = getCroppedImageBase64();

        if (window.electronAPI && window.electronAPI.app) {
            try {
                const result = await window.electronAPI.app.saveTempIcon(base64Data);

                if (result.success) {
                    let cleanPath = result.path.replace(/\\/g, '/');
                    const fileUrl = 'file:///' + cleanPath;


                    // --- 1. UPDATE INPUT ---
                    const iconInput = document.getElementById('iconPath');
                    if (iconInput) {
                        iconInput.value = fileUrl;
                        // Trigger input event so other listeners wake up
                        iconInput.dispatchEvent(new Event('input'));
                    }

                    // --- 2. UPDATE TMP VARIABLE (Memory) ---
                    if (typeof window.updateCurrentButtonIcon === 'function') {
                        window.updateCurrentButtonIcon(fileUrl);
                    }
                    if (typeof currentEditorTmp !== 'undefined' && currentEditorTmp) {
                        currentEditorTmp.icon = fileUrl;
                        currentEditorTmp.iconColor = '';
                    }
                    const c = document.getElementById('iconColor');
                    if (c) { c.value = '#ffffff'; c.classList.add('unset'); }

                    // --- 3. CRITICAL HIT: WRITE DIRECTLY TO IMAGE (DOM) ---
                    // Skip intermediaries, writing directly to element.
                    const rawImg = document.getElementById('previewImgRaw');
                    const iconI = document.getElementById('previewIcon');

                    if (rawImg) {
                        rawImg.src = fileUrl; // <--- Hammering URL here
                        rawImg.style.display = 'block'; // Make visible

                        // Apply scaling
                        const scale = (typeof tmp !== 'undefined') ? (1 + (tmp.iconScale / 100)) : 1;
                        rawImg.style.transform = `scale(${Math.max(0.1, scale)})`;
                    }

                    // Hide old icon
                    if (iconI) iconI.style.display = 'none';

                } else {
                    alert("Error: " + result.error);
                }
            } catch (e) {
                console.error(e);
                alert("Save failed.");
            }
        }
        dialog.close();
    };

}

function updateCropTransform() {
    if (!cropImgEl) return;
    cropImgEl.style.transform = `translate(${cropState.x}px, ${cropState.y}px) scale(${cropState.scale})`;
}

function getCroppedImageBase64() {
    // Output size (128px or 256px for quality)
    const outputSize = 128;

    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d');

    // Crop area size (Should be proportional to .crop-overlay width/height value in CSS)
    // We said 150px in CSS.
    const viewportSize = 150;

    // Calculations
    const scale = cropState.scale;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // Draw image to Canvas
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.translate(cropState.x * (outputSize / viewportSize), cropState.y * (outputSize / viewportSize));
    ctx.scale(scale * (outputSize / viewportSize), scale * (outputSize / viewportSize));
    ctx.drawImage(cropImgEl, -cropState.imgWidth / 2, -cropState.imgHeight / 2);
    ctx.restore();

    return canvas.toDataURL('image/png');
}

// --- PLUGIN SYSTEM ---

async function loadPlugins() {
    const container = el('#pluginsContainer');
    if (!container) return;

    container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;" data-i18n="plugins.loading">Loading plugins...</div>`;

    if (window.electronAPI && window.electronAPI.app && window.electronAPI.app.scanPlugins) {
        const plugins = await window.electronAPI.app.scanPlugins();

        // --- UPDATE: Load AND START scripts ---
        // Load sequentially (await)
        for (const p of plugins) {
            if (p._jsPath) {

                try {
                    // 1. Load script and wait for completion
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = p._jsPath;
                        script.onload = resolve;
                        script.onerror = () => reject(new Error(`Script load error: ${p.meta.name}`));
                        document.body.appendChild(script);
                    });

                    // 2. If script loaded, find and run init function
                    // (We expect the function name in plugin.js to be "init_PLUGIN_ID_plugin")
                    const pluginId = (p.meta && p.meta.id) ? p.meta.id : null;
                    if (pluginId) {
                        const initFunctionName = `init_${pluginId}_plugin`;
                        if (typeof window[initFunctionName] === 'function') {
                            // Give it the API bridge
                            window[initFunctionName](window.SmartDeckAPI);
                        } else {
                            console.warn(`Plugin ${p.meta.name} has a plugin.js but no ${initFunctionName} function was found.`);
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }
        }
        // --- UPDATE END ---

        renderPlugins(plugins); // Draw HTML after all scripts loaded
    } else {
        container.innerHTML = `<div class="muted" data-i18n="plugins.api_not_ready">API not ready.</div>`;
    }
}
function renderPlugins(plugins) {
    const container = el('#pluginsContainer');
    container.innerHTML = '';

    if (!plugins || plugins.length === 0) {
        container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;" data-i18n="plugins.none">No plugins found in /plugins folder.</div>`;
        return;
    }

    plugins.sort((a, b) => {
        const nameA = (a.meta && a.meta.name) ? a.meta.name.toLowerCase() : "zz_unknown";
        const nameB = (b.meta && b.meta.name) ? b.meta.name.toLowerCase() : "zz_unknown";
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
    });

    plugins.forEach(p => {
        const details = document.createElement('details');
        details.className = 'plugin-item';

        const summary = document.createElement('summary');
        const title = (p.meta && p.meta.name) ? p.meta.name : t('plugins.unknown');
        const author = (p.meta && p.meta.author) ?
            ` <span style="font-weight:normal; opacity:0.5; font-size:11px; margin-left: auto; margin-right: 10px;">by ${p.meta.author}</span>` : '';
        summary.innerHTML = `${title}${author}`;

        summary.addEventListener('click', (e) => {
            if (!details.hasAttribute('open')) {
                const siblings = container.querySelectorAll('details');
                siblings.forEach(other => {
                    if (other !== details) {
                        other.removeAttribute('open');
                    }
                });
            }
        });

        const grid = document.createElement('div');
        grid.className = 'plugin-grid';

        if (p.buttons && Array.isArray(p.buttons)) {
            p.buttons.forEach((btnData, i) => {
                const btnEl = document.createElement('div');
                btnEl.className = 'plugin-btn-drag';
                btnEl.draggable = true;

                const pluginId = (p.meta && p.meta.id) ? p.meta.id : title.toLowerCase().replace(' ', '-');
                btnEl.dataset.pluginId = pluginId;
                btnEl.dataset.buttonIndex = i;

                let previewIconUrl = getIconUrl(btnData.icon);

                if (p._basePath && btnData.icon && !btnData.icon.match(/^(http|https|online:|data:|file:)/)) {
                    const cleanBase = p._basePath.replace(/\\/g, '/');
                    const cleanIcon = btnData.icon.replace(/\\/g, '/').replace(/^\//, '');
                    previewIconUrl = `file:///${cleanBase}/${cleanIcon}`;
                }

                if (previewIconUrl) {
                    const img = document.createElement('img');
                    img.src = previewIconUrl;
                    const isAsset = /\.(jpg|jpeg|png|gif|webp)$/i.test(btnData.icon) || !btnData.icon.startsWith('online:');
                    if (isAsset) {
                        img.classList.add('real-image');
                    }
                    img.onerror = () => {
                        img.style.display = 'none';
                        const i = document.createElement('i');
                        i.textContent = '★';
                        btnEl.appendChild(i);
                    };
                    btnEl.appendChild(img);
                } else {
                    const i = document.createElement('i');
                    i.textContent = '★';
                    i.style.fontStyle = 'normal';
                    i.style.fontSize = '24px';
                    btnEl.appendChild(i);
                }

                const span = document.createElement('span');
                span.textContent = btnData.label || t('plugins.button');
                btnEl.appendChild(span);

                btnEl.addEventListener('dragstart', (e) => {
                    const payload = {
                        sourceType: 'plugin-btn',
                        btnData: btnData,
                        basePath: p._basePath,
                        // --- NEW: Added ID and Index to Payload ---
                        pluginId: pluginId,
                        buttonIndex: i
                        // --- NEW CODE END ---
                    };
                    e.dataTransfer.setData('application/json', JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = 'copy';
                });

                grid.appendChild(btnEl);
            });
        }

        details.appendChild(summary);
        details.appendChild(grid);
        container.appendChild(details);
    });
}

function openFirmwareDialog() {
    const dialog = el('#firmwareDialog');
    const modelSelect = el('#fwModelSelect');
    const portSelect = el('#fwPortSelect');
    const refreshBtn = el('#fwRefreshPortsBtn');
    const flashBtn = el('#btnStartFlash');
    const logArea = el('#fwLogArea');
    const closeBtn = el('#firmwareCloseBtn');
    const warningText = el('#fwPortWarning');

    // --- 1. Load Firmware List (boards.json) ---
    const loadFirmwareList = async () => {
        // Loading text
        modelSelect.innerHTML = `<option value="" disabled selected>Loading...</option>`;
        modelSelect.disabled = true;

        if (window.electronAPI && window.electronAPI.app && window.electronAPI.app.getFirmwareList) {
            try {
                // Request list from Main process
                const boards = await window.electronAPI.app.getFirmwareList();

                modelSelect.innerHTML = ''; // Clear list

                if (boards.length === 0) {
                    const opt = document.createElement('option');
                    opt.text = "No firmware found";
                    modelSelect.appendChild(opt);
                } else {
                    // Add incoming list in loop
                    boards.forEach(board => {
                        const opt = document.createElement('option');
                        opt.value = board.folder; // Backend will use folder name
                        opt.textContent = board.name; // User will see name
                        modelSelect.appendChild(opt);
                    });
                }
            } catch (e) {
                console.error("Failed to load firmware list:", e);
                modelSelect.innerHTML = '<option>Error loading list</option>';
            }
        }
        modelSelect.disabled = false;
    };

    // --- 2. Scan COM Ports ---
    const refreshPorts = async () => {
        // "Scanning..." (From translation)
        portSelect.innerHTML = `<option>${t('firmware.scanning', { defaultValue: 'Scanning...' })}</option>`;
        portSelect.disabled = true;

        if (window.electronAPI && window.electronAPI.system && window.electronAPI.system.listSerialPorts) {
            const ports = await window.electronAPI.system.listSerialPorts();
            portSelect.innerHTML = '';

            if (ports.length === 0) {
                const opt = document.createElement('option');
                opt.text = "No COM ports";
                portSelect.appendChild(opt);
            } else {
                ports.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p;
                    opt.textContent = p;
                    portSelect.appendChild(opt);
                });
            }
        } else {
            portSelect.innerHTML = '<option>API Error</option>';
        }
        portSelect.disabled = false;

        // Show warning if app is already connected
        if (connectedSerialPort) {
            warningText.style.display = 'block';
            // Note: Warning text is defined in HTML with data-i18n, we're just showing it in JS.
        } else {
            warningText.style.display = 'none';
        }
    };

    // --- Initial Loads ---
    loadFirmwareList(); // Fetch models
    refreshPorts();     // Fetch ports
    refreshBtn.onclick = refreshPorts; // Refresh button

    // --- 3. Flash Process ---
    flashBtn.onclick = async () => {
        const port = portSelect.value;
        const model = modelSelect.value;

        // Validation
        if (!port || !port.startsWith("COM")) {
            await showCustomAlert(
                t('firmware.alerts.invalidPortTitle', { defaultValue: 'Selection Error' }),
                t('firmware.alerts.invalidPort', { defaultValue: 'Please select a valid COM port first.' })
            );
            return;
        }

        // Disconnect if connection exists
        if (connectedSerialPort) {
            await disconnectSerial();
            logArea.textContent = t('firmware.logs.autoDisconnect') + "\n";
        } else {
            logArea.textContent = "";
        }

        // Lock UI
        flashBtn.disabled = true;
        flashBtn.textContent = t('firmware.btnFlashing'); // "FLASHING... DO NOT UNPLUG!"
        modelSelect.disabled = true;
        portSelect.disabled = true;
        refreshBtn.disabled = true;
        closeBtn.disabled = true;

        // Clear old listeners
        if (window.electronAPI.app.removeAllFlashListeners) {
            window.electronAPI.app.removeAllFlashListeners();
        }

        // Listen and write logs
        window.electronAPI.app.onFlashLog((text) => {
            logArea.textContent += text;
            logArea.scrollTop = logArea.scrollHeight;
        });

        // Function to run when process completes
        window.electronAPI.app.onFlashComplete(async (success) => {
            // Unlock UI
            flashBtn.disabled = false;
            flashBtn.textContent = t('firmware.startBtn'); // "START FLASHING"
            modelSelect.disabled = false;
            portSelect.disabled = false;
            refreshBtn.disabled = false;
            closeBtn.disabled = false;

            if (success) {
                logArea.textContent += "\n" + t('firmware.logs.successReboot');
                await showCustomAlert(
                    t('firmware.alerts.successTitle', { defaultValue: 'Success!' }),
                    t('firmware.alerts.success', { defaultValue: 'Firmware updated successfully! Device will reboot.' })
                );
            } else {
                logArea.textContent += "\n" + t('firmware.logs.failedCheck');
                await showCustomAlert(
                    t('firmware.alerts.failedTitle', { defaultValue: 'Failed' }),
                    t('firmware.alerts.failed', { defaultValue: 'Firmware update failed. Please check the log area for details.' })
                );
            }
        });

        // Send start command to Main process
        window.electronAPI.app.flashFirmware(port, model);
    };

    closeBtn.onclick = () => dialog.close();
    dialog.showModal();
}
// --- NEW: Theme-Compatible Custom Alert Box Function ---
function showCustomAlert(title, message) {
    const dialog = el('#customAlertDialog');
    const alertTitle = el('#alertTitle', dialog);
    const alertMessage = el('#alertMessage', dialog);
    const alertOkBtn = el('#alertOkBtn', dialog);

    alertTitle.textContent = title;
    alertMessage.textContent = message;

    return new Promise(resolve => {
        const closeHandler = () => {
            dialog.close();
            alertOkBtn.removeEventListener('click', closeHandler);
            resolve(true); // Notify that OK was pressed
        };
        alertOkBtn.addEventListener('click', closeHandler);
        dialog.showModal();
    });
}

// ============================================================
// Knob Click Handler (Just opens settings, no drag)
// ============================================================
function initKnobClick() {
    const knobContainer = document.getElementById('knobTriggerBtn');
    if (!knobContainer) return;

    // Simple click to open settings
    knobContainer.addEventListener('click', () => {
        if (typeof openKnobSettings === 'function') {
            openKnobSettings();
        }
    });

    // Ensure Close Button works
    const closeBtn = document.getElementById('knobCloseBtn');
    if (closeBtn) {
        closeBtn.onclick = () => {
            const dialog = document.getElementById('knobSettingsDialog');
            if (dialog) dialog.close();
        };
    }

    // Ensure Cancel Button works
    const cancelBtn = document.getElementById('knobCancelBtn');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            const dialog = document.getElementById('knobSettingsDialog');
            if (dialog) dialog.close();
        };
    }
}

// Initialize Knob Logic when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initKnobClick);
} else {
    initKnobClick();
}
// ============================================
// PRESETS SYSTEM
// ============================================

let presetsWindowVisible = false;

function openPresetsDialog() {
    const win = document.getElementById('presetsWindow');
    if (!win) return;

    if (presetsWindowVisible) {
        win.style.display = 'none';
        presetsWindowVisible = false;
    } else {
        win.style.display = 'flex';
        presetsWindowVisible = true;
        loadPresets();
    }
}

function closePresetsWindow() {
    const win = document.getElementById('presetsWindow');
    if (win) {
        win.style.display = 'none';
        presetsWindowVisible = false;
    }
}

async function loadPresets() {
    const container = document.getElementById('presetsContainer');
    if (!container) return;

    container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;">Loading presets...</div>`;

    // Try scanPresets first, fallback to scanPlugins with 'presets' folder
    if (window.electronAPI && window.electronAPI.app) {
        try {
            let presets = [];

            // Try dedicated presets API first
            if (window.electronAPI.app.scanPresets) {
                presets = await window.electronAPI.app.scanPresets();
            }
            // Fallback: Use same structure as plugins but for 'presets' folder
            else if (window.electronAPI.app.scanPresetsFolder) {
                presets = await window.electronAPI.app.scanPresetsFolder();
            }

            if (presets && presets.length > 0) {
                renderPresets(presets);
            } else {
                container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;">
                    No presets found.<br><br>
                    <small style="opacity:0.6">Add preset folders to the /presets directory.<br>
                    Each folder should contain a <code>preset.json</code> file.</small>
                </div>`;
            }
        } catch (e) {
            console.error("Error loading presets:", e);
            container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;">Error loading presets.</div>`;
        }
    } else {
        container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;">
            Presets API not available.<br><br>
            <small style="opacity:0.6">The Electron API needs to be configured.<br>
            See ELECTRON_PRESETS_API.md for setup instructions.</small>
        </div>`;
    }
}

function renderPresets(presets) {
    const container = document.getElementById('presetsContainer');
    container.innerHTML = '';

    if (!presets || presets.length === 0) {
        container.innerHTML = `<div class="muted" style="text-align:center; padding:20px;">No presets found in /presets folder.</div>`;
        return;
    }

    // Sort alphabetically
    presets.sort((a, b) => {
        const nameA = (a.meta && a.meta.name) ? a.meta.name.toLowerCase() : "zz_unknown";
        const nameB = (b.meta && b.meta.name) ? b.meta.name.toLowerCase() : "zz_unknown";
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
    });

    presets.forEach(p => {
        const details = document.createElement('details');
        details.className = 'preset-item';

        const summary = document.createElement('summary');
        const title = (p.meta && p.meta.name) ? p.meta.name : t('presets.unknown');
        const author = (p.meta && p.meta.author) ?
            ` <span style="font-weight:normal; opacity:0.5; font-size:11px; margin-left: auto; margin-right: 10px;">by ${p.meta.author}</span>` : '';
        summary.innerHTML = `${title}${author}`;

        // Accordion behavior - close others when opening one
        summary.addEventListener('click', (e) => {
            if (!details.hasAttribute('open')) {
                const siblings = container.querySelectorAll('details');
                siblings.forEach(other => {
                    if (other !== details) {
                        other.removeAttribute('open');
                    }
                });
            }
        });

        const grid = document.createElement('div');
        grid.className = 'preset-grid';

        if (p.buttons && Array.isArray(p.buttons)) {
            p.buttons.forEach((btnData, i) => {
                const btnEl = document.createElement('div');
                btnEl.className = 'preset-btn-drag';
                btnEl.draggable = true;

                const presetId = (p.meta && p.meta.id) ? p.meta.id : title.toLowerCase().replace(/\s+/g, '-');
                btnEl.dataset.presetId = presetId;
                btnEl.dataset.buttonIndex = i;

                let previewIconUrl = getIconUrl(btnData.icon);

                // Handle local icons relative to preset folder
                if (p._basePath && btnData.icon && !btnData.icon.match(/^(http|https|online:|data:|file:)/)) {
                    const cleanBase = p._basePath.replace(/\\/g, '/');
                    const cleanIcon = btnData.icon.replace(/\\/g, '/').replace(/^\//, '');
                    previewIconUrl = `file:///${cleanBase}/${cleanIcon}`;
                }

                if (previewIconUrl) {
                    const img = document.createElement('img');
                    img.src = previewIconUrl;
                    const isAsset = /\.(jpg|jpeg|png|gif|webp)$/i.test(btnData.icon) || (btnData.icon && !btnData.icon.startsWith('online:'));
                    if (isAsset) {
                        img.classList.add('real-image');
                    }
                    img.onerror = () => {
                        img.style.display = 'none';
                        const iEl = document.createElement('i');
                        iEl.textContent = '★';
                        iEl.style.fontStyle = 'normal';
                        iEl.style.fontSize = '24px';
                        btnEl.appendChild(iEl);
                    };
                    btnEl.appendChild(img);
                } else {
                    const iEl = document.createElement('i');
                    iEl.textContent = '★';
                    iEl.style.fontStyle = 'normal';
                    iEl.style.fontSize = '24px';
                    btnEl.appendChild(iEl);
                }

                const span = document.createElement('span');
                span.textContent = btnData.label || t('presets.button');
                btnEl.appendChild(span);

                // Drag start - same format as plugins for compatibility
                btnEl.addEventListener('dragstart', (e) => {
                    const payload = {
                        sourceType: 'preset-btn',
                        btnData: btnData,
                        basePath: p._basePath,
                        presetId: presetId,
                        buttonIndex: i
                    };
                    e.dataTransfer.setData('application/json', JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = 'copy';
                });

                grid.appendChild(btnEl);
            });
        }

        details.appendChild(summary);
        details.appendChild(grid);
        container.appendChild(details);
    });
}

// Make presets window draggable
function initPresetsDraggable() {
    const win = document.getElementById('presetsWindow');
    const header = document.getElementById('presetsWindowHeader');
    if (!win || !header) return;

    let isDragging = false;
    let startX, startY, initialX, initialY;

    header.addEventListener('mousedown', (e) => {
        // Don't drag if clicking buttons
        if (e.target.tagName === 'BUTTON') return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialX = win.offsetLeft;
        initialY = win.offsetTop;

        header.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newX = initialX + dx;
        let newY = initialY + dy;

        // Keep within viewport
        newX = Math.max(0, Math.min(newX, window.innerWidth - win.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - win.offsetHeight));

        win.style.left = newX + 'px';
        win.style.top = newY + 'px';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        header.style.cursor = 'grab';
    });
}

// Initialize Presets button and window
function initPresetsSystem() {
    const presetsBtn = document.getElementById('presetsBtn');
    const closeBtn = document.getElementById('closePresetsBtn');
    const refreshBtn = document.getElementById('refreshPresetsBtn');
    const openFolderBtn = document.getElementById('openPresetsFolderBtn');

    if (presetsBtn) {
        presetsBtn.addEventListener('click', openPresetsDialog);
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closePresetsWindow);
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadPresets);
    }

    if (openFolderBtn) {
        openFolderBtn.addEventListener('click', () => {
            if (window.electronAPI && window.electronAPI.app && window.electronAPI.app.openPresetsFolder) {
                window.electronAPI.app.openPresetsFolder();
            }
        });
    }

    // Initialize Themes button
    const themesBtn = document.getElementById('themesBtn');
    if (themesBtn) {
        themesBtn.addEventListener('click', openThemesDialog);
    }

    // Initialize draggable functionality
    initPresetsDraggable();
}

// ============================================
// THEME PRESETS SYSTEM
// ============================================

const DEFAULT_THEMES = [
    // === ORIGINAL 10 THEMES ===
    { name: "Midnight", background: "#0f0f0f", button: "#1a1a2e", text: "#ffffff", stroke: "#4a4a6a", shadow: "#000000", knobColor: "#8b5cf6" },
    { name: "Ocean Blue", background: "#0c1929", button: "#1e3a5f", text: "#e0f0ff", stroke: "#3b82f6", shadow: "#061220", knobColor: "#3b82f6" },
    { name: "Forest Green", background: "#0d1f0d", button: "#1a3a1a", text: "#d4edda", stroke: "#22c55e", shadow: "#051005", knobColor: "#22c55e" },
    { name: "Sunset Orange", background: "#1a0f0f", button: "#3d1f1f", text: "#ffe4e1", stroke: "#f97316", shadow: "#0d0505", knobColor: "#f97316" },
    { name: "Purple Haze", background: "#1a0f1f", button: "#2d1f3d", text: "#f0e6ff", stroke: "#a855f7", shadow: "#0d0510", knobColor: "#a855f7" },
    { name: "Cyber Pink", background: "#0a0a0a", button: "#1f1a2e", text: "#fce7f3", stroke: "#ec4899", shadow: "#000000", knobColor: "#ec4899" },
    { name: "Golden Amber", background: "#1a1508", button: "#2d2510", text: "#fef3c7", stroke: "#f59e0b", shadow: "#0d0a04", knobColor: "#f59e0b" },
    { name: "Teal Dream", background: "#0f1a1a", button: "#1a2d2d", text: "#ccfbf1", stroke: "#14b8a6", shadow: "#050d0d", knobColor: "#14b8a6" },
    { name: "Cherry Red", background: "#1a0a0a", button: "#2d1515", text: "#fecaca", stroke: "#ef4444", shadow: "#0d0505", knobColor: "#ef4444" },
    { name: "Slate Gray", background: "#1e1e1e", button: "#2d2d2d", text: "#e5e5e5", stroke: "#6b7280", shadow: "#0a0a0a", knobColor: "#9ca3af" },
    
    // === COLORHUNT INSPIRED THEMES ===
    // Light Theme - Arctic White
    { name: "Arctic White", background: "#f9f7f7", button: "#ffffff", text: "#112d4e", stroke: "#3f72af", shadow: "#dbe2ef", knobColor: "#3f72af" },
    
    // #222831 #393E46 #00ADB5 #EEEEEE
    { name: "Neon Teal", background: "#222831", button: "#393e46", text: "#eeeeee", stroke: "#00adb5", shadow: "#0d1117", knobColor: "#00adb5" },
    
    // #222831 #393E46 #FFD369 #EEEEEE
    { name: "Mustard Gold", background: "#222831", button: "#393e46", text: "#eeeeee", stroke: "#ffd369", shadow: "#0d1117", knobColor: "#ffd369" },
    
    // #1A1A2E #16213E #0F3460 #E94560
    { name: "Crimson Night", background: "#1a1a2e", button: "#16213e", text: "#eaeaea", stroke: "#e94560", shadow: "#0f0f1a", knobColor: "#e94560" },
    
    // #2C3333 #395B64 #A5C9CA #E7F6F2
    { name: "Sage Breeze", background: "#2c3333", button: "#395b64", text: "#e7f6f2", stroke: "#a5c9ca", shadow: "#1a1f1f", knobColor: "#a5c9ca" },
    
    // #2D4059 #EA5455 #F07B3F #FFD460
    { name: "Warm Coral", background: "#2d4059", button: "#3d5275", text: "#ffd460", stroke: "#ea5455", shadow: "#1a2535", knobColor: "#f07b3f" },
    
    // #364F6B #3FC1C9 #F5F5F5 #FC5185
    { name: "Cotton Candy", background: "#364f6b", button: "#425d7a", text: "#f5f5f5", stroke: "#fc5185", shadow: "#243342", knobColor: "#3fc1c9" },
    
    // #1B262C #0F4C75 #3282B8 #BBE1FA
    { name: "Deep Ocean", background: "#1b262c", button: "#0f4c75", text: "#bbe1fa", stroke: "#3282b8", shadow: "#0d1317", knobColor: "#3282b8" },
    
    // #0F0E0E #2D2D2D #EADEDE #B85252
    { name: "Rosewood", background: "#0f0e0e", button: "#2d2d2d", text: "#eadede", stroke: "#b85252", shadow: "#050505", knobColor: "#b85252" },
    
    // #1F1D36 #3F3351 #864879 #E9A6A6
    { name: "Mauve Dream", background: "#1f1d36", button: "#3f3351", text: "#e9a6a6", stroke: "#864879", shadow: "#0f0e1a", knobColor: "#864879" }
];

const THEMES_STORAGE_KEY = 'smartdeck_custom_themes';

function getCustomThemes() {
    try {
        const saved = localStorage.getItem(THEMES_STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch (e) {
        return [];
    }
}

function saveCustomThemes(themes) {
    localStorage.setItem(THEMES_STORAGE_KEY, JSON.stringify(themes));
}

// Store original theme for cancel/preview
let originalThemeBackup = null;
let selectedThemeIndex = -1;

function openThemesDialog() {
    const existingPanel = document.getElementById('themesPanel');
    if (existingPanel) {
        existingPanel.remove();
        return;
    }

    // Backup current theme for cancel
    originalThemeBackup = {
        background: '#' + cfg.theme.bg,
        button: '#' + cfg.theme.btn,
        text: '#' + cfg.theme.text,
        stroke: '#' + cfg.theme.stroke,
        shadow: '#' + cfg.theme.shadow,
        knobColor: cfg.knob?.ledColor || '#d946ef'
    };
    selectedThemeIndex = -1;

    const customThemes = getCustomThemes();
    const allThemes = [...DEFAULT_THEMES, ...customThemes];

    const panel = document.createElement('div');
    panel.id = 'themesPanel';
    panel.className = 'themes-panel';

    panel.innerHTML = `
        <div class="themes-panel-header">
            <span>🎨 ${t('themes.title') || 'Color Themes'}</span>
            <button id="closeThemesPanel" class="ghost" title="Close">×</button>
        </div>
        
        <div class="themes-list" id="themesList">
            ${allThemes.map((theme, i) => `
                <div class="theme-item" data-index="${i}">
                    <div class="theme-item-colors">
                        <div class="theme-swatch" style="background: ${theme.background};"></div>
                        <div class="theme-swatch" style="background: ${theme.button};"></div>
                        <div class="theme-swatch" style="background: ${theme.stroke};"></div>
                    </div>
                    <span class="theme-item-name">${theme.name}</span>
                    ${i >= DEFAULT_THEMES.length ? `<button class="delete-theme-btn" data-index="${i}" title="${t('themes.delete') || 'Delete'}">×</button>` : ''}
                </div>
            `).join('')}
        </div>
        
        <div class="themes-panel-actions">
            <button id="applyThemeBtn" class="primary" disabled>${t('themes.apply') || 'Apply'}</button>
            <button id="cancelThemeBtn" class="ghost">${t('themes.cancel') || 'Cancel'}</button>
        </div>
        
        <div class="themes-panel-footer">
            <button id="saveCurrentTheme" class="ghost">${t('themes.saveCurrent') || 'Save Current'}</button>
            <button id="importTheme" class="ghost">${t('themes.import') || 'Import'}</button>
            <button id="exportTheme" class="ghost">${t('themes.export') || 'Export'}</button>
        </div>
    `;

    document.body.appendChild(panel);

    const applyBtn = document.getElementById('applyThemeBtn');
    const cancelBtn = document.getElementById('cancelThemeBtn');

    // Close button
    document.getElementById('closeThemesPanel').onclick = () => {
        // Restore original if not applied
        if (originalThemeBackup) {
            previewTheme(originalThemeBackup);
        }
        panel.remove();
    };

    // Theme item HOVER - preview
    panel.querySelectorAll('.theme-item').forEach(item => {
        item.onmouseenter = () => {
            const idx = parseInt(item.dataset.index);
            previewTheme(allThemes[idx]);
        };

        item.onmouseleave = () => {
            // If something is selected, show selected theme
            // Otherwise show original
            if (selectedThemeIndex >= 0) {
                previewTheme(allThemes[selectedThemeIndex]);
            } else if (originalThemeBackup) {
                previewTheme(originalThemeBackup);
            }
        };

        // Theme item CLICK - select (not apply)
        item.onclick = (e) => {
            if (e.target.classList.contains('delete-theme-btn')) return;
            const idx = parseInt(item.dataset.index);
            selectedThemeIndex = idx;

            // Highlight selected
            panel.querySelectorAll('.theme-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');

            // Enable apply button
            applyBtn.disabled = false;
        };
    });

    // Apply button - confirms the selection
    applyBtn.onclick = () => {
        if (selectedThemeIndex >= 0) {
            applyThemePreset(allThemes[selectedThemeIndex]);
            showToast(`${t('themes.applied') || 'Theme applied:'} "${allThemes[selectedThemeIndex].name}"`, 'success');
            originalThemeBackup = null;
            panel.remove();
        }
    };

    // Cancel button - restore original
    cancelBtn.onclick = () => {
        if (originalThemeBackup) {
            previewTheme(originalThemeBackup);
        }
        panel.remove();
    };

    // Delete theme buttons
    panel.querySelectorAll('.delete-theme-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index) - DEFAULT_THEMES.length;
            if (idx >= 0) {
                const themes = getCustomThemes();
                const themeName = themes[idx]?.name || 'Theme';
                themes.splice(idx, 1);
                saveCustomThemes(themes);
                showToast(`"${themeName}" ${t('themes.deleted') || 'deleted'}`, 'info');
                panel.remove();
                openThemesDialog();
            }
        };
    });

    // Save current theme
    document.getElementById('saveCurrentTheme').onclick = async () => {
        const name = await showPromptDialog(t('themes.enterName') || 'Enter theme name:', t('themes.saveTitle') || 'Save Theme');
        if (!name) return;

        const newTheme = {
            name: name,
            background: '#' + cfg.theme.bg,
            button: '#' + cfg.theme.btn,
            text: '#' + cfg.theme.text,
            stroke: '#' + cfg.theme.stroke,
            shadow: '#' + cfg.theme.shadow,
            knobColor: cfg.knob?.ledColor || '#d946ef'
        };

        const themes = getCustomThemes();
        themes.push(newTheme);
        saveCustomThemes(themes);
        showToast(`${t('themes.saved') || 'Theme saved:'} "${name}"`, 'success');
        panel.remove();
        openThemesDialog();
    };

    // Export theme
    document.getElementById('exportTheme').onclick = () => {
        const theme = {
            name: (cfg.deviceName || 'SmartDeck') + ' Theme',
            background: '#' + cfg.theme.bg,
            button: '#' + cfg.theme.btn,
            text: '#' + cfg.theme.text,
            stroke: '#' + cfg.theme.stroke,
            shadow: '#' + cfg.theme.shadow,
            knobColor: cfg.knob?.ledColor || '#d946ef'
        };

        const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'smartdeck-theme.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast(t('themes.exported') || 'Theme exported!', 'success');
    };

    // Import theme
    document.getElementById('importTheme').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const theme = JSON.parse(text);

                if (theme.background && theme.button && theme.text) {
                    const themes = getCustomThemes();
                    themes.push(theme);
                    saveCustomThemes(themes);
                    showToast(`${t('themes.imported') || 'Theme imported:'} "${theme.name}"`, 'success');
                    panel.remove();
                    openThemesDialog();
                } else {
                    showToast(t('themes.invalidFile') || 'Invalid theme file', 'error');
                }
            } catch (err) {
                showToast(t('themes.importFailed') || 'Failed to import theme', 'error');
            }
        };
        input.click();
    };

    // Make panel draggable
    let isDragging = false;
    let offsetX, offsetY;
    panel.querySelector('.themes-panel-header').onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        offsetX = e.clientX - panel.offsetLeft;
        offsetY = e.clientY - panel.offsetTop;
        panel.style.cursor = 'grabbing';
    };
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = (e.clientX - offsetX) + 'px';
        panel.style.top = (e.clientY - offsetY) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
        isDragging = false;
        panel.style.cursor = '';
    });
}

// Preview theme without saving - just update CSS variables
function previewTheme(theme) {
    document.documentElement.style.setProperty('--c-bg', theme.background);
    document.documentElement.style.setProperty('--c-btn', theme.button);
    document.documentElement.style.setProperty('--c-text', theme.text);
    document.documentElement.style.setProperty('--c-stroke', theme.stroke);
    document.documentElement.style.setProperty('--c-shadow', theme.shadow);

    // Preview knob color if available
    if (theme.knobColor) {
        const arc = document.querySelector('#knobTriggerBtn .arc-active');
        if (arc) {
            arc.style.stroke = theme.knobColor;
            arc.style.filter = `url(#glow) drop-shadow(0 0 8px ${theme.knobColor})`;
        }
        const indicator = document.querySelector('#knobTriggerBtn .knob-indicator');
        if (indicator) {
            indicator.style.background = theme.knobColor;
            indicator.style.boxShadow = `0 0 10px ${theme.knobColor}, 0 0 20px ${theme.knobColor}`;
        }
    }
}

function applyThemePreset(theme) {
    // Update config
    cfg.theme.bg = theme.background.replace('#', '');
    cfg.theme.btn = theme.button.replace('#', '');
    cfg.theme.text = theme.text.replace('#', '');
    cfg.theme.stroke = theme.stroke.replace('#', '');
    cfg.theme.shadow = theme.shadow.replace('#', '');

    // Update knob color if theme has it
    if (theme.knobColor) {
        cfg.knob = cfg.knob || {};
        cfg.knob.ledColor = theme.knobColor;

        // Update knob color picker if dialog is open
        const knobColorInput = document.getElementById('knobLedColor');
        if (knobColorInput) {
            knobColorInput.value = theme.knobColor;
        }

        // Update LED color picker in main settings
        const ledPicker = document.getElementById('ledColor');
        if (ledPicker) {
            ledPicker.value = theme.knobColor;
        }

        // Update knob visuals
        updateKnobLeds(knobRotationAngle, theme.knobColor);
    }

    // Update color pickers in UI
    const bgPicker = document.getElementById('bgColor');
    const btnPicker = document.getElementById('btnColor');
    const textPicker = document.getElementById('txtColor');
    const strokePicker = document.getElementById('strokeColor');
    const shadowPicker = document.getElementById('shadowColor');

    if (bgPicker) bgPicker.value = theme.background;
    if (btnPicker) btnPicker.value = theme.button;
    if (textPicker) textPicker.value = theme.text;
    if (strokePicker) strokePicker.value = theme.stroke;
    if (shadowPicker) shadowPicker.value = theme.shadow;

    // Apply theme visually and save
    applyTheme();
    saveConfig();
    populateGridControls();

    // Send to device via serial
    sendThemeToDevice();
}

// Simple prompt dialog
function showPromptDialog(message, title = null) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'prompt-dialog';
        dialog.innerHTML = `
            <h4>${title || t('dialogs.input')}</h4>
            <p>${message}</p>
            <input type="text" id="promptInput" class="text" style="width: 100%; margin-bottom: 15px;">
            <div class="prompt-actions">
                <button id="promptCancel" class="ghost">${t('dialogs.cancel')}</button>
                <button id="promptOk" class="primary">${t('dialogs.ok')}</button>
            </div>
        `;
        document.body.appendChild(dialog);

        const input = dialog.querySelector('#promptInput');
        dialog.querySelector('#promptCancel').onclick = () => { dialog.close(); resolve(null); };
        dialog.querySelector('#promptOk').onclick = () => { dialog.close(); resolve(input.value); };
        input.onkeypress = (e) => { if (e.key === 'Enter') { dialog.close(); resolve(input.value); } };

        dialog.onclose = () => dialog.remove();
        dialog.showModal();
        input.focus();
    });
}

// Initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPresetsSystem);
} else {
    initPresetsSystem();
}
// ============================================
// MULTI-ACTION SYSTEM
// ============================================

let multiActionStack = []; // Mevcut aksiyon listesi
let selectedMultiActionIndex = -1; // Seçili aksiyonun index'i
let multiActionTmp = null; // openEditor'daki tmp referansı

const MULTI_ACTION_TYPES = {
    delay: { icon: '⏱️', nameKey: 'editor.multi.delay', defaultValue: { ms: 500 } },
    key: { icon: '⌨️', nameKey: 'editor.multi.hotkey', defaultValue: { combo: '' } },
    text: { icon: '📝', nameKey: 'editor.multi.text', defaultValue: { text: '', simulate: false } },
    app: { icon: '🚀', nameKey: 'editor.multi.openApp', defaultValue: { path: '' } },
    website: { icon: '🌐', nameKey: 'editor.multi.website', defaultValue: { url: '' } },
    script: { icon: '📜', nameKey: 'editor.multi.script', defaultValue: { command: '' } },
    media: { icon: '🎵', nameKey: 'editor.multi.media', defaultValue: { action: 'play_pause' } },
    sound: { icon: '🔊', nameKey: 'editor.multi.sound', defaultValue: { path: '', volume: 100 } },
    mouse: { icon: '🖱️', nameKey: 'editor.multi.mouse', defaultValue: { event: 'click', button: 'left', x: 0, y: 0, x2: 0, y2: 0 } },
    goto: { icon: '📄', nameKey: 'editor.multi.gotoPage', defaultValue: { page: 0 } }
};

function getMultiActionTypeName(type) {
    const typeInfo = MULTI_ACTION_TYPES[type];
    if (!typeInfo) return type;
    return t(typeInfo.nameKey) || typeInfo.nameKey.split('.').pop();
}

function initMultiActionPanel(tmp) {
    multiActionTmp = tmp;
    multiActionStack = tmp.multiActions ? JSON.parse(JSON.stringify(tmp.multiActions)) : [];
    selectedMultiActionIndex = -1;
    
    renderMultiActionStack();
    hideMultiActionSettings();
    setupMultiActionDragDrop();
}

function renderMultiActionStack() {
    const stackEl = document.getElementById('multiActionStack');
    if (!stackEl) return;
    
    if (multiActionStack.length === 0) {
        stackEl.innerHTML = `<div class="stack-empty-hint">${t('editor.multi.emptyHint')}</div>`;
        return;
    }
    
    stackEl.innerHTML = multiActionStack.map((action, index) => {
        const typeInfo = MULTI_ACTION_TYPES[action.type] || { icon: '❓', nameKey: action.type };
        const typeName = getMultiActionTypeName(action.type);
        const summary = getActionSummary(action);
        const isSelected = index === selectedMultiActionIndex;
        
        return `
            <div class="stack-item ${isSelected ? 'selected' : ''}" 
                 data-index="${index}" 
                 draggable="true">
                <span class="order-num">${index + 1}</span>
                <span class="drag-handle">☰</span>
                <span class="action-icon">${typeInfo.icon}</span>
                <span class="action-name">${typeName}</span>
                <span class="action-summary">${summary}</span>
                <button type="button" class="remove-btn" data-index="${index}">✕</button>
            </div>
        `;
    }).join('');
    
    // Event listeners
    stackEl.querySelectorAll('.stack-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (!e.target.classList.contains('remove-btn') && !e.target.classList.contains('drag-handle')) {
                selectMultiAction(parseInt(item.dataset.index));
            }
        });
    });
    
    stackEl.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeMultiAction(parseInt(btn.dataset.index));
        });
    });
    
    // Stack item drag for reordering
    setupStackItemDrag();
}

function getActionSummary(action) {
    switch(action.type) {
        case 'delay': return `${action.ms || 500}ms`;
        case 'key': return action.combo || '—';
        case 'text': return action.text ? action.text.substring(0, 15) + (action.text.length > 15 ? '...' : '') : '—';
        case 'app': return action.path ? action.path.split(/[\\/]/).pop() : '—';
        case 'website': return action.url ? action.url.replace(/^https?:\/\//, '').substring(0, 20) : '—';
        case 'script': return action.command ? action.command.substring(0, 15) + '...' : '—';
        case 'media': return action.action || 'play_pause';
        case 'sound': return action.path ? action.path.split(/[\\/]/).pop() : '—';
        case 'mouse': {
            const event = action.event || 'click';
            const button = action.button || 'left';
            if (event === 'drag') return 'drag';
            if (event === 'move') return 'move';
            // For click/double_click, show button if not left
            if (button === 'left') return event === 'double_click' ? 'double click' : 'click';
            return `${button} ${event === 'double_click' ? 'double click' : 'click'}`;
        }
        case 'goto': return `Page ${(action.page || 0) + 1}`;
        default: return '—';
    }
}

function selectMultiAction(index) {
    selectedMultiActionIndex = index;
    renderMultiActionStack();
    showMultiActionSettings(index);
}

function removeMultiAction(index) {
    multiActionStack.splice(index, 1);
    if (selectedMultiActionIndex === index) {
        selectedMultiActionIndex = -1;
        hideMultiActionSettings();
    } else if (selectedMultiActionIndex > index) {
        selectedMultiActionIndex--;
    }
    renderMultiActionStack();
    updateMultiActionTmp();
}

function addMultiAction(type) {
    const typeInfo = MULTI_ACTION_TYPES[type];
    if (!typeInfo) return;
    
    const newAction = {
        type: type,
        ...JSON.parse(JSON.stringify(typeInfo.defaultValue))
    };
    
    multiActionStack.push(newAction);
    renderMultiActionStack();
    updateMultiActionTmp();
    
    // Yeni eklenen aksiyonu seç
    selectMultiAction(multiActionStack.length - 1);
}

function updateMultiActionTmp() {
    if (multiActionTmp) {
        multiActionTmp.multiActions = JSON.parse(JSON.stringify(multiActionStack));
    }
}

function hideMultiActionSettings() {
    const settingsEl = document.getElementById('multiActionSettings');
    if (settingsEl) settingsEl.style.display = 'none';
}

function showMultiActionSettings(index) {
    const settingsEl = document.getElementById('multiActionSettings');
    const contentEl = document.getElementById('multiSettingsContent');
    const titleEl = document.getElementById('multiSettingsTitle');
    
    if (!settingsEl || !contentEl || index < 0 || index >= multiActionStack.length) {
        hideMultiActionSettings();
        return;
    }
    
    const action = multiActionStack[index];
    const typeInfo = MULTI_ACTION_TYPES[action.type] || { icon: '❓', nameKey: action.type };
    const typeName = getMultiActionTypeName(action.type);
    
    titleEl.textContent = `${typeInfo.icon} ${typeName} ${t('editor.multi.settings')}`;
    contentEl.innerHTML = getMultiActionSettingsHTML(action, index);
    settingsEl.style.display = 'block';
    
    // Setup event listeners for this action's settings
    setupMultiActionSettingsListeners(action, index);
}

function getMultiActionSettingsHTML(action, index) {
    switch(action.type) {
        case 'delay':
            return `
                <div class="fld">
                    <label>Delay Duration</label>
                    <div class="hstack" style="gap: 10px; align-items: center;">
                        <input type="number" id="multiDelayMs" class="text" value="${action.ms || 500}" min="1" max="60000" style="width: 120px;">
                        <span class="muted">milliseconds</span>
                    </div>
                    <div class="delay-presets">
                        <button type="button" data-ms="100">100ms</button>
                        <button type="button" data-ms="250">250ms</button>
                        <button type="button" data-ms="500">500ms</button>
                        <button type="button" data-ms="1000">1s</button>
                        <button type="button" data-ms="2000">2s</button>
                        <button type="button" data-ms="5000">5s</button>
                    </div>
                </div>
            `;
            
        case 'key':
            // Mevcut rowKeyMods panelinin HTML'ini birebir kopyala
            return `
                <label>Shortcut Combination</label>
                <div class="mods">
                    <button type="button" class="mod" data-mod="CTRL">CTRL</button>
                    <button type="button" class="mod" data-mod="ALT">ALT</button>
                    <button type="button" class="mod" data-mod="SHIFT">SHIFT</button>
                    <button type="button" class="mod" data-mod="GUI">WIN</button>
                    <button type="button" class="mod ghost" data-key="ENTER">ENTER</button>
                    <button type="button" class="mod ghost" data-key="TAB">TAB</button>
                    <button type="button" class="mod ghost" data-key="SCROLL_UP">▲Scr</button>
                    <button type="button" class="mod ghost" data-key="SCROLL_DOWN">▼Scr</button>
                    <button type="button" class="mod ghost" data-key="PAGE_UP">PgUp</button>
                    <button type="button" class="mod ghost" data-key="PAGE_DOWN">PgDn</button>
                    <button type="button" class="mod ghost" data-key="ARROW_UP">↑</button>
                    <button type="button" class="mod ghost" data-key="ARROW_DOWN">↓</button>
                    <button type="button" class="mod ghost" data-key="ARROW_LEFT">←</button>
                    <button type="button" class="mod ghost" data-key="ARROW_RIGHT">→</button>
                    
                    <div class="spacer" style="flex: 1 1 auto;"></div>
                    
                    <select id="multiKeyPreset" class="text" style="width: 220px; height: 38px;"></select>
                </div>
                <div class="combo-row" style="margin-top: 8px; display: flex; gap: 8px;">
                    <input id="multiCombo" class="text" placeholder="e.g. CTRL+ALT+DELETE" value="${action.combo || ''}" readonly style="flex: 1;" />
                    <button type="button" id="multiCaptureToggle" class="primary" style="flex-shrink: 0;">Capture</button>
                </div>
            `;
            
        case 'text':
            return `
                <div style="display: flex; justify-content: space-between; align-items: flex-end; width: 100%;">
                    <label for="multiTextMacro">Text to Type</label>
                    <small class="muted" style="font-size: 11px; margin-bottom: 4px;">Press 'Enter' in box for new line</small>
                </div>
                <textarea id="multiTextMacro" class="text" placeholder="Type your text macro here..." rows="3">${action.text || ''}</textarea>
                <div class="row" style="margin-top: 10px; margin-bottom: 0px; padding-top: 10px; border-top: 1px dashed var(--border);">
                    <div class="hstack" style="justify-content: space-between; align-items: center;">
                        <span style="color: var(--text);">Simulate Typing</span>
                        <label class="switch">
                            <input type="checkbox" id="multiSimulateTyping" ${action.simulate ? 'checked' : ''}>
                            <span class="slider round"></span>
                        </label>
                    </div>
                    <small class="muted" style="margin-top: 5px;">Enabling this sends the macro as a series of individual key presses instead of using the clipboard.</small>
                </div>
            `;
            
        case 'app':
            return `
                <label>Application</label>
                <div style="margin-bottom: 8px;">
                    <select id="multiAppQuickSelect" class="text" style="width: 100%; height: 38px;">
                        <option value="">Select app...</option>
                    </select>
                </div>
                <div class="hstack">
                    <input type="text" id="multiAppPath" class="text" style="flex: 1;" placeholder="C:\\Program Files\\..." value="${action.path || ''}" />
                    <button id="multiAppBrowse" class="ghost" type="button" style="flex-shrink: 0;">Browse</button>
                </div>
                <small class="muted">Select from list above OR browse manually.</small>
            `;
            
        case 'website':
            return `
                <label for="multiWebsiteUrl">Website URL</label>
                <input type="text" id="multiWebsiteUrl" class="text" placeholder="https://www.google.com" value="${action.url || ''}">
            `;
            
        case 'script':
            return `
                <div class="fld" style="margin-bottom: 10px;">
                    <label for="multiScriptPreset">Select Preset Script</label>
                    <select id="multiScriptPreset" class="text" style="width: 100%;">
                        <option value="">--- Select Preset Script ---</option>
                    </select>
                </div>
                <div class="fld">
                    <label for="multiScript">Command / Script</label>
                    <textarea id="multiScript" class="text" placeholder="e.g., taskkill /f /im chrome.exe" rows="3">${action.command || ''}</textarea>
                    <small class="muted" style="margin-top: 5px;">Enter a command or script path to execute.</small>
                </div>
            `;
            
        case 'media':
            return `
                <label>Media Action</label>
                <div class="seg media-seg" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                    <button type="button" class="seg-btn ${action.action === 'play_pause' ? 'active' : ''}" data-media="play_pause"><i>▶</i> Play/Pause</button>
                    <button type="button" class="seg-btn ${action.action === 'mute' ? 'active' : ''}" data-media="mute"><i>🔇</i> Mute</button>
                    <button type="button" class="seg-btn ${action.action === 'vol_up' ? 'active' : ''}" data-media="vol_up"><i>🔊</i> Vol Up</button>
                    <button type="button" class="seg-btn ${action.action === 'prev_track' ? 'active' : ''}" data-media="prev_track"><i>⏪</i> Prev</button>
                    <button type="button" class="seg-btn ${action.action === 'next_track' ? 'active' : ''}" data-media="next_track"><i>⏩</i> Next</button>
                    <button type="button" class="seg-btn ${action.action === 'vol_down' ? 'active' : ''}" data-media="vol_down"><i>🔉</i> Vol Down</button>
                </div>
            `;
            
        case 'sound':
            return `
                <div class="fld">
                    <label>Audio File</label>
                    <div class="hstack">
                        <input type="text" id="multiSoundPath" class="text" style="flex: 1;" placeholder="Select an audio file..." value="${action.path || ''}" readonly />
                        <button id="multiSoundBrowse" class="ghost" type="button" style="flex-shrink: 0;">Browse</button>
                    </div>
                </div>
                <div class="fld">
                    <label>Volume (<span id="multiSoundVolLabel">${action.volume || 100}%</span>)</label>
                    <input type="range" id="multiSoundVolume" min="0" max="100" value="${action.volume || 100}" style="width: 100%; accent-color: var(--accent);">
                </div>
            `;
            
        case 'mouse':
            // Mevcut rowMouse panelinin HTML'ini birebir kopyala
            return `
                <div class="hstack" style="justify-content: space-between; align-items: flex-end;">
                    <div class="fld" style="flex: 1;">
                        <label for="multiMouseEvent">Event</label>
                        <select id="multiMouseEvent" class="text">
                            <option value="click" ${action.event === 'click' ? 'selected' : ''}>Mouse Click</option>
                            <option value="double_click" ${action.event === 'double_click' ? 'selected' : ''}>Mouse Double Click</option>
                            <option value="move" ${action.event === 'move' ? 'selected' : ''}>Mouse Move</option>
                            <option value="drag" ${action.event === 'drag' ? 'selected' : ''}>Drag and Drop</option>
                        </select>
                    </div>
                    <div class="fld" id="multiMouseButtonDiv" style="flex: 1; ${action.event === 'drag' || action.event === 'move' ? 'display:none;' : ''}">
                        <label for="multiMouseButton">Button</label>
                        <select id="multiMouseButton" class="text">
                            <option value="left" ${action.button === 'left' ? 'selected' : ''}>Left Click</option>
                            <option value="right" ${action.button === 'right' ? 'selected' : ''}>Right Click</option>
                            <option value="middle" ${action.button === 'middle' ? 'selected' : ''}>Middle Click</option>
                        </select>
                    </div>
                </div>
                
                <div id="multiMouseMoveOptions" class="mouse-sub-panel" style="margin-top: 10px; ${action.event === 'drag' ? 'display:none;' : ''}">
                    <label>Position (Move To)</label>
                    <div class="hstack" style="gap: 12px;">
                        <div class="fld" style="flex: 1;"><label for="multiMouseX1">X-axis</label><input type="number" id="multiMouseX1" class="text" value="${action.x || 0}"></div>
                        <div class="fld" style="flex: 1;"><label for="multiMouseY1">Y-axis</label><input type="number" id="multiMouseY1" class="text" value="${action.y || 0}"></div>
                        <button type="button" class="primary" id="multiMouseCapture" style="flex-shrink: 0; height: 38px; margin-top: 18px;">Capture</button>
                    </div>
                </div>
                
                <div id="multiMouseDragOptions" class="mouse-sub-panel" style="margin-top: 10px; ${action.event !== 'drag' ? 'display:none;' : ''}">
                    <label>Drag from (Start)</label>
                    <div class="hstack" style="gap: 12px;">
                        <div class="fld" style="flex: 1;"><label for="multiMouseDragX1">X-axis</label><input type="number" id="multiMouseDragX1" class="text" value="${action.x || 0}"></div>
                        <div class="fld" style="flex: 1;"><label for="multiMouseDragY1">Y-axis</label><input type="number" id="multiMouseDragY1" class="text" value="${action.y || 0}"></div>
                        <button type="button" class="primary" id="multiMouseCaptureStart" style="flex-shrink: 0; height: 38px; margin-top: 18px;">Capture Start</button>
                    </div>
                    <label style="margin-top: 10px;">Drag to (End)</label>
                    <div class="hstack" style="gap: 12px;">
                        <div class="fld" style="flex: 1;"><label for="multiMouseDragX2">X-axis</label><input type="number" id="multiMouseDragX2" class="text" value="${action.x2 || 0}"></div>
                        <div class="fld" style="flex: 1;"><label for="multiMouseDragY2">Y-axis</label><input type="number" id="multiMouseDragY2" class="text" value="${action.y2 || 0}"></div>
                        <button type="button" class="primary" id="multiMouseCaptureEnd" style="flex-shrink: 0; height: 38px; margin-top: 18px;">Capture End</button>
                    </div>
                </div>
                
                <div id="multiMouseRealtimePos" class="muted" style="margin-top: 8px;">
                    Current: X: 0, Y: 0
                </div>
            `;
            
        case 'goto':
            const pageButtons = [];
            for (let i = 0; i < (cfg?.pageCount || 1); i++) {
                const pageName = cfg?.pageNames?.[i] || `Page ${i + 1}`;
                const isActive = action.page === i;
                pageButtons.push(`<button type="button" data-page="${i}" class="seg-btn ${isActive ? 'active' : ''}">${pageName}</button>`);
            }
            return `
                <label>Target Page</label>
                <div id="multiGotoPages" class="page-chooser">
                    ${pageButtons.join('')}
                </div>
            `;
            
        default:
            return '<div class="muted">No settings available for this action type.</div>';
    }
}

function setupMultiActionSettingsListeners(action, index) {
    const updateAction = (key, value) => {
        multiActionStack[index][key] = value;
        updateMultiActionTmp();
        renderMultiActionStack();
        // Settings'i yeniden gösterme - sadece stack'i güncelle
    };
    
    switch(action.type) {
        case 'delay':
            const delayInput = document.getElementById('multiDelayMs');
            if (delayInput) {
                delayInput.oninput = () => updateAction('ms', parseInt(delayInput.value) || 500);
            }
            document.querySelectorAll('.delay-presets button').forEach(btn => {
                btn.onclick = () => {
                    const ms = parseInt(btn.dataset.ms);
                    delayInput.value = ms;
                    updateAction('ms', ms);
                };
            });
            break;
            
        case 'key':
            // Mevcut rowKeyMods mantığının aynısı
            const comboInput = document.getElementById('multiCombo');
            const presetSelect = document.getElementById('multiKeyPreset');
            
            // Preset dropdown'u doldur
            if (presetSelect && typeof PRESET_ACTIONS !== 'undefined') {
                presetSelect.innerHTML = `<option value="">${t('presets.selectPreset')}</option>`;
                for (const category in PRESET_ACTIONS) {
                    if (category.startsWith('---')) continue;
                    const actions = PRESET_ACTIONS[category];
                    if (typeof actions === 'object') {
                        const optgroup = document.createElement('optgroup');
                        optgroup.label = getPresetCategoryName(category);
                        for (const name in actions) {
                            const opt = document.createElement('option');
                            opt.value = actions[name];
                            opt.textContent = name;
                            optgroup.appendChild(opt);
                        }
                        presetSelect.appendChild(optgroup);
                    }
                }
                presetSelect.onchange = () => {
                    if (presetSelect.value) {
                        comboInput.value = presetSelect.value;
                        updateAction('combo', presetSelect.value);
                        updateModButtonStates();
                    }
                };
            }
            
            // Combo input değiştiğinde
            if (comboInput) {
                comboInput.oninput = () => updateAction('combo', comboInput.value);
            }
            
            // Mevcut combo değerini parse et ve mod butonlarını güncelle
            const updateModButtonStates = () => {
                const current = (comboInput?.value || '').toUpperCase();
                document.querySelectorAll('#multiSettingsContent .mod[data-mod]').forEach(btn => {
                    const mod = btn.dataset.mod === 'GUI' ? 'WIN' : btn.dataset.mod;
                    btn.classList.toggle('active', current.includes(mod) || current.includes(btn.dataset.mod));
                });
            };
            updateModButtonStates();
            
            // Modifier butonları (CTRL, ALT, SHIFT, WIN) - mevcut mantık
            document.querySelectorAll('#multiSettingsContent .mod[data-mod]').forEach(btn => {
                btn.onclick = () => {
                    let mod = btn.dataset.mod;
                    if (mod === 'GUI') mod = 'WIN';
                    
                    let current = (comboInput?.value || '').toUpperCase();
                    let parts = current ? current.split('+').map(p => p.trim()).filter(p => p) : [];
                    
                    // GUI/WIN kontrolü
                    const modIndex = parts.findIndex(p => p === mod || (mod === 'WIN' && p === 'GUI') || (mod === 'GUI' && p === 'WIN'));
                    
                    if (modIndex >= 0) {
                        parts.splice(modIndex, 1);
                        btn.classList.remove('active');
                    } else {
                        const mods = ['CTRL', 'ALT', 'SHIFT', 'WIN', 'GUI'];
                        const keys = parts.filter(p => !mods.includes(p));
                        const existingMods = parts.filter(p => mods.includes(p));
                        existingMods.push(mod);
                        
                        // Sırala
                        const modOrder = ['CTRL', 'ALT', 'SHIFT', 'WIN', 'GUI'];
                        existingMods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));
                        parts = [...existingMods, ...keys];
                        btn.classList.add('active');
                    }
                    
                    comboInput.value = parts.join('+');
                    updateAction('combo', comboInput.value);
                };
            });
            
            // Key butonları (ENTER, TAB, arrows, etc) - mevcut mantık
            document.querySelectorAll('#multiSettingsContent .mod[data-key]').forEach(btn => {
                btn.onclick = () => {
                    const key = btn.dataset.key;
                    let current = (comboInput?.value || '').toUpperCase();
                    let parts = current ? current.split('+').map(p => p.trim()).filter(p => p) : [];
                    
                    const mods = ['CTRL', 'ALT', 'SHIFT', 'WIN', 'GUI'];
                    const existingMods = parts.filter(p => mods.includes(p));
                    
                    parts = [...existingMods, key];
                    comboInput.value = parts.join('+');
                    updateAction('combo', comboInput.value);
                };
            });
            
            // Capture butonu - klavye tuşlarını dinle
            const multiCaptureBtn = document.getElementById('multiCaptureToggle');
            if (multiCaptureBtn) {
                let isMultiCapturing = false;
                
                const stopMultiCapture = () => {
                    isMultiCapturing = false;
                    multiCaptureBtn.textContent = t('editor.capture.start');
                    multiCaptureBtn.classList.remove('capturing');
                    document.removeEventListener('keydown', multiCaptureKeyHandler, true);
                };
                
                const multiCaptureKeyHandler = (e) => {
                    if (!isMultiCapturing) return;
                    
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (e.key === 'Escape') {
                        stopMultiCapture();
                        comboInput.value = action.combo || '';
                        return;
                    }
                    
                    // Modifier'ları topla
                    const mods = [];
                    if (e.ctrlKey) mods.push('CTRL');
                    if (e.altKey) mods.push('ALT');
                    if (e.shiftKey) mods.push('SHIFT');
                    if (e.metaKey) mods.push('WIN');
                    
                    // Ana tuşu al
                    let key = e.key.toUpperCase();
                    if (key === 'CONTROL') key = '';
                    else if (key === 'ALT') key = '';
                    else if (key === 'SHIFT') key = '';
                    else if (key === 'META') key = '';
                    else if (key === ' ') key = 'SPACE';
                    else if (key === 'ARROWUP') key = 'ARROW_UP';
                    else if (key === 'ARROWDOWN') key = 'ARROW_DOWN';
                    else if (key === 'ARROWLEFT') key = 'ARROW_LEFT';
                    else if (key === 'ARROWRIGHT') key = 'ARROW_RIGHT';
                    
                    // Sadece modifier basıldıysa bekle
                    if (!key) {
                        comboInput.value = mods.join('+') + (mods.length ? '+' : '') + '...';
                        return;
                    }
                    
                    // Combo'yu oluştur
                    const combo = [...mods, key].join('+');
                    comboInput.value = combo;
                    updateAction('combo', combo);
                    updateModButtonStates();
                    stopMultiCapture();
                };
                
                multiCaptureBtn.onclick = () => {
                    if (isMultiCapturing) {
                        stopMultiCapture();
                    } else {
                        isMultiCapturing = true;
                        multiCaptureBtn.textContent = t('editor.capture.listening');
                        multiCaptureBtn.classList.add('capturing');
                        comboInput.value = t('editor.capture.pressKeys');
                        document.addEventListener('keydown', multiCaptureKeyHandler, true);
                    }
                };
            }
            break;
            
        case 'text':
            const textInput = document.getElementById('multiTextMacro');
            const simCheckbox = document.getElementById('multiSimulateTyping');
            if (textInput) textInput.oninput = () => updateAction('text', textInput.value);
            if (simCheckbox) simCheckbox.onchange = () => updateAction('simulate', simCheckbox.checked);
            break;
            
        case 'app':
            const appInput = document.getElementById('multiAppPath');
            const appBrowse = document.getElementById('multiAppBrowse');
            const appQuickSelect = document.getElementById('multiAppQuickSelect');
            
            // Yüklü uygulamaları doldur (cachedAppList global'den)
            if (appQuickSelect && typeof cachedAppList !== 'undefined' && cachedAppList.length > 0) {
                appQuickSelect.innerHTML = '<option value="">Select app...</option>';
                cachedAppList.forEach(app => {
                    const o = document.createElement('option');
                    o.value = app.P;
                    o.textContent = app.N;
                    appQuickSelect.appendChild(o);
                });
            } else if (appQuickSelect) {
                // Henüz yüklenmemişse yükle
                appQuickSelect.innerHTML = '<option value="">Loading apps...</option>';
                if (window.electronAPI?.system?.scanInstalledApps) {
                    window.electronAPI.system.scanInstalledApps().then(apps => {
                        cachedAppList = apps.filter(app => app.P && app.N);
                        appQuickSelect.innerHTML = '<option value="">Select app...</option>';
                        cachedAppList.forEach(app => {
                            const o = document.createElement('option');
                            o.value = app.P;
                            o.textContent = app.N;
                            appQuickSelect.appendChild(o);
                        });
                    }).catch(() => {
                        appQuickSelect.innerHTML = '<option value="">Select app...</option>';
                    });
                }
            }
            
            // Quick select değişince path'i güncelle
            if (appQuickSelect) {
                appQuickSelect.onchange = () => {
                    if (appQuickSelect.value) {
                        appInput.value = appQuickSelect.value;
                        updateAction('path', appQuickSelect.value);
                    }
                };
            }
            
            if (appInput) appInput.oninput = () => updateAction('path', appInput.value);
            if (appBrowse) {
                appBrowse.onclick = async () => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.exe,.lnk,.bat,.cmd';
                    input.onchange = (e) => {
                        if (e.target.files[0]) {
                            const path = e.target.files[0].path || e.target.files[0].name;
                            appInput.value = path;
                            updateAction('path', path);
                            if (appQuickSelect) appQuickSelect.value = '';
                        }
                    };
                    input.click();
                };
            }
            break;
            
        case 'website':
            const urlInput = document.getElementById('multiWebsiteUrl');
            if (urlInput) urlInput.oninput = () => updateAction('url', urlInput.value);
            break;
            
        case 'script':
            const scriptInput = document.getElementById('multiScript');
            const scriptPreset = document.getElementById('multiScriptPreset');
            
            // Populate preset scripts dropdown
            if (scriptPreset) {
                scriptPreset.innerHTML = '<option value="">--- Select Preset Script ---</option>';
                for (const [category, actions] of Object.entries(PRESET_SCRIPTS)) {
                    if (category === "--- Select Preset Script ---") continue;
                    if (typeof actions === 'object' && actions !== null) {
                        const optgroup = document.createElement('optgroup');
                        optgroup.label = category;
                        for (const [name, cmd] of Object.entries(actions)) {
                            // Skip separator entries
                            if (cmd === "" || name.startsWith("---")) continue;
                            const option = document.createElement('option');
                            option.value = cmd;
                            option.textContent = name;
                            optgroup.appendChild(option);
                        }
                        scriptPreset.appendChild(optgroup);
                    }
                }
                
                scriptPreset.onchange = () => {
                    const selectedScript = scriptPreset.value;
                    if (selectedScript && scriptInput) {
                        const currentText = scriptInput.value;
                        const newText = (currentText ? currentText + '\n' : '') + selectedScript;
                        scriptInput.value = newText;
                        updateAction('command', newText);
                        scriptPreset.selectedIndex = 0;
                    }
                };
            }
            
            if (scriptInput) scriptInput.oninput = () => updateAction('command', scriptInput.value);
            break;
            
        case 'media':
            document.querySelectorAll('#multiSettingsContent .seg-btn[data-media]').forEach(btn => {
                btn.onclick = () => {
                    document.querySelectorAll('#multiSettingsContent .seg-btn[data-media]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    updateAction('action', btn.dataset.media);
                };
            });
            break;
            
        case 'sound':
            const soundPath = document.getElementById('multiSoundPath');
            const soundVol = document.getElementById('multiSoundVolume');
            const soundVolLabel = document.getElementById('multiSoundVolLabel');
            const soundBrowse = document.getElementById('multiSoundBrowse');
            
            if (soundVol) {
                soundVol.oninput = () => {
                    soundVolLabel.textContent = soundVol.value + '%';
                    updateAction('volume', parseInt(soundVol.value));
                };
            }
            if (soundBrowse) {
                soundBrowse.onclick = () => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'audio/*';
                    input.onchange = (e) => {
                        if (e.target.files[0]) {
                            const path = e.target.files[0].path || e.target.files[0].name;
                            soundPath.value = path;
                            updateAction('path', path);
                        }
                    };
                    input.click();
                };
            }
            break;
            
        case 'mouse':
            // Mevcut rowMouse mantığının aynısı
            const mouseEventSel = document.getElementById('multiMouseEvent');
            const mouseButtonSel = document.getElementById('multiMouseButton');
            const mouseButtonDiv = document.getElementById('multiMouseButtonDiv');
            const mouseMoveOpts = document.getElementById('multiMouseMoveOptions');
            const mouseDragOpts = document.getElementById('multiMouseDragOptions');
            const mouseRealtimePos = document.getElementById('multiMouseRealtimePos');
            
            // Input elements
            const mX1 = document.getElementById('multiMouseX1');
            const mY1 = document.getElementById('multiMouseY1');
            const mDragX1 = document.getElementById('multiMouseDragX1');
            const mDragY1 = document.getElementById('multiMouseDragY1');
            const mDragX2 = document.getElementById('multiMouseDragX2');
            const mDragY2 = document.getElementById('multiMouseDragY2');
            
            // Capture buttons
            const capBtn = document.getElementById('multiMouseCapture');
            const capStartBtn = document.getElementById('multiMouseCaptureStart');
            const capEndBtn = document.getElementById('multiMouseCaptureEnd');
            
            // Event değiştiğinde panelleri göster/gizle
            const updateMousePanels = () => {
                const ev = mouseEventSel?.value || 'click';
                if (mouseMoveOpts) mouseMoveOpts.style.display = ev !== 'drag' ? 'block' : 'none';
                if (mouseDragOpts) mouseDragOpts.style.display = ev === 'drag' ? 'block' : 'none';
                if (mouseButtonDiv) mouseButtonDiv.style.display = (ev === 'drag' || ev === 'move') ? 'none' : '';
            };
            
            if (mouseEventSel) {
                mouseEventSel.onchange = () => {
                    updateAction('event', mouseEventSel.value);
                    updateMousePanels();
                };
            }
            
            if (mouseButtonSel) {
                mouseButtonSel.onchange = () => updateAction('button', mouseButtonSel.value);
            }
            
            // Position inputs
            if (mX1) mX1.oninput = () => updateAction('x', parseInt(mX1.value) || 0);
            if (mY1) mY1.oninput = () => updateAction('y', parseInt(mY1.value) || 0);
            if (mDragX1) mDragX1.oninput = () => updateAction('x', parseInt(mDragX1.value) || 0);
            if (mDragY1) mDragY1.oninput = () => updateAction('y', parseInt(mDragY1.value) || 0);
            if (mDragX2) mDragX2.oninput = () => updateAction('x2', parseInt(mDragX2.value) || 0);
            if (mDragY2) mDragY2.oninput = () => updateAction('y2', parseInt(mDragY2.value) || 0);
            
            // Mouse capture fonksiyonu - ekranı transparan yapıp tıklama bekler (ana sistemdeki gibi)
            const multiMouseCapture = async (xInput, yInput) => {
                if (!window.electronAPI || !window.electronAPI.robot) return;
                await window.electronAPI.robot.enterCaptureMode();
                document.body.classList.add('in-capture-mode');
                
                const captureClickListener = async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    document.removeEventListener('click', captureClickListener, { capture: true });
                    document.body.classList.remove('in-capture-mode');
                    const pos = await window.electronAPI.robot.getMousePos();
                    await window.electronAPI.robot.exitCaptureMode();
                    if (pos.success) {
                        xInput.value = pos.x;
                        yInput.value = pos.y;
                        xInput.dispatchEvent(new Event('input'));
                        yInput.dispatchEvent(new Event('input'));
                    }
                };
                document.addEventListener('click', captureClickListener, { capture: true, once: true });
            };
            
            // Capture butonları - transparan capture mode kullanır
            if (capBtn) {
                capBtn.onclick = () => multiMouseCapture(mX1, mY1);
            }
            
            if (capStartBtn) {
                capStartBtn.onclick = () => multiMouseCapture(mDragX1, mDragY1);
            }
            
            if (capEndBtn) {
                capEndBtn.onclick = () => multiMouseCapture(mDragX2, mDragY2);
            }
            
            // Realtime mouse position
            if (mouseRealtimePos && window.electronAPI?.robot) {
                const posInterval = setInterval(async () => {
                    if (!document.getElementById('multiMouseRealtimePos')) {
                        clearInterval(posInterval);
                        return;
                    }
                    const pos = await window.electronAPI.robot.getMousePos();
                    if (pos.success) {
                        mouseRealtimePos.textContent = `Current: X: ${pos.x}, Y: ${pos.y}`;
                    }
                }, 100);
            }
            
            updateMousePanels();
            break;
            
        case 'goto':
            document.querySelectorAll('#multiGotoPages .seg-btn, #multiSettingsContent .seg-btn[data-page]').forEach(btn => {
                btn.onclick = () => {
                    document.querySelectorAll('#multiGotoPages .seg-btn, #multiSettingsContent .seg-btn[data-page]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    updateAction('page', parseInt(btn.dataset.page));
                };
            });
            break;
    }
    
    // Delete button
    const deleteBtn = document.getElementById('deleteSelectedAction');
    if (deleteBtn) {
        deleteBtn.onclick = () => removeMultiAction(index);
    }
}

// ============================================================
// FIX: KESİNLEŞTİRİLMİŞ DRAG & DROP MANTIĞI
// ============================================================

// Bu fonksiyon, mouse'un Y konumuna göre hangi elemanın ÖNÜNE ekleme yapılması gerektiğini bulur.
// Karmaşık offset hesapları yerine basit "orta nokta" mantığı kullanır.
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.stack-item:not(.dragging)')];

    // Yukarıdan aşağıya tüm elemanları kontrol et
    // Mouse hangi elemanın orta noktasından daha YUKARIDAYSA, o elemanı döndür.
    return draggableElements.find(child => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - (box.height / 2);
        return offset < 0; // Mouse, elemanın ortasından yukarıdaysa true döner
    });
}

// Global AbortController for drag-drop events
let multiActionDragDropController = null;

function setupMultiActionDragDrop() {
    const palette = document.querySelector('.multi-action-palette');
    const stack = document.getElementById('multiActionStack');
    
    if (!palette || !stack) return;
    
    // Önceki event listener'ları temizle
    if (multiActionDragDropController) {
        multiActionDragDropController.abort();
    }
    multiActionDragDropController = new AbortController();
    const signal = multiActionDragDropController.signal;
    
    // 1. Palette'den Sürükleme (Soldan Sağa)
    palette.querySelectorAll('.palette-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('action-type', item.dataset.actionType);
            e.dataTransfer.setData('source', 'palette');
            item.classList.add('dragging');
        }, { signal });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            clearDropIndicator();
        }, { signal });
    });
    
    // 2. Stack Üzerinde Gezinme (Görsel Mavi Çizgi)
    stack.addEventListener('dragover', (e) => {
        e.preventDefault();
        clearDropIndicator();
        
        const allItems = [...stack.querySelectorAll('.stack-item')];
        const mouseY = e.clientY;
        
        // Indicator elementi oluştur
        const indicator = document.createElement('div');
        indicator.className = 'drop-indicator';
        indicator.style.cssText = `
            height: 4px;
            margin: 4px 0;
            background: var(--accent, #8b5cf6);
            border-radius: 2px;
            box-shadow: 0 0 10px var(--accent, #8b5cf6);
            pointer-events: none;
        `;
        
        if (allItems.length === 0) {
            stack.appendChild(indicator);
            return;
        }
        
        // Mouse hangi item'ın altında?
        let insertAfterItem = null;
        
        for (const item of allItems) {
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            
            if (mouseY > midY) {
                insertAfterItem = item;
            }
        }
        
        if (insertAfterItem) {
            // Bu item'ın sonrasına ekle
            insertAfterItem.insertAdjacentElement('afterend', indicator);
        } else {
            // En başa ekle (ilk item'ın önüne)
            stack.insertBefore(indicator, allItems[0]);
        }
    }, { signal });
    
    stack.addEventListener('dragleave', (e) => {
        if (!stack.contains(e.relatedTarget)) {
            clearDropIndicator();
        }
    }, { signal });
    
    // 3. Drop (Bırakma ve Yerleştirme)
    stack.addEventListener('drop', (e) => {
        e.preventDefault();
        clearDropIndicator();
        
        const source = e.dataTransfer.getData('source');
        const mouseY = e.clientY;
        const allItems = [...stack.querySelectorAll('.stack-item')];
        
        // Mouse hangi item'ın altında? (tüm item'ları kontrol et)
        let dropAfterIndex = -1; // -1 = en başa
        
        for (const item of allItems) {
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const itemIndex = parseInt(item.dataset.index);
            
            if (mouseY > midY) {
                dropAfterIndex = itemIndex;
            }
        }
        
        // Hedef pozisyon = dropAfterIndex + 1
        let targetIndex = dropAfterIndex + 1;
        
        // --- SENARYO A: Paletten Yeni Ekleme ---
        if (source === 'palette') {
            const actionType = e.dataTransfer.getData('action-type');
            if (actionType && MULTI_ACTION_TYPES[actionType]) {
                const typeInfo = MULTI_ACTION_TYPES[actionType];
                const newAction = {
                    type: actionType,
                    ...JSON.parse(JSON.stringify(typeInfo.defaultValue))
                };
                
                multiActionStack.splice(targetIndex, 0, newAction);
                renderMultiActionStack();
                updateMultiActionTmp();
                selectMultiAction(targetIndex);
            }
        } 
        // --- SENARYO B: Liste İçi Sıralama (Reorder) ---
        else if (source === 'stack') {
            const fromIndex = parseInt(e.dataTransfer.getData('drag-index'));
            if (isNaN(fromIndex)) return;
            
            // Aynı yere bırakma kontrolü
            if (targetIndex === fromIndex || targetIndex === fromIndex + 1) {
                return; // Hiçbir şey yapma, zaten orada
            }
            
            // Elemanı çıkar
            const [movedItem] = multiActionStack.splice(fromIndex, 1);
            
            // Hedef index'i ayarla (silme sonrası kayma)
            let insertIndex = targetIndex;
            if (fromIndex < targetIndex) {
                insertIndex--; // Yukarıdan sildiğimiz için index kayar
            }
            
            multiActionStack.splice(insertIndex, 0, movedItem);
            
            // Seçimi güncelle
            if (selectedMultiActionIndex === fromIndex) {
                selectedMultiActionIndex = insertIndex;
            }
            
            renderMultiActionStack();
            updateMultiActionTmp();
        }
    }, { signal });
    
    setupStackItemDrag();
}

function clearDropIndicator() {
    document.querySelectorAll('.drop-indicator').forEach(el => el.remove());
}

function setupStackItemDrag() {
    const stack = document.getElementById('multiActionStack');
    if (!stack) return;
    
    stack.querySelectorAll('.stack-item').forEach(item => {
        item.setAttribute('draggable', 'true');
        
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('source', 'stack');
            e.dataTransfer.setData('drag-index', item.dataset.index);
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => item.classList.add('dragging'), 0);
        });
        
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            clearDropIndicator();
        });
    });
}

// ============================================
// MULTI-ACTION EXECUTION
// ============================================

async function executeMultiActions(actions) {
    if (!actions || !Array.isArray(actions) || actions.length === 0) return;
    
    for (const action of actions) {
        await executeSingleMultiAction(action);
    }
}

async function executeSingleMultiAction(action) {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    switch(action.type) {
        case 'delay':
            await sleep(action.ms || 500);
            break;
            
        case 'key':
            if (action.combo && window.electronAPI?.robot) {
                const parts = action.combo.toUpperCase().split('+').map(p => p.trim());
                const modifiers = [];
                let key = '';
                
                for (const part of parts) {
                    if (['CTRL', 'CONTROL', 'ALT', 'SHIFT', 'COMMAND', 'WIN'].includes(part)) {
                        if (part === 'CTRL' || part === 'CONTROL') modifiers.push('control');
                        else if (part === 'ALT') modifiers.push('alt');
                        else if (part === 'SHIFT') modifiers.push('shift');
                        else if (part === 'WIN' || part === 'COMMAND') modifiers.push('command');
                    } else {
                        key = part.toLowerCase();
                    }
                }
                
                if (key) {
                    await window.electronAPI.robot.keyTap(key, modifiers);
                }
            }
            break;
            
        case 'text':
            if (action.text && window.electronAPI?.robot) {
                if (action.simulate) {
                    await window.electronAPI.robot.typeStringSimulated(action.text);
                } else {
                    await window.electronAPI.robot.typeString(action.text);
                }
            }
            break;
            
        case 'app':
            if (action.path && window.electronAPI?.shell) {
                window.electronAPI.shell.openPath(action.path);
                await sleep(100);
            }
            break;
            
        case 'website':
            if (action.url && window.electronAPI?.shell) {
                let url = action.url;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                window.electronAPI.shell.openExternal(url);
                await sleep(100);
            }
            break;
            
        case 'script':
            if (action.command && window.electronAPI?.system) {
                let cmd = action.command;
                // Replace nircmd.exe with full path from assets
                const nircmdPath = `"${ASSETS_PATH}/nircmd.exe"`;
                cmd = cmd.replace(/nircmd(\.exe)?/gi, nircmdPath);
                await window.electronAPI.system.runCommand(cmd);
            }
            break;
            
        case 'media':
            if (action.action && window.electronAPI?.robot) {
                const mediaKeys = {
                    'play_pause': 'audio_play',
                    'mute': 'audio_mute',
                    'vol_up': 'audio_vol_up',
                    'vol_down': 'audio_vol_down',
                    'next_track': 'audio_next',
                    'prev_track': 'audio_prev'
                };
                const key = mediaKeys[action.action];
                if (key) {
                    await window.electronAPI.robot.keyTap(key, []);
                }
            }
            break;
            
        case 'sound':
            if (action.path) {
                try {
                    const audio = new Audio(action.path.startsWith('file:') ? action.path : 'file://' + action.path);
                    audio.volume = (action.volume || 100) / 100;
                    await audio.play();
                } catch(e) {
                    console.error('Sound play error:', e);
                }
            }
            break;
            
        case 'mouse':
            if (window.electronAPI?.robot) {
                // İlk pozisyona git (move hariç hepsi için)
                if (action.x || action.y) {
                    await window.electronAPI.robot.mouseMove(action.x || 0, action.y || 0);
                    await sleep(50);
                }
                
                // Button değerini al (default: left)
                const mouseButton = action.button || 'left';
                
                if (action.event === 'click') {
                    await window.electronAPI.robot.mouseClick(mouseButton, false);
                } else if (action.event === 'double_click') {
                    await window.electronAPI.robot.mouseClick(mouseButton, true);
                } else if (action.event === 'drag') {
                    // Drag: başlangıç pozisyonundan bitiş pozisyonuna sürükle
                    await window.electronAPI.robot.mouseToggle('down', 'left');
                    await sleep(50);
                    await window.electronAPI.robot.mouseMove(action.x2 || 0, action.y2 || 0);
                    await sleep(50);
                    await window.electronAPI.robot.mouseToggle('up', 'left');
                }
                // 'move' zaten yukarıda sadece pozisyon değiştiriyor
            }
            break;
            
        case 'goto':
            // Goto page - sadece cihaza sinyal gönder
            if (typeof action.page === 'number') {
                currentPage = action.page;
                drawGrid();
                sendSerialCommand(`SET_PAGE:${action.page}`);
            }
            break;
    }
}