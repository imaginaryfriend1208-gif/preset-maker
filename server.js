const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRESETS_DIR = path.join(DATA_DIR, 'presets');

// Ensure data directory exists
fs.mkdirSync(PRESETS_DIR, { recursive: true });

// Middleware
app.use(express.json({ limit: '5mb' }));

// Serve static files
app.use('/', express.static(path.join(__dirname)));
app.use('/preset', express.static(path.join(__dirname, 'preset')));

// ==================== API ROUTES ====================

// List all presets
app.get('/api/presets', (req, res) => {
    try {
        const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
        const presets = files.map(f => {
            const filePath = path.join(PRESETS_DIR, f);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            const stat = fs.statSync(filePath);
            return {
                id: path.basename(f, '.json'),
                name: data._preset_name || path.basename(f, '.json'),
                fileName: f,
                data,
                updatedAt: stat.mtime.toISOString(),
            };
        });
        res.json(presets);
    } catch (err) {
        console.error('Error listing presets:', err);
        res.json([]);
    }
});

// Get one preset
app.get('/api/presets/:id', (req, res) => {
    const filePath = path.join(PRESETS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        res.json({ id: req.params.id, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create preset
app.post('/api/presets', (req, res) => {
    try {
        const { name, data } = req.body;
        if (!data) return res.status(400).json({ error: 'Missing data' });

        // Generate ID from name or random
        const slug = (name || 'preset')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 60);
        const id = slug + '_' + crypto.randomBytes(4).toString('hex');
        const filePath = path.join(PRESETS_DIR, id + '.json');

        // Store preset name as metadata
        data._preset_name = name || 'Untitled';
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

        res.status(201).json({ id, name: data._preset_name, fileName: id + '.json' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update preset
app.put('/api/presets/:id', (req, res) => {
    const filePath = path.join(PRESETS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    try {
        const { name, data } = req.body;
        if (!data) return res.status(400).json({ error: 'Missing data' });
        if (name) data._preset_name = name;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        res.json({ id: req.params.id, saved: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete preset
app.delete('/api/presets/:id', (req, res) => {
    const filePath = path.join(PRESETS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    try {
        fs.unlinkSync(filePath);
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start
app.listen(PORT, () => {
    console.log(`Roxie Tools server running on port ${PORT}`);
    console.log(`Data directory: ${PRESETS_DIR}`);
});
