export function analysisProgressMessageText(input = {}) {
  if (input.autoSelectedSingleImage) {
    return "Found one suitable image. Analyzing it now...";
  }

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

export async function withTemporaryMessage({ bot, chatId, text, enabled = true } = {}, work) {
  if (typeof work !== "function") {
    throw new TypeError("withTemporaryMessage requires a work callback.");
  }

  if (!enabled) {
    return work(null);
  }

  let loadingMessage = null;

  try {
    loadingMessage = await bot.sendMessage(chatId, text);
    return await work(loadingMessage);
  } finally {
    if (loadingMessage?.message_id) {
      await bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});
    }
  }
}
