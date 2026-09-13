const { contextBridge, shell, ipcRenderer } = require('electron');
const path = require('path');

/**
 * Normalize file path for Unicode support
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

// Wrap shell methods for Unicode path support
const safeShell = {
  openPath: (filePath) => {
    return shell.openPath(normalizePath(filePath));
  },
  openExternal: (url, options) => {
    return shell.openExternal(url, options);
  },
  showItemInFolder: (filePath) => {
    return shell.showItemInFolder(normalizePath(filePath));
  },
  beep: () => shell.beep()
};

try {
  contextBridge.exposeInMainWorld('electronAPI', {
    shell: safeShell,  // Use wrapped shell instead of direct shell
    path: path,

    system: {
      runCommand: (cmd) => ipcRenderer.invoke('app:runCommand', cmd),
      scanInstalledApps: () => ipcRenderer.invoke('app:scanInstalledApps'),
      getActiveWindowInfo: () => ipcRenderer.invoke('system:getActiveWindowInfo'),
      listSerialPorts: () => ipcRenderer.invoke('system:listSerialPorts')
    },

    app: {
      getVersion: () => ipcRenderer.invoke('app:getVersion'),
      // --- GÜNCELLEME İÇİN YENİ EKLENENLER ---
      onUpdateAvailable: (callback) => ipcRenderer.on('update_available', () => callback()),
      onUpdateDownloaded: (callback) => ipcRenderer.on('update_downloaded', () => callback()),
      restartAndInstall: () => ipcRenderer.send('app:restartAndInstall'),
      
      // Flasher Operations
      getFirmwareList: () => ipcRenderer.invoke('app:getFirmwareList'),
      flashFirmware: (port, model) => ipcRenderer.send('app:flashFirmware', port, model),
      onFlashLog: (callback) => ipcRenderer.on('flash-log', (event, text) => callback(text)),
      onFlashComplete: (callback) => ipcRenderer.on('flash-complete', (event, success) => callback(success)),
      removeAllFlashListeners: () => {
        ipcRenderer.removeAllListeners('flash-log');
        ipcRenderer.removeAllListeners('flash-complete');
      },

      // Other App Operations
      openPluginsFolder: () => ipcRenderer.invoke('app:openPluginsFolder'),
      getStartupStatus: () => ipcRenderer.invoke('app:getStartupStatus'),
      setStartupStatus: (flag) => ipcRenderer.invoke('app:setStartupStatus', flag),
      getAssetsPath: () => ipcRenderer.invoke('app:getAssetPath'),
      saveTempIcon: (base64) => ipcRenderer.invoke('app:saveTempIcon', base64),
      onCloseRequest: (callback) => ipcRenderer.on('app:request-close-action', (event, ...args) => callback(...args)),
      scanPlugins: () => ipcRenderer.invoke('app:scanPlugins'),
      sendCloseResponse: (data) => ipcRenderer.send('app:response-close-action', data),
      
      // Presets System
      scanPresets: () => ipcRenderer.invoke('app:scanPresets'),
      openPresetsFolder: () => ipcRenderer.invoke('app:openPresetsFolder'),
      
      // Safe path operations (Unicode support)
      openPath: (filePath) => ipcRenderer.invoke('app:openPath', filePath)
    },

    robot: {
      // Keyboard
      keyTap: (key, modifiers) => ipcRenderer.invoke('robot:keyTap', key, modifiers),
      keyToggle: (key, downOrUp) => ipcRenderer.invoke('robot:keyToggle', key, downOrUp),
      keyTapBurst: (key, modifiers, count) => ipcRenderer.invoke('robot:keyTapBurst', key, modifiers, count),
      typeString: (text) => ipcRenderer.invoke('robot:typeString', text),
      typeStringSimulated: (text) => ipcRenderer.invoke('robot:typeStringSimulated', text),

      // Mouse
      getMousePos: () => ipcRenderer.invoke('robot:getMousePos'),
      mouseMove: (x, y) => ipcRenderer.invoke('robot:mouseMove', x, y),
      mouseClick: (button, double) => ipcRenderer.invoke('robot:mouseClick', button, double),
      mouseToggle: (down, button) => ipcRenderer.invoke('robot:mouseToggle', down, button),
      scroll: (amount) => ipcRenderer.invoke('robot:scroll', amount),
      scrollWithModifiers: (amount, modifiers) => ipcRenderer.invoke('robot:scrollWithModifiers', amount, modifiers),

      // Screen Capture
      enterCaptureMode: () => ipcRenderer.invoke('robot:enterCaptureMode'),
      exitCaptureMode: () => ipcRenderer.invoke('robot:exitCaptureMode')
    },

    showNotification: (title, body) => ipcRenderer.invoke('app:showNotification', title, body)
  });

  console.log('Preload script loaded successfully!');

} catch (error) {
  console.error('Error in preload script:', error);
}