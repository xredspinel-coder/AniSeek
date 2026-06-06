import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAndRankDiscoveredImages,
  resolveTelegramPreviewFallback,
  resolveMaxDiscoveredImages,
  selectAnalysisImage,
  trustedLinkSelectionResult
} from "../src/services/linkExtractorService.js";

test("resolveMaxDiscoveredImages defaults and clamps dashboard values", () => {
  assert.equal(resolveMaxDiscoveredImages({}), 5);
  assert.equal(resolveMaxDiscoveredImages({ maxDiscoveredImages: "8" }), 8);
  assert.equal(resolveMaxDiscoveredImages({ maxDiscoveredImages: 0 }), 1);
  assert.equal(resolveMaxDiscoveredImages({ maxDiscoveredImages: 99 }), 20);
});

test("filterAndRankDiscoveredImages sorts useful images by real area first", () => {
  const ranked = filterAndRankDiscoveredImages({
    bestImage: "https://cdn.example.test/card.jpg",
    images: [
      {
        url: "https://cdn.example.test/medium.jpg",
        width: 736,
        height: 736,
        source: "html"
      },
      {
        url: "https://cdn.example.test/wide.jpg",
        width: 1200,
        height: 628,
        source: "twitter",
        score: 1
      },
      {
        url: "https://cdn.example.test/card.jpg",
        width: 480,
        height: 360,
        source: "openGraph"
      },
      {
        url: "https://cdn.example.test/hero.jpg",
        width: 1280,
        height: 720,
        source: "html",
        score: 0
      }
    ]
  });

  assert.deepEqual(ranked.map((image) => image.url), [
    "https://cdn.example.test/hero.jpg",
    "https://cdn.example.test/wide.jpg",
    "https://cdn.example.test/medium.jpg",
    "https://cdn.example.test/card.jpg"
  ]);
});

test("filterAndRankDiscoveredImages filters weak assets and tiny images when useful images exist", () => {
  const ranked = filterAndRankDiscoveredImages({
    bestImage: "https://cdn.example.test/avatar.jpg",
    images: [
      {
        url: "https://cdn.example.test/subreddit-icon.png",
        width: 800,
        height: 800,
        source: "html"
      },
      {
        url: "https://cdn.example.test/tiny.jpg",
        width: 199,
        height: 500,
        source: "html"
      },
      {
        url: "https://cdn.example.test/real.jpg",
        width: 640,
        height: 480,
        source: "html"
      }
    ]
  });

  assert.deepEqual(ranked.map((image) => image.url), ["https://cdn.example.test/real.jpg"]);
});

test("filterAndRankDiscoveredImages can fall back to tiny non-weak images when no useful images exist", () => {
  const ranked = filterAndRankDiscoveredImages({
    images: [
      {
        url: "https://cdn.example.test/small-a.jpg",
        width: 180,
        height: 220,
        source: "html"
      },
      {
        url: "https://cdn.example.test/small-b.jpg",
        width: 190,
        height: 190,
        source: "html"
      }
    ]
  });

  assert.deepEqual(ranked.map((image) => image.url), [
    "https://cdn.example.test/small-a.jpg",
    "https://cdn.example.test/small-b.jpg"
  ]);
});

test("selectAnalysisImage rejects weak bestImage and uses largest real candidate", () => {
  const selected = selectAnalysisImage({
    bestImage: "https://cdn.example.test/profile-image.jpg",
    images: [
      {
        url: "https://cdn.example.test/profile-image.jpg",
        width: 1000,
        height: 1000,
        source: "openGraph"
      },
      {
        url: "https://cdn.example.test/content.jpg",
        width: 1200,
        height: 628,
        source: "html"
      }
    ]
  });

  assert.equal(selected.url, "https://cdn.example.test/content.jpg");
});

test("filterAndRankDiscoveredImages does not let score outrank larger known dimensions", () => {
  const ranked = filterAndRankDiscoveredImages({
    images: [
      {
        url: "https://cdn.example.test/unknown-high-score.jpg",
        source: "html",
        score: 999
      },
      {
        url: "https://cdn.example.test/known-large.jpg",
        width: 800,
        height: 600,
        source: "html",
        score: 1
      }
    ]
  });

  assert.equal(ranked[0].url, "https://cdn.example.test/known-large.jpg");
});

test("resolveTelegramPreviewFallback uses Telegram web page preview image", async () => {
  process.env.BOT_TOKEN = "123456:test-token";
  const bot = {
    async getFile(fileId) {
      assert.equal(fileId, "telegram-preview-file-id");
      return {
        file_path: "photos/preview.jpg"
      };
    }
  };
  const input = await resolveTelegramPreviewFallback({
    web_page: {
      photo: {
        sizes: [
          {
            file_id: "small-preview-file-id",
            width: 90,
            height: 90
          },
          {
            file_id: "telegram-preview-file-id",
            width: 640,
            height: 360
          }
        ]
      }
    }
  }, bot, "https://www.reddit.com/r/anime/comments/example", {
    metadata: {
      bestImage: "https://blocked.example.test/image.jpg",
      images: []
    },
    reason: "provider_blocked"
  });

  assert.equal(input.fallbackUsed, "telegram_preview");
  assert.equal(input.telegramPreviewUsed, true);
  assert.equal(input.sourceType, "telegram_link_preview");
  assert.equal(input.inputTelegramFileId, "telegram-preview-file-id");
  assert.equal(input.inputPreview, null);
  assert.equal(input.previewExtractionMethod, "telegram:web_page_preview:provider_blocked");
  assert.equal(input.imageUrl, "https://api.telegram.org/file/bot123456:test-token/photos/preview.jpg");
});

test("trustedLinkSelectionResult auto-selects one filtered image without selection buttons", () => {
  const result = trustedLinkSelectionResult({
    url: "https://example.test/post",
    source: "generic",
    sourceType: "generic_link_preview",
    bestInput: {
      imageUrl: "https://cdn.example.test/only.jpg"
    },
    images: [
      { url: "https://cdn.example.test/only.jpg" }
    ]
  });

  assert.equal(result.type, "input");
  assert.equal(result.input.autoSelectedSingleImage, true);
  assert.equal(result.input.imageUrl, "https://cdn.example.test/only.jpg");
});

test("trustedLinkSelectionResult keeps Trusted User buttons for multiple images", () => {
  const result = trustedLinkSelectionResult({
    url: "https://example.test/post",
    source: "generic",
    sourceType: "generic_link_preview",
    bestInput: {
      imageUrl: "https://cdn.example.test/best.jpg"
    },
    images: [
      { url: "https://cdn.example.test/one.jpg" },
      { url: "https://cdn.example.test/two.jpg" }
    ]
  });

  assert.equal(result.type, "selection");
  assert.equal(result.images.length, 2);
});
