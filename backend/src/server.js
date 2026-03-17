const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const rateLimit = require('express-rate-limit');
const net = require('net');
const crypto = require('crypto');
const bigInt = require('big-integer');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// WoW Server Configuration
const WOW_SERVER_IP = process.env.WOW_SERVER_IP || 'localhost';
const WOW_SERVER_PORT = process.env.WOW_SERVER_PORT || 8085;

// Public-facing server URL (used in download links and logs)
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;

// SOAP Configuration for AzerothCore
const SOAP_HOST = process.env.SOAP_HOST || 'localhost';
const SOAP_PORT = process.env.SOAP_PORT || 7878;
const SOAP_USERNAME = process.env.SOAP_USERNAME || 'admin';
const SOAP_PASSWORD = process.env.SOAP_PASSWORD || 'admin';
const REALM_NAME = process.env.REALM_NAME || 'AzerothCore Server';

// Authentication mode: 'strict' or 'flexible'
// flexible mode tries multiple password formats
const AUTH_MODE = process.env.AUTH_MODE || 'flexible';

// Configure multer for patch uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../patches/temp');
        await fs.ensureDir(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `upload-${Date.now()}-${file.originalname}`);
    }
});

// Configure multer for launcher update uploads
const launcherStorage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../launcher-updates');
        await fs.ensureDir(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit
    },
    fileFilter: (req, file, cb) => {
        // Allow zip, rar, 7z files
        const allowedTypes = ['.zip', '.rar', '.7z'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only zip, rar, and 7z files are allowed'));
        }
    }
});

const launcherUpload = multer({
    storage: launcherStorage,
    limits: {
        fileSize: 200 * 1024 * 1024 // 200MB limit for launcher
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.exe', '.yml', '.blockmap'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only .exe, .yml, and .blockmap files are allowed'));
        }
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve static launcher update files
app.use('/updates', express.static(path.join(__dirname, '../../launcher-updates')));

// Rate limiting - More permissive for launcher applications
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // 1000 requests per 15 minutes
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Stricter rate limiting for auth endpoints to prevent brute force
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // 50 auth attempts per 15 minutes
    message: { error: 'Too many authentication attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);

// Database connection pools
let authPool, charactersPool, worldPool, itemPool, shopPool;

// Connection health monitoring
let dbConnectionHealth = {
    auth: false,
    characters: false,
    world: false,
    item: false,
    shop: false
};

async function initializeDatabases() {
    const dbConfigs = {
        auth: {
            host: process.env.AUTH_DB_HOST || 'localhost',
            user: process.env.AUTH_DB_USER || 'root',
            password: process.env.AUTH_DB_PASS || 'password',
            database: process.env.AUTH_DB_NAME || 'acore_auth'
        },
        characters: {
            host: process.env.CHAR_DB_HOST || 'localhost',
            user: process.env.CHAR_DB_USER || 'root',
            password: process.env.CHAR_DB_PASS || 'password',
            database: process.env.CHAR_DB_NAME || 'acore_characters'
        },
        world: {
            host: process.env.WORLD_DB_HOST || process.env.CHAR_DB_HOST || 'localhost',
            user: process.env.WORLD_DB_USER || process.env.CHAR_DB_USER || 'root',
            password: process.env.WORLD_DB_PASS || process.env.CHAR_DB_PASS || 'password',
            database: process.env.WORLD_DB_NAME || 'acore_world'
        },
        item: {
            host: process.env.ITEM_DB_HOST || process.env.CHAR_DB_HOST || 'localhost',
            user: process.env.ITEM_DB_USER || process.env.CHAR_DB_USER || 'root',
            password: process.env.ITEM_DB_PASS || process.env.CHAR_DB_PASS || 'password',
            database: process.env.ITEM_DB_NAME || 'itemdb'
        },
        shop: {
            host: process.env.SHOP_DB_HOST || process.env.CHAR_DB_HOST || 'localhost',
            user: process.env.SHOP_DB_USER || process.env.CHAR_DB_USER || 'root',
            password: process.env.SHOP_DB_PASS || process.env.CHAR_DB_PASS || 'password',
            database: process.env.SHOP_DB_NAME || 'shop'
        }
    };

    const poolOptions = {
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        acquireTimeout: 60000,
        timeout: 60000,
        reconnect: true
    };

    try {
        authPool = mysql.createPool({ ...dbConfigs.auth, ...poolOptions });
        charactersPool = mysql.createPool({ ...dbConfigs.characters, ...poolOptions });
        worldPool = mysql.createPool({ ...dbConfigs.world, ...poolOptions });
        itemPool = mysql.createPool({ ...dbConfigs.item, ...poolOptions });
        shopPool = mysql.createPool({ ...dbConfigs.shop, ...poolOptions });

        // Test connections
        await testDatabaseConnections();
        console.log('✅ All database connections established successfully');
    } catch (error) {
        console.error('❌ Database connection error:', error);
        process.exit(1);
    }
}

// Test database connections
async function testDatabaseConnections() {
    const pools = { auth: authPool, characters: charactersPool, world: worldPool, item: itemPool, shop: shopPool };
    
    for (const [name, pool] of Object.entries(pools)) {
        try {
            await pool.execute('SELECT 1');
            dbConnectionHealth[name] = true;
            console.log(`✅ ${name} database: Connected`);
        } catch (error) {
            dbConnectionHealth[name] = false;
            console.warn(`⚠️ ${name} database: Connection failed - ${error.message}`);
            if (name === 'auth' || name === 'characters') {
                throw new Error(`Critical database ${name} unavailable`);
            }
        }
    }
}

// SRP6 Implementation for AzerothCore
class SRP6 {
    constructor() {
        // SRP6 constants used by WoW
        this.N = bigInt('894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7', 16);
        this.g = bigInt(7);
        this.validationCache = new Map(); // Cache for performance
    }
    
    // Clear cache periodically to prevent memory leaks
    clearCache() {
        this.validationCache.clear();
    }

    // Reverse byte array (for little-endian conversion)
    reverseBuffer(buffer) {
        const reversed = Buffer.alloc(buffer.length);
        for (let i = 0; i < buffer.length; i++) {
            reversed[i] = buffer[buffer.length - 1 - i];
        }
        return reversed;
    }

    // Calculate verifier for registration (matches AzerothCore exactly)
    calculateVerifier(username, password, salt) {
        // CRITICAL: AzerothCore expects BOTH username AND password to be UPPERCASE
        const authString = `${username.toUpperCase()}:${password.toUpperCase()}`;
        const h1 = crypto.createHash('sha1').update(authString, 'utf8').digest();
        
        // Step 2: Calculate h2 = SHA1(salt | h1)
        const h2 = crypto.createHash('sha1')
            .update(Buffer.concat([salt, h1]))
            .digest();
        
        // Step 3: Reverse h2 for little-endian
        const h2Reversed = this.reverseBuffer(h2);
        
        // Step 4: Convert to BigInt
        const x = bigInt(h2Reversed.toString('hex'), 16);
        
        // Step 5: Calculate v = g^x % N
        const v = this.g.modPow(x, this.N);
        
        // Step 6: Convert to 32-byte buffer
        let vHex = v.toString(16);
        if (vHex.length < 64) {
            vHex = vHex.padStart(64, '0');
        }
        
        // Step 7: Convert to buffer and reverse for storage
        const vBuffer = Buffer.from(vHex, 'hex');
        return this.reverseBuffer(vBuffer);
    }

    // Flexible password verification - tries multiple formats with caching
    verifyPasswordFlexible(username, password, saltBuffer, verifierBuffer) {
        const cacheKey = `${username}:${password}:${saltBuffer.toString('hex')}`;
        
        // Check cache first
        if (this.validationCache.has(cacheKey)) {
            const cachedResult = this.validationCache.get(cacheKey);
            return cachedResult.equals(verifierBuffer);
        }
        
        // Try different password formats that servers might use
        // IMPORTANT: Try uppercase first as that's what AzerothCore expects
        const passwordVariants = [
            password.toUpperCase(),      // AzerothCore standard - try this first
            password,                    // As provided
            password.toLowerCase(),      // All lowercase
            password.charAt(0).toUpperCase() + password.slice(1).toLowerCase() // First letter capital
        ];

        for (const variant of passwordVariants) {
            try {
                const calculatedVerifier = this.calculateVerifier(username, variant, saltBuffer);
                
                // Cache the result
                this.validationCache.set(cacheKey, calculatedVerifier);
                
                if (calculatedVerifier.equals(verifierBuffer)) {
                    console.log(`Password matched with format: ${variant === password ? 'original' : 'transformed'}`);
                    return true;
                }
            } catch (error) {
                console.warn(`SRP6 calculation failed for variant: ${error.message}`);
            }
        }
        
        return false;
    }

    // Verify password against stored verifier
    verifyPassword(username, password, saltBuffer, verifierBuffer) {
        try {
            if (AUTH_MODE === 'flexible') {
                return this.verifyPasswordFlexible(username, password, saltBuffer, verifierBuffer);
            } else {
                const calculatedVerifier = this.calculateVerifier(username, password, saltBuffer, verifierBuffer);
                return calculatedVerifier.equals(verifierBuffer);
            }
        } catch (error) {
            console.error('Error verifying password:', error);
            return false;
        }
    }

    // Generate random salt
    generateSalt() {
        return crypto.randomBytes(32);
    }
    
    // Validate salt and verifier format
    validateCredentials(salt, verifier) {
        if (!Buffer.isBuffer(salt) || salt.length !== 32) {
            throw new Error('Invalid salt format');
        }
        if (!Buffer.isBuffer(verifier) || verifier.length !== 32) {
            throw new Error('Invalid verifier format');
        }
        return true;
    }
}

const srp6 = new SRP6();

// Clear SRP6 cache every hour to prevent memory leaks
setInterval(() => {
    srp6.clearCache();
    console.log('SRP6 cache cleared');
}, 60 * 60 * 1000);

// Helper function to check if WoW server is online
function checkServerStatus(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let isConnected = false;

        socket.setTimeout(5000); // 5 second timeout

        socket.on('connect', () => {
            isConnected = true;
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            resolve(false);
        });

        socket.on('close', () => {
            if (!isConnected) {
                resolve(false);
            }
        });

        socket.connect(port, host);
    });
}

