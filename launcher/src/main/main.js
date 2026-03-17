require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const ExecutionPolicyBypassUpdater = require('./execution-bypass-updater'); // NEW: Replace electron-updater
const Store = require('electron-store');
const axios = require('axios');
const extract = require('extract-zip');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');

// Initialize store for persistent data
const store = new Store();

// Encryption configuration for credential storage
const ENCRYPTION_KEY = crypto.scryptSync('WoW-Launcher-2024-Secret-Key', 'salt', 32);
const ALGORITHM = 'aes-256-cbc';

// Update system configuration - Using execution policy bypass
const UPDATE_SERVER_URL = process.env.UPDATE_SERVER_URL || 'http://localhost:3001';
const isDev = process.argv.includes('--dev');

// Initialize execution policy bypass updater
let executionBypassUpdater;

// Enhanced credential encryption using CBC mode for compatibility
function encryptCredentials(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt credentials');
  }
}

// Enhanced credential decryption with compatibility
function decryptCredentials(encryptedText) {
  try {
    if (!encryptedText || typeof encryptedText !== 'string') {
      return null;
    }
    
    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      // Handle legacy format
      return decryptCredentialsLegacy(encryptedText);
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedData = parts[1];
    
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption failed:', error);
    return null;
  }
}

// Legacy decryption for backward compatibility
function decryptCredentialsLegacy(encryptedText) {
  try {
    const textParts = encryptedText.split(':');
    if (textParts.length < 2) return null;
    
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedData = textParts.join(':');
    
    const decipher = crypto.createDecipher('aes-256-cbc', 'WoW-Launcher-2024-Secret-Key-32B');
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Legacy decryption failed:', error);
    return null;
  }
}

// Server configuration
const API_BASE_URL = process.env.API_URL || `${UPDATE_SERVER_URL}/api`;
const REALM_CHECK_INTERVAL = 30000; // 30 seconds
const WOW_SERVER_IP = process.env.WOW_SERVER_IP || 'localhost';
const WOW_SERVER_PORT = parseInt(process.env.WOW_SERVER_PORT) || 8085;

// Application state
let mainWindow;
let realmStatusInterval;
let isShuttingDown = false;

// Request timeout and retry configuration
const REQUEST_TIMEOUT = 10000; // 10 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: false,
    backgroundColor: '#1a1a1a',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    show: false // Hide window initially to prevent flickering
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    cleanup();
  });
  
  mainWindow.on('unresponsive', () => {
    console.warn('Main window became unresponsive');
  });
  
  mainWindow.on('responsive', () => {
    console.log('Main window became responsive again');
  });

  // Start checking realm status
  checkRealmStatus();
  realmStatusInterval = setInterval(checkRealmStatus, REALM_CHECK_INTERVAL);
  
  // Show window once DOM is ready to prevent flickering
  mainWindow.webContents.once('dom-ready', () => {
    mainWindow.show();
    
    if (!isDev) {
      executionBypassUpdater = new ExecutionPolicyBypassUpdater(mainWindow);
      executionBypassUpdater.startPeriodicCheck();
      console.log('🚀 Execution Policy Bypass Updater ready!');
    } else {
      console.log('📝 Development mode - updates disabled');
    }
  });
}

// Enhanced realm status checking with retry logic
async function checkRealmStatus() {
  if (isShuttingDown || !mainWindow) return;
  
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      const response = await axios.get(`${API_BASE_URL}/realm/status`, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': 'WoW-Launcher/1.0' }
      });
      
      if (mainWindow && !isShuttingDown) {
        mainWindow.webContents.send('realm-status-update', {
          ...response.data,
          timestamp: Date.now()
        });
      }
      return; // Success, exit retry loop
      
    } catch (error) {
      retries++;
      console.warn(`Realm status check failed (attempt ${retries}/${MAX_RETRIES}):`, error.message);
      
      if (retries >= MAX_RETRIES) {
        if (mainWindow && !isShuttingDown) {
          mainWindow.webContents.send('realm-status-update', { 
            online: false, 
            error: error.message,
            timestamp: Date.now(),
            retries: retries
          });
        }
        break;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * retries));
    }
  }
}

