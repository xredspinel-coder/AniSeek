import "dotenv/config";
import express from "express";
import { bot, processTelegramUpdate } from "./bot.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const token = process.env.BOT_TOKEN;

app.use(express.json({ limit: "2mb" }));

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "");
}

function dashboardOrigins() {
  return String(process.env.DASHBOARD_ORIGIN || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function setResolverCors(req, res) {
  res.set("Cache-Control", "no-store");
  res.set("Vary", "Origin");

  const requestOrigin = normalizeOrigin(req.headers.origin);
  if (!requestOrigin || !dashboardOrigins().includes(requestOrigin)) {
    return false;
  }

  res.set("Access-Control-Allow-Origin", requestOrigin);
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

function rejectResolverOrigin(res) {
  res.status(403).json({
    ok: false,
    error: "Origin is not allowed."
  });
}

function resolverOptions(req, res) {
  if (!setResolverCors(req, res)) {
    res.sendStatus(403);
    return;
  }

  res.sendStatus(204);
}

async function resolveTelegramFile(req, res, fileId) {
  if (!setResolverCors(req, res)) {
    rejectResolverOrigin(res);
    return;
  }

  const normalizedFileId = String(fileId || "").trim();

  if (!normalizedFileId) {
    res.status(400).json({
      ok: false,
      error: "fileId is required"
    });
    return;
  }

  try {
    const file = await bot.getFile(normalizedFileId);

    if (!file?.file_path) {
      res.status(404).json({
        ok: false,
        error: "Telegram file path was not found"
      });
      return;
    }

    res.json({
      ok: true,
      fileId: normalizedFileId,
      filePath: file.file_path,
      url: `https://api.telegram.org/file/bot${token}/${file.file_path}`
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message || "Telegram file resolution failed"
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    name: "AniSeekBot",
    status: "ok"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true
  });
});

app.options("/api/telegram-file/:fileId", resolverOptions);

app.get("/api/telegram-file/:fileId", async (req, res) => {
  await resolveTelegramFile(req, res, req.params.fileId);
});

app.options("/telegram/file-url", resolverOptions);

app.get("/telegram/file-url", async (req, res) => {
  await resolveTelegramFile(req, res, req.query.fileId);
});

app.post("/telegram/webhook", (req, res) => {
  processTelegramUpdate(req.body);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`AniSeekBot webhook server listening on ${port}`);
});
