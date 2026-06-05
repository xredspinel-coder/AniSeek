import test from "node:test";
import assert from "node:assert/strict";
import {
  createDiscoveredImagesCollage,
  discoveredImagesKeyboard,
  imageBackCallbackData,
  imageConfirmCallbackData,
  imagePickCallbackData,
  imageSelectionStep,
  parseImageSelectionCallbackData,
  selectedImageConfirmationKeyboard
} from "../src/services/imageSelectionService.js";

test("image selection callback data stays short and never includes URLs", () => {
  const selectionId = "selection123";
  const url = "https://cdn.example.test/very-long-image-url.jpg";
  const pickData = imagePickCallbackData(selectionId, 2);
  const confirmData = imageConfirmCallbackData(selectionId, 2);
  const backData = imageBackCallbackData(selectionId);

  assert.equal(pickData, "imgpick:selection123:2");
  assert.equal(confirmData, "imgconfirm:selection123:2");
  assert.equal(backData, "imgback:selection123");
  assert.equal([pickData, confirmData, backData].some((value) => value.includes(url)), false);
});

test("image selection callbacks map pick to preview, confirm to analyze, and back to collage", () => {
  assert.equal(imageSelectionStep("imgpick"), "preview_only");
  assert.equal(imageSelectionStep("imgselect"), "preview_only");
  assert.equal(imageSelectionStep("imgconfirm"), "analyze");
  assert.equal(imageSelectionStep("imgback"), "show_collage");

  assert.deepEqual(parseImageSelectionCallbackData("imgpick:abc123:4"), {
    action: "imgpick",
    selectionId: "abc123",
    imageIndex: 4
  });
});

test("discovered image keyboard uses numeric imgpick callbacks", () => {
  const keyboard = discoveredImagesKeyboard("abc", [
    { url: "https://cdn.example.test/1.jpg" },
    { url: "https://cdn.example.test/2.jpg" },
    { url: "https://cdn.example.test/3.jpg" }
  ]);

  assert.deepEqual(keyboard.inline_keyboard[0].map((button) => button.callback_data), [
    "imgpick:abc:0",
    "imgpick:abc:1",
    "imgpick:abc:2"
  ]);
});

test("selected image confirmation keyboard does not analyze until confirm callback", () => {
  const keyboard = selectedImageConfirmationKeyboard("abc", 1);
  const callbacks = keyboard.inline_keyboard.flat().map((button) => button.callback_data);

  assert.deepEqual(callbacks, [
    "imgconfirm:abc:1",
    "imgback:abc"
  ]);
});

test("createDiscoveredImagesCollage returns a PNG buffer without network access", async () => {
  const buffer = await createDiscoveredImagesCollage([
    { url: "https://cdn.example.test/preview.jpg" }
  ], {
    logFailures: false,
    fetchImpl: async () => {
      throw new Error("network disabled for test");
    }
  });

  assert.equal(Buffer.isBuffer(buffer), true);
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