// Application cleanup function
function cleanup() {
  isShuttingDown = true;
  
  if (realmStatusInterval) {
    clearInterval(realmStatusInterval);
    realmStatusInterval = null;
  }
  
  if (executionBypassUpdater) {
    executionBypassUpdater = null;
  }
  
  mainWindow = null;
  console.log('Application cleanup completed');
}

// NEW: Execution policy bypass updater functions
async function checkForLauncherUpdates() {
  try {
    if (!executionBypassUpdater) {
      console.log('Updater not initialized');
      return;
    }
    console.log('🔍 Checking for launcher updates...');
    await executionBypassUpdater.checkForUpdates(false);
  } catch (error) {
    console.error('Error checking for updates:', error);
  }
}

// NEW: Updated IPC Handlers for Execution Policy Bypass Updates
ipcMain.handle('check-launcher-updates', async () => {
  try {
    if (isDev) {
      return { success: false, message: 'Updates disabled in development mode' };
    }
    
    if (!executionBypassUpdater) {
      return { success: false, message: 'Updater not initialized' };
    }
    
    const hasUpdate = await executionBypassUpdater.checkForUpdates(true);
    return { success: true, message: hasUpdate ? 'Update available!' : 'No updates available' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-launcher-update', async (event, updateInfo) => {
  try {
    if (isDev) {
      return { success: false, message: 'Updates disabled in development mode' };
    }
    
    if (!executionBypassUpdater) {
      return { success: false, message: 'Updater not initialized' };
    }
    
    await executionBypassUpdater.downloadUpdate(updateInfo);
    return { success: true, message: 'Download started...' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('install-launcher-update', async () => {
  try {
    if (isDev) {
      return { success: false, message: 'Updates disabled in development mode' };
    }
    
    if (!executionBypassUpdater) {
      return { success: false, message: 'Updater not initialized' };
    }
    
    await executionBypassUpdater.installUpdate();
    return { success: true, message: 'Installing update...' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-launcher-version', async () => {
  return {
    current: app.getVersion(),
    isDev: isDev,
    updateSystem: 'Execution Policy Bypass' // NEW: Indicate which update system is used
  };
});

ipcMain.handle('get-config', () => {
  return { apiBaseUrl: API_BASE_URL };
});

// NEW: Simplified update status events (compatible with existing renderer)
function sendUpdateStatus(type, message, data = {}) {
  if (mainWindow) {
    mainWindow.webContents.send('launcher-update-status', {
      type: type,
      message: message,
      ...data
    });
  }
}

// NEW: Send update events in compatible format
if (!isDev) {
  // Simulate the electron-updater events for compatibility
  setTimeout(() => {
    sendUpdateStatus('checking', 'Execution Policy Bypass Updater ready');
  }, 5000);
}

// Window controls
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// Enhanced authentication with retry logic and better error handling
ipcMain.handle('login', async (event, credentials) => {
  let retries = 0;
  
  while (retries < MAX_RETRIES) {
    try {
      const response = await axios.post(`${API_BASE_URL}/auth/login`, credentials, {
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': 'WoW-Launcher/1.0' }
      });
      
      store.set('authToken', response.data.token);
      store.set('username', credentials.username);
      return { success: true, data: response.data };
      
    } catch (error) {
      retries++;
      
      // Handle specific error types
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;
        
        // Don't retry for client errors (400-499)
        if (status >= 400 && status < 500) {
          return { 
            success: false, 
            error: errorData?.error || errorData?.message || 'Authentication failed',
            code: errorData?.code || 'AUTH_FAILED',
            status: status
          };
        }
        
        // Retry for server errors (500+) or network issues
        if (retries >= MAX_RETRIES) {
          return { 
            success: false, 
            error: 'Server temporarily unavailable. Please try again.',
            code: 'SERVER_ERROR',
            status: status
          };
        }
      } else {
        // Network or timeout error
        if (retries >= MAX_RETRIES) {
          return { 
            success: false, 
            error: 'Connection failed. Please check your internet connection.',
            code: 'NETWORK_ERROR'
          };
        }
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * retries));
    }
  }
});

ipcMain.handle('register', async (event, userData) => {
  try {
    const response = await axios.post(`${API_BASE_URL}/auth/register`, userData, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'User-Agent': 'WoW-Launcher/1.0' }
    });
    return { success: true, data: response.data };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      return { 
        success: false, 
        error: errorData?.error || errorData?.message || 'Registration failed',
        code: errorData?.code || 'REGISTER_FAILED',
        status: status
      };
    }
    
    return { 
      success: false, 
      error: 'Connection failed. Please check your internet connection.',
      code: 'NETWORK_ERROR'
    };
  }
});

ipcMain.handle('logout', async () => {
  try {
    // Clear stored credentials
    store.delete('authToken');
    store.delete('username');
    
    // Optional: Notify server of logout (fire and forget)
    const token = store.get('authToken');
    if (token) {
      axios.post(`${API_BASE_URL}/auth/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 3000
      }).catch(() => {/* Ignore errors */});
    }
    
    return { success: true };
  } catch (error) {
    // Even if something fails, we still want to clear local data
    store.delete('authToken');
    store.delete('username');
    return { success: true };
  }
});

ipcMain.handle('check-auth', async () => {
  const token = store.get('authToken');
  const username = store.get('username');
  if (token && username) {
    try {
      const response = await axios.get(`${API_BASE_URL}/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return { authenticated: true, username, data: response.data };
    } catch (error) {
      store.delete('authToken');
      store.delete('username');
      return { authenticated: false };
    }
  }
  return { authenticated: false };
});

// Credential management
ipcMain.handle('save-credentials', async (event, credentials) => {
  try {
    const credentialsString = JSON.stringify(credentials);
    const encrypted = encryptCredentials(credentialsString);
    store.set('savedCredentials', encrypted);
    return { success: true };
  } catch (error) {
    console.error('Failed to save credentials:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-saved-credentials', async () => {
  try {
    const encrypted = store.get('savedCredentials');
    if (!encrypted) {
      return null;
    }
    
    const decrypted = decryptCredentials(encrypted);
    if (!decrypted) {
      store.delete('savedCredentials');
      return null;
    }
    
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Failed to get saved credentials:', error);
    store.delete('savedCredentials');
    return null;
  }
});

ipcMain.handle('clear-saved-credentials', async () => {
  try {
    store.delete('savedCredentials');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Character data
ipcMain.handle('get-characters', async () => {
  const token = store.get('authToken');
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const response = await axios.get(`${API_BASE_URL}/characters`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.response?.data?.message || error.message };
  }
});

// Character details
ipcMain.handle('get-character-details', async (event, guid) => {
  const token = store.get('authToken');
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const response = await axios.get(`${API_BASE_URL}/characters/${guid}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.response?.data?.message || error.message };
  }
});


// News
ipcMain.handle('get-news', async () => {
  try {
    const response = await axios.get(`${API_BASE_URL}/news`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Game updates
ipcMain.handle('check-updates', async () => {
  try {
    const response = await axios.get(`${API_BASE_URL}/updates/check`);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('download-update', async (event, updateInfo) => {
  try {
    const gamePath = store.get('gamePath');
    if (!gamePath) {
      return { success: false, error: 'Game path not configured. Please set it in Settings.' };
    }

    const gameDir = path.dirname(gamePath);
    const dataDir = path.join(gameDir, 'Data');
    const tempDir = path.join(require('os').tmpdir(), 'wow-patch-temp');

    await fs.mkdir(tempDir, { recursive: true });

    mainWindow.webContents.send('update-progress', { 
      percent: 0, 
      transferred: '0 MB', 
      total: updateInfo.size || 'Unknown',
      status: 'Starting download...' 
    });

    const downloadUrl = `${API_BASE_URL.replace('/api', '')}${updateInfo.downloadUrl}`;
    const tempFilePath = path.join(tempDir, `patch-${updateInfo.id || Date.now()}.zip`);

    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      headers: {
        'Authorization': `Bearer ${store.get('authToken')}`
      }
    });

    const totalLength = parseInt(response.headers['content-length'] || '0');
    let downloadedLength = 0;

    const writer = createWriteStream(tempFilePath);
    const streamPipeline = promisify(pipeline);

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      const percent = totalLength > 0 ? (downloadedLength / totalLength) * 50 : 25;
      const transferredMB = (downloadedLength / (1024 * 1024)).toFixed(1);
      const totalMB = totalLength > 0 ? (totalLength / (1024 * 1024)).toFixed(1) : 'Unknown';
      
      mainWindow.webContents.send('update-progress', {
        percent: Math.round(percent),
        transferred: `${transferredMB} MB`,
        total: `${totalMB} MB`,
        status: 'Downloading patch...'
      });
    });

    await streamPipeline(response.data, writer);

    const stats = await fs.stat(tempFilePath);
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    mainWindow.webContents.send('update-progress', {
      percent: 60,
      transferred: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      total: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      status: 'Extracting patch...'
    });

    await fs.mkdir(dataDir, { recursive: true });

    let extractedFiles = 0;
    let totalFiles = 0;
    
    await extract(tempFilePath, {
      dir: dataDir,
      onEntry: (entry, zipfile) => {
        if (totalFiles === 0) {
          totalFiles = zipfile.entryCount || 1;
        }
        extractedFiles++;
        
        const extractPercent = 60 + (extractedFiles / totalFiles) * 35;
        mainWindow.webContents.send('update-progress', {
          percent: Math.round(extractPercent),
          transferred: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
          total: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
          status: `Extracting: ${entry.fileName || 'files...'}`
        });
      }
    });

    mainWindow.webContents.send('update-progress', {
      percent: 95,
      transferred: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      total: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      status: 'Cleaning up...'
    });

    try {
      await fs.unlink(tempFilePath);
      await fs.rmdir(tempDir);
    } catch (cleanupError) {
      console.log('Cleanup warning:', cleanupError.message);
    }

    if (updateInfo.version) {
      store.set('clientVersion', updateInfo.version);
    }

    mainWindow.webContents.send('update-progress', {
      percent: 100,
      transferred: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      total: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      status: 'Patch installed successfully!'
    });

    return { 
      success: true, 
      message: `Patch ${updateInfo.version || updateInfo.id} installed successfully to ${dataDir}` 
    };

  } catch (error) {
    console.error('Patch download/installation error:', error);
    
    try {
      const tempDir = path.join(require('os').tmpdir(), 'wow-patch-temp');
      await fs.rmdir(tempDir, { recursive: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }

    mainWindow.webContents.send('update-progress', {
      percent: 0,
      transferred: '0 MB',
      total: '0 MB',
      status: `Error: ${error.message}`
    });

    return { success: false, error: error.message };
  }
});

// Launch game
ipcMain.handle('launch-game', async (event, launchData) => {
  try {
    const gamePath = store.get('gamePath');
    if (!gamePath) {
      return { success: false, error: 'Game path not configured. Please set it in Settings.' };
    }
    
    const fs = require('fs');
    if (!fs.existsSync(gamePath)) {
      return { success: false, error: 'WoW.exe not found at the specified path.' };
    }
    
    const gameDir = path.dirname(gamePath);
    
    if (launchData && launchData.username && launchData.autoLogin) {
      await setupAutoLogin(gameDir, launchData.username);
    }
    
    const { spawn } = require('child_process');
    const gameProcess = spawn(gamePath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: gameDir
    });
    
    gameProcess.unref();
    
    return { success: true, message: 'Game launched successfully' };
  } catch (error) {
    console.error('Game launch error:', error);
    return { success: false, error: error.message };
  }
});

// Setup auto-login for WoW
async function setupAutoLogin(gameDir, username) {
  try {
    const wtfDir = path.join(gameDir, 'WTF');
    const configPath = path.join(wtfDir, 'Config.wtf');
    
    await fs.mkdir(wtfDir, { recursive: true });
    
    let configContent = '';
    try {
      configContent = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      configContent = '';
    }
    
    const lines = configContent.split('\n').filter(line => 
      !line.trim().startsWith('SET accountName') &&
      !line.trim().startsWith('SET gxWindow') &&
      !line.trim().startsWith('SET gxMaximize')
    );
    
    lines.push(`SET accountName "${username}"`);
    lines.push('SET gxWindow "1"');
    lines.push('SET gxMaximize "1"');
    
    const newConfigContent = lines.filter(line => line.trim()).join('\n') + '\n';
    await fs.writeFile(configPath, newConfigContent, 'utf8');
    
    console.log(`Auto-login configured for user: ${username}`);
    
    await setupAccountFolder(gameDir, username);
    
  } catch (error) {
    console.error('Failed to setup auto-login:', error);
    throw error;
  }
}

// Setup account-specific WTF folder
async function setupAccountFolder(gameDir, username) {
  try {
    const accountDir = path.join(gameDir, 'WTF', 'Account', username.toUpperCase());
    
    await fs.mkdir(accountDir, { recursive: true });
    
    const accountConfigPath = path.join(accountDir, 'macros-cache.txt');
    if (!require('fs').existsSync(accountConfigPath)) {
      await fs.writeFile(accountConfigPath, 'VER 3 0\n', 'utf8');
    }
    
    console.log(`Account folder configured: ${accountDir}`);
  } catch (error) {
    console.error('Failed to setup account folder:', error);
  }
}

// Settings
ipcMain.handle('get-settings', async () => {
  return {
    gamePath: store.get('gamePath', ''),
    autoUpdate: store.get('autoUpdate', true),
    launchOnStartup: store.get('launchOnStartup', false),
    autoCheckUpdates: store.get('autoCheckUpdates', true)
  };
});

ipcMain.handle('save-settings', async (event, settings) => {
  Object.keys(settings).forEach(key => {
    store.set(key, settings[key]);
  });
  return { success: true };
});

// Update realmlist.wtf
ipcMain.handle('update-realmlist', async (event, gamePath) => {
  try {
    const fs = require('fs').promises;
    const gameDir = path.dirname(gamePath);
    
    const possiblePaths = [
      path.join(gameDir, 'Data', 'enUS', 'realmlist.wtf'),
      path.join(gameDir, 'Data', 'enGB', 'realmlist.wtf'),
      path.join(gameDir, 'Data', 'realmlist.wtf'),
      path.join(gameDir, 'realmlist.wtf')
    ];
    
    const realmlistContent = `set realmlist ${WOW_SERVER_IP}`;
    let updated = false;
    
    for (const realmlistPath of possiblePaths) {
      try {
        await fs.mkdir(path.dirname(realmlistPath), { recursive: true });
        await fs.writeFile(realmlistPath, realmlistContent, 'utf8');
        console.log(`Updated realmlist at: ${realmlistPath}`);
        updated = true;
      } catch (err) {
        console.log(`Could not write to ${realmlistPath}:`, err.message);
      }
    }
    
    if (updated) {
      return { success: true, message: 'Realmlist updated successfully' };
    } else {
      return { success: false, error: 'Could not update realmlist.wtf' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Browse for game executable
ipcMain.handle('browse-game-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'WoW Executable', extensions: ['exe'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    defaultPath: 'C:\\Program Files (x86)\\World of Warcraft'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

// NEW: Handle app quit with pending updates
app.on('before-quit', (event) => {
  if (executionBypassUpdater && executionBypassUpdater.updateDownloaded) {
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      title: 'Update Ready',
      message: 'An update is ready to install.',
      detail: 'Would you like to install it now?',
      buttons: ['Install Now', 'Install Later'],
      defaultId: 0
    });
    
    if (response === 0) {
      event.preventDefault();
      executionBypassUpdater.installUpdate();
    }
  }
});

// Disable hardware acceleration to prevent GPU process crashes on Windows
app.disableHardwareAcceleration();

// App events
app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
