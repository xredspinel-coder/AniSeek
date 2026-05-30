import "dotenv/config";
import express from "express";
import { processTelegramUpdate } from "./bot.js";

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(express.json({ limit: "2mb" }));

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

app.post("/telegram/webhook", (req, res) => {
  processTelegramUpdate(req.body);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`AniSeekBot webhook server listening on ${port}`);
});