// Helper function to generate JWT
function generateToken(accountId, username) {
    return jwt.sign(
        { accountId, username },
        process.env.JWT_SECRET || 'your-secret-key',
        { expiresIn: '7d' }
    );
}

// Enhanced middleware to verify JWT with better error handling
function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ 
                error: 'Access token required',
                code: 'MISSING_TOKEN'
            });
        }

        jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
            if (err) {
                const errorCode = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
                return res.status(403).json({ 
                    error: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token',
                    code: errorCode
                });
            }
            req.user = user;
            next();
        });
    } catch (error) {
        console.error('Authentication middleware error:', error);
        res.status(500).json({ error: 'Authentication error', code: 'AUTH_ERROR' });
    }
}

// Database health check middleware
function checkDatabaseHealth(req, res, next) {
    const requiredDbs = ['auth', 'characters'];
    const unavailableDbs = requiredDbs.filter(db => !dbConnectionHealth[db]);
    
    if (unavailableDbs.length > 0) {
        return res.status(503).json({ 
            error: 'Database service unavailable',
            unavailable: unavailableDbs,
            code: 'DB_UNAVAILABLE'
        });
    }
    next();
}

// Ensure launcher updates directory exists
async function ensureLauncherUpdatesDir() {
    const updateDir = path.join(__dirname, '../../launcher-updates');
    await fs.ensureDir(updateDir);
    
    // Create a default latest.yml if it doesn't exist
    const latestYmlPath = path.join(updateDir, 'latest.yml');
    if (!await fs.pathExists(latestYmlPath)) {
        const defaultYml = `version: 1.0.0
files:
  - url: WoW-Launcher-Setup-1.0.0.exe
    sha512: ""
    size: 0
path: WoW-Launcher-Setup-1.0.0.exe
sha512: ""
releaseDate: "${new Date().toISOString()}"
`;
        await fs.writeFile(latestYmlPath, defaultYml);
        console.log('Created default latest.yml for launcher updates');
    }

    // Create launcher update info file if it doesn't exist
    const updateInfoPath = path.join(updateDir, 'launcher-info.json');
    if (!await fs.pathExists(updateInfoPath)) {
        const defaultInfo = {
            currentVersion: "1.1.0",
            latestVersion: "1.1.0",
            releases: []
        };
        await fs.writeJson(updateInfoPath, defaultInfo, { spaces: 2 });
        console.log('Created default launcher-info.json');
    }
}

// Routes

// ========================================
// NEW: EXECUTION POLICY BYPASS UPDATER ENDPOINTS
// ========================================

// Main endpoint for execution policy bypass updater
app.get('/updates/latest.json', async (req, res) => {
    try {
        console.log('🔍 Launcher update check requested');
        
        const updateInfoPath = path.join(__dirname, '../../launcher-updates/launcher-info.json');
        let updateInfo;
        
        try {
            updateInfo = await fs.readJson(updateInfoPath);
        } catch (error) {
            // Create default if file doesn't exist
            updateInfo = {
                currentVersion: "1.1.0",
                latestVersion: "1.2.0", // Set to 1.2.0 to trigger update for testing
                releases: [
                    {
                        version: "1.2.0",
                        releaseDate: new Date().toISOString(),
                        changelog: [
                            "✅ Added execution policy bypass system",
                            "✅ Improved Windows compatibility",
                            "✅ Better error handling",
                            "✅ Enhanced user experience"
                        ],
                        critical: false
                    }
                ]
            };
            await fs.writeJson(updateInfoPath, updateInfo, { spaces: 2 });
        }
        
        const latestRelease = updateInfo.releases[0] || {};
        const version = updateInfo.latestVersion || "1.2.0";
        
        // Try to find the actual .exe file in launcher-updates directory
        const updateDir = path.join(__dirname, '../../launcher-updates');
        let actualExeFile = null;
        
        try {
            const files = await fs.readdir(updateDir);
            // Look for exe files that match the version
            actualExeFile = files.find(file => 
                file.endsWith('.exe') && 
                (file.includes(version) || file.includes('Setup') || file.includes('Launcher'))
            ) || `WoW Launcher Setup ${version}.exe`; // fallback to expected name
        } catch (error) {
            console.warn('Could not read launcher-updates directory:', error.message);
            actualExeFile = `WoW Launcher Setup ${version}.exe`;
        }

        const response = {
            version: version,
            releaseDate: latestRelease.releaseDate || new Date().toISOString(),
            downloadUrl: `${SERVER_PUBLIC_URL}/updates/${actualExeFile}`,
            releaseNotes: `${SERVER_PUBLIC_URL}/updates/release-notes-${version}.html`,
            forceUpdate: latestRelease.critical || false,
            changelog: latestRelease.changelog || [
                "✅ Added execution policy bypass system",
                "✅ Improved Windows compatibility", 
                "✅ Better error handling"
            ],
            fileSize: 45000000, // ~45MB
            checksum: "sha256:abcdef1234567890...",
            requirements: {
                windows: "10+",
                memory: "512MB",
                disk: "100MB"
            }
        };
        
        console.log(`📋 Returning version info: ${response.version}`);
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error fetching launcher update info:', error);
        res.status(500).json({ error: 'Failed to fetch update information' });
    }
});

