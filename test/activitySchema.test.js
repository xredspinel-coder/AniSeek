import test from "node:test";
import assert from "node:assert/strict";
import { normalizeActivityForStorage } from "../src/services/activitySchema.js";

test("new Telegram photo activity stores unified schema and file ID media", () => {
  const activity = normalizeActivityForStorage({
    userId: 123,
    user: {
      telegramId: "123",
      username: "sango"
    },
    source: "telegram_image",
    inputType: "image",
    inputTelegramFileId: "telegram-photo-file-id",
    inputFileId: "telegram-photo-file-id",
    imageUrl: "https://api.trace.moe/image/result",
    videoUrl: "https://api.trace.moe/video/result",
    animeTitle: "InuYasha",
    similarity: 94.8,
    botResponse: {
      imageUrl: "https://api.trace.moe/image/result",
      videoUrl: "https://api.trace.moe/video/result"
    }
  }, {
    id: "activity-1",
    timestamp: "SERVER_TIMESTAMP"
  });

  assert.equal(activity.id, "activity-1");
  assert.equal(activity.input.telegramFileId, "telegram-photo-file-id");
  assert.equal(activity.media.inputTelegramFileId, "telegram-photo-file-id");
  assert.equal(activity.media.dashboardImageFileId, "telegram-photo-file-id");
  assert.equal(activity.media.dashboardImageUrl, null);
  assert.equal(activity.traceMoe.imageUrl, "https://api.trace.moe/image/result");
  assert.equal(activity.traceMoe.videoUrl, "https://api.trace.moe/video/result");
  assert.equal(activity.result.animeTitle, "InuYasha");
});

test("new link activity stores input URL and selected image without promoting trace media", () => {
  const activity = normalizeActivityForStorage({
    userId: 456,
    source: "reddit_preview",
    sourceType: "reddit_preview",
    inputType: "reddit_preview",
    inputUrl: "https://reddit.example.test/post",
    inputSourceDomain: "reddit.example.test",
    selectedImageUrl: "https://cdn.example.test/selected.jpg",
    extractedImageUrl: "https://cdn.example.test/selected.jpg",
    inputPreview: "https://cdn.example.test/selected.jpg",
    bestImageUrl: "https://cdn.example.test/best.jpg",
    imageCount: 2,
    filteredImageCount: 2,
    animeTitle: "Kedama no Gonjirou",
    traceMoe: {
      imageUrl: "https://api.trace.moe/image/result",
      videoUrl: "https://api.trace.moe/video/result"
    },
    botResponse: {
      imageUrl: "https://api.trace.moe/image/result",
      videoUrl: "https://api.trace.moe/video/result"
    }
  });

  assert.equal(activity.input.url, "https://reddit.example.test/post");
  assert.equal(activity.input.domain, "reddit.example.test");
  assert.equal(activity.input.selectedImageUrl, "https://cdn.example.test/selected.jpg");
  assert.equal(activity.media.dashboardImageUrl, "https://cdn.example.test/selected.jpg");
  assert.equal(activity.media.dashboardImageFileId, null);
  assert.equal(activity.traceMoe.imageUrl, "https://api.trace.moe/image/result");
  assert.equal(activity.botResponse.imageUrl, "https://api.trace.moe/image/result");
});
