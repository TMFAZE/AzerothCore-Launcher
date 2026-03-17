// Main application logic
class LauncherApp {
    constructor() {
        this.currentView = 'login';
        this.isAuthenticated = false;
        this.userData = null;
        this.characters = [];
        this.news = [];
        this.apiBaseUrl = '';
        this.forceUpdatePending = false;

        this.init();
    }

    // Auto-login functionality
    async checkSavedCredentials() {
        try {
            const savedCreds = await window.api.getSavedCredentials();
            if (savedCreds && savedCreds.username && savedCreds.password) {
                // Show auto-login indicator
                this.showAutoLoginIndicator(savedCreds.username);
                
                // Attempt auto-login
                const result = await window.api.login({
                    username: savedCreds.username,
                    password: savedCreds.password,
                    autoLogin: true
                });
                
                if (result.success) {
                    this.isAuthenticated = true;
                    this.userData = result.data;
                    this.showAuthenticatedUI(savedCreds.username);
                    this.switchView('home');
                    await this.checkForceUpdate();
                    return true;
                } else {
                    // Auto-login failed, clear saved credentials
                    await window.api.clearSavedCredentials();
                    this.hideAutoLoginIndicator();
                }
            }
        } catch (error) {
            console.error('Auto-login failed:', error);
        }
        return false;
    }
    
    showAutoLoginIndicator(username) {
        const loginContainer = document.querySelector('.login-container');
        const indicator = document.createElement('div');
        indicator.id = 'auto-login-indicator';
        indicator.className = 'auto-login-indicator';
        indicator.innerHTML = `
            <div class="spinner"></div>
            Automatically logging in as ${username}...
        `;
        loginContainer.insertBefore(indicator, loginContainer.firstChild);
    }
    
    hideAutoLoginIndicator() {
        const indicator = document.getElementById('auto-login-indicator');
        if (indicator) {
            indicator.remove();
        }
    }
    
    async saveCredentials(username, password) {
        try {
            await window.api.saveCredentials({ username, password });
        } catch (error) {
            console.error('Failed to save credentials:', error);
        }
    }
    
    async clearSavedCredentials() {
        try {
            await window.api.clearSavedCredentials();
            document.getElementById('clear-saved-login').style.display = 'none';
            document.getElementById('remember-me').checked = false;
        } catch (error) {
            console.error('Failed to clear credentials:', error);
        }
    }

    async init() {
        // Load config from main process
        const config = await window.api.getConfig();
        this.apiBaseUrl = config.apiBaseUrl;

        // Setup event listeners
        this.setupWindowControls();
        this.setupNavigation();
        this.setupAuthForms();
        this.setupGameLauncher();
        this.setupSettings();
        this.setupUpdates();
        this.setupLauncherUpdates();
        this.setupCharacterDetail();
        this.setupShop();
        
        // Check for saved credentials and auto-login
        await this.checkSavedCredentials();
        
        // If no auto-login, check authentication status normally
        if (!this.isAuthenticated) {
            await this.checkAuthentication();
        }
        
        // Setup realm status listener
        window.api.onRealmStatusUpdate((status) => {
            this.updateRealmStatus(status);
        });
        
        // Setup game update listeners
        window.api.onUpdateAvailable((info) => {
            this.showUpdateAvailable(info);
        });
        
        window.api.onUpdateProgress((progress) => {
            this.updateDownloadProgress(progress);
        });
        
        window.api.onUpdateDownloaded((info) => {
            this.showUpdateReady(info);
        });
        
        // Load current launcher version
        this.loadLauncherVersion();
    }
    
    // Setup launcher update functionality
    setupLauncherUpdates() {
        // Manual update check button in settings
        const manualUpdateBtn = document.getElementById('manual-update-check');
        if (manualUpdateBtn) {
            manualUpdateBtn.addEventListener('click', async () => {
                this.performManualUpdateCheck();
            });
        }
    }
    
    async loadLauncherVersion() {
        try {
            const versionInfo = await window.api.getLauncherVersion();
            const versionSpan = document.getElementById('current-version');
            if (versionSpan) {
                let versionText = `v${versionInfo.current}`;
                if (versionInfo.isDev) {
                    versionText += ' (Development)';
                }
                versionSpan.textContent = versionText;
            }
        } catch (error) {
            console.error('Failed to load launcher version:', error);
        }
    }
    
    async performManualUpdateCheck() {
        const statusEl = document.getElementById('update-check-status');
        const checkBtn = document.getElementById('manual-update-check');
        
        // Show checking status
        statusEl.style.display = 'block';
        statusEl.className = 'update-status checking';
        statusEl.textContent = 'Checking for launcher updates...';
        checkBtn.disabled = true;
        checkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
        
        try {
            const result = await window.api.checkLauncherUpdates();
            
            if (result.success) {
                // Update check was initiated successfully
                // The actual results will be handled by the custom updater dialogs
                setTimeout(() => {
                    statusEl.className = 'update-status';
                    statusEl.textContent = 'Check complete. Updates handled by system dialogs.';
                }, 2000);
            } else {
                statusEl.className = 'update-status error';
                statusEl.textContent = `Error: ${result.error || result.message}`;
            }
        } catch (error) {
            statusEl.className = 'update-status error';
            statusEl.textContent = `Error checking for updates: ${error.message}`;
        } finally {
            checkBtn.disabled = false;
            checkBtn.innerHTML = '<i class="fas fa-sync"></i> Check Now';
            
            // Hide status after 5 seconds if no error
            if (!statusEl.classList.contains('error')) {
                setTimeout(() => {
                    statusEl.style.display = 'none';
                }, 5000);
            }
        }
    }
    
