import crypto from "node:crypto";
import TelegramBot from "node-telegram-bot-api";
import { getSettings } from "./services/settingsService.js";
import { getOrCreateUser } from "./services/userService.js";
import { checkAnalysisAccess, incrementDailyUsage } from "./services/limitService.js";
import { searchAnimeScene } from "./services/animeService.js";
import { isTechnicalFailureType, recordActivity, recordError, updateActivitySentMedia } from "./services/activityService.js";
import {
  WRONG_MATCH_REASONS,
  canTrustedUserBypass,
  createWrongMatchReport,
  getRandomAnime,
  getTopAnime,
  getTrendingSearches,
  getUsageSummary,
  getUserStatsSummary,
  isTrustedUser,
  recordBotEvent,
  setWrongMatchReason
} from "./services/featureService.js";
import {
  InputResolutionError,
  extractUrls,
  resolveDiscoveredImageInput,
  resolveImageInput,
  resolveMaxDiscoveredImages,
  resolveTrustedLinkSelection
} from "./services/linkExtractorService.js";

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is required.");
}

export const bot = new TelegramBot(token, {
  polling: false
});

const TRENDING_WINDOW_HOURS = 24;
const IMAGE_SELECTION_TTL_MS = 15 * 60 * 1000;
const imageSelections = new Map();
const FEATURE_ITEMS = [
  {
    key: "usage",
    setting: "enableMyUsage",
    label: "📊 My Usage",
    callbackData: "usage",
    command: "/usage",
    disabledMessage: "This feature is not available right now."
  },
  {
    key: "stats",
    setting: "enableMyStatistics",
    label: "📈 My Statistics",
    callbackData: "stats",
    command: "/stats",
    disabledMessage: "This feature is not available right now."
  },
  {
    key: "trending",
    setting: "enableTrendingSearches",
    label: "🔥 Trending Searches",
    callbackData: "trend",
    command: "/trending",
    disabledMessage: "This feature is not available right now."
  },
  {
    key: "random",
    setting: "enableRandomAnime",
    label: "🎲 Random Anime",
    callbackData: "random",
    command: "/random",
    disabledMessage: "This feature is not available right now."
  },
  {
    key: "top",
    setting: "enableTopAnime",
    label: "🏆 Top Anime",
    callbackData: "top",
    command: "/top",
    disabledMessage: "This feature is not available right now."
  }
];

function pruneImageSelections(now = Date.now()) {
  for (const [selectionId, selection] of imageSelections.entries()) {
    if (now - selection.createdAt > IMAGE_SELECTION_TTL_MS) {
      imageSelections.delete(selectionId);
    }
  }
}

function messageSnapshot(message) {
  return {
    message_id: message.message_id || null,
    text: message.text || null,
    caption: message.caption || null,
    chat: {
      id: message.chat?.id || null
    },
    from: message.from || null
  };
}

function storeImageSelection(message, user, selection) {
  pruneImageSelections();

  const selectionId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  imageSelections.set(selectionId, {
    id: selectionId,
    userId: String(user.telegramId || user.id || message.from?.id || ""),
    chatId: String(message.chat?.id || ""),
    message: messageSnapshot(message),
    url: selection.url,
    sourceType: selection.sourceType,
    metadata: selection.metadata,
    bestInput: selection.bestInput,
    images: selection.images,
    createdAt: Date.now()
  });

  return selectionId;
}

function getImageSelection(selectionId) {
  pruneImageSelections();
  return imageSelections.get(selectionId) || null;
}

function trustedLinkKeyboard(selectionId) {
  return {
    inline_keyboard: [
      [{ text: "Use best image", callback_data: `imgbest:${selectionId}` }],
      [{ text: "Show discovered images", callback_data: `imglist:${selectionId}` }]
    ]
  };
}

function imageDimensionLabel(image = {}) {
  if (Number.isFinite(image.width) && Number.isFinite(image.height)) {
    return `${image.width}x${image.height}`;
  }

  return "Unknown size";
}

function imageSourceLabel(image = {}) {
  return String(image.source || image.title || image.alt || "metadata image")
    .replace(/[_-]+/g, " ")
    .slice(0, 80);
}