// Release notes endpoint
app.get('/updates/release-notes-:version.html', (req, res) => {
    const version = req.params.version;
    
    const releaseNotes = `
<!DOCTYPE html>
<html>
<head>
    <title>WoW Launcher - Release Notes v${version}</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            max-width: 800px; 
            margin: 50px auto; 
            padding: 20px;
            background: #1a1a1a;
            color: #ffffff;
        }
        h1 { color: #4CAF50; text-align: center; }
        .changelog { 
            background: #2d2d2d; 
            padding: 20px; 
            border-radius: 8px; 
            margin: 20px 0;
            border-left: 4px solid #4CAF50;
        }
        .feature { color: #4CAF50; }
        .bugfix { color: #2196F3; }
        .security { color: #ff9800; }
        ul { line-height: 1.6; }
        .back-link { 
            text-align: center; 
            margin-top: 30px;
        }
        .back-link a {
            color: #4CAF50;
            text-decoration: none;
            padding: 10px 20px;
            border: 1px solid #4CAF50;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <h1>🚀 WoW Launcher v${version}</h1>
    
    <div class="changelog">
        <h2>🆕 What's New in v${version}</h2>
        <ul>
            <li class="security">🛡️ <strong>Execution Policy Bypass System</strong> - Automatic bypass of Windows security restrictions using 5 different methods</li>
            <li class="feature">⚡ <strong>PowerShell Bypass</strong> - Uses <code>-ExecutionPolicy Unrestricted</code> for seamless updates</li>
            <li class="feature">🔧 <strong>Multiple Installation Methods</strong> - CMD, Batch, Shell, and Process Spawn fallbacks</li>
            <li class="feature">📥 <strong>Smart Download</strong> - Downloads to user directory to avoid permission issues</li>
            <li class="bugfix">🐛 <strong>Better Error Handling</strong> - Clear error messages and troubleshooting guidance</li>
            <li class="feature">🎮 <strong>Enhanced UI</strong> - Progress tracking and visual feedback during updates</li>
            <li class="feature">⌨️ <strong>Keyboard Shortcuts</strong> - Press Ctrl+U to check for updates manually</li>
            <li class="bugfix">🔄 <strong>Automatic Fallback</strong> - Manual installation guide if all automated methods fail</li>
        </ul>
    </div>

    <div class="changelog">
        <h2>🔧 Technical Improvements</h2>
        <ul>
            <li>Removed electron-updater dependency for better Windows compatibility</li>
            <li>Custom update system specifically designed for Windows security restrictions</li>
            <li>Enhanced logging and debugging capabilities</li>
            <li>Improved user experience with clear progress indicators</li>
            <li>Better integration with existing launcher infrastructure</li>
        </ul>
    </div>

    <div class="changelog">
        <h2>🛡️ Security & Compatibility</h2>
        <ul>
            <li><strong>Windows 10/11 Compatible:</strong> Tested on latest Windows versions</li>
            <li><strong>No Admin Required:</strong> Updates work with standard user permissions</li>
            <li><strong>Multiple Bypass Methods:</strong> 5 different approaches for maximum compatibility</li>
            <li><strong>Safe Fallback:</strong> Manual installation if automatic methods fail</li>
        </ul>
    </div>

    <div class="back-link">
        <a href="javascript:window.close()">Close Window</a>
    </div>
</body>
</html>
    `;
    
    res.send(releaseNotes);
});

// Installer not found — real .exe files are served by the express.static('/updates') middleware above
app.get('/updates/WoW-Launcher-Setup-:version.exe', (req, res) => {
    res.status(404).json({ error: `Installer for version ${req.params.version} not found. Upload it via the dev tool.` });
});

// Update launcher version info (for admin use)
app.post('/api/launcher/update-info', async (req, res) => {
    try {
        const { version, changelog, critical } = req.body;
        
        if (!version) {
            return res.status(400).json({ error: 'Version is required' });
        }
        
        const updateInfoPath = path.join(__dirname, '../../launcher-updates/launcher-info.json');
        let updateInfo;
        
        try {
            updateInfo = await fs.readJson(updateInfoPath);
        } catch (error) {
            updateInfo = {
                currentVersion: "1.1.0",
                latestVersion: "1.1.0",
                releases: []
            };
        }
        
        // Add new release
        const newRelease = {
            version: version,
            releaseDate: new Date().toISOString(),
            changelog: changelog || [],
            critical: critical || false
        };
        
        updateInfo.latestVersion = version;
        updateInfo.releases.unshift(newRelease); // Add to beginning
        
        // Keep only last 10 releases
        updateInfo.releases = updateInfo.releases.slice(0, 10);
        
        await fs.writeJson(updateInfoPath, updateInfo, { spaces: 2 });
        
        console.log(`✅ Launcher version updated to ${version}`);
        res.json(newRelease);
        
    } catch (error) {
        console.error('❌ Error updating launcher info:', error);
        res.status(500).json({ error: 'Failed to update launcher info' });
    }
});

// ========================================
// EXISTING ROUTES (UNCHANGED)
// ========================================

// Realm status
app.get('/api/realm/status', async (req, res) => {
    try {
        // Check if the world server is running
        const isOnline = await checkServerStatus(WOW_SERVER_IP, WOW_SERVER_PORT);
        
        let realmInfo = {
            online: isOnline,
            name: REALM_NAME,
            address: WOW_SERVER_IP,
            port: WOW_SERVER_PORT
        };

        // Try to get additional info from database if available
        if (isOnline) {
            try {
                const [realms] = await authPool.execute(
                    'SELECT id, name, address, port, population FROM realmlist WHERE id = ?',
                    [1] // Assuming realm ID 1
                );

                if (realms.length > 0) {
                    realmInfo = {
                        ...realmInfo,
                        name: realms[0].name,
                        population: realms[0].population
                    };
                }
            } catch (dbError) {
                console.log('Could not fetch realm info from database:', dbError.message);
            }
        }

        res.json(realmInfo);
    } catch (error) {
        console.error('Realm status error:', error);
        res.json({ 
            online: false, 
            error: error.message,
            name: REALM_NAME 
        });
    }
});

// Launcher update routes
app.get('/api/launcher/version', (req, res) => {
    res.json({
        success: true,
        version: '1.0.0',
        updateAvailable: false
    });
});

