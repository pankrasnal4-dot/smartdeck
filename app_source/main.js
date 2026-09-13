// ============================================================================
// MAIN PROCESS - Electron Main Entry Point
// ============================================================================
// This file handles the main Electron process, including:
// - Window management and lifecycle
// - IPC communication with renderer process
// - System integrations (RobotJS, serial ports, notifications)
// - Tray icon and menu
// ============================================================================
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false; // <--- ÖNEMLİ: Otomatik indirmeyi kapatır
const { exec } = require('child_process');
const { app, BrowserWindow, session, Tray, Menu, ipcMain, clipboard, Notification, screen, shell } = require('electron/main');
const path = require('node:path');
const robot = require('@jitsi/robotjs');

// === ROBOTJS GECİKMELERİNİ SIFIRLA ===
robot.setKeyboardDelay(0);  // Tuş basımları arası gecikme: 0ms
robot.setMouseDelay(0);     // Mouse işlemleri arası gecikme: 0ms

const { productName } = require('./package.json');
const fs = require('fs');
const { spawn } = require('child_process');

// Active window detection
let activeWin = null;
try {
  activeWin = require('active-win');
} catch (e) {
  try {
    (async () => {
      const mod = await import('active-win');
      activeWin = mod.default || mod;
    })();
  } catch (err) {
    console.warn('[ActiveWin] Loading active-win failed:', err.message);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalize file path for Unicode support
 * Handles Turkish and other non-ASCII characters in Windows paths
 * @param {string} filePath - The path to normalize
 * @returns {string} - Normalized path
 */
function normalizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  
  // Normalize Unicode characters (NFC normalization)
  let normalized = filePath.normalize('NFC');
  
  // Convert forward slashes to backslashes on Windows
  if (process.platform === 'win32') {
    normalized = normalized.replace(/\//g, '\\');
  }
  
  // Use path.normalize to resolve .. and . segments
  return path.normalize(normalized);
}

/**
 * Safely open a path with Unicode support
 * @param {string} filePath - The path to open
 * @returns {Promise} - Result of shell.openPath
 */
async function safeOpenPath(filePath) {
  const normalized = normalizePath(filePath);
  return shell.openPath(normalized);
}

/**
 * Get the correct path to assets folder
 * In development: uses local 'assets' folder
 * In production: uses 'resources/assets' folder
 */
function getAssetPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets');
  }
  return path.join(__dirname, 'assets');
}


// Get Windows startup status (run on login)
ipcMain.handle('app:getStartupStatus', () => {
  const exePath = process.execPath;
  const settings = app.getLoginItemSettings({ path: exePath });
  console.log('[Startup] getLoginItemSettings:', settings);
  return settings.openAtLogin;
});

// Set Windows startup status
ipcMain.handle('app:setStartupStatus', (event, shouldOpen) => {
  console.log('[Startup] setStartupStatus called with:', shouldOpen);
  
  // Get the correct executable path
  const exePath = process.execPath;
  console.log('[Startup] Executable path:', exePath);
  
  app.setLoginItemSettings({
    openAtLogin: shouldOpen,
    openAsHidden: shouldOpen,  // Startup'ta gizli başla (sadece açıkken)
    path: exePath,
    args: ['--minimized']
  });
  
  // Verify the change
  const newSettings = app.getLoginItemSettings({ path: exePath });
  console.log('[Startup] New settings after change:', newSettings);
  
  return { success: newSettings.openAtLogin === shouldOpen, current: newSettings.openAtLogin };
});

// Get startup minimized preference
ipcMain.handle('app:getStartMinimized', () => {
  const exePath = process.execPath;
  return app.getLoginItemSettings({ path: exePath }).openAsHidden || false;
});

// Get assets path for renderer process
ipcMain.handle('app:getAssetPath', () => {
  return getAssetPath();
});

// ============================================================================
// WINDOW CREATION & MANAGEMENT
// ============================================================================


const iconPath = path.join(__dirname, 'icon.ico');

let mainWindow;
let tray = null;
let isQuitting = false;
let originalBounds = null;
let startMinimized = false;

