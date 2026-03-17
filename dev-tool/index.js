require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.DEV_TOOL_PORT || 3002;

// Backend API configuration
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001/api';
const BACKEND_BASE_URL = BACKEND_URL.replace('/api', '');

// Request configuration
const REQUEST_TIMEOUT = 30000; // 30 seconds for file uploads
const MAX_RETRIES = 3;

// Configure axios defaults
axios.defaults.timeout = REQUEST_TIMEOUT;
axios.defaults.headers.common['User-Agent'] = 'WoW-DevTool/1.0';

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Enhanced error handling middleware
app.use((err, req, res, next) => {
    console.error('Dev tool error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large' });
        }
    }
    
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
        error: isProduction ? 'Internal server error' : err.message
    });
});

// Enhanced multer configuration with better security
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'temp');
        await fs.ensureDir(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Sanitize filename
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniqueName = `${file.fieldname}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${sanitizedName}`;
        cb(null, uniqueName);
    }
});

// File filter for security
const fileFilter = (req, file, cb) => {
    const allowedTypes = {
        'patch': ['.zip', '.rar', '.7z'],
        'exe': ['.exe'],
        'yml': ['.yml', '.yaml'],
        'blockmap': ['.blockmap']
    };
    
    const ext = path.extname(file.originalname).toLowerCase();
    const fieldAllowedTypes = allowedTypes[file.fieldname] || [];
    
    if (fieldAllowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type for ${file.fieldname}: ${ext}`));
    }
};

const upload = multer({ 
    storage,
    fileFilter,
    limits: {
        fileSize: 500 * 1024 * 1024, // 500MB
        files: 10
    }
});

// Enhanced launcher upload configuration
const launcherUpload = multer({
    storage: multer.diskStorage({
        destination: async (req, file, cb) => {
            const uploadDir = path.join(__dirname, 'temp', 'launcher');
            await fs.ensureDir(uploadDir);
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            // Keep original names for launcher files but sanitize
            const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            cb(null, sanitizedName);
        }
    }),
    fileFilter,
    limits: {
        fileSize: 200 * 1024 * 1024, // 200MB limit for launcher files
        files: 5
    }
});

// Helper function for making API requests with retry logic
async function makeApiRequest(method, url, data = null, options = {}) {
    let retries = 0;
    
    while (retries < MAX_RETRIES) {
        try {
            const config = {
                method,
                url: url.startsWith('http') ? url : `${BACKEND_URL}${url}`,
                timeout: REQUEST_TIMEOUT,
                ...options
            };
            
            if (data) {
                if (data instanceof FormData) {
                    config.data = data;
                    config.headers = { ...config.headers, ...data.getHeaders() };
                } else {
                    config.data = data;
                    config.headers = { 'Content-Type': 'application/json', ...config.headers };
                }
            }
            
            const response = await axios(config);
            return { success: true, data: response.data, status: response.status };
            
        } catch (error) {
            retries++;
            
            if (error.response) {
                // Server responded with error status
                const status = error.response.status;
                
                // Don't retry client errors (4xx)
                if (status >= 400 && status < 500) {
                    return {
                        success: false,
                        error: error.response.data?.error || error.response.data?.message || 'Request failed',
                        status: status,
                        code: error.response.data?.code
                    };
                }
            }
            
            // Retry for network errors or server errors
            if (retries >= MAX_RETRIES) {
                return {
                    success: false,
                    error: error.response?.data?.error || error.message || 'Request failed',
                    status: error.response?.status,
                    retries: retries
                };
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
    }
}

// Initialize temp directory and cleanup old files
async function initialize() {
    try {
        const tempDir = path.join(__dirname, 'temp');
        const launcherTempDir = path.join(__dirname, 'temp', 'launcher');
        
        await fs.ensureDir(tempDir);
        await fs.ensureDir(launcherTempDir);
        
        // Clean up old temporary files (older than 1 hour)
        await cleanupOldFiles(tempDir);
        await cleanupOldFiles(launcherTempDir);
        
        console.log('✅ Dev tool initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize dev tool:', error);
        throw error;
    }
}

// Cleanup old temporary files
async function cleanupOldFiles(directory) {
    try {
        const files = await fs.readdir(directory);
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        
        for (const file of files) {
            const filePath = path.join(directory, file);
            const stats = await fs.stat(filePath);
            
            if (stats.mtime.getTime() < oneHourAgo) {
                await fs.remove(filePath);
                console.log(`🗑️ Cleaned up old temp file: ${file}`);
            }
        }
    } catch (error) {
        console.warn('⚠️ Failed to cleanup old files:', error.message);
    }
}

// Routes

// Enhanced dashboard data retrieval
app.get('/api/dashboard', async (req, res) => {
    try {
        // Use Promise.allSettled to handle partial failures gracefully
        const [newsResult, updatesResult, launcherFilesResult] = await Promise.allSettled([
            makeApiRequest('GET', '/news'),
            makeApiRequest('GET', '/updates/check'),
            makeApiRequest('GET', '/launcher/files')
        ]);
        
        // Process results with fallbacks
        const news = newsResult.status === 'fulfilled' && newsResult.value.success 
            ? newsResult.value.data || [] 
            : [];
            
        const updates = updatesResult.status === 'fulfilled' && updatesResult.value.success
            ? updatesResult.value.data || { patches: [], currentVersion: '3.3.5a' }
            : { patches: [], currentVersion: '3.3.5a' };
            
        const launcherFiles = launcherFilesResult.status === 'fulfilled' && launcherFilesResult.value.success
            ? launcherFilesResult.value.data || []
            : [];
        
        // Log any failures
        if (newsResult.status === 'rejected') {
            console.warn('⚠️ Failed to fetch news:', newsResult.reason?.message);
        }
        if (updatesResult.status === 'rejected') {
            console.warn('⚠️ Failed to fetch updates:', updatesResult.reason?.message);
        }
        if (launcherFilesResult.status === 'rejected') {
            console.warn('⚠️ Failed to fetch launcher files:', launcherFilesResult.reason?.message);
        }
        
        res.json({
            news: news.slice(0, 5),
            updates,
            launcherFiles,
            stats: {
                totalNews: news.length,
                totalPatches: updates.patches ? updates.patches.length : 0,
                currentVersion: updates.currentVersion || '3.3.5a',
                launcherFiles: launcherFiles.length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Dashboard error:', error);
        res.status(500).json({ 
            error: 'Failed to load dashboard data',
            details: error.message 
        });
    }
});

// News management
app.get('/api/news', async (req, res) => {
    try {
        const response = await axios.get(`${BACKEND_URL}/news`);
        res.json(response.data);
    } catch (error) {
        console.error('News fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/news', async (req, res) => {
    try {
        const { title, content, author } = req.body;
        
        if (!title || !content || !author) {
            return res.status(400).json({ error: 'Title, content, and author are required' });
        }
        
        // Create news via backend API
        const response = await axios.post(`${BACKEND_URL}/news`, {
            title,
            content,
            author
        });
        
        console.log(`News created: "${title}" by ${author}`);
        res.json(response.data);
        
    } catch (error) {
        console.error('News creation error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.delete('/api/news/:id', async (req, res) => {
    try {
        const response = await axios.delete(`${BACKEND_URL}/news/${req.params.id}`);
        
        console.log(`News deleted: ID ${req.params.id}`);
        res.json(response.data);
        
    } catch (error) {
        console.error('News deletion error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

// Game Update/Patch management
app.get('/api/updates', async (req, res) => {
    try {
        const response = await axios.get(`${BACKEND_URL}/updates/check`);
        res.json(response.data);
    } catch (error) {
        console.error('Updates fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/updates/upload', upload.single('patch'), async (req, res) => {
    try {
        const { version, description, critical } = req.body;
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        console.log(`Uploading game patch ${version} to backend server...`);
        
        // Create FormData for multipart upload to backend
        const formData = new FormData();
        formData.append('patch', fs.createReadStream(file.path), {
            filename: file.originalname,
            contentType: 'application/zip'
        });
        formData.append('version', version);
        formData.append('description', description);
        formData.append('critical', critical);
        
        // Upload to backend server
        const response = await axios.post(`${BACKEND_URL}/updates/upload`, formData, {
            headers: {
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        // Clean up temporary file
        await fs.remove(file.path);
        
        console.log('Game patch uploaded successfully!');
        res.json(response.data);
        
    } catch (error) {
        console.error('Upload error:', error);
        
        // Clean up temporary file on error
        if (req.file) {
            try {
                await fs.remove(req.file.path);
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }
        }
        
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.delete('/api/updates/:id', async (req, res) => {
    try {
        const response = await axios.delete(`${BACKEND_URL}/updates/${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Patch deletion error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

// Launcher Update management
app.get('/api/launcher/files', async (req, res) => {
    try {
        const response = await axios.get(`${BACKEND_URL}/launcher/files`);
        res.json(response.data);
    } catch (error) {
        console.error('Launcher files fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

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
        
        console.log(`Uploading launcher update ${version} to backend server...`);
        
        // Create FormData for multipart upload to backend
        const formData = new FormData();
        
        // Add files
        formData.append('exe', fs.createReadStream(req.files.exe[0].path), {
            filename: req.files.exe[0].originalname,
            contentType: 'application/octet-stream'
        });
        
        formData.append('yml', fs.createReadStream(req.files.yml[0].path), {
            filename: req.files.yml[0].originalname,
            contentType: 'text/yaml'
        });
        
        if (req.files.blockmap) {
            formData.append('blockmap', fs.createReadStream(req.files.blockmap[0].path), {
                filename: req.files.blockmap[0].originalname,
                contentType: 'application/octet-stream'
            });
        }
        
        // Add metadata
        formData.append('version', version);
        if (releaseNotes) {
            formData.append('releaseNotes', releaseNotes);
        }
        
        // Upload to backend server
        const response = await axios.post(`${BACKEND_URL}/launcher/upload`, formData, {
            headers: {
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        // Clean up temporary files
        const filesToClean = [
            ...req.files.exe,
            ...req.files.yml,
            ...(req.files.blockmap || [])
        ];
        
        for (const file of filesToClean) {
            try {
                await fs.remove(file.path);
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }
        }
        
        // Also update launcher-info.json for the updater
        try {
            const changelogArray = releaseNotes ? releaseNotes.split('\n').filter(line => line.trim()) : [];
            await axios.post(`${BACKEND_URL}/launcher/update-info`, {
                version: version,
                changelog: changelogArray,
                critical: false
            });
            console.log(`Launcher-info.json updated for version ${version}`);
        } catch (updateError) {
            console.warn('Failed to update launcher-info.json:', updateError.message);
        }

        console.log('Launcher update uploaded successfully!');
        res.json(response.data);
        
    } catch (error) {
        console.error('Launcher upload error:', error);
        
        // Clean up temporary files on error
        if (req.files) {
            const allFiles = Object.values(req.files).flat();
            for (const file of allFiles) {
                try {
                    await fs.remove(file.path);
                } catch (cleanupError) {
                    console.error('Cleanup error:', cleanupError);
                }
            }
        }
        
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

// Shop management routes
app.get('/api/shop/categories', async (req, res) => {
    try {
        const response = await axios.get(`${BACKEND_URL}/shop/categories`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop categories fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/shop/items', async (req, res) => {
    try {
        const response = await axios.get(`${BACKEND_URL}/shop/items`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop items fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/shop/categories', async (req, res) => {
    try {
        const { name, description, icon, sortOrder } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Category name is required' });
        }
        
        const response = await axios.post(`${BACKEND_URL}/shop/admin/categories`, {
            name,
            description,
            icon,
            sortOrder
        });
        
        console.log(`Shop category created: "${name}"`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop category creation error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.put('/api/shop/categories/:id', async (req, res) => {
    try {
        const response = await axios.put(`${BACKEND_URL}/shop/admin/categories/${req.params.id}`, req.body);
        
        console.log(`Shop category updated: ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop category update error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.delete('/api/shop/categories/:id', async (req, res) => {
    try {
        const response = await axios.delete(`${BACKEND_URL}/shop/admin/categories/${req.params.id}`);
        
        console.log(`Shop category deleted: ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop category deletion error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.post('/api/shop/items', async (req, res) => {
    try {
        const { categoryId, name, description, icon, priceGold, itemType, itemData, stockQuantity, sortOrder } = req.body;
        
        if (!categoryId || !name || !priceGold || !itemType) {
            return res.status(400).json({ error: 'Category ID, name, price, and item type are required' });
        }
        
        const response = await axios.post(`${BACKEND_URL}/shop/admin/items`, {
            categoryId,
            name,
            description,
            icon,
            priceGold,
            itemType,
            itemData,
            stockQuantity,
            sortOrder
        });
        
        console.log(`Shop item created: "${name}"`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop item creation error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.put('/api/shop/items/:id', async (req, res) => {
    try {
        const response = await axios.put(`${BACKEND_URL}/shop/admin/items/${req.params.id}`, req.body);
        
        console.log(`Shop item updated: ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop item update error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.delete('/api/shop/items/:id', async (req, res) => {
    try {
        const response = await axios.delete(`${BACKEND_URL}/shop/admin/items/${req.params.id}`);
        
        console.log(`Shop item deleted: ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop item deletion error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

// Shop item commands management
app.get('/api/shop/items/:id/commands', async (req, res) => {
    try {
        const response = await axios.get(`${BACKEND_URL}/shop/admin/items/${req.params.id}/commands`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop commands fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/shop/items/:id/commands', async (req, res) => {
    try {
        const response = await axios.post(`${BACKEND_URL}/shop/admin/items/${req.params.id}/commands`, req.body);
        
        console.log(`Shop command created for item ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop command creation error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.put('/api/shop/commands/:id', async (req, res) => {
    try {
        const response = await axios.put(`${BACKEND_URL}/shop/admin/commands/${req.params.id}`, req.body);
        
        console.log(`Shop command updated: ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop command update error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

app.delete('/api/shop/commands/:id', async (req, res) => {
    try {
        const response = await axios.delete(`${BACKEND_URL}/shop/admin/commands/${req.params.id}`);
        
        console.log(`Shop command deleted: ID ${req.params.id}`);
        res.json(response.data);
    } catch (error) {
        console.error('Shop command deletion error:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error || error.message 
        });
    }
});

// Serve HTML interface
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>WoW Launcher Dev Tool</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f5f5;
            color: #333;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            background: #2c3e50;
            color: white;
            padding: 20px 0;
            margin-bottom: 30px;
        }
        
        header h1 {
            text-align: center;
        }
        
        .dashboard {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .stat-card h3 {
            color: #7f8c8d;
            font-size: 14px;
            margin-bottom: 10px;
        }
        
        .stat-card .value {
            font-size: 32px;
            font-weight: bold;
            color: #2c3e50;
        }
        
        .section {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        
        .section h2 {
            margin-bottom: 20px;
            color: #2c3e50;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
        }
        
        .form-group input,
        .form-group textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        
        .form-group textarea {
            resize: vertical;
            min-height: 100px;
        }
        
        .btn {
            background: #3498db;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        
        .btn:hover {
            background: #2980b9;
        }
        
        .btn-danger {
            background: #e74c3c;
        }
        
        .btn-danger:hover {
            background: #c0392b;
        }
        
        .btn-success {
            background: #27ae60;
        }
        
        .btn-success:hover {
            background: #229954;
        }
        
        .list-item {
            padding: 15px;
            border: 1px solid #ddd;
            border-radius: 4px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .list-item h4 {
            margin-bottom: 5px;
        }
        
        .list-item .meta {
            font-size: 12px;
            color: #7f8c8d;
        }
        
        .tabs {
            display: flex;
            border-bottom: 2px solid #ddd;
            margin-bottom: 20px;
        }
        
        .tab {
            padding: 10px 20px;
            cursor: pointer;
            border: none;
            background: none;
            font-size: 16px;
            color: #7f8c8d;
        }
        
        .tab.active {
            color: #3498db;
            border-bottom: 2px solid #3498db;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .upload-area {
            border: 2px dashed #ddd;
            border-radius: 4px;
            padding: 40px;
            text-align: center;
            margin-bottom: 20px;
        }
        
        .file-input {
            display: none;
        }
        
        .upload-btn {
            background: #2ecc71;
            color: white;
            padding: 10px 30px;
            border-radius: 4px;
            cursor: pointer;
            display: inline-block;
            margin: 5px;
        }
        
        .upload-btn:hover {
            background: #27ae60;
        }
        
        .file-info {
            margin-top: 10px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
            font-size: 14px;
        }
        
        .launcher-files {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .file-card {
            padding: 15px;
            border: 1px solid #ddd;
            border-radius: 4px;
            text-align: center;
            background: #f8f9fa;
        }
        
        .file-card.required {
            border-color: #e74c3c;
            background: #fdf2f2;
        }
        
        .file-card.uploaded {
            border-color: #27ae60;
            background: #f2f8f2;
        }
    </style>
</head>
<body>
    <header>
        <div class="container">
            <h1>🚀 WoW Launcher Developer Tool</h1>
        </div>
    </header>
    
    <div class="container">
        <div class="dashboard" id="dashboard">
            <div class="stat-card">
                <h3>Total News</h3>
                <div class="value" id="total-news">0</div>
            </div>
            <div class="stat-card">
                <h3>Game Patches</h3>
                <div class="value" id="total-patches">0</div>
            </div>
            <div class="stat-card">
                <h3>Game Version</h3>
                <div class="value" id="current-version">-</div>
            </div>
            <div class="stat-card">
                <h3>Launcher Files</h3>
                <div class="value" id="launcher-files">0</div>
            </div>
        </div>
        
        <div class="section">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('news')">📰 News</button>
                <button class="tab" onclick="switchTab('updates')">🎮 Game Updates</button>
                <button class="tab" onclick="switchTab('launcher')">🚀 Launcher Updates</button>
                <button class="tab" onclick="switchTab('shop')">🛒 Shop Management</button>
            </div>
            
            <div id="news-tab" class="tab-content active">
                <h2>Add News</h2>
                <form id="news-form">
                    <div class="form-group">
                        <label>Title</label>
                        <input type="text" id="news-title" required>
                    </div>
                    <div class="form-group">
                        <label>Content</label>
                        <textarea id="news-content" required></textarea>
                    </div>
                    <div class="form-group">
                        <label>Author</label>
                        <input type="text" id="news-author" value="Admin" required>
                    </div>
                    <button type="submit" class="btn">Publish News</button>
                </form>
                
                <h2 style="margin-top: 40px;">Recent News</h2>
                <div id="news-list"></div>
            </div>
            
            <div id="updates-tab" class="tab-content">
                <h2>Upload Game Patch</h2>
                <form id="patch-form">
                    <div class="upload-area">
                        <input type="file" id="patch-file-input" class="file-input" accept=".zip,.rar,.7z" required>
                        <label for="patch-file-input" class="upload-btn">Choose Patch File</label>
                        <p id="patch-file-name" style="margin-top: 10px; color: #7f8c8d;">No file selected</p>
                    </div>
                    
                    <div class="form-group">
                        <label>Version</label>
                        <input type="text" id="patch-version" placeholder="e.g., 3.3.5b" required>
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea id="patch-description" required></textarea>
                    </div>
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="patch-critical">
                            Critical Update (forces update)
                        </label>
                    </div>
                    <button type="submit" class="btn">Upload Game Patch</button>
                </form>
                
                <h2 style="margin-top: 40px;">Available Game Patches</h2>
                <div id="patches-list"></div>
            </div>
            
            <div id="launcher-tab" class="tab-content">
                <h2>🚀 Upload Launcher Update</h2>
                <p style="margin-bottom: 20px; color: #7f8c8d;">Upload launcher update files from your build output (dist/ folder)</p>
                
                <form id="launcher-form">
                    <div class="launcher-files">
                        <div class="file-card required" id="exe-card">
                            <h4>.EXE File</h4>
                            <p>Setup executable</p>
                            <input type="file" id="exe-file-input" class="file-input" accept=".exe" required>
                            <label for="exe-file-input" class="upload-btn">Select .EXE</label>
                            <div class="file-info" id="exe-info">Not selected</div>
                        </div>
                        
                        <div class="file-card required" id="yml-card">
                            <h4>.YML File</h4>
                            <p>Update metadata</p>
                            <input type="file" id="yml-file-input" class="file-input" accept=".yml" required>
                            <label for="yml-file-input" class="upload-btn">Select .YML</label>
                            <div class="file-info" id="yml-info">Not selected</div>
                        </div>
                        
                        <div class="file-card" id="blockmap-card">
                            <h4>.BLOCKMAP File</h4>
                            <p>Delta updates (optional)</p>
                            <input type="file" id="blockmap-file-input" class="file-input" accept=".blockmap">
                            <label for="blockmap-file-input" class="upload-btn">Select .BLOCKMAP</label>
                            <div class="file-info" id="blockmap-info">Not selected</div>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Version</label>
                        <input type="text" id="launcher-version" placeholder="e.g., 1.2.0" required>
                    </div>
                    <div class="form-group">
                        <label>Release Notes</label>
                        <textarea id="launcher-notes" placeholder="What's new in this version..."></textarea>
                    </div>
                    <button type="submit" class="btn btn-success">🚀 Upload Launcher Update</button>
                </form>
                
                <h2 style="margin-top: 40px;">Current Launcher Files</h2>
                <div id="launcher-files-list"></div>
            </div>
            
            <div id="shop-tab" class="tab-content">
                <h2>🛒 Shop Management</h2>
                
                <!-- Shop Categories Section -->
                <div class="shop-section">
                    <h3>Categories</h3>
                    <form id="category-form" style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div class="form-group">
                                <label>Category Name</label>
                                <input type="text" id="category-name" placeholder="e.g., Mounts" required>
                            </div>
                            <div class="form-group">
                                <label>Sort Order</label>
                                <input type="number" id="category-sort" placeholder="0" min="0">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Description</label>
                            <textarea id="category-description" placeholder="Category description..."></textarea>
                        </div>
                        <button type="submit" class="btn btn-primary">Add Category</button>
                    </form>
                    
                    <div id="categories-list"></div>
                </div>
                
                <!-- Shop Items Section -->
                <div class="shop-section" style="margin-top: 40px;">
                    <h3>Shop Items</h3>
                    <form id="item-form" style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                            <div class="form-group">
                                <label>Category</label>
                                <select id="item-category" required>
                                    <option value="">Select category...</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Item Name</label>
                                <input type="text" id="item-name" placeholder="e.g., Swift Spectral Tiger" required>
                            </div>
                            <div class="form-group">
                                <label>Price (Gold in Copper)</label>
                                <input type="number" id="item-price" placeholder="1000000" min="0" required>
                            </div>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
                            <div class="form-group">
                                <label>Item Type</label>
                                <select id="item-type" required>
                                    <option value="">Select type...</option>
                                    <option value="mount">Mount</option>
                                    <option value="service">Service</option>
                                    <option value="gear_set">Gear Set</option>
                                    <option value="item">Item</option>
                                    <option value="consumable">Consumable</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Stock Quantity</label>
                                <input type="number" id="item-stock" placeholder="-1 for unlimited" value="-1">
                            </div>
                            <div class="form-group">
                                <label>Sort Order</label>
                                <input type="number" id="item-sort" placeholder="0" min="0">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Description</label>
                            <textarea id="item-description" placeholder="Item description..."></textarea>
                        </div>
                        <div class="form-group">
                            <label>Item Data (JSON)</label>
                            <textarea id="item-data" placeholder='{"item_id": 49284, "spell_id": 42777}'></textarea>
                            <small style="color: #666;">For mounts: {"item_id": 123, "spell_id": 456}, For items: {"item_id": 123}, For services: {"service_type": "race_change"}</small>
                        </div>
                        <button type="submit" class="btn btn-primary">Add Item</button>
                    </form>
                    
                    <div id="items-list"></div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        // Load dashboard data
        async function loadDashboard() {
            try {
                const response = await fetch('/api/dashboard');
                const data = await response.json();
                
                document.getElementById('total-news').textContent = data.stats.totalNews;
                document.getElementById('total-patches').textContent = data.stats.totalPatches;
                document.getElementById('current-version').textContent = data.stats.currentVersion;
                document.getElementById('launcher-files').textContent = data.stats.launcherFiles;
                
                // Load news list
                loadNewsList(data.news);
                
                // Load patches list
                loadPatchesList(data.updates.patches || []);
                
                // Load launcher files list
                loadLauncherFilesList(data.launcherFiles || []);
            } catch (error) {
                console.error('Failed to load dashboard:', error);
            }
        }
        
        // Tab switching
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            if (tab === 'news') {
                document.querySelector('.tab:nth-child(1)').classList.add('active');
                document.getElementById('news-tab').classList.add('active');
            } else if (tab === 'updates') {
                document.querySelector('.tab:nth-child(2)').classList.add('active');
                document.getElementById('updates-tab').classList.add('active');
            } else if (tab === 'launcher') {
                document.querySelector('.tab:nth-child(3)').classList.add('active');
                document.getElementById('launcher-tab').classList.add('active');
            } else if (tab === 'shop') {
                document.querySelector('.tab:nth-child(4)').classList.add('active');
                document.getElementById('shop-tab').classList.add('active');
                loadShopData();
            }
        }
        
        // News management
        document.getElementById('news-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const data = {
                title: document.getElementById('news-title').value,
                content: document.getElementById('news-content').value,
                author: document.getElementById('news-author').value
            };
            
            try {
                const response = await fetch('/api/news', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                if (response.ok) {
                    alert('News published successfully!');
                    document.getElementById('news-form').reset();
                    loadDashboard();
                } else {
                    const error = await response.json();
                    alert('Failed to publish news: ' + error.error);
                }
            } catch (error) {
                alert('Failed to publish news: ' + error.message);
            }
        });
        
        function loadNewsList(news) {
            const container = document.getElementById('news-list');
            container.innerHTML = news.map(item => 
                '<div class="list-item">' +
                    '<div>' +
                        '<h4>' + item.title + '</h4>' +
                        '<div class="meta">By ' + item.author + ' on ' + new Date(item.date).toLocaleDateString() + '</div>' +
                    '</div>' +
                    '<button class="btn btn-danger" onclick="deleteNews(' + item.id + ')">Delete</button>' +
                '</div>'
            ).join('');
        }
        
        async function deleteNews(id) {
            if (!confirm('Delete this news item?')) return;
            
            try {
                await fetch('/api/news/' + id, { method: 'DELETE' });
                loadDashboard();
            } catch (error) {
                alert('Failed to delete news');
            }
        }
        
        // Game Patch management
        document.getElementById('patch-file-input').addEventListener('change', (e) => {
            const fileName = e.target.files[0]?.name || 'No file selected';
            document.getElementById('patch-file-name').textContent = fileName;
        });
        
        document.getElementById('patch-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData();
            formData.append('patch', document.getElementById('patch-file-input').files[0]);
            formData.append('version', document.getElementById('patch-version').value);
            formData.append('description', document.getElementById('patch-description').value);
            formData.append('critical', document.getElementById('patch-critical').checked);
            
            try {
                const response = await fetch('/api/updates/upload', {
                    method: 'POST',
                    body: formData
                });
                
                if (response.ok) {
                    alert('Game patch uploaded successfully!');
                    document.getElementById('patch-form').reset();
                    document.getElementById('patch-file-name').textContent = 'No file selected';
                    loadDashboard();
                } else {
                    const error = await response.json();
                    alert('Failed to upload patch: ' + error.error);
                }
            } catch (error) {
                alert('Failed to upload patch: ' + error.message);
            }
        });
        
        function loadPatchesList(patches) {
            const container = document.getElementById('patches-list');
            container.innerHTML = patches.map(patch => 
                '<div class="list-item">' +
                    '<div>' +
                        '<h4>Version ' + patch.version + '</h4>' +
                        '<div class="meta">' +
                            (patch.size / 1024 / 1024).toFixed(2) + ' MB • ' +
                            'Released ' + new Date(patch.releaseDate).toLocaleDateString() + ' • ' +
                            (patch.critical ? 'CRITICAL' : 'Optional') +
                        '</div>' +
                    '</div>' +
                    '<button class="btn btn-danger" onclick="deletePatch(' + patch.id + ')">Delete</button>' +
                '</div>'
            ).join('');
        }
        
        async function deletePatch(id) {
            if (!confirm('Delete this patch?')) return;
            
            try {
                await fetch('/api/updates/' + id, { method: 'DELETE' });
                loadDashboard();
            } catch (error) {
                alert('Failed to delete patch');
            }
        }
        
        // Launcher Update management
        ['exe', 'yml', 'blockmap'].forEach(type => {
            document.getElementById(type + '-file-input').addEventListener('change', (e) => {
                const file = e.target.files[0];
                const info = document.getElementById(type + '-info');
                const card = document.getElementById(type + '-card');
                
                if (file) {
                    info.textContent = file.name + ' (' + (file.size / 1024 / 1024).toFixed(2) + ' MB)';
                    card.classList.add('uploaded');
                } else {
                    info.textContent = 'Not selected';
                    card.classList.remove('uploaded');
                }
            });
        });
        
        document.getElementById('launcher-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData();
            
            const exeFile = document.getElementById('exe-file-input').files[0];
            const ymlFile = document.getElementById('yml-file-input').files[0];
            const blockmapFile = document.getElementById('blockmap-file-input').files[0];
            
            if (!exeFile || !ymlFile) {
                alert('Both .exe and .yml files are required!');
                return;
            }
            
            formData.append('exe', exeFile);
            formData.append('yml', ymlFile);
            if (blockmapFile) {
                formData.append('blockmap', blockmapFile);
            }
            
            formData.append('version', document.getElementById('launcher-version').value);
            formData.append('releaseNotes', document.getElementById('launcher-notes').value);
            
            try {
                const response = await fetch('/api/launcher/upload', {
                    method: 'POST',
                    body: formData
                });
                
                if (response.ok) {
                    const result = await response.json();
                    alert('Launcher update uploaded successfully!\\n\\nFiles uploaded:\\n' + 
                          '• ' + result.files.exe + '\\n' +
                          '• ' + result.files.yml + 
                          (result.files.blockmap ? '\\n• ' + result.files.blockmap : ''));
                    document.getElementById('launcher-form').reset();
                    
                    // Reset file cards
                    ['exe', 'yml', 'blockmap'].forEach(type => {
                        document.getElementById(type + '-info').textContent = 'Not selected';
                        document.getElementById(type + '-card').classList.remove('uploaded');
                    });
                    
                    loadDashboard();
                } else {
                    const error = await response.json();
                    alert('Failed to upload launcher update: ' + error.error);
                }
            } catch (error) {
                alert('Failed to upload launcher update: ' + error.message);
            }
        });
        
        function loadLauncherFilesList(files) {
            const container = document.getElementById('launcher-files-list');
            if (files.length === 0) {
                container.innerHTML = '<p style="color: #7f8c8d; text-align: center;">No launcher files uploaded yet</p>';
                return;
            }
            
            container.innerHTML = files.map(file => 
                '<div class="list-item">' +
                    '<div>' +
                        '<h4>' + file.name + '</h4>' +
                        '<div class="meta">' +
                            (file.size / 1024 / 1024).toFixed(2) + ' MB • ' +
                            'Modified ' + new Date(file.modified).toLocaleDateString() +
                        '</div>' +
                    '</div>' +
                '</div>'
            ).join('');
        }
        
        // Shop management functions
        async function loadShopData() {
            await loadCategories();
            await loadItems();
        }
        
        async function loadCategories() {
            try {
                const response = await fetch('/api/shop/categories');
                const categories = await response.json();
                
                const categoriesList = document.getElementById('categories-list');
                const categorySelect = document.getElementById('item-category');
                
                // Update category list
                if (categories.length === 0) {
                    categoriesList.innerHTML = '<p style="color: #7f8c8d; text-align: center;">No categories created yet</p>';
                } else {
                    categoriesList.innerHTML = categories.map(cat => 
                        '<div class="list-item">' +
                            '<div>' +
                                '<h4>' + cat.name + '</h4>' +
                                '<div class="meta">' + (cat.description || 'No description') + ' • Sort: ' + cat.sort_order + '</div>' +
                            '</div>' +
                            '<div>' +
                                '<button onclick="editCategory(' + cat.id + ')" class="btn" style="padding: 5px 10px; font-size: 12px; margin-right: 5px;">Edit</button>' +
                                '<button onclick="deleteCategory(' + cat.id + ')" class="btn btn-danger" style="padding: 5px 10px; font-size: 12px;">Delete</button>' +
                            '</div>' +
                        '</div>'
                    ).join('');
                }
                
                // Update category select dropdown
                categorySelect.innerHTML = '<option value="">Select category...</option>' +
                    categories.map(cat => '<option value="' + cat.id + '">' + cat.name + '</option>').join('');
                    
            } catch (error) {
                console.error('Failed to load categories:', error);
                document.getElementById('categories-list').innerHTML = '<p style="color: #e74c3c;">Failed to load categories</p>';
            }
        }
        
        async function loadItems() {
            try {
                const response = await fetch('/api/shop/items');
                const items = await response.json();
                
                const itemsList = document.getElementById('items-list');
                
                if (items.length === 0) {
                    itemsList.innerHTML = '<p style="color: #7f8c8d; text-align: center;">No items created yet</p>';
                } else {
                    itemsList.innerHTML = items.map(item => 
                        '<div class="list-item">' +
                            '<div>' +
                                '<h4>' + item.name + ' <small style="color: #999;">(' + item.category_name + ')</small></h4>' +
                                '<div class="meta">' +
                                    formatGoldPrice(item.price_gold) + ' • ' +
                                    item.item_type.replace('_', ' ') + ' • ' +
                                    (item.stock_quantity === -1 ? 'Unlimited stock' : item.stock_quantity + ' in stock') +
                                '</div>' +
                                '<div class="meta" style="margin-top: 5px;">' + (item.description || 'No description') + '</div>' +
                            '</div>' +
                            '<div>' +
                                '<button onclick="editItem(' + item.id + ')" class="btn" style="padding: 5px 10px; font-size: 12px; margin-right: 5px;">Edit</button>' +
                                '<button onclick="manageCommands(' + item.id + ')" class="btn btn-success" style="padding: 5px 10px; font-size: 12px; margin-right: 5px;">Commands</button>' +
                                '<button onclick="deleteItem(' + item.id + ')" class="btn btn-danger" style="padding: 5px 10px; font-size: 12px;">Delete</button>' +
                            '</div>' +
                        '</div>'
                    ).join('');
                }
                
            } catch (error) {
                console.error('Failed to load items:', error);
                document.getElementById('items-list').innerHTML = '<p style="color: #e74c3c;">Failed to load items</p>';
            }
        }
        
        function formatGoldPrice(copperAmount) {
            const gold = Math.floor(copperAmount / 10000);
            const silver = Math.floor((copperAmount % 10000) / 100);
            const copper = copperAmount % 100;
            
            let result = '';
            if (gold > 0) result += gold + 'g';
            if (silver > 0) result += silver + 's';
            if (copper > 0) result += copper + 'c';
            
            return result || '0c';
        }
        
        async function deleteItem(itemId) {
            if (!confirm('Are you sure you want to delete this item?')) return;
            
            try {
                const response = await fetch('/api/shop/items/' + itemId, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    alert('Item deleted successfully!');
                    await loadItems();
                } else {
                    const error = await response.json();
                    alert('Failed to delete item: ' + error.error);
                }
            } catch (error) {
                alert('Failed to delete item: ' + error.message);
            }
        }
        
        // Shop form handlers
        document.getElementById('category-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('category-name').value;
            const description = document.getElementById('category-description').value;
            const sortOrder = parseInt(document.getElementById('category-sort').value) || 0;
            
            try {
                const response = await fetch('/api/shop/categories', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description, sortOrder })
                });
                
                if (response.ok) {
                    alert('Category created successfully!');
                    document.getElementById('category-form').reset();
                    await loadCategories();
                } else {
                    const error = await response.json();
                    alert('Failed to create category: ' + error.error);
                }
            } catch (error) {
                alert('Failed to create category: ' + error.message);
            }
        });
        
        document.getElementById('item-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const categoryId = parseInt(document.getElementById('item-category').value);
            const name = document.getElementById('item-name').value;
            const description = document.getElementById('item-description').value;
            const priceGold = parseInt(document.getElementById('item-price').value);
            const itemType = document.getElementById('item-type').value;
            const stockQuantity = parseInt(document.getElementById('item-stock').value);
            const sortOrder = parseInt(document.getElementById('item-sort').value) || 0;
            
            let itemData = null;
            const itemDataText = document.getElementById('item-data').value.trim();
            if (itemDataText) {
                try {
                    itemData = JSON.parse(itemDataText);
                } catch (err) {
                    alert('Invalid JSON in Item Data field');
                    return;
                }
            }
            
            try {
                const response = await fetch('/api/shop/items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        categoryId,
                        name,
                        description,
                        priceGold,
                        itemType,
                        itemData,
                        stockQuantity,
                        sortOrder
                    })
                });
                
                if (response.ok) {
                    alert('Item created successfully!');
                    document.getElementById('item-form').reset();
                    await loadItems();
                } else {
                    const error = await response.json();
                    alert('Failed to create item: ' + error.error);
                }
            } catch (error) {
                alert('Failed to create item: ' + error.message);
            }
        });
        
        // Edit functions
        async function editCategory(categoryId) {
            const categories = await fetch('/api/shop/categories').then(r => r.json());
            const category = categories.find(c => c.id === categoryId);
            if (!category) return;
            
            const name = prompt('Category Name:', category.name);
            if (name === null) return;
            
            const description = prompt('Description:', category.description || '');
            if (description === null) return;
            
            const sortOrder = prompt('Sort Order:', category.sort_order || 0);
            if (sortOrder === null) return;
            
            try {
                const response = await fetch('/api/shop/categories/' + categoryId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        description: description,
                        sortOrder: parseInt(sortOrder) || 0,
                        active: 1
                    })
                });
                
                if (response.ok) {
                    alert('Category updated successfully!');
                    await loadCategories();
                } else {
                    const error = await response.json();
                    alert('Failed to update category: ' + error.error);
                }
            } catch (error) {
                alert('Failed to update category: ' + error.message);
            }
        }
        
        async function deleteCategory(categoryId) {
            if (!confirm('Are you sure you want to delete this category? This will also delete all items in this category.')) return;
            
            try {
                const response = await fetch('/api/shop/categories/' + categoryId, {
                    method: 'DELETE'
                });
                
                if (response.ok) {
                    alert('Category deleted successfully!');
                    await loadCategories();
                    await loadItems();
                } else {
                    const error = await response.json();
                    alert('Failed to delete category: ' + error.error);
                }
            } catch (error) {
                alert('Failed to delete category: ' + error.message);
            }
        }
        
        async function editItem(itemId) {
            const items = await fetch('/api/shop/items').then(r => r.json());
            const item = items.find(i => i.id === itemId);
            if (!item) return;
            
            const name = prompt('Item Name:', item.name);
            if (name === null) return;
            
            const description = prompt('Description:', item.description || '');
            if (description === null) return;
            
            const price = prompt('Price (copper):', item.price_gold);
            if (price === null) return;
            
            const stock = prompt('Stock Quantity (-1 for unlimited):', item.stock_quantity);
            if (stock === null) return;
            
            const sortOrder = prompt('Sort Order:', item.sort_order || 0);
            if (sortOrder === null) return;
            
            let itemData = item.item_data;
            const itemDataStr = prompt('Item Data (JSON):', JSON.stringify(item.item_data || {}));
            if (itemDataStr === null) return;
            
            try {
                itemData = JSON.parse(itemDataStr);
            } catch (e) {
                alert('Invalid JSON in Item Data');
                return;
            }
            
            try {
                const response = await fetch('/api/shop/items/' + itemId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        categoryId: item.category_id,
                        name: name,
                        description: description,
                        icon: item.icon,
                        priceGold: parseInt(price) || 0,
                        itemType: item.item_type,
                        itemData: itemData,
                        stockQuantity: parseInt(stock),
                        sortOrder: parseInt(sortOrder) || 0,
                        active: 1
                    })
                });
                
                if (response.ok) {
                    alert('Item updated successfully!');
                    await loadItems();
                } else {
                    const error = await response.json();
                    alert('Failed to update item: ' + error.error);
                }
            } catch (error) {
                alert('Failed to update item: ' + error.message);
            }
        }
        
        async function manageCommands(itemId) {
            const modal = document.createElement('div');
            modal.style.cssText = \`
                position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
                background: rgba(0,0,0,0.5); z-index: 1000; display: flex; 
                align-items: center; justify-content: center;
            \`;
            
            const content = document.createElement('div');
            content.style.cssText = \`
                background: white; padding: 30px; border-radius: 8px; 
                max-width: 800px; width: 90%; max-height: 80%; overflow-y: auto;
            \`;
            
            content.innerHTML = \`
                <h3>Manage Commands for Item</h3>
                <div id="commands-list" style="margin: 20px 0;"></div>
                <h4>Add New Command</h4>
                <div style="margin: 15px 0;">
                    <label>Command Template:</label>
                    <textarea id="new-command" placeholder="e.g., send items {{character_name}} 'Shop Purchase' 'Your item!' 123:1" style="width: 100%; height: 60px; margin-top: 5px;"></textarea>
                </div>
                <div style="margin: 15px 0;">
                    <label>Description:</label>
                    <input type="text" id="new-command-desc" placeholder="What this command does" style="width: 100%; margin-top: 5px;">
                </div>
                <div style="margin: 15px 0;">
                    <label>Execution Order:</label>
                    <input type="number" id="new-command-order" value="1" style="width: 100px; margin-top: 5px;">
                </div>
                <div style="margin: 20px 0;">
                    <button onclick="addCommand(\${itemId})" class="btn">Add Command</button>
                    <button onclick="closeModal()" class="btn btn-danger" style="margin-left: 10px;">Close</button>
                </div>
            \`;
            
            modal.appendChild(content);
            document.body.appendChild(modal);
            modal.onclick = (e) => { if (e.target === modal) closeModal(); };
            
            window.closeModal = () => document.body.removeChild(modal);
            
            // Load commands
            try {
                const response = await fetch('/api/shop/items/' + itemId + '/commands');
                const commands = await response.json();
                
                const commandsList = document.getElementById('commands-list');
                if (commands.length === 0) {
                    commandsList.innerHTML = '<p style="color: #7f8c8d;">No commands configured for this item.</p>';
                } else {
                    commandsList.innerHTML = commands.map(cmd => \`
                        <div style="border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 4px;">
                            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                <div style="flex: 1;">
                                    <strong>Order \${cmd.execution_order}:</strong> \${cmd.description || 'No description'}
                                    <div style="margin: 5px 0; font-family: monospace; background: #f5f5f5; padding: 8px; border-radius: 3px;">
                                        \${cmd.command_template}
                                    </div>
                                </div>
                                <div>
                                    <button onclick="editCommand(\${cmd.id})" class="btn" style="padding: 5px 10px; font-size: 12px; margin-right: 5px;">Edit</button>
                                    <button onclick="deleteCommand(\${cmd.id})" class="btn btn-danger" style="padding: 5px 10px; font-size: 12px;">Delete</button>
                                </div>
                            </div>
                        </div>
                    \`).join('');
                }
            } catch (error) {
                document.getElementById('commands-list').innerHTML = '<p style="color: #e74c3c;">Failed to load commands</p>';
            }
            
            window.addCommand = async (itemId) => {
                const commandTemplate = document.getElementById('new-command').value;
                const description = document.getElementById('new-command-desc').value;
                const executionOrder = parseInt(document.getElementById('new-command-order').value) || 1;
                
                if (!commandTemplate) {
                    alert('Command template is required');
                    return;
                }
                
                try {
                    const response = await fetch('/api/shop/items/' + itemId + '/commands', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            commandTemplate: commandTemplate,
                            description: description,
                            executionOrder: executionOrder
                        })
                    });
                    
                    if (response.ok) {
                        alert('Command added successfully!');
                        closeModal();
                        manageCommands(itemId);
                    } else {
                        const error = await response.json();
                        alert('Failed to add command: ' + error.error);
                    }
                } catch (error) {
                    alert('Failed to add command: ' + error.message);
                }
            };
            
            window.editCommand = async (commandId) => {
                const commands = await fetch('/api/shop/items/' + itemId + '/commands').then(r => r.json());
                const command = commands.find(c => c.id === commandId);
                if (!command) return;
                
                const commandTemplate = prompt('Command Template:', command.command_template);
                if (commandTemplate === null) return;
                
                const description = prompt('Description:', command.description || '');
                if (description === null) return;
                
                const executionOrder = prompt('Execution Order:', command.execution_order);
                if (executionOrder === null) return;
                
                try {
                    const response = await fetch('/api/shop/commands/' + commandId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            commandTemplate: commandTemplate,
                            description: description,
                            executionOrder: parseInt(executionOrder) || 1,
                            active: 1
                        })
                    });
                    
                    if (response.ok) {
                        alert('Command updated successfully!');
                        manageCommands(itemId);
                    } else {
                        const error = await response.json();
                        alert('Failed to update command: ' + error.error);
                    }
                } catch (error) {
                    alert('Failed to update command: ' + error.message);
                }
            };
            
            window.deleteCommand = async (commandId) => {
                if (!confirm('Are you sure you want to delete this command?')) return;
                
                try {
                    const response = await fetch('/api/shop/commands/' + commandId, {
                        method: 'DELETE'
                    });
                    
                    if (response.ok) {
                        alert('Command deleted successfully!');
                        manageCommands(itemId);
                    } else {
                        const error = await response.json();
                        alert('Failed to delete command: ' + error.error);
                    }
                } catch (error) {
                    alert('Failed to delete command: ' + error.message);
                }
            };
        }
        
        // Initialize
        loadDashboard();
    </script>
</body>
</html>`;
    
    res.send(html);
});

// Enhanced startup with proper error handling
async function start() {
    try {
        console.log('🚀 Starting WoW Launcher Developer Tool...');
        
        // Initialize directories and cleanup
        await initialize();
        
        // Test backend connectivity
        console.log('🔗 Testing backend connectivity...');
        const healthCheck = await makeApiRequest('GET', '/health').catch(() => null);
        
        if (healthCheck?.success) {
            console.log('✅ Backend server is reachable');
        } else {
            console.log('⚠️  Backend server connectivity issue - some features may not work');
        }
        
        // Setup graceful shutdown
        setupGracefulShutdown();
        
        // Start server
        const server = app.listen(PORT, () => {
            console.log('='.repeat(70));
            console.log('🎨 WoW Launcher Developer Tool');
            console.log('='.repeat(70));
            console.log(`📍 Dev Tool URL: http://localhost:${PORT}`);
            console.log(`🔗 Backend API: ${BACKEND_URL}`);
            console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log('');
            console.log('📋 Available Features:');
            console.log('  ✅ News management (create, view, delete)');
            console.log('  ✅ Game patch upload and management (500MB limit)');
            console.log('  ✅ Launcher update upload and management (200MB limit)');
            console.log('  ✅ Shop management (categories, items, pricing)');
            console.log('  ✅ Live dashboard with statistics');
            console.log('  ✅ Automatic file cleanup (1 hour)');
            console.log('');
            console.log('🚀 Launcher Update Workflow:');
            console.log('  1. Build launcher: npm run build-win');
            console.log('  2. Upload dist/ files via web interface');
            console.log('  3. Players receive auto-update notifications');
            console.log('');
            console.log('📁 Server Endpoints:');
            console.log(`  Update Server: ${BACKEND_BASE_URL}/updates`);
            console.log(`  Health Check: ${BACKEND_BASE_URL}/health`);
            console.log('='.repeat(70));
            console.log('✨ Developer tool ready for use!');
        });
        
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
        console.error('❌ Failed to start dev tool:', error);
        process.exit(1);
    }
}

// Setup graceful shutdown
function setupGracefulShutdown() {
    const cleanup = async (signal) => {
        console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);
        
        try {
            // Clean up temporary files
            const tempDir = path.join(__dirname, 'temp');
            if (await fs.pathExists(tempDir)) {
                await fs.remove(tempDir);
                console.log('✅ Temporary files cleaned up');
            }
            
            console.log('👋 Dev tool shutdown complete');
            process.exit(0);
        } catch (error) {
            console.error('❌ Error during shutdown:', error);
            process.exit(1);
        }
    };
    
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGINT', () => cleanup('SIGINT'));
    
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught Exception:', error);
        cleanup('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        cleanup('UNHANDLED_REJECTION');
    });
}

start();