// Upload launcher update files
app.post('/api/launcher/upload', launcherUpload.fields([
    { name: 'exe', maxCount: 1 },
    { name: 'yml', maxCount: 1 },
    { name: 'blockmap', maxCount: 1 }
]), async (req, res) => {
    try {
        const { version, releaseNotes } = req.body;
        
        if (!req.files || !req.files.exe || !req.files.yml) {
            return res.status(400).json({ error: 'Both .exe and .yml files are required' });
        }
        
        console.log(`Uploading launcher update ${version}...`);
        
        // Files are automatically saved to launcher-updates directory by multer
        const exeFile = req.files.exe[0];
        const ymlFile = req.files.yml[0];
        const blockmapFile = req.files.blockmap ? req.files.blockmap[0] : null;
        
        // Generate release notes HTML file
        if (releaseNotes && releaseNotes.trim()) {
            const lines = releaseNotes.split('\n').filter(l => l.trim());
            const listItems = lines.map(l => `<li>${l.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</li>`).join('\n            ');
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WoW Launcher ${version} - Release Notes</title>
    <style>
        body { font-family: Arial, sans-serif; background: #1a1a1a; color: #ccc; max-width: 700px; margin: 40px auto; padding: 0 20px; }
        h1 { color: #f39c12; border-bottom: 1px solid #333; padding-bottom: 12px; }
        .version { color: #888; font-size: 14px; margin-bottom: 24px; }
        ul { line-height: 1.8; padding-left: 20px; }
        li { margin-bottom: 6px; }
    </style>
</head>
<body>
    <h1>WoW Launcher ${version}</h1>
    <p class="version">Released ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    <ul>
            ${listItems}
    </ul>
</body>
</html>`;

            const htmlPath = path.join(__dirname, '../../launcher-updates', `release-notes-${version}.html`);
            await fs.writeFile(htmlPath, html, 'utf8');
            console.log(`Release notes written: release-notes-${version}.html`);
        }
        
        console.log(`Launcher update ${version} uploaded successfully!`);
        console.log(`Files: ${exeFile.filename}, ${ymlFile.filename}${blockmapFile ? `, ${blockmapFile.filename}` : ''}`);
        
        res.json({
            success: true,
            version,
            files: {
                exe: exeFile.filename,
                yml: ymlFile.filename,
                blockmap: blockmapFile ? blockmapFile.filename : null
            }
        });
        
    } catch (error) {
        console.error('Launcher upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// List launcher update files
app.get('/api/launcher/files', async (req, res) => {
    try {
        const updateDir = path.join(__dirname, '../../launcher-updates');
        const files = await fs.readdir(updateDir);
        
        const fileList = await Promise.all(files.map(async (file) => {
            const filePath = path.join(updateDir, file);
            const stats = await fs.stat(filePath);
            return {
                name: file,
                size: stats.size,
                modified: stats.mtime
            };
        }));
        
        res.json(fileList);
    } catch (error) {
        console.error('Error listing launcher files:', error);
        res.status(500).json({ error: error.message });
    }
});

// Authentication routes
app.post('/api/auth/register', checkDatabaseHealth, async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        // Check if account exists
        const [existing] = await authPool.execute(
            'SELECT id FROM account WHERE username = ? OR email = ?',
            [username.toUpperCase(), email]
        );

        if (existing.length > 0) {
            return res.status(409).json({ error: 'Username or email already exists' });
        }

        // Generate salt and verifier for SRP6
        const salt = srp6.generateSalt();
        const verifier = srp6.calculateVerifier(username, password, salt);

        console.log(`Registering user: ${username.toUpperCase()}`);

        // Insert new account
        const [result] = await authPool.execute(
            'INSERT INTO account (username, salt, verifier, email, reg_mail, joindate, expansion) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
            [username.toUpperCase(), salt, verifier, email, email, 2] // Expansion 2 for WotLK
        );

        res.json({
            success: true,
            message: 'Account created successfully! Please note: When logging into WoW, your password will be automatically converted to UPPERCASE. Use the password exactly as you entered it here in the launcher.'
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed: ' + error.message });
    }
});

app.post('/api/auth/login', checkDatabaseHealth, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    try {
        // Get account info
        const [accounts] = await authPool.execute(
            'SELECT id, username, salt, verifier, email, locked, expansion FROM account WHERE username = ?',
            [username.toUpperCase()]
        );

        if (accounts.length === 0) {
            console.log(`Login failed: User ${username.toUpperCase()} not found`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const account = accounts[0];

        // Check if account is locked
        if (account.locked) {
            return res.status(403).json({ error: 'Account is locked' });
        }

        console.log(`Attempting login for: ${account.username} (flexible mode: ${AUTH_MODE === 'flexible'})`);

        // Verify password using SRP6
        const isValidPassword = srp6.verifyPassword(
            username,
            password,
            account.salt,
            account.verifier
        );

        if (!isValidPassword) {
            console.log(`Login failed: Invalid password for ${username.toUpperCase()}`);
            if (AUTH_MODE === 'flexible') {
                return res.status(401).json({ 
                    error: 'Invalid credentials. Try your password in UPPERCASE or as you created it in-game.' 
                });
            } else {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
        }

        // Update last login
        await authPool.execute(
            'UPDATE account SET last_login = NOW() WHERE id = ?',
            [account.id]
        );

        // Generate token
        const token = generateToken(account.id, account.username);

        console.log(`Login successful for: ${account.username}`);

        res.json({
            success: true,
            token,
            username: account.username,
            email: account.email
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed: ' + error.message });
    }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
    res.json({
        valid: true,
        username: req.user.username,
        accountId: req.user.accountId
    });
});

// Characters routes
app.get('/api/characters', checkDatabaseHealth, authenticateToken, async (req, res) => {
    try {
        const [characters] = await charactersPool.execute(`
            SELECT 
                c.guid,
                c.name,
                c.race,
                c.class,
                c.gender,
                c.level,
                c.totaltime,
                c.totalKills,
                c.todayKills
            FROM characters c
            WHERE c.account = ?
            ORDER BY c.level DESC, c.totaltime DESC
        `, [req.user.accountId]);

        // Add realm name and calculate a simple gear score placeholder
        const charactersWithRealm = characters.map(char => ({
            ...char,
            realmName: REALM_NAME,
            gearScore: Math.round((char.level || 1) * 10 + Math.random() * 50) // Simple placeholder based on level
        }));

        res.json(charactersWithRealm);
    } catch (error) {
        console.error('Characters fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch characters' });
    }
});

// Get detailed character info
app.get('/api/characters/:guid', checkDatabaseHealth, authenticateToken, async (req, res) => {
    // Set cache-control headers to prevent caching
    res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    
    try {
        const guid = parseInt(req.params.guid);
        
        // Get character basic info
        const [character] = await charactersPool.execute(`
            SELECT 
                c.guid,
                c.name,
                c.race,
                c.class,
                c.gender,
                c.level,
                c.totaltime,
                c.totalKills,
                c.todayKills,
                c.money,
                c.map,
                c.zone,
                c.position_x,
                c.position_y,
                c.position_z
            FROM characters c
            WHERE c.guid = ? AND c.account = ?
        `, [guid, req.user.accountId]);

        if (character.length === 0) {
            return res.status(404).json({ error: 'Character not found' });
        }

        const char = character[0];

        // Get character equipment with actual item IDs from item_instance
        const [equipment] = await charactersPool.execute(`
            SELECT 
                ci.slot,
                ci.item as itemGuid,
                ii.itemEntry as itemId
            FROM character_inventory ci
            LEFT JOIN item_instance ii ON ci.item = ii.guid
            WHERE ci.guid = ? AND ci.bag = 0 AND ci.slot < 19
            ORDER BY ci.slot
        `, [guid]);

        // Get item details from world database for each equipped item
        const equipmentWithDetails = [];
        for (const item of equipment) {
            if (item.itemId && item.itemId > 0) {
                try {
                    const [itemDetails] = await itemPool.execute(`
                        SELECT name, Quality as quality
                        FROM items 
                        WHERE entry = ?
                    `, [item.itemId]);
                    
                    if (itemDetails.length > 0) {
                        // Clean up the item name by removing escaped quotes
                        let itemName = itemDetails[0].name || `Item ${item.itemId}`;
                        if (itemName.startsWith('"') && itemName.endsWith('"')) {
                            itemName = itemName.slice(1, -1);
                        }
                        
                        equipmentWithDetails.push({
                            slot: item.slot,
                            item: item.itemId,
                            name: itemName,
                            quality: itemDetails[0].quality || 0
                        });
                    } else {
                        equipmentWithDetails.push({
                            slot: item.slot,
                            item: item.itemId,
                            name: `Unknown Item (${item.itemId})`,
                            quality: 0
                        });
                    }
                } catch (itemError) {
                    console.error(`Database error when fetching item ${item.itemId}:`, itemError);
                    equipmentWithDetails.push({
                        slot: item.slot,
                        item: item.itemId,
                        name: `DB Error: Item ${item.itemId}`,
                        quality: 0
                    });
                }
            } else if (item.itemGuid) {
                // Handle case where item_instance lookup failed
                equipmentWithDetails.push({
                    slot: item.slot,
                    item: item.itemGuid,
                    name: `No ItemID for Guid ${item.itemGuid}`,
                    quality: 0
                });
            }
        }

        // Get character achievements (top 10 most recent)
        const [achievements] = await charactersPool.execute(`
            SELECT 
                ca.achievement,
                ca.date
            FROM character_achievement ca
            WHERE ca.guid = ?
            ORDER BY ca.date DESC
            LIMIT 10
        `, [guid]);

        // For achievements, just show IDs for now since structure varies
        const achievementsWithDetails = achievements.map(ach => ({
            id: ach.achievement,
            title: `Achievement ${ach.achievement}`,
            date: ach.date
        }));

        // Calculate gear score based on equipment
        let gearScore = 0;
        equipmentWithDetails.forEach(item => {
            if (item.quality) {
                gearScore += (item.quality + 1) * 10; // Simple calculation based on item quality
            }
        });

        // Map zones and areas (simplified mapping for common zones)
        const zoneMap = {
            1: 'Dun Morogh',
            12: 'Elwynn Forest', 
            14: 'Duskwood',
            17: 'The Barrens',
            85: 'Tirisfal Glades',
            141: 'Teldrassil',
            148: 'Darkshore',
            215: 'Mulgore',
            1519: 'Stormwind City',
            1637: 'Orgrimmar',
            3430: 'Eversong Woods',
            3433: 'Silvermoon City',
            3525: 'The Exodar',
            3557: 'Azuremyst Isle'
        };

        const characterDetails = {
            ...char,
            realmName: REALM_NAME,
            gearScore: Math.max(gearScore, Math.round((char.level || 1) * 10)), // Ensure minimum gear score
            location: {
                zone: zoneMap[char.zone] || `Zone ${char.zone}`,
                map: char.map,
                coordinates: {
                    x: parseFloat(char.position_x).toFixed(2),
                    y: parseFloat(char.position_y).toFixed(2),
                    z: parseFloat(char.position_z).toFixed(2)
                }
            },
            gold: {
                total: char.money || 0,
                gold: Math.floor((char.money || 0) / 10000),
                silver: Math.floor(((char.money || 0) % 10000) / 100),
                copper: (char.money || 0) % 100
            },
            equipment: equipmentWithDetails.map(item => ({
                slot: item.slot,
                itemId: item.item,
                name: item.name || 'Unknown Item',
                quality: item.quality || 0
            })),
            achievements: achievementsWithDetails
        };

        res.json(characterDetails);
    } catch (error) {
        console.error('Character details fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch character details' });
    }
});



// News routes
app.get('/api/news', async (req, res) => {
    try {
        const fs = require('fs-extra');
        const newsFile = require('path').join(__dirname, '../../news.json');
        
        // Create empty news file if it doesn't exist
        if (!await fs.pathExists(newsFile)) {
            await fs.writeJson(newsFile, []);
        }
        
        const news = await fs.readJson(newsFile);
        res.json(news);
    } catch (error) {
        console.error('News fetch error:', error);
        res.json([]); // Return empty array if file doesn't exist
    }
});

// Create news
app.post('/api/news', async (req, res) => {
    try {
        const { title, content, author } = req.body;
        
        if (!title || !content || !author) {
            return res.status(400).json({ error: 'Title, content, and author are required' });
        }
        
        const fs = require('fs-extra');
        const newsFile = require('path').join(__dirname, '../../news.json');
        
        // Create empty news file if it doesn't exist
        let news = [];
        if (await fs.pathExists(newsFile)) {
            news = await fs.readJson(newsFile);
        }
        
        const newItem = {
            id: Date.now(),
            title,
            content,
            author,
            date: new Date().toISOString(),
            published: true
        };
        
        news.unshift(newItem); // Add to beginning
        await fs.writeJson(newsFile, news, { spaces: 2 });
        
        console.log(`News created: "${title}" by ${author}`);
        res.json(newItem);
    } catch (error) {
        console.error('News creation error:', error);
        res.status(500).json({ error: 'Failed to create news' });
    }
});

// Update news
app.put('/api/news/:id', async (req, res) => {
    try {
        const { title, content, author } = req.body;
        const newsId = parseInt(req.params.id);
        
        const fs = require('fs-extra');
        const newsFile = require('path').join(__dirname, '../../news.json');
        
        if (!await fs.pathExists(newsFile)) {
            return res.status(404).json({ error: 'News not found' });
        }
        
        const news = await fs.readJson(newsFile);
        const itemIndex = news.findIndex(item => item.id === newsId);
        
        if (itemIndex === -1) {
            return res.status(404).json({ error: 'News item not found' });
        }
        
        // Update the item
        news[itemIndex] = {
            ...news[itemIndex],
            title: title || news[itemIndex].title,
            content: content || news[itemIndex].content,
            author: author || news[itemIndex].author,
            date: new Date().toISOString() // Update timestamp
        };
        
        await fs.writeJson(newsFile, news, { spaces: 2 });
        
        console.log(`News updated: "${news[itemIndex].title}"`);
        res.json(news[itemIndex]);
    } catch (error) {
        console.error('News update error:', error);
        res.status(500).json({ error: 'Failed to update news' });
    }
});

// Delete news
app.delete('/api/news/:id', async (req, res) => {
    try {
        const newsId = parseInt(req.params.id);
        
        const fs = require('fs-extra');
        const newsFile = require('path').join(__dirname, '../../news.json');
        
        if (!await fs.pathExists(newsFile)) {
            return res.status(404).json({ error: 'News not found' });
        }
        
        const news = await fs.readJson(newsFile);
        const item = news.find(item => item.id === newsId);
        
        if (!item) {
            return res.status(404).json({ error: 'News item not found' });
        }
        
        const filtered = news.filter(item => item.id !== newsId);
        await fs.writeJson(newsFile, filtered, { spaces: 2 });
        
        console.log(`News deleted: "${item.title}"`);
        res.json({ success: true, message: 'News deleted successfully' });
    } catch (error) {
        console.error('News deletion error:', error);
        res.status(500).json({ error: 'Failed to delete news' });
    }
});

// Updates routes
app.get('/api/updates/check', async (req, res) => {
    try {
        const fs = require('fs-extra');
        const updatesFile = require('path').join(__dirname, '../../updates.json');
        const updates = await fs.readJson(updatesFile);
        
        const currentVersion = req.query.version || '3.3.5a';
        
        // Check if there's a newer version
        const hasUpdate = updates.patches.length > 0 && 
                         updates.currentVersion !== currentVersion;
        
        if (hasUpdate) {
            const latestPatch = updates.patches[0];
            res.json({
                available: true,
                currentVersion: currentVersion,
                latestVersion: updates.currentVersion,
                version: updates.currentVersion,
                description: latestPatch.description,
                downloadUrl: `/api/updates/download/${latestPatch.id}`,
                size: latestPatch.size,
                critical: latestPatch.critical
            });
        } else {
            res.json({
                available: false,
                currentVersion: currentVersion,
                latestVersion: currentVersion
            });
        }
    } catch (error) {
        console.error('Update check error:', error);
        res.status(500).json({ error: 'Failed to check for updates' });
    }
});

// Download update
app.get('/api/updates/download/:id', async (req, res) => {
    try {
        const fs = require('fs-extra');
        const path = require('path');
        const updatesFile = path.join(__dirname, '../../updates.json');
        const updates = await fs.readJson(updatesFile);
        
        const patch = updates.patches.find(p => p.id == req.params.id);
        if (!patch) {
            return res.status(404).json({ error: 'Patch not found' });
        }
        
        const patchPath = path.join(__dirname, '../../patches/releases', patch.fileName);
        if (await fs.pathExists(patchPath)) {
            res.download(patchPath, patch.fileName);
        } else {
            res.status(404).json({ error: 'Patch file not found' });
        }
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to download patch' });
    }
});

// Upload patch (for dev-tool)
app.post('/api/updates/upload', upload.single('patch'), async (req, res) => {
    try {
        const { version, description, critical } = req.body;
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        console.log(`Uploading patch ${version}...`);
        
        // Calculate file hash
        const fileBuffer = await fs.readFile(file.path);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        
        // Move file to releases directory
        const fileName = `patch-${version}-${Date.now()}.zip`;
        const releasesDir = path.join(__dirname, '../../patches/releases');
        await fs.ensureDir(releasesDir);
        const finalPath = path.join(releasesDir, fileName);
        await fs.move(file.path, finalPath);
        
        // Update patches list
        const updatesFile = path.join(__dirname, '../../updates.json');
        let updates;
        try {
            updates = await fs.readJson(updatesFile);
        } catch (error) {
            // Create new updates file if it doesn't exist
            updates = {
                currentVersion: '3.3.5a',
                patches: []
            };
        }
        
        const patchInfo = {
            id: Date.now(),
            version,
            description,
            critical: critical === 'true' || critical === true,
            fileName,
            size: file.size,
            hash,
            releaseDate: new Date().toISOString(),
            downloadCount: 0
        };
        
        updates.patches.unshift(patchInfo);
        updates.currentVersion = version;
        
        await fs.writeJson(updatesFile, updates, { spaces: 2 });
        
        console.log(`Patch ${version} uploaded successfully!`);
        res.json(patchInfo);
        
    } catch (error) {
        console.error('Upload error:', error);
        
        // Clean up uploaded file on error
        if (req.file && req.file.path) {
            try {
                await fs.remove(req.file.path);
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }
        }
        
        res.status(500).json({ error: error.message });
    }
});

// Delete patch
app.delete('/api/updates/:id', async (req, res) => {
    try {
        const updatesFile = path.join(__dirname, '../../updates.json');
        const updates = await fs.readJson(updatesFile);
        const patch = updates.patches.find(p => p.id == req.params.id);
        
        if (patch) {
            // Delete file
            const filePath = path.join(__dirname, '../../patches/releases', patch.fileName);
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
            }
            
            // Remove from list
            updates.patches = updates.patches.filter(p => p.id != req.params.id);
            await fs.writeJson(updatesFile, updates, { spaces: 2 });
            
            console.log(`Patch ${patch.version} deleted successfully`);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete patch' });
    }
});

// ========================================
// SHOP API ROUTES
// ========================================

// Get shop categories
app.get('/api/shop/categories', async (req, res) => {
    try {
        const [categories] = await shopPool.execute(`
            SELECT id, name, description, icon, sort_order
            FROM shop_categories 
            WHERE active = 1 
            ORDER BY sort_order ASC, name ASC
        `);
        
        res.json(categories);
    } catch (error) {
        console.error('Shop categories fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch shop categories' });
    }
});

// Get shop items by category
app.get('/api/shop/items/:categoryId', async (req, res) => {
    try {
        const categoryId = parseInt(req.params.categoryId);
        
        const [items] = await shopPool.execute(`
            SELECT id, name, description, icon, price_gold, item_type, 
                   stock_quantity, purchases_count, sort_order
            FROM shop_items 
            WHERE category_id = ? AND active = 1 
            ORDER BY sort_order ASC, name ASC
        `, [categoryId]);
        
        res.json(items);
    } catch (error) {
        console.error('Shop items fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch shop items' });
    }
});

// Get all shop items (for admin/dev-tool)
app.get('/api/shop/items', async (req, res) => {
    try {
        const [items] = await shopPool.execute(`
            SELECT si.*, sc.name as category_name
            FROM shop_items si
            LEFT JOIN shop_categories sc ON si.category_id = sc.id
            ORDER BY si.category_id, si.sort_order ASC, si.name ASC
        `);
        
        res.json(items);
    } catch (error) {
        console.error('Shop items fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch shop items' });
    }
});

// Helper function to deliver items to character via database-stored commands
async function deliverItemToCharacter(connection, character, shopItem, quantity) {
    try {
        console.log(`Delivering ${shopItem.item_type} "${shopItem.name}" to ${character.name}`);
        
        // Get commands for this item from database
        const [commands] = await shopPool.execute(`
            SELECT command_template, description, execution_order
            FROM shop_item_commands 
            WHERE item_id = ? AND active = 1 
            ORDER BY execution_order ASC
        `, [shopItem.id]);
        
        if (commands.length === 0) {
            console.warn(`No commands found for item ${shopItem.id} (${shopItem.name})`);
            return;
        }
        
        console.log(`Found ${commands.length} commands to execute for ${shopItem.name}`);
        
        // Execute each command in order
        for (const cmd of commands) {
            // Replace placeholders in command template
            let finalCommand = cmd.command_template
                .replace(/\{\{character_name\}\}/g, character.name)
                .replace(/\{\{quantity\}\}/g, quantity);
            
            console.log(`📋 Executing: ${cmd.description}`);
            await sendServerCommand(finalCommand);
        }
        
        console.log(`✅ All commands executed for ${shopItem.name}`);
        
    } catch (error) {
        console.error('Error delivering item to character:', error);
        throw error;
    }
}

// Remote console command functions using HTTP POST (AzerothCore SOAP style)
async function sendServerCommand(command) {
    try {
        console.log(`🎮 SENDING SOAP COMMAND: ${command}`);
        
        const soapUrl = `http://${SOAP_HOST}:${SOAP_PORT}/`;
        console.log(`🔗 Sending command to ${soapUrl}`);
        
        // AzerothCore SOAP envelope format
        const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:AC">
  <soap:Body>
    <tns:executeCommand>
      <command>${command}</command>
    </tns:executeCommand>
  </soap:Body>
</soap:Envelope>`;

        const authString = Buffer.from(`${SOAP_USERNAME}:${SOAP_PASSWORD}`).toString('base64');
        
        const response = await axios.post(soapUrl, soapEnvelope, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': '"urn:AC#executeCommand"',
                'Authorization': `Basic ${authString}`
            },
            timeout: 10000, // 10 second timeout
            validateStatus: false // Don't throw on 4xx/5xx status codes
        });

        console.log(`📡 SOAP Response Status: ${response.status}`);
        console.log(`📡 SOAP Response Headers:`, response.headers);
        console.log(`📡 SOAP Response Data:`, response.data);

        if (response.status !== 200) {
            console.error(`❌ SOAP server returned status ${response.status}`);
            console.error(`❌ Response body:`, response.data);
            throw new Error(`SOAP server error ${response.status}: ${response.data || response.statusText}`);
        }

        console.log(`✅ SOAP command executed successfully. Response:`, response.data);
        
        return response.data;
        
    } catch (error) {
        if (error.response) {
            console.error(`❌ SOAP HTTP Error ${error.response.status}:`, error.response.data);
            throw new Error(`SOAP HTTP error ${error.response.status}: ${error.response.data}`);
        } else if (error.request) {
            console.error(`❌ SOAP Network Error:`, error.message);
            throw new Error(`SOAP network error: ${error.message}`);
        } else {
            console.error(`❌ SOAP Request Error:`, error.message);
            throw new Error(`SOAP request error: ${error.message}`);
        }
    }
}


// Purchase shop item
app.post('/api/shop/purchase', authenticateToken, async (req, res) => {
    try {
        const { itemId, paymentCharacterGuid, recipientCharacterGuid, quantity = 1 } = req.body;
        
        if (!itemId || !paymentCharacterGuid || !recipientCharacterGuid) {
            return res.status(400).json({ error: 'Item ID, payment character GUID, and recipient character GUID are required' });
        }
        
        // Get item details
        const [items] = await shopPool.execute(`
            SELECT id, name, price_gold, item_type, item_data, stock_quantity
            FROM shop_items 
            WHERE id = ? AND active = 1
        `, [itemId]);
        
        if (items.length === 0) {
            return res.status(404).json({ error: 'Item not found or inactive' });
        }
        
        const item = items[0];
        const totalPrice = item.price_gold * quantity;
        
        // Check stock
        if (item.stock_quantity !== -1 && item.stock_quantity < quantity) {
            return res.status(400).json({ error: 'Insufficient stock' });
        }
        
        // Get payment character details and verify ownership
        const [paymentCharacters] = await charactersPool.execute(`
            SELECT guid, name, money, account
            FROM characters 
            WHERE guid = ? AND account = ?
        `, [paymentCharacterGuid, req.user.accountId]);
        
        if (paymentCharacters.length === 0) {
            return res.status(404).json({ error: 'Payment character not found or not owned by you' });
        }
        
        // Get recipient character details and verify ownership
        const [recipientCharacters] = await charactersPool.execute(`
            SELECT guid, name, account, online
            FROM characters 
            WHERE guid = ? AND account = ?
        `, [recipientCharacterGuid, req.user.accountId]);
        
        if (recipientCharacters.length === 0) {
            return res.status(404).json({ error: 'Recipient character not found or not owned by you' });
        }
        
        const paymentCharacter = paymentCharacters[0];
        const recipientCharacter = recipientCharacters[0];
        
        // Check if recipient character is online - must be offline to purchase
        if (recipientCharacter.online === 1) {
            return res.status(400).json({ 
                error: 'Character must be offline to purchase items',
                characterName: recipientCharacter.name,
                code: 'CHARACTER_ONLINE'
            });
        }
        
        // Check if payment character has enough gold
        if (paymentCharacter.money < totalPrice) {
            return res.status(400).json({ 
                error: 'Insufficient gold',
                required: totalPrice,
                available: paymentCharacter.money,
                shortfall: totalPrice - paymentCharacter.money
            });
        }
        
        // Start transaction
        const connection = await charactersPool.getConnection();
        await connection.beginTransaction();
        
        try {
            // Deduct gold from payment character
            await connection.execute(`
                UPDATE characters 
                SET money = money - ? 
                WHERE guid = ? AND account = ?
            `, [totalPrice, paymentCharacterGuid, req.user.accountId]);
            
            // Deliver item to recipient character
            await deliverItemToCharacter(connection, recipientCharacter, item, quantity);
            
            // Record transaction
            await shopPool.execute(`
                INSERT INTO shop_transactions 
                (account_id, character_guid, item_id, quantity, price_paid, character_name, status, completed_date)
                VALUES (?, ?, ?, ?, ?, ?, 'completed', NOW())
            `, [req.user.accountId, recipientCharacterGuid, itemId, quantity, totalPrice, recipientCharacter.name]);
            
            // Update item purchase count and stock
            if (item.stock_quantity !== -1) {
                await shopPool.execute(`
                    UPDATE shop_items 
                    SET purchases_count = purchases_count + ?, stock_quantity = stock_quantity - ?
                    WHERE id = ?
                `, [quantity, quantity, itemId]);
            } else {
                await shopPool.execute(`
                    UPDATE shop_items 
                    SET purchases_count = purchases_count + ?
                    WHERE id = ?
                `, [quantity, itemId]);
            }
            
            await connection.commit();
            
            const goldAmount = Math.floor(totalPrice / 10000);
            const silverAmount = Math.floor((totalPrice % 10000) / 100);
            const copperAmount = totalPrice % 100;
            
            let priceDisplay = '';
            if (goldAmount > 0) priceDisplay += `${goldAmount}g `;
            if (silverAmount > 0) priceDisplay += `${silverAmount}s `;
            if (copperAmount > 0) priceDisplay += `${copperAmount}c`;
            if (!priceDisplay) priceDisplay = '0c';
            
            console.log(`Shop purchase completed: ${paymentCharacter.name} paid ${priceDisplay.trim()} for ${quantity}x ${item.name} delivered to ${recipientCharacter.name}`);
            
            res.json({
                success: true,
                message: `Successfully purchased ${quantity}x ${item.name} for ${recipientCharacter.name}`,
                transaction: {
                    itemName: item.name,
                    quantity: quantity,
                    pricePaid: totalPrice,
                    paymentCharacterName: paymentCharacter.name,
                    recipientCharacterName: recipientCharacter.name,
                    remainingGold: paymentCharacter.money - totalPrice
                }
            });
            
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
        
    } catch (error) {
        console.error('Shop purchase error:', error);
        res.status(500).json({ error: 'Failed to complete purchase: ' + error.message });
    }
});

// Get character gold for shop display
app.get('/api/shop/character-gold/:guid', authenticateToken, async (req, res) => {
    try {
        const guid = parseInt(req.params.guid);
        
        const [characters] = await charactersPool.execute(`
            SELECT guid, name, money 
            FROM characters 
            WHERE guid = ? AND account = ?
        `, [guid, req.user.accountId]);
        
        if (characters.length === 0) {
            return res.status(404).json({ error: 'Character not found' });
        }
        
        const character = characters[0];
        
        res.json({
            guid: character.guid,
            name: character.name,
            totalGold: character.money,
            gold: Math.floor(character.money / 10000),
            silver: Math.floor((character.money % 10000) / 100),
            copper: character.money % 100
        });
        
    } catch (error) {
        console.error('Character gold fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch character gold' });
    }
});

// Get purchase history for account
app.get('/api/shop/purchases', authenticateToken, async (req, res) => {
    try {
        const [purchases] = await shopPool.execute(`
            SELECT st.*, si.name as item_name, si.item_type
            FROM shop_transactions st
            LEFT JOIN shop_items si ON st.item_id = si.id
            WHERE st.account_id = ?
            ORDER BY st.transaction_date DESC
            LIMIT 50
        `, [req.user.accountId]);
        
        res.json(purchases);
    } catch (error) {
        console.error('Purchase history fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch purchase history' });
    }
});

// Admin routes for shop management (dev-tool)

// Create shop category
app.post('/api/shop/admin/categories', async (req, res) => {
    try {
        const { name, description, icon, sortOrder } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Category name is required' });
        }
        
        const [result] = await shopPool.execute(`
            INSERT INTO shop_categories (name, description, icon, sort_order)
            VALUES (?, ?, ?, ?)
        `, [name, description, icon, sortOrder || 0]);
        
        res.json({ success: true, categoryId: result.insertId });
    } catch (error) {
        console.error('Category creation error:', error);
        res.status(500).json({ error: 'Failed to create category' });
    }
});

// Update shop category
app.put('/api/shop/admin/categories/:id', async (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        const { name, description, icon, sortOrder, active } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Category name is required' });
        }
        
        const [result] = await shopPool.execute(`
            UPDATE shop_categories 
            SET name = ?, description = ?, icon = ?, sort_order = ?, active = ?
            WHERE id = ?
        `, [name, description || null, icon || null, sortOrder || 0, active !== undefined ? active : 1, categoryId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Category update error:', error);
        res.status(500).json({ error: 'Failed to update category' });
    }
});

// Delete shop category
app.delete('/api/shop/admin/categories/:id', async (req, res) => {
    try {
        const categoryId = parseInt(req.params.id);
        
        const [result] = await shopPool.execute(`
            DELETE FROM shop_categories WHERE id = ?
        `, [categoryId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Category deletion error:', error);
        res.status(500).json({ error: 'Failed to delete category' });
    }
});

// Create shop item
app.post('/api/shop/admin/items', async (req, res) => {
    try {
        const { categoryId, name, description, icon, priceGold, itemType, itemData, stockQuantity, sortOrder } = req.body;
        
        if (!categoryId || !name || !priceGold || !itemType) {
            return res.status(400).json({ error: 'Category ID, name, price, and item type are required' });
        }
        
        const [result] = await shopPool.execute(`
            INSERT INTO shop_items (category_id, name, description, icon, price_gold, item_type, item_data, stock_quantity, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            categoryId, 
            name, 
            description || null, 
            icon || null, 
            priceGold, 
            itemType, 
            itemData ? JSON.stringify(itemData) : null, 
            stockQuantity || -1, 
            sortOrder || 0
        ]);
        
        res.json({ success: true, itemId: result.insertId });
    } catch (error) {
        console.error('Item creation error:', error);
        res.status(500).json({ error: 'Failed to create item' });
    }
});

// Update shop item
app.put('/api/shop/admin/items/:id', async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const { categoryId, name, description, icon, priceGold, itemType, itemData, stockQuantity, sortOrder, active } = req.body;
        
        const [result] = await shopPool.execute(`
            UPDATE shop_items 
            SET category_id = COALESCE(?, category_id),
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                icon = COALESCE(?, icon),
                price_gold = COALESCE(?, price_gold),
                item_type = COALESCE(?, item_type),
                item_data = COALESCE(?, item_data),
                stock_quantity = COALESCE(?, stock_quantity),
                sort_order = COALESCE(?, sort_order),
                active = COALESCE(?, active)
            WHERE id = ?
        `, [categoryId, name, description, icon, priceGold, itemType, 
            itemData ? JSON.stringify(itemData) : null, stockQuantity, sortOrder, active, itemId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Item update error:', error);
        res.status(500).json({ error: 'Failed to update item' });
    }
});

// Delete shop item
app.delete('/api/shop/admin/items/:id', async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        
        const [result] = await shopPool.execute(`
            DELETE FROM shop_items WHERE id = ?
        `, [itemId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Item deletion error:', error);
        res.status(500).json({ error: 'Failed to delete item' });
    }
});

// Shop command management routes

// Get commands for a shop item
app.get('/api/shop/admin/items/:id/commands', async (req, res) => {
    try {
        const [commands] = await shopPool.execute(`
            SELECT id, command_template, execution_order, description, active
            FROM shop_item_commands 
            WHERE item_id = ?
            ORDER BY execution_order ASC
        `, [req.params.id]);
        
        res.json(commands);
    } catch (error) {
        console.error('Shop commands fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch commands' });
    }
});

// Add command to shop item  
app.post('/api/shop/admin/items/:id/commands', async (req, res) => {
    try {
        const { commandTemplate, description, executionOrder } = req.body;
        
        if (!commandTemplate) {
            return res.status(400).json({ error: 'Command template is required' });
        }
        
        const [result] = await shopPool.execute(`
            INSERT INTO shop_item_commands (item_id, command_template, description, execution_order)
            VALUES (?, ?, ?, ?)
        `, [req.params.id, commandTemplate, description || '', executionOrder || 0]);
        
        console.log(`Shop command added to item ${req.params.id}: "${commandTemplate}"`);
        res.json({ success: true, commandId: result.insertId });
    } catch (error) {
        console.error('Shop command creation error:', error);
        res.status(500).json({ error: 'Failed to create command' });
    }
});

// Update shop command
app.put('/api/shop/admin/commands/:id', async (req, res) => {
    try {
        const { commandTemplate, description, executionOrder, active } = req.body;
        
        const [result] = await shopPool.execute(`
            UPDATE shop_item_commands 
            SET command_template = COALESCE(?, command_template),
                description = COALESCE(?, description),
                execution_order = COALESCE(?, execution_order),
                active = COALESCE(?, active)
            WHERE id = ?
        `, [commandTemplate, description, executionOrder, active, req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Command not found' });
        }
        
        console.log(`Shop command updated: ID ${req.params.id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Shop command update error:', error);
        res.status(500).json({ error: 'Failed to update command' });
    }
});

// Delete shop command
app.delete('/api/shop/admin/commands/:id', async (req, res) => {
    try {
        const [result] = await shopPool.execute(`
            DELETE FROM shop_item_commands WHERE id = ?
        `, [req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Command not found' });
        }
        
        console.log(`Shop command deleted: ID ${req.params.id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Shop command deletion error:', error);
        res.status(500).json({ error: 'Failed to delete command' });
    }
});

// Enhanced error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    // Don't leak error details in production
    const isProduction = process.env.NODE_ENV === 'production';
    const errorResponse = {
        error: isProduction ? 'Internal server error' : err.message,
        code: 'INTERNAL_ERROR'
    };
    
    if (!isProduction) {
        errorResponse.stack = err.stack;
    }
    
    res.status(500).json(errorResponse);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        databases: dbConnectionHealth,
        uptime: process.uptime()
    });
});

// Start server with proper initialization
async function startServer() {
    try {
        console.log('🚀 Starting WoW Launcher Backend Server...');
        console.log('=' .repeat(60));
        
        // Initialize databases first
        await initializeDatabases();
        
        // Setup launcher updates directory
        await ensureLauncherUpdatesDir();
        
        // Setup graceful shutdown
        setupGracefulShutdown();
        
        const HOST = process.env.HOST || '0.0.0.0';
        
        const server = app.listen(PORT, HOST, () => {
            console.log('✅ Backend server started successfully!');
            console.log('');
            console.log('📍 Server Information:');
            console.log(`   Local: http://localhost:${PORT}`);
            console.log(`   Network: http://${HOST}:${PORT}`);
            console.log(`   External: ${SERVER_PUBLIC_URL}`);
            console.log('');
            console.log('🔗 API Endpoints:');
            console.log(`   Health Check: ${SERVER_PUBLIC_URL}/health`);
            console.log(`   Launcher Updates: ${SERVER_PUBLIC_URL}/updates/latest.json`);
            console.log(`   API Base: ${SERVER_PUBLIC_URL}/api`);
            console.log('');
            console.log('⚙️  Configuration:');
            console.log(`   WoW Server: ${WOW_SERVER_IP}:${WOW_SERVER_PORT}`);
            console.log(`   Auth Mode: ${AUTH_MODE}`);
            console.log(`   Rate Limit: 1000 requests per 15 minutes`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            
            if (AUTH_MODE === 'flexible') {
                console.log('   Password Format: Flexible (tries multiple formats)');
            }
            
            console.log('=' .repeat(60));
            console.log('🎮 Server ready to accept connections!');
        });
        
        // Handle server startup errors
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use`);
                process.exit(1);
            } else {
                console.error('❌ Server startup error:', error);
                process.exit(1);
            }
        });
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Setup graceful shutdown handlers
function setupGracefulShutdown() {
    const cleanup = async (signal) => {
        console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);
        
        try {
            // Close database connections
            if (authPool) await authPool.end();
            if (charactersPool) await charactersPool.end();
            if (worldPool) await worldPool.end();
            if (itemPool) await itemPool.end();
            if (shopPool) await shopPool.end();
            
            console.log('✅ Database connections closed');
            console.log('👋 Server shutdown complete');
            process.exit(0);
        } catch (error) {
            console.error('❌ Error during shutdown:', error);
            process.exit(1);
        }
    };
    
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGINT', () => cleanup('SIGINT'));
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught Exception:', error);
        cleanup('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        cleanup('UNHANDLED_REJECTION');
    });
}

startServer();