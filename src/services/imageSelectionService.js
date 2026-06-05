import sharp from "sharp";

const CALLBACK_ACTIONS = new Set(["imgpick", "imgselect", "imgconfirm", "imgback", "imgbest", "imglist"]);
const COLLAGE_CELL_WIDTH = 320;
const COLLAGE_CELL_HEIGHT = 240;
const COLLAGE_GAP = 10;
const COLLAGE_PADDING = 12;
const COLLAGE_BACKGROUND = "#111827";
const COLLAGE_FETCH_TIMEOUT_MS = 8_000;
const COLLAGE_MAX_IMAGE_BYTES = 8_000_000;

function numericIndex(value) {
  const numberValue = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function encodeSelectionId(selectionId) {
  return String(selectionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

export function imagePickCallbackData(selectionId, imageIndex) {
  return `imgpick:${encodeSelectionId(selectionId)}:${numericIndex(imageIndex) ?? 0}`;
}

export function imageConfirmCallbackData(selectionId, imageIndex) {
  return `imgconfirm:${encodeSelectionId(selectionId)}:${numericIndex(imageIndex) ?? 0}`;
}

export function imageBackCallbackData(selectionId) {
  return `imgback:${encodeSelectionId(selectionId)}`;
}

export function parseImageSelectionCallbackData(data = "") {
  const [action, selectionId, rawIndex] = String(data || "").split(":");

  if (!CALLBACK_ACTIONS.has(action)) {
    return null;
  }

  return {
    action,
    selectionId: encodeSelectionId(selectionId),
    imageIndex: numericIndex(rawIndex)
  };
}

export function imageSelectionStep(action) {
  if (action === "imgpick" || action === "imgselect") {
    return "preview_only";
  }

  if (action === "imgconfirm") {
    return "analyze";
  }

  if (action === "imgback") {
    return "show_collage";
  }

  return "other";
}

export function discoveredImagesKeyboard(selectionId, images = []) {
  const rows = [];

  for (let index = 0; index < images.length; index += 5) {
    rows.push(images.slice(index, index + 5).map((_, offset) => {
      const imageIndex = index + offset;
      return {
        text: String(imageIndex + 1),
        callback_data: imagePickCallbackData(selectionId, imageIndex)
      };
    }));
  }

  return {
    inline_keyboard: rows
  };
}

export function selectedImageConfirmationKeyboard(selectionId, imageIndex) {
  return {
    inline_keyboard: [
      [
        {
          text: "Confirm analysis",
          callback_data: imageConfirmCallbackData(selectionId, imageIndex)
        },
        {
          text: "Back to image selection",
          callback_data: imageBackCallbackData(selectionId)
        }
      ]
    ]
  };
}

function collageColumns(count) {
  if (count <= 1) {
    return 1;
  }

  if (count <= 4) {
    return 2;
  }

  return 3;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function labelSvg(label, width = COLLAGE_CELL_WIDTH, height = COLLAGE_CELL_HEIGHT) {
  const radius = 24;
  const center = radius + 10;

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="rgba(0,0,0,0.74)"/>
      <text x="${center}" y="${center + 8}" text-anchor="middle" font-size="24" font-weight="700" fill="#ffffff" font-family="Arial, sans-serif">${xmlEscape(label)}</text>
    </svg>
  `);
}

function placeholderSvg(label, width = COLLAGE_CELL_WIDTH, height = COLLAGE_CELL_HEIGHT) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#1f2937"/>
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="20" font-weight="700" fill="#d1d5db" font-family="Arial, sans-serif">Preview unavailable</text>
      <text x="${width / 2}" y="${height / 2 + 28}" text-anchor="middle" font-size="14" fill="#9ca3af" font-family="Arial, sans-serif">Image ${xmlEscape(label)}</text>
    </svg>
  `);
}

async function fetchImageBuffer(url, fetchImpl = fetch) {
  const parsed = new URL(url);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported collage image URL protocol.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COLLAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(parsed.toString(), {
      headers: {
        Accept: "image/jpeg,image/png,image/webp,image/gif",
        "User-Agent": "AniSeekBot/1.0"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Image preview fetch failed with ${response.status}.`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error("Image preview response is not an image.");
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > COLLAGE_MAX_IMAGE_BYTES) {
      throw new Error("Image preview is too large.");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > COLLAGE_MAX_IMAGE_BYTES) {
      throw new Error("Image preview is too large.");
    }

    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

async function createCollageCell(image, index, { fetchImpl, logFailures = true } = {}) {
  const label = String(index + 1);

  try {
    const imageBuffer = await fetchImageBuffer(image.url, fetchImpl);
    const resized = await sharp(imageBuffer, {
      animated: false,
      limitInputPixels: 48_000_000
    })
      .resize(COLLAGE_CELL_WIDTH, COLLAGE_CELL_HEIGHT, {
        fit: "cover",
        position: "attention"
      })
      .png()
      .toBuffer();

    return sharp(resized)
      .composite([{ input: labelSvg(label), left: 0, top: 0 }])
      .png()
      .toBuffer();
  } catch (error) {
    if (logFailures) {
      console.warn("Could not render discovered image preview.", {
        imageUrl: image?.url || null,
        reason: error.message
      });
    }

    return sharp(placeholderSvg(label)).png().toBuffer();
  }
}

export async function createDiscoveredImagesCollage(images = [], { fetchImpl = fetch, logFailures = true } = {}) {
  const safeImages = Array.isArray(images) ? images.filter((image) => image?.url) : [];

  if (!safeImages.length) {
    return null;
  }

  const columns = collageColumns(safeImages.length);
  const rows = Math.ceil(safeImages.length / columns);
  const width = columns * COLLAGE_CELL_WIDTH + (columns - 1) * COLLAGE_GAP + COLLAGE_PADDING * 2;
  const height = rows * COLLAGE_CELL_HEIGHT + (rows - 1) * COLLAGE_GAP + COLLAGE_PADDING * 2;
  const cells = await Promise.all(safeImages.map((image, index) => createCollageCell(image, index, { fetchImpl, logFailures })));
  const composites = cells.map((cell, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;

    return {
      input: cell,
      left: COLLAGE_PADDING + column * (COLLAGE_CELL_WIDTH + COLLAGE_GAP),
      top: COLLAGE_PADDING + row * (COLLAGE_CELL_HEIGHT + COLLAGE_GAP)
    };
  });

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: COLLAGE_BACKGROUND
    }
  })
    .composite(composites)
    .png()
    .toBuffer();
}