function formatDiscoveredImagesMessage(images = []) {
  return [
    "<b>Choose an image to analyze:</b>",
    "",
    ...images.map((image, index) => `${index + 1}. ${escapeHtml(imageDimensionLabel(image))} - ${escapeHtml(imageSourceLabel(image))}`)
  ].join("\n");
}

function discoveredImagesKeyboard(selectionId, images = []) {
  const rows = [];

  for (let index = 0; index < images.length; index += 5) {
    rows.push(images.slice(index, index + 5).map((_, offset) => {
      const imageIndex = index + offset;
      return {
        text: String(imageIndex + 1),
        callback_data: `imgselect:${selectionId}:${imageIndex}`
      };
    }));
  }

  return {
    inline_keyboard: rows
  };
}

async function sendTrustedLinkSelection(chatId, selectionId) {
  await bot.sendMessage(chatId, "I found images in that link. Choose how you want to continue.", {
    reply_markup: trustedLinkKeyboard(selectionId)
  });
}

async function replaceCallbackMessage(query, text, options = {}) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    return false;
  }

  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options
    });
    return true;
  } catch {
    return false;
  }
}

async function clearCallbackMarkup(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (!chatId || !messageId) {
    return;
  }

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId,
    message_id: messageId
  }).catch(() => {});
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isFeatureEnabled(settings = {}, key) {
  const feature = FEATURE_ITEMS.find((item) => item.key === key || item.callbackData === key || item.command === key);

  if (!feature) {
    return false;
  }

  return settings[feature.setting] !== false;
}

function enabledFeatureItems(settings = {}) {
  return FEATURE_ITEMS.filter((item) => isFeatureEnabled(settings, item.key));
}

function featureByCommand(command) {
  return FEATURE_ITEMS.find((item) => item.command === command) || null;
}

function featureByCallbackData(data) {
  return FEATURE_ITEMS.find((item) => item.callbackData === data) || null;
}

function helpMessage(settings = {}) {
  const commands = enabledFeatureItems(settings).map((item) => item.command);
  const supportedLinks = ["direct images"];

  if (settings.enableReddit !== false) {
    supportedLinks.push("Reddit");
  }

  if (settings.enableTwitter !== false) {
    supportedLinks.push("Twitter/X best effort");
  }

  if (settings.enableFacebook) {
    supportedLinks.push("Facebook best effort");
  }

  if (settings.enableGenericLinks !== false) {
    supportedLinks.push("generic website previews");
  }

  const lines = [
    "<b>AniSeek</b>",
    "Send an anime screenshot, a forwarded image, a direct image URL, or a supported social link.",
    "",
    `Supported links: ${supportedLinks.join(", ")}.`
  ];

  if (commands.length) {
    lines.push("", `Commands: ${commands.join(", ")}`);
  }

  return lines.join("\n");
}

function commandName(text = "") {
  const [command] = String(text || "").trim().split(/\s+/);
  return command ? command.split("@")[0].toLowerCase() : "";
}

function resultActions(activityId, settings = {}) {
  if (!activityId) {
    return undefined;
  }

  const row = [
    { text: "⚠️ Wrong Match", callback_data: `wrong:${activityId}` }
  ];

  if (enabledFeatureItems(settings).length) {
    row.push({ text: "📋 More", callback_data: `more:${activityId}` });
  }

  return {
    inline_keyboard: [row]
  };
}

function moreMenuKeyboard(settings = {}) {
  return {
    inline_keyboard: enabledFeatureItems(settings).map((item) => [
      { text: item.label, callback_data: item.callbackData }
    ])
  };
}

function wrongMatchReasonKeyboard(reportId) {
  return {
    inline_keyboard: Object.entries(WRONG_MATCH_REASONS).map(([key, label]) => [
      { text: label, callback_data: `wr:${reportId}:${key}` }
    ])
  };
}

function formatDate(value) {
  if (!value) {
    return null;
  }

  return value.toLocaleDateString("en-CA");
}

