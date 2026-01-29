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
  db.run("DELETE FROM permits", function(err) {
    if (err) {
      console.error("Error deleting permits:", err.message);
    } else {
      console.log(`Deleted ${this.changes} rows from permits.`);
    }
  });

  db.run("DELETE FROM schools", function(err) {
    if (err) {
      console.error("Error deleting schools:", err.message);
    } else {
      console.log(`Deleted ${this.changes} rows from schools.`);
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
