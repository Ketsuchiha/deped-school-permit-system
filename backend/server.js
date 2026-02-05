const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Create unique filename: timestamp + original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Initialize SQLite Database
const db = new sqlite3.Database('./school_permits.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    // Create tables if they don't exist
    db.run(`CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT,
      deleted INTEGER DEFAULT 0,
      deletedAt DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS permits (
      id TEXT PRIMARY KEY,
      schoolId TEXT,
      levels TEXT,
      schoolYear TEXT,
      permitNumber TEXT,
      extractedText TEXT,
      filePath TEXT,
      fileName TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted INTEGER DEFAULT 0,
      deletedAt DATETIME,
      FOREIGN KEY(schoolId) REFERENCES schools(id)
    )`);

    // Migration: Add deleted/deletedAt columns if missing (safe to run multiple times)
    const columns = ['deleted', 'deletedAt'];
    const tables = ['schools', 'permits'];
    
    tables.forEach(table => {
      columns.forEach(col => {
        const type = col === 'deleted' ? 'INTEGER DEFAULT 0' : 'DATETIME';
        db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`, (err) => {
          // Ignore error if column already exists
          if (err && !err.message.includes('duplicate column name')) {
            // console.log(`Column ${col} already exists in ${table} or error:`, err.message);
          }
        });
      });
    });

    // Migration: Add Geo columns to schools
    const geoColumns = [
      { name: 'latitude', type: 'REAL' },
      { name: 'longitude', type: 'REAL' },
      { name: 'geo_accuracy', type: 'TEXT' },
      { name: 'geo_status', type: 'TEXT' }
    ];
    
    geoColumns.forEach(col => {
      db.run(`ALTER TABLE schools ADD COLUMN ${col.name} ${col.type}`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
           // console.log(`Error adding ${col.name}:`, err.message);
        }
      });
    });
  });
}

// ─── API Endpoints ─────────────────────────────────────────────

// Get all active schools
app.get('/api/schools', (req, res) => {
  db.all("SELECT * FROM schools WHERE deleted = 0 OR deleted IS NULL", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Create a school
app.post('/api/schools', async (req, res) => {
  const { id, name, type, address } = req.body;
  
  let lat = null, lng = null, acc = null, status = 'PENDING';

  try {
    const GeoService = require('./services/geoService');
    const geoService = new GeoService();
    const geoResult = await geoService.resolveLocation(name, address);

    if (geoResult.status === 'SUCCESS') {
      lat = geoResult.latitude;
      lng = geoResult.longitude;
      acc = geoResult.accuracy;
      status = 'VERIFIED';
    } else {
      status = geoResult.status;
    }
  } catch (e) {
    console.error("GeoService Error:", e);
    status = 'SYSTEM_ERROR';
  }

  const sql = `INSERT INTO schools (id, name, type, address, latitude, longitude, geo_accuracy, geo_status, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`;

  db.run(sql, [id, name, type, address, lat, lng, acc, status], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name, type, address, latitude: lat, longitude: lng, geo_accuracy: acc, geo_status: status, deleted: 0 });
  });
});

// Get all active permits
app.get('/api/permits', (req, res) => {
  db.all("SELECT * FROM permits WHERE deleted = 0 OR deleted IS NULL", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // Parse levels back to array
    const permits = rows.map(p => ({
      ...p,
      levels: JSON.parse(p.levels || '[]'),
      filePreviewUrl: p.filePath
    }));
    res.json(permits);
  });
});

// Upload a permit
app.post('/api/permits', upload.single('file'), (req, res) => {
  try {
    const { id, schoolId, levels, schoolYear, permitNumber, extractedText } = req.body;
    
    let fileUrl = null;
    let filePath = null;
    let originalName = null;

    if (req.file) {
      fileUrl = `http://localhost:${PORT}/uploads/${req.file.filename}`;
      filePath = req.file.path;
      originalName = req.file.originalname;
    }
    
    const sql = `INSERT INTO permits (id, schoolId, levels, schoolYear, permitNumber, extractedText, filePath, fileName, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`;
    
    db.run(sql, [id, schoolId, levels, schoolYear, permitNumber, extractedText, fileUrl, originalName], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        id,
        schoolId,
        levels: JSON.parse(levels || '[]'),
        schoolYear,
        permitNumber,
        extractedText,
        filePreviewUrl: fileUrl,
        fileName: originalName,
        deleted: 0
      });
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update a school
app.put('/api/schools/:id', (req, res) => {
  const { id } = req.params;
  const { name, type, address } = req.body;
  const sql = `UPDATE schools SET name = ?, type = ?, address = ? WHERE id = ?`;
  db.run(sql, [name, type, address, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name, type, address });
  });
});

// Soft Delete a school (and its permits)
app.delete('/api/schools/:id', (req, res) => {
  const { id } = req.params;
  const now = new Date().toISOString();
  
  // Soft delete permits first
  db.run(`UPDATE permits SET deleted = 1, deletedAt = ? WHERE schoolId = ?`, [now, id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Then soft delete the school
    db.run(`UPDATE schools SET deleted = 1, deletedAt = ? WHERE id = ?`, [now, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'School and associated permits moved to trash' });
    });
  });
});