function formatUsageMessage(summary) {
  const lines = [
    "<b>📊 My Usage</b>",
    "",
    summary.hasUnlimited || summary.user.isAdmin
      ? `Used today: <b>${escapeHtml(summary.dailyUsed)} / Unlimited</b>`
      : `Used today: <b>${escapeHtml(summary.dailyUsed)} / ${escapeHtml(summary.dailyLimit)}</b>`,
    summary.remaining === null ? "Remaining: <b>Unlimited</b>" : `Remaining: <b>${escapeHtml(summary.remaining)}</b>`,
    `Reset: <b>${escapeHtml(summary.resetLabel)}</b>`
  ];

  if (summary.dailyLimitOverride !== null) {
    lines.push("", `Custom daily limit: <b>${escapeHtml(summary.dailyLimitOverride)}</b>`);
  }

  if (summary.hasUnlimited) {
    lines.push("", `Unlimited access until: <b>${escapeHtml(formatDate(summary.unlimitedUntil) || "active")}</b>`);
  }

  if (summary.trustedUser) {
    lines.push("", "Trusted mode: <b>enabled</b>");
  }

  return lines.join("\n");
}

function formatStatsMessage(stats) {
  const total = Number(stats.totalSearches || 0);
  const successRate = total ? Math.round((Number(stats.successfulSearches || 0) / total) * 100) : 0;
  const topAnime = stats.topAnime?.animeTitle || stats.topAnime?.title || "Not enough data";

  return [
    "<b>📈 My Statistics</b>",
    "",
    `Total searches: <b>${escapeHtml(total)}</b>`,
    `Successful: <b>${escapeHtml(stats.successfulSearches || 0)}</b>`,
    `Rejected: <b>${escapeHtml(stats.rejectedSearches || 0)}</b>`,
    `Failed: <b>${escapeHtml(stats.failedSearches || 0)}</b>`,
    `Success rate: <b>${escapeHtml(successRate)}%</b>`,
    `Average similarity: <b>${escapeHtml(stats.averageSimilarity || 0)}%</b>`,
    `Most searched anime: <b>${escapeHtml(topAnime)}</b>`
  ].join("\n");
}

