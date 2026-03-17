/**
 * Execution Policy Bypass Auto-Updater - Enhanced Error Handling
 * Uses PowerShell bypass techniques to run executable updates
 */

const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const https = require('https');
const http = require('http');
const semver = require('semver');

class ExecutionPolicyBypassUpdater {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        const baseUrl = process.env.UPDATE_SERVER_URL || 'http://localhost:3001';
        this.updateServer = `${baseUrl}/updates`;
        this.currentVersion = app.getVersion();
        this.updateDownloaded = false;
        this.updatePath = null;
        
        console.log(`🔄 Execution policy bypass updater initialized (v${this.currentVersion})`);
    }
    
    async checkForUpdates(showNoUpdate = false) {
        try {
            console.log('🔍 Checking for updates...');
            
            const updateInfo = await this.fetchUpdateInfo();
            
            if (!updateInfo) {
                throw new Error('Failed to fetch update information');
            }
            
            console.log(`📋 Server version: ${updateInfo.version}`);
            
            if (semver.gt(updateInfo.version, this.currentVersion)) {
                console.log('✨ Update available!');
                this.showUpdateAvailable(updateInfo);
                return true;
            } else {
                console.log('✅ No update available');
                if (showNoUpdate) {
                    this.showNoUpdateDialog();
                }
                return false;
            }
            
        } catch (error) {
            console.error('❌ Update check failed:', error);
            if (showNoUpdate) {
                this.showUpdateError(error);
            }
            return false;
        }
    }
    
    async fetchUpdateInfo() {
        return new Promise((resolve, reject) => {
            const url = `${this.updateServer}/latest.json`;
            const client = url.startsWith('https:') ? https : http;
            
            console.log(`📡 Fetching from: ${url}`);
            
            const request = client.get(url, (response) => {
                let data = '';
                
                // Check status code
                if (response.statusCode !== 200) {
                    reject(new Error(`Server returned ${response.statusCode}: ${response.statusMessage}`));
                    return;
                }
                
                // Check content type
                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
                    console.warn(`⚠️ Unexpected content type: ${contentType}`);
                }
                
                response.on('data', (chunk) => {
                    data += chunk;
                });
                
                response.on('end', () => {
                    try {
                        console.log(`📥 Raw response: ${data.substring(0, 200)}...`);
                        
                        if (!data.trim()) {
                            reject(new Error('Empty response from server'));
                            return;
                        }
                        
                        const updateInfo = JSON.parse(data);
                        
                        // Validate required fields
                        if (!updateInfo.version) {
                            reject(new Error('Invalid response: missing version field'));
                            return;
                        }
                        
                        console.log('✅ Valid JSON response received');
                        resolve(updateInfo);
                    } catch (parseError) {
                        console.error('❌ JSON Parse Error:', parseError);
                        console.error('❌ Raw data:', data);
                        reject(new Error(`Invalid JSON response: ${parseError.message}`));
                    }
                });
            });
            
            request.on('error', (error) => {
                console.error('❌ Network Error:', error);
                if (error.code === 'ECONNREFUSED') {
                    reject(new Error('Update server is not running. Please contact support.'));
                } else if (error.code === 'ENOTFOUND') {
                    reject(new Error('Cannot reach update server. Check your internet connection.'));
                } else {
                    reject(new Error(`Network error: ${error.message}`));
                }
            });
            
            request.setTimeout(15000, () => {
                request.abort();
                reject(new Error('Request timeout. Please try again.'));
            });
        });
    }
    
    async downloadUpdate(updateInfo) {
        try {
            console.log('📥 Starting update download...');
            
            const downloadUrl = updateInfo.downloadUrl || `${this.updateServer}/WoW-Launcher-Setup-${updateInfo.version}.exe`;
            const fileName = `WoW-Launcher-Update-${updateInfo.version}.exe`;
            
            // Use a specific temp directory that has fewer restrictions
            const tempDir = path.join(process.env.USERPROFILE || process.env.HOMEPATH, 'Downloads', 'WoWLauncherUpdates');
            
            // Ensure temp directory exists
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            
            const downloadPath = path.join(tempDir, fileName);
            
            // Remove existing file if it exists
            if (fs.existsSync(downloadPath)) {
                fs.unlinkSync(downloadPath);
            }
            
            await this.downloadFile(downloadUrl, downloadPath, (progress) => {
                this.updateDownloadProgress(progress);
            });
            
            console.log('✅ Update downloaded successfully');
            this.updatePath = downloadPath;
            this.updateDownloaded = true;
            
            this.showUpdateReady(updateInfo);
            
        } catch (error) {
            console.error('❌ Download failed:', error);
            this.showUpdateError(error);
        }
    }
    
    async downloadFile(url, filePath, progressCallback) {
        return new Promise((resolve, reject) => {
            console.log(`📥 Downloading: ${url}`);
            
            const client = url.startsWith('https:') ? https : http;
            
            const request = client.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                    return;
                }
                
                const fileSize = parseInt(response.headers['content-length']) || 0;
                let downloadedSize = 0;
                
                const fileStream = fs.createWriteStream(filePath);
                
                response.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    
                    if (fileSize > 0 && progressCallback) {
                        const progress = {
                            percent: (downloadedSize / fileSize) * 100,
                            transferred: downloadedSize,
                            total: fileSize
                        };
                        progressCallback(progress);
                    }
                });
                
                response.pipe(fileStream);
                
                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log('✅ Download completed');
                    resolve();
                });
                
                fileStream.on('error', (error) => {
                    fs.unlink(filePath, () => {}); // Clean up
                    reject(error);
                });
            });
            
            request.on('error', (error) => {
                console.error('❌ Download request error:', error);
                reject(error);
            });
            
            request.setTimeout(60000, () => {
                request.abort();
                reject(new Error('Download timeout'));
            });
        });
    }
    
    async installUpdate() {
        if (!this.updateDownloaded || !this.updatePath) {
            throw new Error('No update available to install');
        }
        
        try {
            console.log('🔧 Installing update using execution policy bypass...');
            console.log(`📁 Update file path: ${this.updatePath}`);
            
            // Verify file exists before attempting to install
            if (!fs.existsSync(this.updatePath)) {
                throw new Error(`Update file not found: ${this.updatePath}`);
            }
            
            const stats = fs.statSync(this.updatePath);
            console.log(`📊 Update file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            
            // Try multiple bypass methods in order of preference
            const methods = [
                'powershellBypass',
                'cmdDirect',
                'batchWrapper',
                'shellExecute',
                'processSpawn'
            ];
            
            for (const method of methods) {
                try {
                    console.log(`🔧 Attempting installation method: ${method}`);
                    await this.executeUpdateWithMethod(method);
                    console.log(`✅ Update installation successful with method: ${method}`);
                    return;
                } catch (error) {
                    console.warn(`⚠️ Method ${method} failed:`, error.message);
                    continue;
                }
            }
            
            // If all methods fail, show manual instruction
            this.showManualInstallInstructions();
            
        } catch (error) {
            console.error('❌ All installation methods failed:', error);
            this.showUpdateError(error);
        }
    }
    
    async executeUpdateWithMethod(method) {
        const updateFile = this.updatePath;
        
        switch (method) {
            case 'powershellBypass':
                return await this.powershellBypassExecution(updateFile);
                
            case 'cmdDirect':
                return await this.cmdDirectExecution(updateFile);
                
            case 'batchWrapper':
                return await this.batchWrapperExecution(updateFile);
                
            case 'shellExecute':
                return await this.shellExecuteMethod(updateFile);
                
            case 'processSpawn':
                return await this.processSpawnMethod(updateFile);
                
            default:
                throw new Error(`Unknown method: ${method}`);
        }
    }
    
    async powershellBypassExecution(updateFile) {
        return new Promise((resolve, reject) => {
            // Create a delayed update script that runs after the app closes
            const tempDir = path.dirname(updateFile);
            const batchFile = path.join(tempDir, 'update-launcher.bat');
            
            // Create batch script that waits for app to close, then runs installer
            const batchContent = `@echo off
echo Starting WoW Launcher Update...
echo Waiting for launcher to close...
timeout /t 3 /nobreak
echo Installing update from: "${updateFile}"
"${updateFile}" /S /FORCE /CLOSEAPPLICATIONS
if %ERRORLEVEL% EQU 0 (
    echo Update completed successfully
    del "${updateFile}"
    del "%~f0"
) else (
    echo Update failed with exit code %ERRORLEVEL%
    pause
)
`;
            
            try {
                // Write the batch file
                fs.writeFileSync(batchFile, batchContent);
                console.log(`✅ Created update batch script: ${batchFile}`);
                
                // Run the batch file in a detached process
                const updateProcess = spawn('cmd.exe', ['/c', batchFile], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false
                });
                
                updateProcess.unref(); // Allow process to continue after parent exits
                
                console.log('✅ Update script launched, closing launcher...');
                
                // Close the app immediately to free up files
                setTimeout(() => {
                    console.log('🔄 Exiting launcher for update...');
                    app.exit(0);
                }, 1000);
                
                resolve();
                
            } catch (error) {
                reject(new Error(`Failed to create update script: ${error.message}`));
            }
        });
    }
    
    async cmdDirectExecution(updateFile) {
        return new Promise((resolve, reject) => {
            // Method 2: Use the same delayed batch approach
            return this.powershellBypassExecution(updateFile)
                .then(resolve)
                .catch(reject);
        });
    }
    
    async batchWrapperExecution(updateFile) {
        return new Promise((resolve, reject) => {
            // Method 3: Use the same delayed batch approach
            return this.powershellBypassExecution(updateFile)
                .then(resolve)
                .catch(reject);
        });
    }
    
    async shellExecuteMethod(updateFile) {
        return new Promise((resolve, reject) => {
            // Method 4: Use the same delayed batch approach
            return this.powershellBypassExecution(updateFile)
                .then(resolve)
                .catch(reject);
        });
    }
    
    async processSpawnMethod(updateFile) {
        return new Promise((resolve, reject) => {
            // Method 5: Use the same delayed batch approach
            return this.powershellBypassExecution(updateFile)
                .then(resolve)
                .catch(reject);
        });
    }
    
    showManualInstallInstructions() {
        const response = dialog.showMessageBoxSync(this.mainWindow, {
            type: 'warning',
            title: 'Manual Installation Required',
            message: 'Automatic installation failed due to security restrictions.',
            detail: `The update has been downloaded to:\n${this.updatePath}\n\n` +
                   `To complete the update:\n` +
                   `1. Close this launcher\n` +
                   `2. Navigate to the download location\n` +
                   `3. Right-click the installer and select "Run as administrator"\n` +
                   `4. Follow the installation prompts\n` +
                   `5. Restart the launcher`,
            buttons: ['Open Download Folder', 'Close Launcher', 'Cancel'],
            defaultId: 0
        });
        
        switch (response) {
            case 0: // Open Download Folder
                shell.showItemInFolder(this.updatePath);
                break;
            case 1: // Close Launcher
                app.quit();
                break;
            case 2: // Cancel
                break;
        }
    }
    
    startPeriodicCheck() {
        // Check for updates on startup (after 10 seconds)
        setTimeout(() => {
            this.checkForUpdates(false);
        }, 10000);
        
        // Check every 4 hours
        setInterval(() => {
            this.checkForUpdates(false);
        }, 4 * 60 * 60 * 1000);
        
        console.log('✅ Periodic update checking started');
    }
    
    // UI Methods
    showUpdateAvailable(updateInfo) {
        const response = dialog.showMessageBoxSync(this.mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `WoW Launcher ${updateInfo.version} is available!`,
            detail: `Current version: ${this.currentVersion}\n\n` +
                   `This update uses advanced bypass techniques to avoid\n` +
                   `Windows execution policy restrictions.`,
            buttons: ['Download Now', 'Later', 'Release Notes'],
            defaultId: 0,
            cancelId: 1
        });
        
        switch (response) {
            case 0: // Download Now
                this.downloadUpdate(updateInfo);
                break;
            case 1: // Later
                break;
            case 2: // Release Notes
                if (updateInfo.releaseNotes) {
                    shell.openExternal(updateInfo.releaseNotes);
                }
                break;
        }
    }
    
    showUpdateReady(updateInfo) {
        const response = dialog.showMessageBoxSync(this.mainWindow, {
            type: 'info',
            title: 'Update Ready to Install',
            message: `Version ${updateInfo.version} has been downloaded.`,
            detail: `The installer will attempt to bypass Windows security\n` +
                   `restrictions automatically. The application will restart\n` +
                   `to complete the update.`,
            buttons: ['Install Now', 'Install Later'],
            defaultId: 0,
            cancelId: 1
        });
        
        if (response === 0) {
            this.installUpdate();
        }
    }
    
    showNoUpdateDialog() {
        dialog.showMessageBoxSync(this.mainWindow, {
            type: 'info',
            title: 'No Updates Available',
            message: 'You are running the latest version.',
            detail: `Current version: ${this.currentVersion}`,
            buttons: ['OK']
        });
    }
    
    showUpdateError(error) {
        let errorMessage = error.message || 'Unknown error occurred';
        let detailMessage = '';
        
        // Provide helpful error messages based on error type
        if (errorMessage.includes('ECONNREFUSED')) {
            detailMessage = 'The update server appears to be offline.\nPlease try again later or contact support.';
        } else if (errorMessage.includes('ENOTFOUND')) {
            detailMessage = 'Cannot reach the update server.\nPlease check your internet connection.';
        } else if (errorMessage.includes('Invalid JSON')) {
            detailMessage = 'The update server returned an invalid response.\nThis may be a temporary server issue.';
        } else if (errorMessage.includes('timeout')) {
            detailMessage = 'The request timed out.\nPlease check your internet connection and try again.';
        } else {
            detailMessage = 'Please try again later or contact support if the problem persists.';
        }
        
        dialog.showErrorBox('Update Error', 
            `Failed to update: ${errorMessage}\n\n${detailMessage}`);
    }
    
    updateDownloadProgress(progress) {
        console.log(`📥 Download progress: ${Math.round(progress.percent)}%`);
        
        if (this.mainWindow && this.mainWindow.webContents) {
            this.mainWindow.webContents.send('launcher-update-download-progress', {
                percent: Math.round(progress.percent),
                bytesPerSecond: 0,
                transferred: progress.transferred,
                total: progress.total
            });
        }
    }
}

module.exports = ExecutionPolicyBypassUpdater;