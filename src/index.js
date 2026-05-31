import "dotenv/config";
import express from "express";
import { bot, processTelegramUpdate } from "./bot.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const token = process.env.BOT_TOKEN;

app.use(express.json({ limit: "2mb" }));

function resolveCorsOrigin(req) {
  const configured = process.env.DASHBOARD_ORIGIN;

  if (!configured) {
    return "*";
  }

  const allowedOrigins = configured.split(",").map((origin) => origin.trim()).filter(Boolean);
  const requestOrigin = req.headers.origin;
  return requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
}

function setResolverCors(req, res) {
  res.set("Access-Control-Allow-Origin", resolveCorsOrigin(req));
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Cache-Control", "no-store");
  res.set("Vary", "Origin");
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

app.options("/telegram/file-url", (req, res) => {
  setResolverCors(req, res);
  res.sendStatus(204);
});

app.get("/telegram/file-url", async (req, res) => {
  setResolverCors(req, res);

  const fileId = String(req.query.fileId || "").trim();

  if (!fileId) {
    res.status(400).json({
      error: "fileId is required"
    });
    return;
  }

  try {
    const file = await bot.getFile(fileId);

    if (!file?.file_path) {
      res.status(404).json({
        error: "Telegram file path was not found"
      });
      return;
    }

    res.json({
      fileId,
      filePath: file.file_path,
      url: `https://api.telegram.org/file/bot${token}/${file.file_path}`
    });
  } catch (error) {
    res.status(502).json({
      error: error.message || "Telegram file resolution failed"
    });
  }
});

app.post("/telegram/webhook", (req, res) => {
  processTelegramUpdate(req.body);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`AniSeekBot webhook server listening on ${port}`);
});