function formatAnimeRanking(title, items, emptyMessage) {
  if (!items.length) {
    return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(emptyMessage)}`;
  }

  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    ...items.map((item, index) => `${index + 1}. ${escapeHtml(item.animeTitle)} - ${escapeHtml(item.count)} searches`)
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
    fileId: input.inputTelegramFileId || input.inputFileId || message.document?.file_id || null,
    source: input.source || null,
    sourceType: input.sourceType || null,
    type: input.inputType || null,
    extractedImageUrl: input.extractedImageUrl || null,
    inputSourceDomain: input.inputSourceDomain || null,
    previewExtractionStatus: input.previewExtractionStatus || null,
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

function buildActivityMedia(input = {}, result = {}, sentMedia = {}) {
  const inputTelegramFileId = input.inputTelegramFileId || input.inputFileId || null;

  return {
    inputTelegramFileId,
    sentPhotoFileId: sentMedia.sentPhotoFileId || null,
    sentVideoFileId: sentMedia.sentVideoFileId || null,
    sentAnimationFileId: sentMedia.sentAnimationFileId || null,
    inputImageUrl: inputTelegramFileId ? null : input.inputImageUrl || input.inputPreview || input.inputThumbnail || null,
    extractedImageUrl: input.extractedImageUrl || null,
    inputTelegramFileUrl: input.inputTelegramFileUrl || null,
    resultImageUrl: result.imageUrl || result.resultImageUrl || null,
    resultVideoUrl: result.videoUrl || result.resultVideoUrl || null,
    botVideoUrl: sentMedia.botVideoUrl || null,
    botImageUrl: sentMedia.botImageUrl || null
  };
}

function previewExtractionSnapshot(input = {}) {
  return {
    sourceType: input.sourceType || null,
    extractedImageUrl: input.extractedImageUrl || null,
    inputSourceDomain: input.inputSourceDomain || null,
    previewExtractionMethod: input.previewExtractionMethod || null,
    previewExtractionStatus: input.previewExtractionStatus || null,
    previewExtractionError: input.previewExtractionError || null,
    previewExtractionCandidateCount: Number.isFinite(input.previewExtractionCandidateCount)
      ? input.previewExtractionCandidateCount
      : null,
    previewExtractionSelectedMimeType: input.previewExtractionSelectedMimeType || null,
    providerDiagnostics: input.providerDiagnostics || null,
    provider: input.provider || input.providerDiagnostics?.platform || null,
    bestImageUrl: input.bestImageUrl || null,
    selectedImageUrl: input.selectedImageUrl || input.extractedImageUrl || null,
    imageCount: input.imageCount ?? input.previewExtractionCandidateCount ?? null,
    filteredImageCount: input.filteredImageCount ?? null,
    fallbackUsed: input.fallbackUsed || null,
    telegramPreviewUsed: Boolean(input.telegramPreviewUsed || input.fallbackUsed === "telegram_preview")
  };
}

function progressMessageText(input = {}) {
  if (
    input.previewExtractionStatus === "success" &&
    input.extractedImageUrl &&
    input.sourceType &&
    input.sourceType !== "direct_image_url"
  ) {
    return "Found a preview image from this link. Analyzing...";
  }

  return "Searching the scene...";
}

function inputResolutionUserMessage(error) {
  if (!(error instanceof InputResolutionError)) {
    return "I could not process that request. Please send an anime screenshot or a supported image link.";
  }

  if (error.rejectionReason === "telegram_download_error") {
    return "I could not download that Telegram image. Please send it again or upload the image directly.";
  }

  if (error.rejectionReason === "unsupported_source") {
    return "This feature is not available right now.";
  }

  if (error.rejectionReason === "invalid_url") {
    return "That link is not supported. Please send a public http:// or https:// image link.";
  }

  if (error.rejectionReason === "metadata_fetch_error") {
    return "I could not open this link. Try another link or send the image directly.";
  }

  if (error.rejectionReason === "provider_blocked") {
    return "I could not extract a suitable image from this link. If Telegram shows a preview image, I will try to use it. Otherwise, send the image directly.";
  }

  if (error.rejectionReason === "invalid_media") {
    return "I could not find a usable image in that message. Please send the image directly or try another link.";
  }

  return "I could not open that link. Please try another link or send the image directly.";
}

async function recordInputResolutionFailure(message, user, error) {
  const chatId = message.chat.id;
  const userSnapshot = buildUserSnapshot(user);
  const rejectionReason = error instanceof InputResolutionError ? error.rejectionReason : "processing_error";
  const failureType = isTechnicalFailureType(rejectionReason) ? rejectionReason : "processing_error";
  const extraction = error instanceof InputResolutionError ? previewExtractionSnapshot(error) : {};
  const userMessage = inputResolutionUserMessage(error);
  const botResponse = {
    message: userMessage
  };

  await recordError({
    userId: user.telegramId,
    user: userSnapshot,
    source: error.source || extraction.sourceType || "unknown",
    inputUrl: error.inputUrl || buildUserInput(message).url,
    inputType: extraction.sourceType || error.source || "unknown",
    userInput: buildUserInput(message, {
      inputUrl: error.inputUrl,
      source: error.source || extraction.sourceType,
      sourceType: extraction.sourceType,
      inputType: extraction.sourceType || error.source,
      ...extraction
    }),
    media: buildActivityMedia(extraction),
    ...extraction,
    status: "failed",
    failureType,
    rejectionReason,
    botResponse,
    message: error.message,
    stack: error.stack
  });

  await bot.sendMessage(chatId, userMessage);
}

function buildResultMessage(match, { trustedLowSimilarity = false } = {}) {
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

  if (trustedLowSimilarity) {
    lines.push("", "<i>Trusted mode allowed this low-confidence result.</i>");
  }

  return lines.join("\n");
}

function sentTelegramMediaIds(sentMessage = {}) {
  return {
    sentPhotoFileId: sentMessage.photo?.at(-1)?.file_id || null,
    sentVideoFileId: sentMessage.video?.file_id || null,
    sentAnimationFileId: sentMessage.animation?.file_id || null
  };
}

async function sendResult(chatId, match, settings, { trustedLowSimilarity = false } = {}) {
  const caption = buildResultMessage(match, { trustedLowSimilarity });

  if (match.videoUrl) {
    try {
      const sentMessage = await bot.sendVideo(chatId, match.videoUrl, {
        caption,
        parse_mode: "HTML"
      });
      return {
        messageId: sentMessage.message_id,
        botVideoUrl: null,
        botImageUrl: null,
        ...sentTelegramMediaIds(sentMessage)
      };
    } catch (error) {
      console.warn("Telegram video preview failed, falling back to message.", error.message);
    }
  }

  const sentMessage = await bot.sendMessage(chatId, caption, {
    parse_mode: "HTML",
    disable_web_page_preview: false
  });

  return {
    messageId: sentMessage.message_id,
    botVideoUrl: null,
    botImageUrl: null,
    sentPhotoFileId: null,
    sentVideoFileId: null,
    sentAnimationFileId: null
  };
}

async function attachResultActions(chatId, messageId, activityId, settings) {
  if (!chatId || !messageId || !activityId) {
    return;
  }

  try {
    await bot.editMessageReplyMarkup(resultActions(activityId, settings), {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.warn("Could not attach result actions.", error.message);
  }
}

async function sendFeatureMenu(chatId, settings) {
  const keyboard = moreMenuKeyboard(settings);

  if (!keyboard.inline_keyboard.length) {
    await bot.sendMessage(chatId, "Extra AniSeek features are not available right now.");
    return;
  }

  await bot.sendMessage(chatId, "<b>AniSeek menu</b>", {
    parse_mode: "HTML",
    reply_markup: keyboard
  });
}

async function sendFeatureDisabled(chatId, feature) {
  await bot.sendMessage(chatId, feature?.disabledMessage || "This feature is not available right now.");
}

async function sendUsage(chatId, user, settings) {
  const summary = await getUsageSummary(user, settings);

  await recordBotEvent("user_requested_usage", {
    user,
    chatId
  });
  await bot.sendMessage(chatId, formatUsageMessage(summary), {
    parse_mode: "HTML"
  });
}

async function sendStats(chatId, user) {
  const stats = await getUserStatsSummary(user.telegramId);

  await recordBotEvent("user_requested_stats", {
    user,
    chatId
  });
  await bot.sendMessage(chatId, formatStatsMessage(stats), {
    parse_mode: "HTML"
  });
}

async function sendTrending(chatId, user, settings) {
  const hours = TRENDING_WINDOW_HOURS;
  const items = await getTrendingSearches({
    hours,
    limit: 5
  });

  await recordBotEvent("user_requested_trending", {
    user,
    chatId,
    metadata: {
      hours
    }
  });
  await bot.sendMessage(
    chatId,
    formatAnimeRanking(`🔥 Trending Searches (${hours}h)`, items, "No trending searches yet."),
    {
      parse_mode: "HTML"
    }
  );
}

async function sendRandom(chatId, user, settings) {
  await recordBotEvent("user_requested_random", {
    user,
    chatId
  });

  if (!settings.enableRandomAnime) {
    await bot.sendMessage(chatId, "This feature is not available right now.");
    return;
  }

  const anime = await getRandomAnime();

  if (!anime) {
    await bot.sendMessage(chatId, "No successful anime history is available yet.");
    return;
  }

  const lines = [
    "<b>🎲 Random Anime</b>",
    "",
    "Try this one:",
    `<b>${escapeHtml(anime.animeTitle)}</b>`
  ];

  if (anime.anilistUrl) {
    lines.push("", `AniList: <a href="${escapeHtml(anime.anilistUrl)}">open page</a>`);
  }

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

async function sendTop(chatId, user, settings) {
  await recordBotEvent("user_requested_top_anime", {
    user,
    chatId
  });

  if (!settings.enableTopAnime) {
    await bot.sendMessage(chatId, "This feature is not available right now.");
    return;
  }

  const items = await getTopAnime({
    period: "all",
    limit: 5
  });

  await bot.sendMessage(chatId, formatAnimeRanking("🏆 Top Anime", items, "No top anime yet."), {
    parse_mode: "HTML"
  });
}

async function runResolvedAnalysis(message, user, settings, input) {
  const chatId = message.chat.id;
  const userSnapshot = buildUserSnapshot(user);

  const access = await checkAnalysisAccess(user, settings);

  if (!access.allowed) {
    await bot.sendMessage(chatId, access.reason);
    return;
  }

  const progressMessage = await bot.sendMessage(chatId, progressMessageText(input));
  let resultSent = false;

  try {
    const match = await searchAnimeScene(input.imageUrl);
    const threshold = Number(settings.similarityThreshold) || 0;
    const trustedLowSimilarity = match.similarity < threshold && canTrustedUserBypass(user, settings);

    if (match.similarity < threshold && !trustedLowSimilarity) {
      const messageText = [
        `I could not find a confident match for this image. Best result: ${match.similarity}%.`,
        "",
        buildResultMessage(match)
      ].join("\n");
      const sentMessage = await bot.sendMessage(chatId, messageText, {
        parse_mode: "HTML",
        disable_web_page_preview: false
      });

      const activity = await recordActivity({
        userId: user.telegramId,
        user: userSnapshot,
        source: input.source,
        ...input,
        inputUrl: input.inputUrl || input.imageUrl,
        userInput: buildUserInput(message, input),
        ...match,
        media: buildActivityMedia(input, match),
        status: "low_similarity",
        rejectionReason: "low_similarity",
        botResponse: {
          ...buildSuccessResponse(match),
          message: messageText
        },
        error: `Similarity is below ${threshold}%`
      });

      await attachResultActions(chatId, sentMessage.message_id, activity.id, settings);
      return;
    }

    const sentMedia = await sendResult(chatId, match, settings, {
      trustedLowSimilarity
    });
    resultSent = true;
    const status = trustedLowSimilarity ? "success_trusted_low_similarity" : "success";
    const botResponse = {
      ...buildSuccessResponse(match),
      message: trustedLowSimilarity ? "Trusted mode allowed this low-confidence result." : null
    };

    const activity = await recordActivity({
      userId: user.telegramId,
      user: userSnapshot,
      source: input.source,
      ...input,
      inputUrl: input.inputUrl || input.imageUrl,
      userInput: buildUserInput(message, input),
      ...match,
      media: buildActivityMedia(input, match, sentMedia),
      status,
      rejectionReason: trustedLowSimilarity ? "trusted_low_similarity" : null,
      botResponse
    });

    await updateActivitySentMedia(activity.id, sentMedia);
    await attachResultActions(chatId, sentMedia.messageId, activity.id, settings);
    await incrementDailyUsage(user.telegramId);
  } catch (error) {
    if (resultSent) {
      console.error("Successful Telegram response was sent, but post-send logging failed.", error);
      return;
    }

    const isNoMatch = /did not return a match|no result/i.test(error.message);
    const status = isNoMatch ? "rejected" : "failed";
    const rejectionReason = isNoMatch ? "no_match" : "trace_api_error";
    const messageText = isNoMatch
      ? "I could not find a match for that image. Try a clearer screenshot or another frame."
      : "I could not analyze that image right now. Please try again in a little while.";

    if (isNoMatch) {
      await recordActivity({
        userId: user.telegramId,
        user: userSnapshot,
        source: input.source,
        ...input,
        inputUrl: input.inputUrl || input.imageUrl,
        userInput: buildUserInput(message, input),
        imageUrl: null,
        videoUrl: null,
        media: buildActivityMedia(input),
        status,
        rejectionReason,
        botResponse: {
          message: messageText
        },
        error: error.message
      });
    } else {
      await recordError({
        userId: user.telegramId,
        user: userSnapshot,
        source: input.source,
        ...input,
        inputUrl: input.inputUrl || null,
        userInput: buildUserInput(message, input),
        media: buildActivityMedia(input),
        status,
        failureType: "trace_api_error",
        rejectionReason,
        botResponse: {
          message: messageText
        },
        message: error.message,
        stack: error.stack
      });
    }

    await bot.sendMessage(chatId, messageText);
  } finally {
    bot.deleteMessage(chatId, progressMessage.message_id).catch(() => {});
  }
}

async function handleAnalysis(message, user, settings) {
  let input;

  try {
    if (isTrustedUser(user)) {
      const trustedSelection = await resolveTrustedLinkSelection(message, bot, settings, {
        trustedUser: true
      });

      if (trustedSelection?.type === "selection") {
        const selectionId = storeImageSelection(message, user, trustedSelection);
        await sendTrustedLinkSelection(message.chat.id, selectionId);
        return;
      }

      if (trustedSelection?.type === "input") {
        input = trustedSelection.input;
      }
    }

    input = input || await resolveImageInput(message, bot, settings);
  } catch (error) {
    await recordInputResolutionFailure(message, user, error);
    return;
  }

  if (!input) {
    const botResponse = {
      message: "Send an anime screenshot, a forwarded image, a direct image URL, or a supported social link."
    };

    await recordError({
      userId: user.telegramId,
      user: buildUserSnapshot(user),
      source: "unknown",
      inputType: "unknown",
      userInput: buildUserInput(message),
      media: buildActivityMedia(),
      status: "failed",
      failureType: "invalid_media",
      rejectionReason: "invalid_media",
      botResponse,
      message: botResponse.message
    });

    await bot.sendMessage(message.chat.id, helpMessage(settings), {
      parse_mode: "HTML"
    });
    return;
  }

  await runResolvedAnalysis(message, user, settings, input);
}

bot.on("message", async (message) => {
  try {
    if (!message.from || !message.chat) {
      return;
    }

    const settings = await getSettings();
    const user = await getOrCreateUser(message);
    const text = message.text || "";
    const command = commandName(text);

    if (command === "/start" || command === "/help") {
      await bot.sendMessage(message.chat.id, helpMessage(settings), {
        parse_mode: "HTML"
      });
      return;
    }

    const featureCommand = featureByCommand(command);

    if (featureCommand) {
      if (!isFeatureEnabled(settings, featureCommand.key)) {
        await sendFeatureDisabled(message.chat.id, featureCommand);
        return;
      }

      if (featureCommand.key === "usage") {
        await sendUsage(message.chat.id, user, settings);
      } else if (featureCommand.key === "stats") {
        await sendStats(message.chat.id, user);
      } else if (featureCommand.key === "trending") {
        await sendTrending(message.chat.id, user, settings);
      } else if (featureCommand.key === "random") {
        await sendRandom(message.chat.id, user, settings);
      } else if (featureCommand.key === "top") {
        await sendTop(message.chat.id, user, settings);
      }
      return;
    }

    if (command.startsWith("/")) {
      await bot.sendMessage(message.chat.id, helpMessage(settings), {
        parse_mode: "HTML"
      });
      return;
    }

    await handleAnalysis(message, user, settings);
  } catch (error) {
    console.error("Message handling failed.", error);
    if (message.chat?.id) {
      await bot.sendMessage(message.chat.id, "Something went wrong. Please try again in a little while.");
    }

    await recordError({
      userId: message.from?.id,
      failureType: "processing_error",
      message: error.message,
      stack: error.stack
    }).catch(() => {});
  }
});

async function handleImageSelectionCallback(query, settings, user) {
  const data = String(query.data || "");
  const [action, selectionId, rawIndex] = data.split(":");

  if (!["imgbest", "imglist", "imgselect"].includes(action)) {
    return false;
  }

  const selection = getImageSelection(selectionId);
  const chatId = query.message?.chat?.id;

  if (!selection) {
    await bot.answerCallbackQuery(query.id, {
      text: "This image selection expired. Send the link again."
    });
    await clearCallbackMarkup(query);
    return true;
  }

  if (selection.userId !== String(query.from?.id || "")) {
    await bot.answerCallbackQuery(query.id, {
      text: "This image selection belongs to another user.",
      show_alert: true
    });
    return true;
  }

  if (selection.chatId !== String(chatId || "")) {
    await bot.answerCallbackQuery(query.id, {
      text: "This image selection is not available in this chat.",
      show_alert: true
    });
    return true;
  }

  if (action === "imgbest") {
    imageSelections.delete(selectionId);
    await bot.answerCallbackQuery(query.id, {
      text: "Using the best image."
    });
    await replaceCallbackMessage(query, "Using the best image. Analyzing...");
    await runResolvedAnalysis(selection.message, user, settings, selection.bestInput);
    return true;
  }

  const maxImages = resolveMaxDiscoveredImages(settings);
  const visibleImages = selection.images.slice(0, maxImages);

  if (action === "imglist") {
    if (!visibleImages.length) {
      await bot.answerCallbackQuery(query.id, {
        text: "No discovered images are available."
      });
      await bot.sendMessage(chatId, "No useful discovered images are available. Use the best image or send the image directly.");
      return true;
    }

    await bot.answerCallbackQuery(query.id);
    const text = formatDiscoveredImagesMessage(visibleImages);
    const options = {
      parse_mode: "HTML",
      reply_markup: discoveredImagesKeyboard(selectionId, visibleImages)
    };
    const edited = await replaceCallbackMessage(query, text, options);

    if (!edited) {
      await bot.sendMessage(chatId, text, options);
    }

    return true;
  }

  const imageIndex = Number.parseInt(rawIndex, 10);
  const selectedImage = Number.isInteger(imageIndex) ? visibleImages[imageIndex] : null;

  if (!selectedImage) {
    await bot.answerCallbackQuery(query.id, {
      text: "That image choice is no longer available."
    });
    return true;
  }

  await bot.answerCallbackQuery(query.id, {
    text: `Using image ${imageIndex + 1}.`
  });

  let input;

  try {
    input = await resolveDiscoveredImageInput({
      url: selection.url,
      sourceType: selection.sourceType,
      metadata: selection.metadata,
      image: selectedImage,
      candidateCount: selection.images.length
    });
  } catch (error) {
    await recordInputResolutionFailure(selection.message, user, error);
    return true;
  }

  imageSelections.delete(selectionId);
  await replaceCallbackMessage(query, `Image ${imageIndex + 1} selected. Analyzing...`);
  await runResolvedAnalysis(selection.message, user, settings, input);
  return true;
}

bot.on("callback_query", async (query) => {
  const data = String(query.data || "");
  const chatId = query.message?.chat?.id;

  try {
    if (!query.from || !chatId) {
      return;
    }

    const settings = await getSettings();
    const user = await getOrCreateUser({
      from: query.from
    });

    if (await handleImageSelectionCallback(query, settings, user)) {
      return;
    }

    if (data.startsWith("wrong:")) {
      const activityId = data.slice("wrong:".length);
      const report = await createWrongMatchReport(activityId, query.from);

      await recordBotEvent("wrong_match_report_created", {
        user,
        chatId,
        activityId,
        reportId: report.reportId
      });
      await bot.answerCallbackQuery(query.id, {
        text: "Wrong match report created."
      });
      await bot.sendMessage(chatId, "Why is it wrong?", {
        reply_markup: wrongMatchReasonKeyboard(report.reportId)
      });
      return;
    }

    if (data.startsWith("wr:")) {
      const [, reportId, reasonKey] = data.split(":");
      const reason = await setWrongMatchReason(reportId, reasonKey);

      await bot.answerCallbackQuery(query.id, {
        text: `Reason saved: ${reason}`
      });
      await bot.sendMessage(chatId, `Thanks. Reason saved: ${reason}`);
      return;
    }

    if (data.startsWith("more:")) {
      const activityId = data.slice("more:".length);
      const hasEnabledFeatures = enabledFeatureItems(settings).length > 0;

      await recordBotEvent("user_opened_more_menu", {
        user,
        chatId,
        activityId
      });

      if (!hasEnabledFeatures) {
        await bot.answerCallbackQuery(query.id, {
          text: "This feature is not available right now."
        });
        await bot.editMessageReplyMarkup(resultActions(activityId, settings), {
          chat_id: chatId,
          message_id: query.message.message_id
        }).catch(() => {});
        await sendFeatureDisabled(chatId);
        return;
      }

      await bot.answerCallbackQuery(query.id);
      await sendFeatureMenu(chatId, settings);
      return;
    }

    const featureCallback = featureByCallbackData(data);

    if (featureCallback) {
      if (!isFeatureEnabled(settings, featureCallback.key)) {
        await bot.answerCallbackQuery(query.id, {
          text: "This feature is not available right now."
        });
        await sendFeatureDisabled(chatId, featureCallback);
        return;
      }

      await bot.answerCallbackQuery(query.id);

      if (featureCallback.key === "usage") {
        await sendUsage(chatId, user, settings);
      } else if (featureCallback.key === "stats") {
        await sendStats(chatId, user);
      } else if (featureCallback.key === "trending") {
        await sendTrending(chatId, user, settings);
      } else if (featureCallback.key === "random") {
        await sendRandom(chatId, user, settings);
      } else if (featureCallback.key === "top") {
        await sendTop(chatId, user, settings);
      }
      return;
    }

    await bot.answerCallbackQuery(query.id, {
      text: "Unknown AniSeek action."
    });
  } catch (error) {
    console.error("Callback handling failed.", error);
    await bot.answerCallbackQuery(query.id, {
      text: "Something went wrong. Please try again."
    }).catch(() => {});
    await recordError({
      userId: query.from?.id,
      failureType: "processing_error",
      message: error.message,
      stack: error.stack
    }).catch(() => {});
  }
});

export function processTelegramUpdate(update) {
  bot.processUpdate(update);
}
