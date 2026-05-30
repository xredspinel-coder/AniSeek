import TelegramBot from "node-telegram-bot-api";
import { getSettings } from "./services/settingsService.js";
import { getOrCreateUser } from "./services/userService.js";
import { checkAnalysisAccess, incrementDailyUsage } from "./services/limitService.js";
import { searchAnimeScene } from "./services/animeService.js";
import { recordActivity, recordError } from "./services/activityService.js";
import { InputResolutionError, extractUrls, resolveImageInput } from "./services/linkExtractorService.js";

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

function buildUserSnapshot(user) {
  return {
    telegramId: user.telegramId,
    username: user.username || null,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.telegramId
  };
}

function buildUserInput(message, input = {}) {
  const text = message.text || message.caption || null;
  const [firstUrl] = extractUrls(message);

  return {
    messageId: message.message_id || null,
    chatId: message.chat?.id ? String(message.chat.id) : null,
    text,
    url: input.inputUrl || firstUrl || null,
    fileId: input.inputFileId || message.document?.file_id || null,
    source: input.source || null,
    type: input.inputType || null,
    isForwarded: Boolean(message.forward_origin || message.forward_from || message.forward_sender_name || message.forward_date)
  };
}

function buildSuccessResponse(match) {
  return {
    title: match.animeTitle,
    similarity: match.similarity,
    episode: match.episode ?? null,
    time: match.formattedTime || null,
    anilistUrl: match.anilistUrl || null,
    imageUrl: match.imageUrl || null,
    videoUrl: match.videoUrl || null
  };
}

function buildResultMessage(match) {
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

  return lines.join("\n");
}

async function sendResult(chatId, match, settings) {
  const caption = buildResultMessage(match);

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
  const userSnapshot = buildUserSnapshot(user);
  let input;

  try {
    input = await resolveImageInput(message, bot, settings);
  } catch (error) {
    const status = error instanceof InputResolutionError ? error.status : "failed";
    const rejectionReason = error instanceof InputResolutionError ? error.rejectionReason : "processing_error";
    const botResponse = {
      message: error.message
    };

    await recordActivity({
      userId: user.telegramId,
      user: userSnapshot,
      source: error.source || "unknown",
      inputUrl: error.inputUrl || buildUserInput(message).url,
      inputType: error.source || "unknown",
      userInput: buildUserInput(message, {
        inputUrl: error.inputUrl,
        source: error.source,
        inputType: error.source
      }),
      status,
      rejectionReason,
      botResponse,
      error: status === "failed" ? error.message : null
    });

    if (status === "failed") {
      await recordError({
        userId: user.telegramId,
        source: error.source || null,
        inputUrl: error.inputUrl || null,
        message: error.message,
        stack: error.stack
      }, {
        countAnalytics: false
      });
    }

    await bot.sendMessage(chatId, error.message);
    return;
  }

  if (!input) {
    const botResponse = {
      message: "Send an anime screenshot, a forwarded image, a direct image URL, or a supported social link."
    };

    await recordActivity({
      userId: user.telegramId,
      user: userSnapshot,
      source: "unknown",
      inputType: "unknown",
      userInput: buildUserInput(message),
      status: "rejected",
      rejectionReason: "invalid_media",
      botResponse
    });

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
  let resultSent = false;

  try {
    const match = await searchAnimeScene(input.imageUrl);
    const threshold = Number(settings.similarityThreshold) || 0;

    if (match.similarity < threshold) {
      const messageText = `No confident match. Best result was ${match.similarity}%, below the ${threshold}% threshold.`;

      await recordActivity({
        userId: user.telegramId,
        user: userSnapshot,
        source: input.source,
        ...input,
        inputUrl: input.inputUrl || input.imageUrl,
        userInput: buildUserInput(message, input),
        ...match,
        status: "rejected",
        rejectionReason: "low_similarity",
        botResponse: {
          ...buildSuccessResponse(match),
          message: messageText
        },
        error: `Similarity is below ${threshold}%`
      });

      await bot.sendMessage(chatId, messageText);
      return;
    }

    await sendResult(chatId, match, settings);
    resultSent = true;

    await recordActivity({
      userId: user.telegramId,
      user: userSnapshot,
      source: input.source,
      ...input,
      inputUrl: input.inputUrl || input.imageUrl,
      userInput: buildUserInput(message, input),
      ...match,
      status: "success",
      rejectionReason: null,
      botResponse: buildSuccessResponse(match)
    });

    await incrementDailyUsage(user.telegramId);
  } catch (error) {
    if (resultSent) {
      console.error("Successful Telegram response was sent, but post-send logging failed.", error);
      return;
    }

    const isNoMatch = /did not return a match|no result/i.test(error.message);
    const status = isNoMatch ? "rejected" : "failed";
    const rejectionReason = isNoMatch ? "no_match" : "api_error";
    const messageText = `I could not analyze that image: ${error.message}`;

    await recordActivity({
      userId: user.telegramId,
      user: userSnapshot,
      source: input.source,
      ...input,
      inputUrl: input.inputUrl || input.imageUrl,
      userInput: buildUserInput(message, input),
      status,
      rejectionReason,
      botResponse: {
        message: messageText
      },
      error: error.message
    });

    if (status === "failed") {
      await recordError({
        userId: user.telegramId,
        source: input.source,
        inputUrl: input.inputUrl || input.imageUrl,
        message: error.message,
        stack: error.stack
      }, {
        countAnalytics: false
      });
    }

    await bot.sendMessage(chatId, messageText);
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