// Update a permit
app.put('/api/permits/:id', upload.single('file'), (req, res) => {
  try {
    const { id } = req.params;
    const { schoolId, levels, schoolYear, permitNumber, extractedText } = req.body;
    
    let fileUrl = null;
    let originalName = null;
    let sql = '';
    let params = [];

    // If a new file is uploaded, update file fields
    if (req.file) {
      fileUrl = `http://localhost:${PORT}/uploads/${req.file.filename}`;
      originalName = req.file.originalname;
      sql = `UPDATE permits SET schoolId = ?, levels = ?, schoolYear = ?, permitNumber = ?, extractedText = ?, filePath = ?, fileName = ? WHERE id = ?`;
      params = [schoolId, levels, schoolYear, permitNumber, extractedText, fileUrl, originalName, id];
    } else {
      // If no new file, keep existing file info
      sql = `UPDATE permits SET schoolId = ?, levels = ?, schoolYear = ?, permitNumber = ?, extractedText = ? WHERE id = ?`;
      params = [schoolId, levels, schoolYear, permitNumber, extractedText, id];
    }

    db.run(sql, params, function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        id,
        schoolId,
        levels: JSON.parse(levels || '[]'),
        schoolYear,
        permitNumber,
        extractedText,
        filePreviewUrl: fileUrl, 
        fileName: originalName
      });
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Soft Delete a permit
app.delete('/api/permits/:id', (req, res) => {
  const { id } = req.params;
  const now = new Date().toISOString();
  db.run(`UPDATE permits SET deleted = 1, deletedAt = ? WHERE id = ?`, [now, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Permit moved to trash' });
  });
});

// Geocode an address
app.get('/api/geocode', async (req, res) => {
  const { address, name } = req.query;
  
  if (!address) {
    return res.status(400).json({ error: 'Address is required' });
  }

  try {
    const GeoService = require('./services/geoService');
    const geoService = new GeoService();
    const result = await geoService.resolveLocation(name || '', address);
    res.json(result);
  } catch (error) {
    console.error('Geocoding error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tile Proxy to bypass client-side blocking
// Renamed to 'maps/proxy' to avoid 'tile' keyword blocking
app.get('/api/maps/proxy/:z/:x/:y', (req, res) => {
  const { z, x, y } = req.params;
  const https = require('https');
  const tileUrl = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  
  console.log(`[Proxy] Fetching: ${z}/${x}/${y}`);

  const options = {
    headers: {
      'User-Agent': 'DepEdPermitSystem/1.0 (Education Project)',
      'Accept': 'image/png,image/*;q=0.8',
    }
  };
  
  const proxyReq = https.get(tileUrl, options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      console.error(`[Proxy] Upstream Error: ${proxyRes.statusCode}`);
      proxyRes.resume();
      return res.status(proxyRes.statusCode).send('Upstream error');
    }
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[Proxy] Network Error:`, err.message);
    if (!res.headersSent) res.status(502).send('Proxy network error');
  });
  
  proxyReq.setTimeout(15000, () => {
    console.error(`[Proxy] Timeout: ${z}/${x}/${y}`);
    proxyReq.destroy();
  });
});

// ─── Trash Endpoints ─────────────────────────────────────────────

// Get all trash items
app.get('/api/trash', (req, res) => {
  const result = { schools: [], permits: [] };
  
  db.all("SELECT * FROM schools WHERE deleted = 1", [], (err, schoolRows) => {
    if (err) return res.status(500).json({ error: err.message });
    result.schools = schoolRows;
    
    db.all("SELECT * FROM permits WHERE deleted = 1", [], (err, permitRows) => {
      if (err) return res.status(500).json({ error: err.message });
      
      result.permits = permitRows.map(p => ({
        ...p,
        levels: JSON.parse(p.levels || '[]'),
        filePreviewUrl: p.filePath
      }));
      
      res.json(result);
    });
  });
});

// Restore item
app.post('/api/restore/:type/:id', (req, res) => {
  const { type, id } = req.params;
  const table = type === 'school' ? 'schools' : 'permits';
  
  // If restoring a school, also restore its permits that were deleted at the same time?
  // Or just restore the school.
  // Requirement: "restore... successfully restore too". 
  // If I restore a school, I should probably restore its permits if they were deleted with it.
  // But distinguishing which permits were deleted *with* the school vs deleted individually is hard without a batch ID.
  // Simplified logic: If restoring school, restore all its currently deleted permits.
  // Or just restore the school and let user restore permits manually?
  // User said: "when it deleted the School name with the Permit it should show on the trashbin page and had action to restore and would successfully restore too."
  // This implies restoring the school should bring back its permits.
  
  if (type === 'school') {
    db.run(`UPDATE schools SET deleted = 0, deletedAt = NULL WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Also restore permits for this school
      db.run(`UPDATE permits SET deleted = 0, deletedAt = NULL WHERE schoolId = ? AND deleted = 1`, [id], (err) => {
        if (err) console.error('Error restoring permits:', err);
        res.json({ message: 'School and permits restored' });
      });
    });
  } else {
    // Restore single permit
    db.run(`UPDATE permits SET deleted = 0, deletedAt = NULL WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Permit restored' });
    });
  }
});

// Delete forever
app.delete('/api/trash/:type/:id', (req, res) => {
  const { type, id } = req.params;
  const table = type === 'school' ? 'schools' : 'permits';
  
  if (type === 'school') {
    // Delete permits first
    db.run(`DELETE FROM permits WHERE schoolId = ?`, [id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      
      db.run(`DELETE FROM schools WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'School permanently deleted' });
      });
    });
  } else {
    db.run(`DELETE FROM permits WHERE id = ?`, [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Permit permanently deleted' });
    });
  }
});

