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
