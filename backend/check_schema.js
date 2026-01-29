const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'school_permits.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error(err.message);
    return;
  }
});

db.all("PRAGMA table_info(permits)", [], (err, rows) => {
  if (err) {
    console.error(err.message);
  } else {
    console.log("Permits table columns:", rows.map(r => r.name));
  }
  db.close();
});
