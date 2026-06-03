import "dotenv/config";
import express from "express";
import { Readable } from "node:stream";
import { bot, processTelegramUpdate } from "./bot.js";

const app = express();
const port = Number(process.env.PORT || 8080);
const token = process.env.BOT_TOKEN;
const defaultDashboardOrigins = [
  "https://aniseek.web.app",
  "https://aniseek-5e38b.web.app",
  "http://localhost:5176",
  "http://127.0.0.1:5176",
  "http://localhost:5177",
  "http://127.0.0.1:5177"
];

app.use(express.json({ limit: "2mb" }));

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "");
}

function dashboardOrigins() {
  const configuredOrigins = String(process.env.DASHBOARD_ORIGIN || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  return [...new Set([...configuredOrigins, ...defaultDashboardOrigins.map(normalizeOrigin)])];
}

function setResolverCors(req, res) {
  res.set("Cache-Control", "no-store");
  res.set("Vary", "Origin");

  const requestOrigin = normalizeOrigin(req.headers.origin);
  if (!requestOrigin) {
    return true;
  }

  if (!dashboardOrigins().includes(requestOrigin)) {
    return false;
  }

  res.set("Access-Control-Allow-Origin", requestOrigin);
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Range");
  res.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  return true;
}

function rejectResolverOrigin(res, fileId = null) {
  res.status(403).json({
    ok: false,
    fileId,
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

function publicBaseUrl(req) {
  const configuredUrl = normalizeOrigin(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL);

  if (configuredUrl) {
    return configuredUrl;
  }

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");

  return host ? `${protocol}://${host}` : "";
}

function telegramFileDownloadUrl(filePath) {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

function publicTelegramFileProxyUrl(req, fileId) {
  const baseUrl = publicBaseUrl(req);

  if (!baseUrl || !fileId) {
    return "";
  }

  return `${baseUrl}/api/telegram-file/${encodeURIComponent(fileId)}/content`;
}

async function resolveTelegramFile(req, res, fileId) {
  if (!setResolverCors(req, res)) {
    rejectResolverOrigin(res, String(fileId || "").trim() || null);
    return;
  }

  const normalizedFileId = String(fileId || "").trim();

  if (!normalizedFileId) {
    res.status(400).json({
      ok: false,
      fileId: normalizedFileId,
      error: "fileId is required"
    });
    return;
  }

  try {
    const file = await bot.getFile(normalizedFileId);

    if (!file?.file_path) {
      res.status(404).json({
        ok: false,
        fileId: normalizedFileId,
        error: "Telegram file path was not found",
        telegramDescription: "Telegram getFile response did not include file_path."
      });
      return;
    }

    res.json({
      ok: true,
      fileId: normalizedFileId,
      filePath: file.file_path,
      url: publicTelegramFileProxyUrl(req, normalizedFileId)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      fileId: normalizedFileId,
      error: error.message || "Telegram file resolution failed",
      telegramDescription: error.response?.body?.description || error.description || error.message || null
    });
  }
}

async function streamTelegramFile(req, res, fileId) {
  if (!setResolverCors(req, res)) {
    rejectResolverOrigin(res, String(fileId || "").trim() || null);
    return;
  }

  const normalizedFileId = String(fileId || "").trim();

  if (!normalizedFileId) {
    res.status(400).json({
      ok: false,
      fileId: normalizedFileId,
      error: "fileId is required"
    });
    return;
  }

  try {
    const file = await bot.getFile(normalizedFileId);

    if (!file?.file_path) {
      res.status(404).json({
        ok: false,
        fileId: normalizedFileId,
        error: "Telegram file path was not found",
        telegramDescription: "Telegram getFile response did not include file_path."
      });
      return;
    }

    const telegramResponse = await fetch(telegramFileDownloadUrl(file.file_path), {
      headers: req.headers.range ? { Range: req.headers.range } : undefined
    });

    res.status(telegramResponse.status);
    ["content-type", "content-length", "content-range", "accept-ranges"].forEach((header) => {
      const value = telegramResponse.headers.get(header);

      if (value) {
        res.set(header, value);
      }
    });

    if (!telegramResponse.ok && telegramResponse.status !== 206) {
      res.json({
        ok: false,
        fileId: normalizedFileId,
        filePath: file.file_path,
        error: `Telegram file download failed with ${telegramResponse.status}`,
        telegramDescription: telegramResponse.statusText || null
      });
      return;
    }

    if (!telegramResponse.body) {
      res.status(502).json({
        ok: false,
        fileId: normalizedFileId,
        filePath: file.file_path,
        error: "Telegram file download response had no body"
      });
      return;
    }

    Readable.fromWeb(telegramResponse.body).pipe(res);
  } catch (error) {
    res.status(502).json({
      ok: false,
      fileId: normalizedFileId,
      error: error.message || "Telegram file streaming failed",
      telegramDescription: error.response?.body?.description || error.description || error.message || null
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

app.options("/api/telegram-file/:fileId/content", resolverOptions);

app.get("/api/telegram-file/:fileId/content", async (req, res) => {
  await streamTelegramFile(req, res, req.params.fileId);
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
