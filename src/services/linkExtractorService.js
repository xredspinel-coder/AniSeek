const IMAGE_EXTENSION_PATTERN = /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export class InputResolutionError extends Error {
  constructor(message, { status = "rejected", rejectionReason = "invalid_media", source = null, inputUrl = null } = {}) {
    super(message);
    this.name = "InputResolutionError";
    this.status = status;
    this.rejectionReason = rejectionReason;
    this.source = source;
    this.inputUrl = inputUrl;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function stripTrailingPunctuation(url) {
  return url.replace(/[),.;\]]+$/g, "");
}

function getMessageText(message) {
  return message.text || message.caption || "";
}

function isForwarded(message) {
  return Boolean(message.forward_origin || message.forward_from || message.forward_sender_name || message.forward_date);
}

function getLargestPhoto(message) {
  const photos = message.photo || [];
  return photos[photos.length - 1] || null;
}

async function getTelegramFileUrl(bot, fileId) {
  const file = await bot.getFile(fileId);

  if (!file?.file_path) {
    throw new InputResolutionError("Could not resolve Telegram file URL.", {
      status: "failed",
      rejectionReason: "api_error"
    });
  }

  return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
}

function isDirectImageUrl(url) {
  return IMAGE_EXTENSION_PATTERN.test(url);
}

async function isImageByContentType(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "AniSeekBot/1.0"
      },
      redirect: "follow"
    });

    return response.headers.get("content-type")?.toLowerCase().startsWith("image/") || false;
  } catch {
    return false;
  }
}

function classifyHost(url) {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();

  if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it") {
    return "reddit";
  }

  if (host === "twitter.com" || host === "x.com" || host.endsWith(".twitter.com")) {
    return "twitter";
  }

  if (host === "facebook.com" || host === "fb.watch" || host.endsWith(".facebook.com")) {
    return "facebook";
  }

  return "direct_url";
}

async function fetchHtml(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 AniSeekBot/1.0"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new InputResolutionError(`Could not fetch page metadata (${response.status}).`, {
      status: "failed",
      rejectionReason: "api_error",
      inputUrl: url
    });
  }

  return response.text();
}

function extractMetaImage(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/&amp;/g, "&");
    }
  }

  return null;
}

async function resolveSocialImage(url) {
  const html = await fetchHtml(url);
  const imageUrl = extractMetaImage(html);

  if (!imageUrl) {
    throw new InputResolutionError("No image preview was found on that page.", {
      status: "rejected",
      rejectionReason: "invalid_media",
      inputUrl: url
    });
  }

  return new URL(imageUrl, url).toString();
}

function ensureSocialEnabled(source, settings, url) {
  if (source === "reddit" && !settings.enableReddit) {
    throw new InputResolutionError("Reddit links are disabled by the current settings.", {
      rejectionReason: "unsupported_source",
      source,
      inputUrl: url
    });
  }

  if (source === "twitter" && !settings.enableTwitter) {
    throw new InputResolutionError("Twitter/X links are disabled by the current settings.", {
      rejectionReason: "unsupported_source",
      source,
      inputUrl: url
    });
  }

  if (source === "facebook" && !settings.enableFacebook) {
    throw new InputResolutionError("Facebook links are disabled by the current settings.", {
      rejectionReason: "unsupported_source",
      source,
      inputUrl: url
    });
  }
}

export function extractUrls(message) {
  return [...getMessageText(message).matchAll(URL_PATTERN)].map((match) => stripTrailingPunctuation(match[0]));
}

export async function resolveImageInput(message, bot, settings) {
  const photo = getLargestPhoto(message);

  if (photo) {
    const imageUrl = await getTelegramFileUrl(bot, photo.file_id);

    return {
      source: isForwarded(message) ? "forwarded_image" : "telegram_image",
      inputType: isForwarded(message) ? "telegram_forward" : "image",
      inputUrl: null,
      inputFileId: photo.file_id,
      inputTelegramFileUrl: imageUrl,
      inputImageUrl: imageUrl,
      inputThumbnail: imageUrl,
      inputPreview: imageUrl,
      imageUrl
    };
  }

  if (message.document?.mime_type?.startsWith("image/") && message.document.file_id) {
    const imageUrl = await getTelegramFileUrl(bot, message.document.file_id);
    let thumbnailUrl = imageUrl;

    if (message.document.thumbnail?.file_id) {
      try {
        thumbnailUrl = await getTelegramFileUrl(bot, message.document.thumbnail.file_id);
      } catch {
        thumbnailUrl = imageUrl;
      }
    }

    return {
      source: isForwarded(message) ? "forwarded_image" : "telegram_image",
      inputType: isForwarded(message) ? "telegram_forward" : "image",
      inputUrl: null,
      inputFileId: message.document.file_id,
      inputTelegramFileUrl: imageUrl,
      inputImageUrl: imageUrl,
      inputThumbnail: thumbnailUrl,
      inputPreview: imageUrl,
      imageUrl
    };
  }

  const [url] = extractUrls(message);

  if (!url) {
    return null;
  }

  if (isDirectImageUrl(url)) {
    return {
      source: "direct_url",
      inputType: "url",
      inputUrl: url,
      inputFileId: null,
      inputTelegramFileUrl: null,
      inputImageUrl: url,
      inputThumbnail: url,
      inputPreview: url,
      imageUrl: url
    };
  }

  const source = classifyHost(url);
  ensureSocialEnabled(source, settings, url);

  if (source === "direct_url" && await isImageByContentType(url)) {
    return {
      source: "direct_url",
      inputType: "url",
      inputUrl: url,
      inputFileId: null,
      inputTelegramFileUrl: null,
      inputImageUrl: url,
      inputThumbnail: url,
      inputPreview: url,
      imageUrl: url
    };
  }

  if (source === "direct_url") {
    throw new InputResolutionError("Please send a direct image URL or a URL that returns image content.", {
      rejectionReason: "invalid_media",
      source,
      inputUrl: url
    });
  }

  let imageUrl;

  try {
    imageUrl = await resolveSocialImage(url);
  } catch (error) {
    if (error instanceof InputResolutionError) {
      error.source = error.source || source;
      error.inputUrl = error.inputUrl || url;
    }

    throw error;
  }

  return {
    source,
    inputType: source,
    inputUrl: url,
    inputFileId: null,
    inputTelegramFileUrl: null,
    inputImageUrl: imageUrl,
    inputThumbnail: imageUrl,
    inputPreview: imageUrl,
    imageUrl
  };
}
