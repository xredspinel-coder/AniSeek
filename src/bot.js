import TelegramBot from "node-telegram-bot-api";
import { getSettings } from "./services/settingsService.js";
import { getOrCreateUser } from "./services/userService.js";
import { checkAnalysisAccess, incrementDailyUsage } from "./services/limitService.js";
import { searchAnimeScene } from "./services/animeService.js";
import { recordActivity, recordError } from "./services/activityService.js";
import { resolveImageInput } from "./services/linkExtractorService.js";

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is required.");
}

export const bot = new TelegramBot(token, {
  polling: false
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function helpMessage() {
  return [
    "<b>AniSeek</b>",
    "Send an anime screenshot, a forwarded image, a direct image URL, or a supported social link.",
    "",
    "Supported links: direct images, Reddit, Twitter/X best effort, Facebook best effort."
  ].join("\n");
}

function buildResultMessage(match, activityId) {
  const lines = [
    `<b>${escapeHtml(match.animeTitle)}</b>`,
    `Similarity: <b>${escapeHtml(match.similarity)}%</b>`
  ];

  if (match.formattedTime) {
    lines.push(`Time: <b>${escapeHtml(match.formattedTime)}</b>`);
  }

  if (match.episode !== null && match.episode !== undefined) {
    lines.push(`Episode: <b>${escapeHtml(match.episode)}</b>`);
  }

  if (match.anilistUrl) {
    lines.push(`AniList: <a href="${escapeHtml(match.anilistUrl)}">open page</a>`);
  }

  lines.push(`Activity: <code>${escapeHtml(activityId)}</code>`);
  return lines.join("\n");
}

async function sendResult(chatId, match, activityId, settings) {
  const caption = buildResultMessage(match, activityId);

  if (settings.enableVideoPreview && match.videoUrl) {
    try {
      await bot.sendVideo(chatId, match.videoUrl, {
        caption,
        parse_mode: "HTML"
      });
      return;
    } catch (error) {
      console.warn("Telegram video preview failed, falling back to message.", error.message);
    }
  }

  await bot.sendMessage(chatId, caption, {
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

async function handleAnalysis(message, user, settings) {
  const chatId = message.chat.id;
  let input;

  try {
    input = await resolveImageInput(message, bot, settings);
  } catch (error) {
    await recordError({
      userId: user.telegramId,
      message: error.message,
      stack: error.stack
    });

    await bot.sendMessage(chatId, error.message);
    return;
  }

  if (!input) {
    await bot.sendMessage(chatId, helpMessage(), {
      parse_mode: "HTML"
    });
    return;
  }

  const access = await checkAnalysisAccess(user, settings);

  if (!access.allowed) {
    await bot.sendMessage(chatId, access.reason);
    return;
  }

  const progressMessage = await bot.sendMessage(chatId, "Searching the scene...");

  try {
    const match = await searchAnimeScene(input.imageUrl);
    const threshold = Number(settings.similarityThreshold) || 0;
    const status = match.similarity >= threshold ? "success" : "low_similarity";

    const activity = await recordActivity({
      userId: user.telegramId,
      source: input.source,
      inputUrl: input.inputUrl || input.imageUrl,
      ...match,
      status,
      error: status === "low_similarity" ? `Similarity is below ${threshold}%` : null
    });

    await incrementDailyUsage(user.telegramId);

    if (status === "low_similarity") {
      await bot.sendMessage(
        chatId,
        `No confident match. Best result was ${match.similarity}%, below the ${threshold}% threshold.`
      );
      return;
    }

    await sendResult(chatId, match, activity.id, settings);
  } catch (error) {
    await recordActivity({
      userId: user.telegramId,
      source: input.source,
      inputUrl: input.inputUrl || input.imageUrl,
      status: "error",
      error: error.message
    });

    await recordError({
      userId: user.telegramId,
      source: input.source,
      inputUrl: input.inputUrl || input.imageUrl,
      message: error.message,
      stack: error.stack
    }, {
      countAnalytics: false
    });

    await incrementDailyUsage(user.telegramId);
    await bot.sendMessage(chatId, `I could not analyze that image: ${error.message}`);
  } finally {
    bot.deleteMessage(chatId, progressMessage.message_id).catch(() => {});
  }
}

bot.on("message", async (message) => {
  try {
    if (!message.from || !message.chat) {
      return;
    }

    const settings = await getSettings();
    const user = await getOrCreateUser(message);
    const text = message.text || "";

    if (text.startsWith("/start") || text.startsWith("/help")) {
      await bot.sendMessage(message.chat.id, helpMessage(), {
        parse_mode: "HTML"
      });
      return;
    }

    await handleAnalysis(message, user, settings);
  } catch (error) {
    console.error("Message handling failed.", error);
    if (message.chat?.id) {
      await bot.sendMessage(message.chat.id, "AniSeek hit an internal error. The error was logged.");
    }

    await recordError({
      userId: message.from?.id,
      message: error.message,
      stack: error.stack
    }).catch(() => {});
  }
});

export function processTelegramUpdate(update) {
  bot.processUpdate(update);
}
