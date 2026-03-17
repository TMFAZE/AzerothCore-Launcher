const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),

  // Authentication
  login: (credentials) => ipcRenderer.invoke('login', credentials),
  register: (userData) => ipcRenderer.invoke('register', userData),
  logout: () => ipcRenderer.invoke('logout'),
  checkAuth: () => ipcRenderer.invoke('check-auth'),
  
  // Credential management
  saveCredentials: (credentials) => ipcRenderer.invoke('save-credentials', credentials),
  getSavedCredentials: () => ipcRenderer.invoke('get-saved-credentials'),
  clearSavedCredentials: () => ipcRenderer.invoke('clear-saved-credentials'),

  // Game data
  getCharacters: () => ipcRenderer.invoke('get-characters'),
  getCharacterDetails: (guid) => ipcRenderer.invoke('get-character-details', guid),
  getNews: () => ipcRenderer.invoke('get-news'),
  
  // Game updates
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  downloadUpdate: (updateInfo) => ipcRenderer.invoke('download-update', updateInfo),
  
  // Launcher auto-updates
  checkLauncherUpdates: () => ipcRenderer.invoke('check-launcher-updates'),
  downloadLauncherUpdate: () => ipcRenderer.invoke('download-launcher-update'),
  installLauncherUpdate: () => ipcRenderer.invoke('install-launcher-update'),
  getLauncherVersion: () => ipcRenderer.invoke('get-launcher-version'),
  
  // Game launcher
  launchGame: (launchData) => ipcRenderer.invoke('launch-game', launchData),
  
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  browseGamePath: () => ipcRenderer.invoke('browse-game-path'),
  updateRealmlist: (gamePath) => ipcRenderer.invoke('update-realmlist', gamePath),
  
  // Event listeners for game updates
  onRealmStatusUpdate: (callback) => {
    ipcRenderer.on('realm-status-update', (event, data) => callback(data));
  },
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, info) => callback(info));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.on('update-progress', (event, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', (event, info) => callback(info));
  },
  
  // Event listeners for launcher auto-updates
  onLauncherUpdateStatus: (callback) => {
    ipcRenderer.on('launcher-update-status', (event, data) => callback(data));
  },
  onLauncherUpdateAvailable: (callback) => {
    ipcRenderer.on('launcher-update-available', (event, info) => callback(info));
  },
  onLauncherUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('launcher-update-download-progress', (event, progress) => callback(progress));
  },
  onLauncherUpdateDownloaded: (callback) => {
    ipcRenderer.on('launcher-update-downloaded', (event, info) => callback(info));
  },
  onLauncherUpdateError: (callback) => {
    ipcRenderer.on('launcher-update-error', (event, error) => callback(error));
  },
  
  // Remove listeners
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // Config
  getConfig: () => ipcRenderer.invoke('get-config')
});
