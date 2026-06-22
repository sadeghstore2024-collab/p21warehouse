import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// --- SQLite storage ---
// Use a persistent Railway Volume if one is mounted (set DATA_DIR to its path),
// otherwise fall back to the app folder.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "data.sqlite");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);

const readState = () => {
  const row = db.prepare("SELECT value FROM state WHERE key = 'main'").get();
  return row ? JSON.parse(row.value) : {};
};

const writeState = (data) => {
  db.prepare(
    "INSERT INTO state (key, value, updated_at) VALUES ('main', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(JSON.stringify(data), Date.now());
};

const getLastUpdated = () => {
  const row = db.prepare("SELECT updated_at FROM state WHERE key = 'main'").get();
  return row ? row.updated_at : 0;
};

app.use(express.json({ limit: "50mb" }));

// Allow all devices and browsers to access
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Return data with server timestamp for conflict detection
app.get("/api/state", (req, res) => {
  try {
    const data = readState();
    const updatedAt = getLastUpdated();
    res.json({ ...data, _serverUpdatedAt: updatedAt });
  } catch {
    res.json({ _serverUpdatedAt: 0 });
  }
});

app.post("/api/state", (req, res) => {
  try {
    const { _serverUpdatedAt, ...cleanData } = req.body;
    writeState(cleanData);
    res.json({ ok: true, updatedAt: getLastUpdated() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Automatic Telegram backup (sends a copy of the data every 6 hours) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendBackupToTelegram() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const data = readState();
    const json = JSON.stringify(data, null, 2);
    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append(
      "document",
      new Blob([json], { type: "application/json" }),
      `backup-${new Date().toISOString().slice(0, 10)}.json`
    );
    form.append("caption", "📦 پشتیبان خودکار اطلاعات انبار");
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    console.error("Telegram backup failed:", err);
  }
}

setInterval(sendBackupToTelegram, 6 * 60 * 60 * 1000);

app.use(express.static(path.join(__dirname, "dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