// ─── Auto Cleanup (15 days) ──────────────────────────────────────
const CLEANUP_INTERVAL = 1000 * 60 * 60; // Check every hour
setInterval(() => {
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() - 15);
  const limitStr = limitDate.toISOString();
  
  // Delete old permits
  db.run(`DELETE FROM permits WHERE deleted = 1 AND deletedAt < ?`, [limitStr], function(err) {
    if (err) console.error('Auto-cleanup permits error:', err);
    else if (this.changes > 0) console.log(`Auto-cleaned ${this.changes} permits`);
  });

  // Delete old schools (cascade to permits already handled if logic is sound, but permits are separate table)
  // We need to delete schools, but first ensure their permits are gone.
  // Actually, we should check schools.
  db.all(`SELECT id FROM schools WHERE deleted = 1 AND deletedAt < ?`, [limitStr], (err, rows) => {
    if (err) return;
    rows.forEach(row => {
      // Delete associated permits first
      db.run(`DELETE FROM permits WHERE schoolId = ?`, [row.id]);
      // Delete school
      db.run(`DELETE FROM schools WHERE id = ?`, [row.id]);
    });
    if (rows.length > 0) console.log(`Auto-cleaned ${rows.length} schools`);
  });
  
}, CLEANUP_INTERVAL);


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
