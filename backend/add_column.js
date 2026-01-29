const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'school_permits.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
  console.log('Connected to the SQLite database.');
});

db.serialize(() => {
  db.run("ALTER TABLE permits ADD COLUMN extractedText TEXT", function(err) {
    if (err) {
      // Ignore error if column already exists
      if (err.message.includes('duplicate column name')) {
        console.log('Column extractedText already exists.');
      } else {
        console.error("Error adding column:", err.message);
      }
    } else {
      console.log("Column extractedText added successfully.");
    }
  });
});

db.close((err) => {
  if (err) {
    console.error('Error closing database:', err.message);
  } else {
    console.log('Database connection closed.');
  }
});