function debugLog(msg) {
  try {
    const logFile = path.join(app.getPath('userData'), 'smartdeck_runtime.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  debugLog('Instance lock not acquired, quitting duplicate process');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    debugLog('second-instance event received: ' + JSON.stringify(commandLine));
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * Create the main application window
 * Handles window events: minimize, close
 */

function createWindow() {
  debugLog('createWindow called, startMinimized=' + startMinimized);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1200,
    icon: iconPath,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false 
    },
  });

  mainWindow.webContents.on('did-finish-load', () => {
    debugLog('mainWindow did-finish-load');
    if (!startMinimized) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    debugLog(`mainWindow did-fail-load: code=${code}, desc=${desc}`);
  });

  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    debugLog(`[Renderer Console] [lvl ${level}] ${message} (${sourceId}:${line})`);
  });

  // --- GÜNCELLEME OLAYLARI ---

  // Güncelleme var, indirme başladı
  autoUpdater.on('update-available', () => {
    if (mainWindow) mainWindow.webContents.send('update_available');
  });

  // İndirme bitti
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) mainWindow.webContents.send('update_downloaded');
  });

  // Kullanıcı butona basınca çalışacak komut
  ipcMain.on('app:restartAndInstall', () => {
    autoUpdater.quitAndInstall();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  
  if (!startMinimized) {
    mainWindow.show();
    mainWindow.focus();
  }

  mainWindow.setMenu(null);

  // Hide window to tray instead of minimizing
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  // Handle window close event with user confirmation
  mainWindow.on('close', async (event) => {
    debugLog('mainWindow close event, isQuitting=' + isQuitting);
    if (isQuitting) return;

    event.preventDefault();

    let defaultAction = 'showConfirm';
    try {
      defaultAction = await mainWindow.webContents.executeJavaScript(`window.getCloseAction()`);
      debugLog('mainWindow getCloseAction returned: ' + defaultAction);
    } catch (e) {
      debugLog("Error getting settings from renderer: " + e.message);
    }

    if (defaultAction === 'minimize') {
      debugLog('Hiding mainWindow due to defaultAction=minimize');
      mainWindow.hide();
      return;
    }
    if (defaultAction === 'exit') {
      debugLog('Quitting app due to defaultAction=exit');
      isQuitting = true;
      app.quit();
      return;
    }

    try {
      const message = "Are you sure you want to exit the application completely? If you exit, the device connection will be severed.";

      const result = await mainWindow.webContents.executeJavaScript(`
            new Promise(resolve => {
                // showCustomConfirm fonksiyonu yoksa standart confirm kullan
                if (typeof showCustomConfirm !== 'function') {
                    const c = confirm("${message}");
                    resolve({ choice: c, remember: false });
                    return;
                }

                const confirmed = showCustomConfirm(
                    \`\${"${message}"}\n\n<label style="display: flex; align-items: center; gap: 8px; margin-top: 15px; font-size: 13px; color: var(--text); cursor: pointer;"><input type="checkbox" id="rememberChoice" style="width: 16px; height: 16px; accent-color: var(--accent);"> Remember my choice</label>\`,
                    "Confirm Exit",
                    "Exit App",
                    "Minimize to Tray" 
                );

                confirmed.then(userChoice => {
                    const remember = document.getElementById('rememberChoice')?.checked || false;
                    resolve({ choice: userChoice, remember: remember });
                });
            })
        `);

      if (result.choice) {
        if (result.remember) {
          await mainWindow.webContents.executeJavaScript(`window.setCloseAction('exit')`);
        }
        isQuitting = true;
        app.quit();
      } else {
        if (result.remember) {
          await mainWindow.webContents.executeJavaScript(`window.setCloseAction('minimize')`);
        }
        mainWindow.hide();
      }
    } catch (e) {
      console.error("Error showing confirm dialog:", e);
      mainWindow.hide();
    }
  });
}

// ============================================================================
// APP INITIALIZATION
// ============================================================================

app.whenReady().then(() => {

  // Versiyon bilgisini gönder
if (!gotTheLock) return;

  // Windows'ta login'de açıldıysa veya --minimized argümanı varsa minimize başlat
  const hasMinimizedArg = process.argv.includes('--minimized') || process.argv.includes('--hidden');
  
  if (hasMinimizedArg) {
    startMinimized = true;
    debugLog('[Startup] Starting minimized to tray (CLI arg)');
  } else {
    startMinimized = false;
    debugLog('[Startup] Starting with visible window');
  }

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  // Get list of available firmware boards
  ipcMain.handle('app:getFirmwareList', async () => {
    let boardsPath = path.join(getAssetPath(), 'firmware', 'boards.json');
    if (!fs.existsSync(boardsPath)) {
      boardsPath = path.join(__dirname, 'assets', 'firmware', 'boards.json');
    }

    if (!fs.existsSync(boardsPath)) {
      console.warn("boards.json not found at:", boardsPath);
      return [];
    }

    try {
      const rawData = fs.readFileSync(boardsPath, 'utf-8');
      const boards = JSON.parse(rawData.replace(/^\uFEFF/, ''));
      return boards;
    } catch (e) {
      console.error("Error reading boards.json:", e);
      return [];
    }
  });
  // Open plugins folder in file explorer
  ipcMain.handle('app:openPluginsFolder', () => {
    const pluginsDir = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'plugins');

    if (!fs.existsSync(pluginsDir)) {
      try {
        fs.mkdirSync(pluginsDir);
      } catch (e) {
        console.error("Could not create plugins dir:", e);
        return { success: false, error: e.message };
      }
    }

    safeOpenPath(pluginsDir);
    return { success: true, path: pluginsDir };
  });
  // Execute system commands (for button actions)
  ipcMain.handle('app:runCommand', async (event, command) => {
    return new Promise((resolve) => {
      // Unicode path desteği için encoding ayarları
      const execOptions = {
        encoding: 'utf8',
        shell: true,
        windowsHide: true
      };
      
      exec(command, execOptions, (error, stdout, stderr) => {
        if (error) {
          console.warn(`Command error: ${error.message}`);

          if (error.code === 'ENOENT') {
            return resolve({ success: false, error: error.message });
          }
          return resolve({
            success: true,
            stdout,
            stderr,
            warning: error.message
          });
        }

        resolve({ success: true, stdout, stderr });
      });
    });
  });

  ipcMain.handle('app:saveTempIcon', async (event, base64Data) => {
    try {
      const data = base64Data.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(data, 'base64');

      const tempPath = app.getPath('temp');
      const fileName = `smartdeck_icon_${Date.now()}.png`;
      const fullPath = path.join(tempPath, fileName);

      fs.writeFileSync(fullPath, buffer);

      return { success: true, path: fullPath };
    } catch (e) {
      console.error("Save temp icon error:", e);
      return { success: false, error: e.message };
    }
  });
  // Scan installed Windows applications via PowerShell
  ipcMain.handle('app:scanInstalledApps', async () => {
    // UTF-8 output and proper resolution of Squirrel / Update.exe shortcuts (e.g. Discord, Teams)
    const psCommand = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference='SilentlyContinue';$W=New-Object -ComObject WScript.Shell;Get-ChildItem -Path([Environment]::GetFolderPath('CommonStartMenu')),([Environment]::GetFolderPath('StartMenu')) -Recurse -Include *.lnk|ForEach-Object{$s=$W.CreateShortcut($_);$t=$s.TargetPath;$args=$s.Arguments;$n=$_.BaseName;if($t.EndsWith('.exe')){if($t.EndsWith('Update.exe') -and $args -match '--processStart\\s+([^\\s]+)'){$cand=Get-ChildItem -Path([System.IO.Path]::GetDirectoryName($t)) -Recurse -Filter $matches[1] -ErrorAction SilentlyContinue|Select-Object -First 1;if($cand){$t=$cand.FullName}};[PSCustomObject]@{N=$n;P=$t}}}|Sort-Object -Property N -Unique|ConvertTo-Json -Compress";

    return new Promise((resolve) => {
      exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psCommand.replace(/"/g, '\\"')}"`,
        { maxBuffer: 1024 * 1024 * 10, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            console.error("App Scan Error:", error);
            resolve([]);
          } else {
            try {
              const apps = JSON.parse(stdout || '[]');
              resolve(Array.isArray(apps) ? apps : [apps]);
            } catch (e) {
              resolve([]);
            }
          }
        });
    });
  });
  // Scan installed plugins
  ipcMain.handle('app:scanPlugins', async () => {


    ipcMain.handle('system:listSerialPorts', async () => {
      return new Promise((resolve) => {
        const cmd = 'powershell "[System.IO.Ports.SerialPort]::GetPortNames()"';
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            console.error("Port list error:", error);
            resolve([]);
            return;
          }
          const ports = stdout.trim().split(/\r?\n/).map(p => p.trim()).filter(p => p && p.startsWith('COM'));
          const uniquePorts = [...new Set(ports)].sort();
          resolve(uniquePorts);
        });
      });
    });
    // Flash firmware to ESP32 device
    ipcMain.on('app:flashFirmware', (event, port, modelFolder) => {
      let esptoolPath = path.join(getAssetPath(), 'tools', 'esptool.exe');
      if (!fs.existsSync(esptoolPath)) {
        esptoolPath = path.join(__dirname, 'assets', 'tools', 'esptool.exe');
      }
      let firmwareDir = path.join(getAssetPath(), 'firmware', modelFolder);
      if (!fs.existsSync(firmwareDir)) {
        firmwareDir = path.join(__dirname, 'assets', 'firmware', modelFolder);
      }
      let boardsPath = path.join(getAssetPath(), 'firmware', 'boards.json');
      if (!fs.existsSync(boardsPath)) {
        boardsPath = path.join(__dirname, 'assets', 'firmware', 'boards.json');
      }
      // Default flash parameters for ESP32-S3
      let targetChip = 'esp32s3';
      let flashMode = 'dio';
      let flashFreq = '80m';
      let bootloaderAddr = '0x0';

      try {
        if (fs.existsSync(boardsPath)) {
          const boardsData = JSON.parse(fs.readFileSync(boardsPath, 'utf-8').replace(/^\uFEFF/, ''));
          const selectedBoard = boardsData.find(b => b.folder === modelFolder || b.id === modelFolder);

          if (selectedBoard) {
            if (selectedBoard.chip) targetChip = selectedBoard.chip;
            if (selectedBoard.flash_mode) flashMode = selectedBoard.flash_mode;
            // flash_freq json'da yoksa varsayılan 80m kalsın, varsa onu al
            if (selectedBoard.flash_freq) flashFreq = selectedBoard.flash_freq;
            if (selectedBoard.boot_addr) bootloaderAddr = selectedBoard.boot_addr;
          }
        }
      } catch (e) {
        console.error("Error reading boards.json parameters:", e);
      }

      console.log(`Flashing ${modelFolder} -> Chip: ${targetChip}, Mode: ${flashMode}, BootAddr: ${bootloaderAddr}`);

      const bootloaderPath = path.join(firmwareDir, 'bootloader.bin');
      const partitionsPath = path.join(firmwareDir, 'partitions.bin');
      const bootAppPath = path.join(firmwareDir, 'boot_app0.bin');
      const firmwarePath = path.join(firmwareDir, 'firmware.bin');

      if (!fs.existsSync(bootloaderPath) || !fs.existsSync(firmwarePath)) {
        event.reply('flash-log', `Error: Firmware files not found for model ${modelFolder}\n`);
        event.reply('flash-complete', false);
        return;
      }

      const args = [
        '--chip', targetChip,
        '--port', port,
        '--baud', '460800',
        '--before', 'default_reset',
        '--after', 'hard_reset',
        'write_flash',
        '-z',
        '--flash_mode', flashMode,
        '--flash_freq', flashFreq,
        '--flash_size', 'detect',
        bootloaderAddr, bootloaderPath,
        '0x8000', partitionsPath,
        '0xe000', bootAppPath,
        '0x10000', firmwarePath
      ];

      event.reply('flash-log', `Starting flash for ${modelFolder} (${targetChip}) on ${port}...\n`);
      event.reply('flash-log', `Params: Mode=${flashMode}, BootAddr=${bootloaderAddr}\n`);
      event.reply('flash-log', `Command: esptool.exe ${args.join(' ')}\n\n`);

      const flasher = spawn(esptoolPath, args);

      flasher.stdout.on('data', (data) => {
        event.reply('flash-log', data.toString());
      });

      flasher.stderr.on('data', (data) => {
        event.reply('flash-log', data.toString());
      });

      flasher.on('close', (code) => {
        if (code === 0) {
          event.reply('flash-log', '\nFlash Complete Successfully!\n');
          event.reply('flash-complete', true);
        } else {
          event.reply('flash-log', `\nProcess exited with code ${code}\n`);
          event.reply('flash-complete', false);
        }
      });

      flasher.on('error', (err) => {
        event.reply('flash-log', `\nFailed to start esptool: ${err.message}\n`);
        event.reply('flash-complete', false);
      });
    });


    const pluginsDir = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'plugins');

    if (!fs.existsSync(pluginsDir)) {
      try { fs.mkdirSync(pluginsDir); } catch (e) { }
      return [];
    }

    try {
      const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
      const plugins = [];

      for (const entry of entries) {
        let fullPath = null;
        let basePath = null;

        if (entry.isDirectory()) {
          const p1 = path.join(pluginsDir, entry.name, 'plugin.json');
          const p2 = path.join(pluginsDir, entry.name, 'manifest.json');

          if (fs.existsSync(p1)) fullPath = p1;
          else if (fs.existsSync(p2)) fullPath = p2;

          if (fullPath) {
            basePath = path.join(pluginsDir, entry.name);
          }
        }
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          fullPath = path.join(pluginsDir, entry.name);
          basePath = pluginsDir;
        }

        if (fullPath && basePath) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const data = JSON.parse(raw);

            if (data.buttons && Array.isArray(data.buttons)) {
              data._basePath = basePath;

              const jsPath = path.join(basePath, 'plugin.js');
              if (fs.existsSync(jsPath)) {
                data._jsPath = `file:///${jsPath.replace(/\\/g, '/')}?v=${Date.now()}`;
                console.log(`Dinamik eklenti bulundu: ${data.meta.name}`);
              }

              plugins.push(data);
            }
          } catch (err) {
            console.error(`Plugin load error (${entry.name}):`, err);
          }
        }
      }
      return plugins;
    } catch (e) {
      console.error("Plugin scan error:", e);
      return [];
    }
  });

  // ============================================================================
  // PRESETS SYSTEM
  // ============================================================================
  
  // Get presets folder path (same level as plugins)
  const getPresetsPath = () => {
    return path.join(app.isPackaged ? process.resourcesPath : __dirname, 'presets');
  };

  // Scan presets folder
  ipcMain.handle('app:scanPresets', async () => {
    const presetsDir = getPresetsPath();

    if (!fs.existsSync(presetsDir)) {
      try {
        fs.mkdirSync(presetsDir, { recursive: true });
      } catch (e) {
        console.error("Could not create presets dir:", e);
        return [];
      }
    }

    try {
      const entries = fs.readdirSync(presetsDir, { withFileTypes: true });
      const presets = [];

      for (const entry of entries) {
        let fullPath = null;
        let basePath = null;

        if (entry.isDirectory()) {
          // Look for preset.json inside folder
          const p1 = path.join(presetsDir, entry.name, 'preset.json');
          
          if (fs.existsSync(p1)) {
            fullPath = p1;
            basePath = path.join(presetsDir, entry.name);
          }
        }
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          // Direct JSON file in presets folder
          fullPath = path.join(presetsDir, entry.name);
          basePath = presetsDir;
        }

        if (fullPath && basePath) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const data = JSON.parse(raw);

            if (data.buttons && Array.isArray(data.buttons)) {
              data._basePath = basePath;
              presets.push(data);
            }
          } catch (err) {
            console.error(`Preset load error (${entry.name}):`, err);
          }
        }
      }
      return presets;
    } catch (e) {
      console.error("Preset scan error:", e);
      return [];
    }
  });

  // Open presets folder in file explorer
  ipcMain.handle('app:openPresetsFolder', () => {
    const presetsDir = getPresetsPath();

    if (!fs.existsSync(presetsDir)) {
      try {
        fs.mkdirSync(presetsDir, { recursive: true });
      } catch (e) {
        console.error("Could not create presets dir:", e);
        return { success: false, error: e.message };
      }
    }

    safeOpenPath(presetsDir);
    return { success: true, path: presetsDir };
  });

  ipcMain.handle('system:getActiveWindowInfo', async () => {
    // 1. Try active-win first
    if (activeWin) {
      try {
        const result = await activeWin();
        if (result && (result.title || (result.owner && result.owner.name))) {
          return { 
            success: true, 
            title: result.title || "", 
            process: result.owner ? result.owner.name : "",
            processPath: result.owner ? result.owner.path : ""
          };
        }
      } catch (e) {
        // Fall through to native fallback
      }
    }

    // 2. Windows fallback using active_window.exe
    if (process.platform === 'win32') {
      try {
        const helperPath = path.join(getAssetPath(), 'tools', 'active_window.exe');
        if (fs.existsSync(helperPath)) {
          const { execFile } = require('child_process');
          const winInfo = await new Promise((resolve) => {
            execFile(helperPath, { timeout: 1000 }, (err, stdout) => {
              if (err || !stdout) return resolve(null);
              try {
                const parsed = JSON.parse(stdout.trim());
                resolve(parsed.success ? parsed : null);
              } catch {
                resolve(null);
              }
            });
          });

          if (winInfo && (winInfo.process || winInfo.title)) {
            return {
              success: true,
              title: winInfo.title || "",
              process: winInfo.process || "",
              processPath: winInfo.processPath || ""
            };
          }
        }
      } catch (e) {
        // Fall through
      }
    }

    return { success: false, title: "", error: "No active window detected" };
  });


  if (process.platform === 'win32') {
    app.setAppUserModelId("Smart Deck Notification");
  }


  ipcMain.handle('robot:keyTap', (event, key, modifiers) => {
    try {
      if (typeof key !== 'string' || key.length === 0) return { success: true };
      // Delay zaten başlangıçta 0 olarak ayarlandı
      if (modifiers && modifiers.length > 0) {
        robot.keyTap(key, modifiers);
      } else {
        robot.keyTap(key);
      }
      return { success: true };
    } catch (e) {
      console.error("RobotJS keyTap error:", e.message);
      return { success: false, error: e.message };
    }
  });

  // Key Toggle - Hold or release a key
  ipcMain.handle('robot:keyToggle', (event, key, downOrUp) => {
    try {
      if (typeof key !== 'string' || key.length === 0) return { success: true };
      robot.keyToggle(key, downOrUp);
      return { success: true };
    } catch (e) {
      console.error("RobotJS keyToggle error:", e.message);
      return { success: false, error: e.message };
    }
  });

  // SIMULATE TYPING - Harf harf yazar (görsel efekt, Unicode destekli)
  ipcMain.handle('robot:typeStringSimulated', async (event, text) => {
    try {
      if (typeof text !== 'string' || text.length === 0) {
        return { success: true };
      }
      
      // Windows/Unix line ending'leri normalize et
      const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      
      // Satır satır işle
      const lines = normalizedText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Her karakteri tek tek yaz (gerçekçi yazma efekti)
        for (const char of line) {
          robot.typeString(char);
          // 30-80ms arası rastgele gecikme (gerçek yazış hızı)
          await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
        }
        
        // Son satır değilse enter bas
        if (i < lines.length - 1) {
          await new Promise(r => setTimeout(r, 30));
          // Önce Escape - autocomplete/öneri kutusunu kapat
          robot.keyTap('escape');
          await new Promise(r => setTimeout(r, 20));
          // Sonra Enter
          robot.keyTap('enter');
          await new Promise(r => setTimeout(r, 50));
        }
      }
      
      return { success: true };
    } catch (e) {
      console.error("RobotJS typeStringSimulated error:", e.message);
      return { success: false, error: e.message };
    }
  });

  // NORMAL - Tek seferde yaz (hızlı, Unicode destekli)
  ipcMain.handle('robot:typeString', (event, text) => {
    try {
      if (typeof text !== 'string' || text.length === 0) {
        return { success: true };
      }
      
      // Windows/Unix line ending'leri normalize et
      const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      
      // Satır satır işle (\n için enter bas)
      const lines = normalizedText.split('\n');
      lines.forEach((line, index) => {
        if (line.length > 0) {
          robot.typeString(line);
        }
        // Son satır değilse enter bas
        if (index < lines.length - 1) {
          // Önce Escape - autocomplete/öneri kutusunu kapat
          robot.keyTap('escape');
          // Sonra Enter
          robot.keyTap('enter');
        }
      });
      
      return { success: true };
    } catch (e) {
      console.error("RobotJS typeString error:", e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('robot:getMousePos', () => {
    try {
      return { success: true, ...robot.getMousePos() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('robot:enterCaptureMode', () => {
    if (mainWindow) {
      originalBounds = mainWindow.getBounds();
      const displays = screen.getAllDisplays();
      let minX = 0, minY = 0, maxX = 0, maxY = 0;

      for (const display of displays) {
        const { x, y, width, height } = display.bounds;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + width > maxX) maxX = x + width;
        if (y + height > maxY) maxY = y + height;
      }

      const totalWidth = maxX - minX;
      const totalHeight = maxY - minY;

      mainWindow.setBounds({ x: minX, y: minY, width: totalWidth, height: totalHeight });
      mainWindow.setOpacity(0.01);
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  ipcMain.handle('robot:exitCaptureMode', () => {
    if (mainWindow) {
      if (originalBounds) mainWindow.setBounds(originalBounds);
      mainWindow.setOpacity(1.0);
      mainWindow.setAlwaysOnTop(false);
      mainWindow.focus();
      originalBounds = null;
    }
  });

  ipcMain.handle('robot:mouseMove', (event, x, y) => {
    try { robot.moveMouse(x, y); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('robot:mouseClick', (event, button, double) => {
    try { robot.mouseClick(button || 'left', double || false); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('robot:mouseToggle', (event, down, button) => {
    try { robot.mouseToggle(down || 'down', button || 'left'); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('robot:scroll', (event, amount) => {
    if (!robot) return { success: false, error: 'RobotJS not available' };
    try { robot.scrollMouse(0, amount); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  });

  // Scroll with modifier keys (e.g., ALT+SCROLL, CTRL+SCROLL)
  ipcMain.handle('robot:scrollWithModifiers', async (event, amount, modifiers) => {
    if (!robot) return { success: false, error: 'RobotJS not available' };
    
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    try {
      // Press modifier keys
      if (modifiers && modifiers.length > 0) {
        for (const mod of modifiers) {
          robot.keyToggle(mod, 'down');
        }
        // Wait for OS to register modifier key
        await sleep(30);
      }
      
      // Scroll
      robot.scrollMouse(0, amount);
      
      // Wait before releasing
      await sleep(30);
      
      // Release modifier keys
      if (modifiers && modifiers.length > 0) {
        for (const mod of modifiers) {
          robot.keyToggle(mod, 'up');
        }
      }
      
      return { success: true };
    } catch (e) {
      // Make sure to release keys on error
      if (modifiers && modifiers.length > 0) {
        for (const mod of modifiers) {
          try { robot.keyToggle(mod, 'up'); } catch (_) {}
        }
      }
      return { success: false, error: e.message };
    }
  });

  // Safe open path with Unicode support
  ipcMain.handle('app:openPath', async (event, filePath) => {
    try {
      const result = await safeOpenPath(filePath);
      return { success: result === '', path: filePath, error: result || null };
    } catch (e) {
      console.error('Error opening path:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('app:showNotification', (event, title, body) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: title, body: body, icon: iconPath, silent: true });
      notification.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      notification.show();
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      return { success: true };
    }
    return { success: false, error: 'Notifications not supported' };
  });

  app.on('before-quit', () => {
    debugLog('app before-quit event triggered, isQuitting=' + isQuitting);
    isQuitting = true;
  });

  app.on('will-quit', () => {
    debugLog('app will-quit event triggered');
  });

  app.on('quit', (e, code) => {
    debugLog('app quit event triggered with code=' + code);
  });

  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') {
      return true;
    }
    return false;
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
"default-src 'self' data: blob: https://api.iconify.design https://api.github.com https://geocoding-api.open-meteo.com https://api.open-meteo.com; img-src 'self' data: blob: file: https://api.iconify.design; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self' file: data: blob:"
        ]
      }
    });
  });

  createWindow();

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open',
      click: () => {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    },
    {
      label: 'Exit',
      click: () => {
        debugLog('Tray Exit clicked');
        app.quit();
      }
    }
  ]);
  tray.setToolTip('Smart Deck');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });

  autoUpdater.on('error', (err) => {
    debugLog('autoUpdater error: ' + (err?.message || err));
  });

  autoUpdater.on('update-not-available', () => {
    debugLog('autoUpdater update-not-available');
  });

  // Otomatik güncelleme kontrolü kapatıldı (stabilite)
  // setTimeout(() => {
  //   debugLog('Triggering autoUpdater.checkForUpdatesAndNotify()');
  //   autoUpdater.checkForUpdatesAndNotify().catch(e => debugLog('autoUpdater error caught: ' + e));
  // }, 3000);
});

// Her 4 SAATTE BİR periyodik kontrol yap
// setInterval(() => {
//   autoUpdater.checkForUpdatesAndNotify().catch(e => debugLog('autoUpdater error caught: ' + e));
// }, 1000 * 60 * 60 * 4);

app.on('window-all-closed', () => {
  debugLog('app window-all-closed event triggered');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});