    async checkForSavedLogin() {
        try {
            const savedCreds = await window.api.getSavedCredentials();
            if (savedCreds && savedCreds.username) {
                // Pre-fill username and show clear button
                document.getElementById('username').value = savedCreds.username;
                document.getElementById('remember-me').checked = true;
                document.getElementById('clear-saved-login').style.display = 'block';
            }
        } catch (error) {
            console.error('Failed to check saved credentials:', error);
        }
    }

    // Window controls
    setupWindowControls() {
        document.getElementById('minimize-btn').addEventListener('click', () => {
            window.api.minimizeWindow();
        });

        document.getElementById('maximize-btn').addEventListener('click', () => {
            window.api.maximizeWindow();
        });

        document.getElementById('close-btn').addEventListener('click', () => {
            window.api.closeWindow();
        });
    }

    // Navigation
    setupNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                if (this.forceUpdatePending && e.currentTarget.dataset.view !== 'updates') return;
                const view = e.currentTarget.dataset.view;
                this.switchView(view);
            });
        });
    }

    switchView(viewName) {
        // Update active nav item
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
            if (item.dataset.view === viewName) {
                item.classList.add('active');
            }
        });

        // Hide all views
        document.querySelectorAll('.view').forEach(view => {
            view.style.display = 'none';
        });

        // Show selected view
        const viewElement = document.getElementById(`${viewName}-view`);
        if (viewElement) {
            viewElement.style.display = 'block';
            this.currentView = viewName;
            
            // Load view-specific data
            this.loadViewData(viewName);
        }
    }

    async loadViewData(viewName) {
        switch (viewName) {
            case 'home':
                await this.loadHomeData();
                break;
            case 'characters':
                await this.loadCharacters();
                break;
            case 'shop':
                await this.loadShopData();
                break;
            case 'news':
                await this.loadNews();
                break;
            case 'settings':
                await this.loadSettings();
                break;
            case 'updates':
                await this.checkForUpdates();
                break;
        }
    }

    // Authentication
    async checkAuthentication() {
        const result = await window.api.checkAuth();
        if (result.authenticated) {
            this.isAuthenticated = true;
            this.userData = result.data;
            this.showAuthenticatedUI(result.username);
            this.switchView('home');
            await this.checkForceUpdate();
        } else {
            this.showLoginUI();
        }
    }

    setupAuthForms() {
        // Check for saved credentials on form setup
        this.checkForSavedLogin();
        
        // Login form
        const loginForm = document.getElementById('login-form');
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const rememberMe = document.getElementById('remember-me').checked;
            
            this.showLoading(loginForm);
            
            const result = await window.api.login({ username, password });
            
            if (result.success) {
                this.isAuthenticated = true;
                this.userData = result.data;
                
                // Save credentials if remember me is checked
                if (rememberMe) {
                    await this.saveCredentials(username, password);
                }
                
                this.showAuthenticatedUI(username);
                this.switchView('home');
                await this.checkForceUpdate();
            } else {
                this.showError(loginForm, result.error || 'Login failed');
            }
            
            this.hideLoading(loginForm);
        });

        // Register form
        const registerForm = document.getElementById('register-form');
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const username = document.getElementById('reg-username').value;
            const email = document.getElementById('reg-email').value;
            const password = document.getElementById('reg-password').value;
            const passwordConfirm = document.getElementById('reg-password-confirm').value;
            
            if (password !== passwordConfirm) {
                this.showError(registerForm, 'Passwords do not match');
                return;
            }
            
            this.showLoading(registerForm);
            
            const result = await window.api.register({ username, email, password });
            
            if (result.success) {
                this.showSuccess(registerForm, 'Registration successful! Please login.');
                setTimeout(() => {
                    document.getElementById('show-login').click();
                }, 2000);
            } else {
                this.showError(registerForm, result.error || 'Registration failed');
            }
            
            this.hideLoading(registerForm);
        });

        // Switch between login and register
        document.getElementById('show-register').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-form').style.display = 'none';
            document.getElementById('register-form').style.display = 'block';
        });

        document.getElementById('show-login').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
        });
        
        // Clear saved login button
        document.getElementById('clear-saved-login').addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear your saved login?')) {
                await this.clearSavedCredentials();
                this.showSuccess(loginForm, 'Saved login credentials cleared');
            }
        });
    }

    showAuthenticatedUI(username) {
        // Hide login view
        document.getElementById('login-view').style.display = 'none';
        
        // Update user section in sidebar
        const userSection = document.getElementById('user-section');
        userSection.innerHTML = `
            <div class="user-info">
                <span class="username">${username}</span>
                <button class="logout-btn" id="logout-btn">Logout</button>
            </div>
        `;
        
        // Setup logout in sidebar
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                await window.api.logout();
                this.showLoginUI();
            });
        }
    }

    showLoginUI() {
        this.switchView('login');
        
        // Clear all user data
        this.clearUserData();
        
        // Reset navigation to show login as active
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Reset user section to show login prompt
        const userSection = document.getElementById('user-section');
        userSection.innerHTML = `
            <div class="login-prompt" id="login-prompt">
                <button class="btn btn-login" id="login-btn">
                    <span class="login-icon">👤</span> Login
                </button>
                <p class="login-text">Sign in to access your characters</p>
            </div>
        `;
        
        // Setup login button click handlers
        this.setupLoginButtons();
    }
    
    // Clear all user-related data
    clearUserData() {
        this.isAuthenticated = false;
        this.userData = null;
        this.characters = [];
        this.news = [];
        
        // Clear UI displays
        this.clearHomeData();
        this.clearCharactersData();
        this.clearNewsData();
        
        // Reset forms
        this.resetAuthForms();
        
        // Note: We don't clear saved credentials here on logout
        // Only clear them when user explicitly chooses to
    }
    
    // Clear home view data
    clearHomeData() {
        document.getElementById('username-display').textContent = 'Player';
        document.getElementById('total-characters').textContent = '0';
        document.getElementById('highest-level').textContent = '0';
        document.getElementById('total-playtime').textContent = '0h';
        
        const recentNewsList = document.getElementById('recent-news-list');
        if (recentNewsList) {
            recentNewsList.innerHTML = '';
        }
    }
    
    // Clear characters view data
    clearCharactersData() {
        const charactersGrid = document.getElementById('characters-grid');
        if (charactersGrid) {
            charactersGrid.innerHTML = '';
        }
    }
    
    // Clear news view data
    clearNewsData() {
        const newsList = document.getElementById('news-list');
        if (newsList) {
            newsList.innerHTML = '';
        }
    }
    
    // Reset authentication forms
    resetAuthForms() {
        const loginForm = document.getElementById('login-form');
        const registerForm = document.getElementById('register-form');
        
        if (loginForm) {
            loginForm.reset();
            this.removeMessages(loginForm);
            
            // Don't reset remember me checkbox or username if credentials are saved
            this.checkForSavedLogin();
        }
        
        if (registerForm) {
            registerForm.reset();
            registerForm.style.display = 'none';
            this.removeMessages(registerForm);
        }
        
        // Show login form by default
        if (loginForm) {
            loginForm.style.display = 'block';
        }
        
        // Hide auto-login indicator if visible
        this.hideAutoLoginIndicator();
    }
    
    // Setup login button handlers
    setupLoginButtons() {
        // Sidebar login button
        const sidebarLoginBtn = document.getElementById('login-btn');
        if (sidebarLoginBtn) {
            sidebarLoginBtn.addEventListener('click', () => {
                this.switchView('login');
            });
        }
        
        // Header login button
        const headerLoginBtn = document.getElementById('header-login-btn');
        if (headerLoginBtn) {
            headerLoginBtn.addEventListener('click', () => {
                this.switchView('login');
            });
        }
    }

    // Home view
    async loadHomeData() {
        // Update username display
        document.getElementById('username-display').textContent = this.userData?.username || 'Player';
        
        // Load characters for stats
        const charResult = await window.api.getCharacters();
        if (charResult.success) {
            this.characters = charResult.data;
            this.updateHomeStats();
        }
        
        // Load recent news
        const newsResult = await window.api.getNews();
        if (newsResult.success) {
            this.news = newsResult.data;
            this.displayRecentNews();
        }
    }

    updateHomeStats() {
        const totalChars = this.characters.length;
        const highestLevel = Math.max(...this.characters.map(c => c.level || 0), 0);
        const totalPlaytime = this.characters.reduce((sum, c) => sum + (c.totaltime || 0), 0);
        
        document.getElementById('total-characters').textContent = totalChars;
        document.getElementById('highest-level').textContent = highestLevel;
        document.getElementById('total-playtime').textContent = `${Math.floor(totalPlaytime / 3600)}h`;
    }

    displayRecentNews() {
        const container = document.getElementById('recent-news-list');
        const recentNews = this.news.slice(0, 3); // Show only 3 most recent
        
        container.innerHTML = recentNews.map(item => `
            <div class="news-item">
                <h3 class="news-title">${item.title}</h3>
                <p class="news-date">${new Date(item.date).toLocaleDateString()}</p>
                <p class="news-content">${item.summary || item.content.substring(0, 150) + '...'}</p>
            </div>
        `).join('');
    }

    // Characters view
    async loadCharacters() {
        const result = await window.api.getCharacters();
        if (result.success) {
            this.characters = result.data;
            this.displayCharacters();
        } else {
            this.showError(document.getElementById('characters-view'), result.error);
        }
    }

    displayCharacters() {
        const grid = document.getElementById('characters-grid');
        
        if (this.characters.length === 0) {
            grid.innerHTML = '<p>No characters found.</p>';
            return;
        }
        
        grid.innerHTML = this.characters.map(char => `
            <div class="character-card" data-guid="${char.guid}" onclick="app.showCharacterDetails(${char.guid})">
                <h3 class="character-name">${char.name}</h3>
                <p class="character-info">Level ${char.level} ${this.getRaceClass(char.race, char.class)}</p>
                <p class="character-info">Realm: ${char.realmName || 'Unknown'}</p>
                <p class="gear-score">Gear Score: ${char.gearScore || 0}</p>
                <div class="character-card-footer">
                    <span class="click-hint">Click for details</span>
                </div>
            </div>
        `).join('');
    }

    getRaceClass(raceId, classId) {
        // Map race and class IDs to names
        const races = {
            1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf',
            5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll',
            10: 'Blood Elf', 11: 'Draenei'
        };
        
        const classes = {
            1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue',
            5: 'Priest', 6: 'Death Knight', 7: 'Shaman', 8: 'Mage',
            9: 'Warlock', 11: 'Druid'
        };
        
        return `${races[raceId] || 'Unknown'} ${classes[classId] || 'Unknown'}`;
    }

    // News view
    async loadNews() {
        const result = await window.api.getNews();
        if (result.success) {
            this.news = result.data;
            this.displayNews();
        } else {
            this.showError(document.getElementById('news-view'), result.error);
        }
    }

    displayNews() {
        const list = document.getElementById('news-list');
        
        if (this.news.length === 0) {
            list.innerHTML = '<p>No news available.</p>';
            return;
        }
        
        list.innerHTML = this.news.map(item => `
            <div class="news-item">
                <h2 class="news-title">${item.title}</h2>
                <p class="news-date">${new Date(item.date).toLocaleDateString()}</p>
                <div class="news-content">${item.content}</div>
            </div>
        `).join('');
    }

    // Game launcher
    setupGameLauncher() {
        document.getElementById('play-button').addEventListener('click', async () => {
            const button = document.getElementById('play-button');
            button.disabled = true;
            button.innerHTML = '<div class="spinner"></div> Launching...';
            
            // Pass authentication data for auto-login to game
            const launchData = {
                username: this.userData?.username,
                authToken: this.userData?.authToken,
                autoLogin: true
            };
            
            const result = await window.api.launchGame(launchData);
            
            if (result.success) {
                // Show success message
                this.showSuccess(document.querySelector('.welcome-section'), 
                    'Game launched successfully! You should be automatically logged in.');
            } else {
                this.showError(document.querySelector('.welcome-section'), result.error);
            }
            
            setTimeout(() => {
                button.disabled = false;
                button.innerHTML = '<span class="play-icon">▶</span> PLAY';
            }, 3000);
        });
    }

    // Settings
    async loadSettings() {
        const settings = await window.api.getSettings();
        
        document.getElementById('game-path').value = settings.gamePath || '';
        document.getElementById('auto-update').checked = settings.autoUpdate;
        document.getElementById('launch-startup').checked = settings.launchOnStartup;
        
        // Load auto-check updates setting
        const autoCheckUpdates = document.getElementById('auto-check-updates');
        if (autoCheckUpdates) {
            autoCheckUpdates.checked = settings.autoCheckUpdates !== false; // default to true
        }
        
        // Load launcher version in settings
        this.loadLauncherVersion();
    }

    setupSettings() {
        // Browse for game path
        document.getElementById('browse-btn').addEventListener('click', async () => {
            const result = await window.api.browseGamePath();
            if (result.success) {
                document.getElementById('game-path').value = result.path;
            }
        });

        // Save settings
        document.getElementById('settings-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const settings = {
                gamePath: document.getElementById('game-path').value,
                autoUpdate: document.getElementById('auto-update').checked,
                launchOnStartup: document.getElementById('launch-startup').checked,
                autoCheckUpdates: document.getElementById('auto-check-updates').checked
            };
            
            const result = await window.api.saveSettings(settings);
            
            if (result.success) {
                this.showSuccess(e.target, 'Settings saved successfully');
                
                // Check if we need to update realmlist.wtf
                if (settings.gamePath) {
                    await this.updateRealmlist(settings.gamePath);
                }
            } else {
                this.showError(e.target, 'Failed to save settings');
            }
        });
    }
    
    // Update realmlist.wtf file
    async updateRealmlist(gamePath) {
        try {
            const result = await window.api.updateRealmlist(gamePath);
            if (result.success) {
                console.log('Realmlist updated successfully');
            } else {
                console.error('Failed to update realmlist:', result.error);
            }
        } catch (error) {
            console.error('Failed to update realmlist:', error);
        }
    }

    // Updates
    async checkForUpdates() {
        const statusEl = document.getElementById('update-status');
        statusEl.innerHTML = '<div class="spinner"></div><p>Checking for updates...</p>';
        
        const result = await window.api.checkUpdates();
        
        if (result.success) {
            const updates = result.data;
            if (updates && updates.available) {
                statusEl.innerHTML = `
                    <h3>Update Available!</h3>
                    <p>Version ${updates.version} is available (Current: ${updates.currentVersion})</p>
                    <p>${updates.description}</p>
                    <button class="btn btn-primary" id="download-update-btn">Download Update</button>
                `;
                
                document.getElementById('download-update-btn').addEventListener('click', () => {
                    this.downloadUpdate(updates);
                });
            } else {
                statusEl.innerHTML = '<p>Your game is up to date!</p>';
            }
        } else {
            statusEl.innerHTML = `<p class="error-message">Failed to check for updates: ${result.error}</p>`;
        }
    }

    async checkForceUpdate() {
        const result = await window.api.checkUpdates();
        if (!result.success) return;

        const updates = result.data;
        if (updates && updates.available && updates.critical) {
            this.forceUpdatePending = true;

            // Lock all nav items except updates
            document.querySelectorAll('.nav-item').forEach(item => {
                if (item.dataset.view !== 'updates') {
                    item.disabled = true;
                    item.classList.add('nav-locked');
                }
            });

            // Navigate to updates view and show the mandatory banner
            this.switchView('updates');
            const statusEl = document.getElementById('update-status');
            statusEl.innerHTML = `
                <div class="force-update-banner">
                    <h3>⚠️ Required Update</h3>
                    <p>A critical update must be installed before you can play.</p>
                    <p>Version ${updates.version} — ${updates.description}</p>
                    <button class="btn btn-primary" id="download-update-btn">Download Required Update</button>
                </div>
            `;
            document.getElementById('download-update-btn').addEventListener('click', () => {
                this.downloadUpdate(updates);
            });
        }
    }

    unlockNav() {
        this.forceUpdatePending = false;
        document.querySelectorAll('.nav-item').forEach(item => {
            item.disabled = false;
            item.classList.remove('nav-locked');
        });
    }

    setupUpdates() {
        document.getElementById('check-updates-btn').addEventListener('click', () => {
            this.checkForUpdates();
        });
    }

    async downloadUpdate(updateInfo) {
        document.getElementById('update-progress').style.display = 'block';
        document.getElementById('download-update-btn').disabled = true;
        
        const result = await window.api.downloadUpdate(updateInfo);
        
        if (result.success) {
            if (this.forceUpdatePending) {
                this.unlockNav();
            }
            this.showSuccess(document.getElementById('update-status'),
                result.message || 'Patch installed successfully!');
        } else {
            this.showError(document.getElementById('update-status'), result.error);
            document.getElementById('update-progress').style.display = 'none';
            document.getElementById('download-update-btn').disabled = false;
        }
    }

    updateDownloadProgress(progress) {
        const fill = document.getElementById('progress-fill');
        const text = document.getElementById('progress-text');
        const status = document.getElementById('progress-status');
        
        fill.style.width = `${progress.percent}%`;
        text.textContent = `${Math.round(progress.percent)}% - ${progress.transferred}/${progress.total}`;
        
        if (status && progress.status) {
            status.textContent = progress.status;
        }
        
        // Hide progress bar when complete
        if (progress.percent >= 100) {
            setTimeout(() => {
                document.getElementById('update-progress').style.display = 'none';
                document.getElementById('download-update-btn').disabled = false;
                this.checkForUpdates(); // Refresh update status
            }, 3000);
        }
    }

    // Realm status
    updateRealmStatus(status) {
        const indicator = document.querySelector('.status-indicator');
        const realmName = document.querySelector('.realm-name');
        
        if (status.online) {
            indicator.classList.remove('offline');
            indicator.classList.add('online');
            realmName.textContent = status.name || 'Online';
        } else {
            indicator.classList.remove('online');
            indicator.classList.add('offline');
            realmName.textContent = 'Offline';
        }
    }

    // UI helpers
    showLoading(container) {
        const btn = container.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner"></div>';
        }
    }

    hideLoading(container) {
        const btn = container.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.textContent || 'Submit';
        }
    }

    showError(container, message) {
        this.removeMessages(container);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        container.appendChild(errorDiv);
        
        setTimeout(() => errorDiv.remove(), 5000);
    }

    showSuccess(container, message) {
        this.removeMessages(container);
        const successDiv = document.createElement('div');
        successDiv.className = 'success-message';
        successDiv.textContent = message;
        container.appendChild(successDiv);
        
        setTimeout(() => successDiv.remove(), 5000);
    }

    removeMessages(container) {
        container.querySelectorAll('.error-message, .success-message').forEach(el => el.remove());
    }

    // Game update handlers (kept for backward compatibility)
    showUpdateAvailable(info) {
        // Show notification about game update (not launcher update)
        if (confirm(`Game update ${info.version} is available. Download now?`)) {
            this.downloadUpdate(info);
        }
    }

    showUpdateReady(info) {
        this.showSuccess(document.getElementById('update-status'), 
            `Game update ${info.version} installed successfully!`);
    }

    // Character detail methods
    setupCharacterDetail() {
        const modal = document.getElementById('character-detail-modal');
        const closeBtn = document.getElementById('close-character-detail');
        
        // Close modal when clicking the close button
        closeBtn.addEventListener('click', () => {
            this.hideCharacterDetails();
        });
        
        // Close modal when clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.hideCharacterDetails();
            }
        });
        
        this.characterDetailRefreshInterval = null;
        this.currentCharacterGuid = null;
    }

    setupShop() {
        // Setup shop purchase modal event listeners
        const purchaseModal = document.getElementById('shop-purchase-modal');
        const closePurchaseBtn = document.getElementById('close-purchase-modal');
        const cancelPurchaseBtn = document.getElementById('cancel-purchase');
        const confirmPurchaseBtn = document.getElementById('confirm-purchase');

        // Close modal when clicking the close button
        closePurchaseBtn.addEventListener('click', () => {
            this.closePurchaseModal();
        });

        // Close modal when clicking cancel
        cancelPurchaseBtn.addEventListener('click', () => {
            this.closePurchaseModal();
        });

        // Confirm purchase
        confirmPurchaseBtn.addEventListener('click', () => {
            this.confirmPurchase();
        });

        // Close modal when clicking outside
        purchaseModal.addEventListener('click', (e) => {
            if (e.target === purchaseModal) {
                this.closePurchaseModal();
            }
        });
    }

    async showCharacterDetails(guid) {
        const modal = document.getElementById('character-detail-modal');
        const modalBody = document.getElementById('character-detail-body');
        const modalName = document.getElementById('character-detail-name');
        
        this.currentCharacterGuid = guid;
        
        // Show modal with loading state
        modal.style.display = 'flex';
        modalBody.innerHTML = `
            <div class="character-detail-loading">
                <div class="spinner"></div>
                <p>Loading character details...</p>
            </div>
        `;
        modalName.textContent = 'Loading...';
        
        await this.refreshCharacterDetails();
        
        // Set up automatic refresh every 30 seconds
        this.characterDetailRefreshInterval = setInterval(async () => {
            if (this.currentCharacterGuid && modal.style.display === 'flex') {
                await this.refreshCharacterDetails(false); // Silent refresh
            }
        }, 30000);
    }

    async refreshCharacterDetails(showLoading = true) {
        if (!this.currentCharacterGuid) return;
        
        try {
            const result = await window.api.getCharacterDetails(this.currentCharacterGuid);
            if (result.success) {
                const char = result.data;
                this.displayCharacterDetailContent(char);
                
                // Update the last refreshed timestamp
                const lastUpdateEl = document.getElementById('last-update-time');
                if (lastUpdateEl) {
                    lastUpdateEl.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
                }
            } else {
                if (showLoading) {
                    this.showCharacterDetailError(result.error);
                }
            }
        } catch (error) {
            if (showLoading) {
                this.showCharacterDetailError(error.message);
            }
        }
    }

    displayCharacterDetailContent(char) {
        const modalBody = document.getElementById('character-detail-body');
        const modalName = document.getElementById('character-detail-name');
        
        modalName.textContent = char.name;
        
        // Equipment slot names
        const slotNames = {
            0: 'Head', 1: 'Neck', 2: 'Shoulders', 3: 'Shirt', 4: 'Chest',
            5: 'Waist', 6: 'Legs', 7: 'Feet', 8: 'Wrists', 9: 'Hands',
            10: 'Finger 1', 11: 'Finger 2', 12: 'Trinket 1', 13: 'Trinket 2',
            14: 'Back', 15: 'Main Hand', 16: 'Off Hand', 17: 'Ranged', 18: 'Tabard'
        };

        // Quality colors
        const qualityColors = {
            0: '#9d9d9d', // Poor (gray)
            1: '#ffffff', // Common (white)
            2: '#1eff00', // Uncommon (green)
            3: '#0070dd', // Rare (blue)
            4: '#a335ee', // Epic (purple)
            5: '#ff8000', // Legendary (orange)
            6: '#e6cc80'  // Artifact (light yellow)
        };
        
        modalBody.innerHTML = `
            <div class="character-detail-sections">
                <div class="character-basic-info">
                    <h3>${char.name}</h3>
                    <p class="character-level-class">Level ${char.level} ${this.getRaceClass(char.race, char.class)}</p>
                    <p class="character-realm">Realm: ${char.realmName}</p>
                </div>

                <div class="character-detail-stats">
                    <div class="stat-section">
                        <h4><i class="fas fa-map-marker-alt"></i> Location</h4>
                        <p><strong>Zone:</strong> ${char.location.zone}</p>
                        <p><strong>Coordinates:</strong> (${char.location.coordinates.x}, ${char.location.coordinates.y})</p>
                    </div>

                    <div class="stat-section">
                        <h4><i class="fas fa-coins"></i> Currency</h4>
                        <div class="gold-display">
                            <span class="gold">${char.gold.gold}g</span>
                            <span class="silver">${char.gold.silver}s</span>
                            <span class="copper">${char.gold.copper}c</span>
                        </div>
                    </div>

                    <div class="stat-section">
                        <h4><i class="fas fa-chart-bar"></i> Stats</h4>
                        <p><strong>Gear Score:</strong> ${char.gearScore}</p>
                        <p><strong>Total Kills:</strong> ${char.totalKills || 0}</p>
                        <p><strong>Playtime:</strong> ${Math.floor((char.totaltime || 0) / 3600)}h ${Math.floor(((char.totaltime || 0) % 3600) / 60)}m</p>
                    </div>
                </div>

                <div class="character-equipment">
                    <h4><i class="fas fa-tshirt"></i> Equipment</h4>
                    <div class="equipment-grid">
                        ${char.equipment.map(item => {
                            const slotName = slotNames[item.slot] || `Slot ${item.slot}`;
                            const qualityColor = qualityColors[item.quality] || '#9d9d9d';
                            return `
                                <div class="equipment-slot">
                                    <div class="equipment-item" style="border-left: 3px solid ${qualityColor}">
                                        <div class="slot-name">${slotName}</div>
                                        <div class="item-name" style="color: ${qualityColor}">${item.name}</div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                        ${char.equipment.length === 0 ? '<p>No equipment data available</p>' : ''}
                    </div>
                </div>

                <div class="character-achievements">
                    <h4><i class="fas fa-trophy"></i> Recent Achievements</h4>
                    <div class="achievements-list">
                        ${char.achievements.map(ach => `
                            <div class="achievement-item">
                                <div class="achievement-title">${ach.title}</div>
                                <div class="achievement-date">${new Date(ach.date).toLocaleDateString()}</div>
                            </div>
                        `).join('')}
                        ${char.achievements.length === 0 ? '<p>No recent achievements</p>' : ''}
                    </div>
                </div>

                <div class="character-detail-footer">
                    <div class="character-detail-controls">
                        <button class="btn btn-refresh" id="refresh-character-btn" title="Refresh all character data">
                            <i class="fas fa-sync-alt"></i> Refresh Data
                        </button>
                        <div class="auto-refresh-indicator">
                            <i class="fas fa-clock"></i> Auto-refreshes every 30s
                        </div>
                        <div class="last-update-time" id="last-update-time">
                            Last updated: ${new Date().toLocaleTimeString()}
                        </div>
                        <div class="save-info">
                            <i class="fas fa-info-circle"></i> Game server saves data every ~15 minutes or on logout
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Setup refresh button
        const refreshBtn = document.getElementById('refresh-character-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refreshing...';
                
                await this.refreshCharacterDetails();
                
                setTimeout(() => {
                    refreshBtn.disabled = false;
                    refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh Data';
                }, 1000);
            });
        }
    }

    showCharacterDetailError(error) {
        const modalBody = document.getElementById('character-detail-body');
        const modalName = document.getElementById('character-detail-name');
        
        modalName.textContent = 'Error';
        modalBody.innerHTML = `
            <div class="character-detail-error">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Failed to load character details</p>
                <p class="error-message">${error}</p>
            </div>
        `;
    }

    hideCharacterDetails() {
        const modal = document.getElementById('character-detail-modal');
        modal.style.display = 'none';
        
        // Clear refresh interval and current character
        if (this.characterDetailRefreshInterval) {
            clearInterval(this.characterDetailRefreshInterval);
            this.characterDetailRefreshInterval = null;
        }
        this.currentCharacterGuid = null;
        
        // Refresh character list to show updated gear scores
        if (this.currentView === 'characters') {
            this.loadCharacters();
        } else if (this.currentView === 'home') {
            this.loadHomeData();
        }
    }

    // Shop functionality
    async loadShopData() {
        if (!this.isAuthenticated) {
            this.switchView('login');
            return;
        }

        await this.loadCharactersForPayment();
        await this.loadShopCategories();
        await this.loadPurchaseHistory();
    }

    async loadCharactersForPayment() {
        try {
            // Use the same method as the existing character loading
            const result = await window.api.getCharacters();
            if (!result.success) {
                console.error('Failed to load characters:', result.error);
                return;
            }
            
            const characters = result.data;
            const paymentSelect = document.getElementById('payment-character-select');
            const recipientSelect = document.getElementById('recipient-character-select');
            
            // Clear existing options
            paymentSelect.innerHTML = '<option value="">Select character to pay...</option>';
            recipientSelect.innerHTML = '<option value="">Select character to receive item...</option>';
            
            characters.forEach(char => {
                // Payment character option
                const paymentOption = document.createElement('option');
                paymentOption.value = char.guid;
                paymentOption.textContent = `${char.name} (Level ${char.level})`;
                paymentSelect.appendChild(paymentOption);
                
                // Recipient character option
                const recipientOption = document.createElement('option');
                recipientOption.value = char.guid;
                recipientOption.textContent = `${char.name} (Level ${char.level})`;
                recipientSelect.appendChild(recipientOption);
            });

            // Setup payment character selection handler (only once)
            if (!paymentSelect.hasAttribute('data-handler-attached')) {
                paymentSelect.addEventListener('change', async (e) => {
                    const guid = e.target.value;
                    if (guid) {
                        await this.loadCharacterGold(guid);
                    } else {
                        document.getElementById('character-gold-display').style.display = 'none';
                    }
                });
                paymentSelect.setAttribute('data-handler-attached', 'true');
            }
            
            // Setup recipient character selection handler (only once)
            if (!recipientSelect.hasAttribute('data-handler-attached')) {
                recipientSelect.addEventListener('change', (e) => {
                    const guid = e.target.value;
                    const recipientInfo = document.getElementById('recipient-info');
                    const recipientName = document.getElementById('recipient-name');
                    
                    if (guid) {
                        const selectedChar = characters.find(char => char.guid == guid);
                        if (selectedChar) {
                            recipientName.textContent = `${selectedChar.name} (Level ${selectedChar.level})`;
                            recipientInfo.style.display = 'block';
                        }
                    } else {
                        recipientInfo.style.display = 'none';
                    }
                });
                recipientSelect.setAttribute('data-handler-attached', 'true');
            }

        } catch (error) {
            console.error('Failed to load characters for payment:', error);
        }
    }

    async loadCharacterGold(characterGuid) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/shop/character-gold/${characterGuid}`, {
                headers: {
                    'Authorization': `Bearer ${this.userData.token}`
                }
            });

            if (response.ok) {
                const goldData = await response.json();
                const goldDisplay = document.getElementById('character-gold-display');
                const goldAmount = document.getElementById('character-gold-amount');
                
                goldAmount.textContent = `${goldData.gold}g ${goldData.silver}s ${goldData.copper}c`;
                goldDisplay.style.display = 'block';
                
                // Store character gold data for purchases
                this.selectedCharacterGold = goldData;
            }
        } catch (error) {
            console.error('Failed to load character gold:', error);
        }
    }

    async loadShopCategories() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/shop/categories`);
            const categories = await response.json();
            
            const categoryTabs = document.getElementById('category-tabs');
            categoryTabs.innerHTML = '';
            
            if (categories.length === 0) {
                categoryTabs.innerHTML = '<p class="shop-empty">No categories available</p>';
                return;
            }

            categories.forEach((category, index) => {
                const tab = document.createElement('button');
                tab.className = `category-tab ${index === 0 ? 'active' : ''}`;
                tab.dataset.categoryId = category.id;
                tab.textContent = category.name;
                
                tab.addEventListener('click', () => {
                    // Remove active class from all tabs
                    document.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
                    // Add active class to clicked tab
                    tab.classList.add('active');
                    // Load items for this category
                    this.loadShopItems(category.id);
                });
                
                categoryTabs.appendChild(tab);
            });

            // Load first category items by default
            if (categories.length > 0) {
                this.loadShopItems(categories[0].id);
            }

        } catch (error) {
            console.error('Failed to load shop categories:', error);
        }
    }

    async loadShopItems(categoryId) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/shop/items/${categoryId}`);
            const items = await response.json();
            
            const itemsGrid = document.getElementById('shop-items-grid');
            
            if (items.length === 0) {
                itemsGrid.innerHTML = `
                    <div class="shop-empty">
                        <h4>No items available</h4>
                        <p>This category doesn't have any items yet.</p>
                    </div>
                `;
                return;
            }

            itemsGrid.innerHTML = items.map(item => `
                <div class="shop-item" data-item-id="${item.id}">
                    <div class="shop-item-header">
                        <h4 class="shop-item-name">${item.name}</h4>
                        <span class="shop-item-price">${this.formatGold(item.price_gold)}</span>
                    </div>
                    <div class="shop-item-type">${item.item_type.replace('_', ' ')}</div>
                    <p class="shop-item-description">${item.description || 'No description available'}</p>
                    <div class="shop-item-actions">
                        <span class="shop-item-stock ${item.stock_quantity === -1 ? 'unlimited' : (item.stock_quantity < 5 ? 'low' : '')}">
                            ${item.stock_quantity === -1 ? 'Unlimited' : `${item.stock_quantity} in stock`}
                        </span>
                        <button class="btn-buy" ${item.stock_quantity === 0 ? 'disabled' : ''} 
                                onclick="app.showPurchaseModal(${item.id})">
                            ${item.stock_quantity === 0 ? 'Out of Stock' : 'Buy Now'}
                        </button>
                    </div>
                </div>
            `).join('');

        } catch (error) {
            console.error('Failed to load shop items:', error);
            document.getElementById('shop-items-grid').innerHTML = `
                <div class="shop-empty">
                    <h4>Error</h4>
                    <p>Failed to load items. Please try again.</p>
                </div>
            `;
        }
    }

    async showPurchaseModal(itemId) {
        const paymentCharacter = document.getElementById('payment-character-select').value;
        const recipientCharacter = document.getElementById('recipient-character-select').value;
        
        if (!paymentCharacter) {
            alert('Please select a character to pay with first.');
            return;
        }
        
        if (!recipientCharacter) {
            alert('Please select a character to receive the item.');
            return;
        }

        try {
            // Get item details
            const response = await fetch(`${this.apiBaseUrl}/shop/items`);
            const allItems = await response.json();
            const item = allItems.find(i => i.id === itemId);
            
            if (!item) {
                alert('Item not found.');
                return;
            }

            // Populate modal
            document.getElementById('purchase-item-name').textContent = item.name;
            document.getElementById('purchase-item-description').textContent = item.description || 'No description available';
            document.getElementById('purchase-price').textContent = this.formatGold(item.price_gold);
            
            const paymentOption = document.getElementById('payment-character-select').selectedOptions[0];
            const recipientOption = document.getElementById('recipient-character-select').selectedOptions[0];
            
            document.getElementById('purchase-character').textContent = paymentOption.textContent;
            document.getElementById('purchase-character-gold').textContent = document.getElementById('character-gold-amount').textContent;
            document.getElementById('purchase-recipient').textContent = recipientOption.textContent;

            // Store purchase data
            this.pendingPurchase = {
                itemId: itemId,
                paymentCharacterGuid: paymentCharacter,
                recipientCharacterGuid: recipientCharacter,
                item: item
            };

            // Show modal
            document.getElementById('shop-purchase-modal').style.display = 'flex';

        } catch (error) {
            console.error('Failed to show purchase modal:', error);
            alert('Failed to load purchase details.');
        }
    }

    async confirmPurchase() {
        if (!this.pendingPurchase) return;

        try {
            const response = await fetch(`${this.apiBaseUrl}/shop/purchase`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.userData.token}`
                },
                body: JSON.stringify({
                    itemId: this.pendingPurchase.itemId,
                    paymentCharacterGuid: this.pendingPurchase.paymentCharacterGuid,
                    recipientCharacterGuid: this.pendingPurchase.recipientCharacterGuid,
                    quantity: 1
                })
            });

            const result = await response.json();

            if (response.ok) {
                alert(`Purchase successful! ${result.message}`);
                
                // Refresh shop data
                await this.loadCharacterGold(this.pendingPurchase.paymentCharacterGuid);
                const activeCategory = document.querySelector('.category-tab.active');
                if (activeCategory) {
                    await this.loadShopItems(activeCategory.dataset.categoryId);
                }
                await this.loadPurchaseHistory();
                
                // Close modal
                this.closePurchaseModal();
            } else {
                // Handle specific error types
                if (result.code === 'CHARACTER_ONLINE') {
                    alert(`Purchase failed: ${result.characterName} must be offline to purchase items. Please log out the character and try again.`);
                } else {
                    alert(`Purchase failed: ${result.error}`);
                }
            }

        } catch (error) {
            console.error('Purchase failed:', error);
            alert('Purchase failed due to network error.');
        }
    }

    closePurchaseModal() {
        document.getElementById('shop-purchase-modal').style.display = 'none';
        this.pendingPurchase = null;
    }

    async loadPurchaseHistory() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/shop/purchases`, {
                headers: {
                    'Authorization': `Bearer ${this.userData.token}`
                }
            });

            if (response.ok) {
                const purchases = await response.json();
                const historyContainer = document.getElementById('purchase-history');
                
                if (purchases.length === 0) {
                    historyContainer.innerHTML = '<p class="shop-empty">No purchase history</p>';
                    return;
                }

                historyContainer.innerHTML = purchases.slice(0, 10).map(purchase => `
                    <div class="purchase-item">
                        <div class="purchase-item-details">
                            <div class="purchase-item-name">${purchase.item_name || 'Unknown Item'}</div>
                            <div class="purchase-item-meta">
                                ${purchase.character_name} • ${new Date(purchase.transaction_date).toLocaleDateString()}
                            </div>
                        </div>
                        <div class="purchase-item-price">${this.formatGold(purchase.price_paid)}</div>
                    </div>
                `).join('');
            }

        } catch (error) {
            console.error('Failed to load purchase history:', error);
        }
    }

    formatGold(copperAmount) {
        const gold = Math.floor(copperAmount / 10000);
        const silver = Math.floor((copperAmount % 10000) / 100);
        const copper = copperAmount % 100;
        
        let result = '';
        if (gold > 0) result += `${gold}g`;
        if (silver > 0) result += `${silver}s`;
        if (copper > 0) result += `${copper}c`;
        
        return result || '0c';
    }
}

// Initialize app when DOM is ready
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new LauncherApp();
});
