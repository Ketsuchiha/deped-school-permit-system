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
    // Create tables
    db.run(`CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT
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
      FOREIGN KEY(schoolId) REFERENCES schools(id)
    )`);
  }
});

// ─── API Endpoints ─────────────────────────────────────────────

// Get all schools
app.get('/api/schools', (req, res) => {
  db.all("SELECT * FROM schools", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Create a school
app.post('/api/schools', (req, res) => {
  const { id, name, type, address } = req.body;
  const sql = `INSERT INTO schools (id, name, type, address) VALUES (?, ?, ?, ?)`;
  db.run(sql, [id, name, type, address], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, name, type, address });
  });
});

// Get all permits
app.get('/api/permits', (req, res) => {
  db.all("SELECT * FROM permits", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // Parse levels back to array
    const permits = rows.map(p => ({
      ...p,
      levels: JSON.parse(p.levels),
      filePreviewUrl: p.filePath
    }));
    res.json(permits);
  });
});

// Upload a permit
app.post('/api/permits', upload.single('file'), (req, res) => {
  try {
    const { id, schoolId, levels, schoolYear, permitNumber, extractedText } = req.body;
    
    // For Homeschooling, file might be optional (application data only)
    // We won't strictly enforce file presence here, but frontend should for non-homeschooling.
    
    let fileUrl = null;
    let filePath = null;
    let originalName = null;

    if (req.file) {
      fileUrl = `http://localhost:${PORT}/uploads/${req.file.filename}`;
      filePath = req.file.path;
      originalName = req.file.originalname;
    }
    
    const sql = `INSERT INTO permits (id, schoolId, levels, schoolYear, permitNumber, extractedText, filePath, fileName) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    // Levels comes as a stringified JSON from frontend or form-data
    
    db.run(sql, [id, schoolId, levels, schoolYear, permitNumber, extractedText, fileUrl, originalName], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        id,
        schoolId,
        levels: JSON.parse(levels),
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
