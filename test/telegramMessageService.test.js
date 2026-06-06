import test from "node:test";
import assert from "node:assert/strict";
import { analysisProgressMessageText, withTemporaryMessage } from "../src/services/telegramMessageService.js";

test("analysisProgressMessageText uses the one-image auto-selection message", () => {
  assert.equal(
    analysisProgressMessageText({ autoSelectedSingleImage: true }),
    "Found one suitable image. Analyzing it now..."
  );
});

test("withTemporaryMessage deletes loading message after successful work", async () => {
  const calls = [];
  const bot = {
    async sendMessage(chatId, text) {
      calls.push(["sendMessage", chatId, text]);
      return { message_id: 42 };
    },
    async deleteMessage(chatId, messageId) {
      calls.push(["deleteMessage", chatId, messageId]);
    }
  };

  const result = await withTemporaryMessage({
    bot,
    chatId: 100,
    text: "Analyzing the link and extracting images..."
  }, async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(calls, [
    ["sendMessage", 100, "Analyzing the link and extracting images..."],
    ["deleteMessage", 100, 42]
  ]);
});

test("withTemporaryMessage deletes loading message after failed work", async () => {
  const calls = [];
  const bot = {
    async sendMessage(chatId, text) {
      calls.push(["sendMessage", chatId, text]);
      return { message_id: 77 };
    },
    async deleteMessage(chatId, messageId) {
      calls.push(["deleteMessage", chatId, messageId]);
    }
  };

  await assert.rejects(
    withTemporaryMessage({
      bot,
      chatId: 100,
      text: "Analyzing the link and extracting images..."
    }, async () => {
      throw new Error("metadata failed");
    }),
    /metadata failed/
  );

  assert.deepEqual(calls, [
    ["sendMessage", 100, "Analyzing the link and extracting images..."],
    ["deleteMessage", 100, 77]
  ]);
});
