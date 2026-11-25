import { lookup } from "node:dns/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const IMAGE_EXTENSION_PATTERN = /\.(gif|jpe?g|png|webp)(?:[?#].*)?$/i;
const execFileAsync = promisify(execFile);
const DEFAULT_GALLERY_DL_TIMEOUT_MS = 120_000;
const configuredGalleryDlTimeout = Number.parseInt(process.env.GALLERY_DL_TIMEOUT_MS || "", 10);
const GALLERY_DL_TIMEOUT_MS = Number.isFinite(configuredGalleryDlTimeout)
  ? Math.max(45_000, Math.min(configuredGalleryDlTimeout, 300_000))
  : DEFAULT_GALLERY_DL_TIMEOUT_MS;
const MAX_GALLERY_DL_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GALLERY_DL_CANDIDATES = 40;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 8_000;
const TELEGRAM_FILE_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_DISCOVERED_IMAGES = 5;
const MAX_DISCOVERED_IMAGES_LIMIT = 20;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniSeekBot/1.0";
const DIRECT_IMAGE_SOURCE_TYPE = "direct_image_url";
const GENERIC_SOURCE_TYPE = "generic_link_preview";
const TELEGRAM_PREVIEW_SOURCE_TYPE = "telegram_link_preview";
const GALLERY_DL_METHOD = "gallery-dl:get-urls";
const GALLERY_DL_SELECTED_METHOD = "gallery-dl:selected-image";
const TELEGRAM_PREVIEW_METHOD = "telegram:web_page_preview";
const PLATFORM_SOURCE_TYPES = {
  reddit: "reddit_preview",
  twitter: "twitter_preview",
  facebook: "facebook_preview",
  instagram: "instagram_gallery",
  tiktok: "tiktok_gallery"
};
const WEAK_IMAGE_TEXT_PATTERN =
  /avatar|favicon|emoji|award|sprite|pixel|placeholder|community[-_\s]*icon|subreddit[-_\s]*icon|profile[-_\s]*(?:image|photo|picture)?|channel[-_\s]*icon|\bicon\b/i;

export class InputResolutionError extends Error {
  constructor(
    message,
    {
      status = "rejected",
      rejectionReason = "invalid_media",
      source = null,
      inputUrl = null,
      sourceType = null,
      extractedImageUrl = null,
      inputSourceDomain = null,
      previewExtractionMethod = null,
      previewExtractionStatus = null,
      previewExtractionError = null,
      previewExtractionCandidateCount = null,
      previewExtractionSelectedMimeType = null,
      providerDiagnostics = null,
      fallbackUsed = null,
      bestImageUrl = null,
      selectedImageUrl = null,
      imageCount = null,
      filteredImageCount = null,
      telegramPreviewUsed = false
    } = {}
  ) {
    super(message);
    this.name = "InputResolutionError";
    this.status = status;
    this.rejectionReason = rejectionReason;
    this.source = source;
    this.inputUrl = inputUrl;
    this.sourceType = sourceType;
    this.extractedImageUrl = extractedImageUrl;
    this.inputSourceDomain = inputSourceDomain;
    this.previewExtractionMethod = previewExtractionMethod;
    this.previewExtractionStatus = previewExtractionStatus;
    this.previewExtractionError = previewExtractionError;
    this.previewExtractionCandidateCount = previewExtractionCandidateCount;
    this.previewExtractionSelectedMimeType = previewExtractionSelectedMimeType;
    this.providerDiagnostics = providerDiagnostics;
    this.fallbackUsed = fallbackUsed;
    this.bestImageUrl = bestImageUrl;
    this.selectedImageUrl = selectedImageUrl;
    this.imageCount = imageCount;
    this.filteredImageCount = filteredImageCount;
    this.telegramPreviewUsed = telegramPreviewUsed;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
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

function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function platformSourceType(source) {
  return PLATFORM_SOURCE_TYPES[source] || GENERIC_SOURCE_TYPE;
}

function providerDiagnosticsFromMetadata(metadata = {}) {
  return metadata.providerDiagnostics || metadata.diagnostics?.providerDiagnostics || null;
}

function isProviderBlocked(metadata = {}) {
  return providerDiagnosticsFromMetadata(metadata)?.blocked === true;
}

function metadataErrors(metadata = {}) {
  return [
    ...(Array.isArray(metadata.diagnostics?.errors) ? metadata.diagnostics.errors : []),
    ...(Array.isArray(metadata.diagnostics?.warnings) ? metadata.diagnostics.warnings : [])
  ].filter(Boolean);
}

function previewFields({
  url,
  sourceType = GENERIC_SOURCE_TYPE,
  method = null,
  status = "failed",
  error = null,
  candidateCount = null,
  selectedImageUrl = null,
  mimeType = null,
  providerDiagnostics = null,
  fallbackUsed = null
} = {}) {
  return {
    sourceType,
    extractedImageUrl: selectedImageUrl || null,
    inputSourceDomain: sourceDomain(url),
    previewExtractionMethod: method,
    previewExtractionStatus: status,
    previewExtractionError: error,
    previewExtractionCandidateCount: Number.isFinite(candidateCount) ? candidateCount : null,
    previewExtractionSelectedMimeType: mimeType || null,
    providerDiagnostics,
    fallbackUsed
  };
}

function logPreviewExtraction(level, details = {}) {
  const payload = {
    url: details.url || null,
    domain: details.domain || sourceDomain(details.url) || null,
    provider: details.provider || null,
    status: details.status || null,
    extractorUsed: details.extractorUsed || details.method || null,
    imageCandidateCount: Number.isFinite(details.candidateCount) ? details.candidateCount : null,
    imageCount: Number.isFinite(details.imageCount) ? details.imageCount : Number.isFinite(details.candidateCount) ? details.candidateCount : null,
    filteredImageCount: Number.isFinite(details.filteredImageCount) ? details.filteredImageCount : null,
    bestImage: details.bestImage || null,
    selectedImage: details.selectedImage || details.selectedImageUrl || null,
    selectedImageUrl: details.selectedImageUrl || details.selectedImage || null,
    fallbackUsed: details.fallbackUsed || null,
    telegramPreviewUsed: Boolean(details.telegramPreviewUsed || details.fallbackUsed === "telegram_preview"),
    trustedUser: typeof details.trustedUser === "boolean" ? details.trustedUser : null,
    providerDiagnostics: details.providerDiagnostics || null,
    failureReason: details.failureReason || null,
    sourceType: details.sourceType || null,
    errorStack: details.errorStack || null
  };

  const logger = level === "error" || level === "warn" ? console.warn : console.info;
  logger("[preview-extractor]", payload);
}

function inputError(message, options = {}) {
  const fields = previewFields({
    url: options.inputUrl,
    sourceType: options.sourceType || options.source || GENERIC_SOURCE_TYPE,
    method: options.previewExtractionMethod,
    status: options.previewExtractionStatus || "failed",
    error: options.previewExtractionError || message,
    candidateCount: options.previewExtractionCandidateCount,
    selectedImageUrl: options.extractedImageUrl,
    mimeType: options.previewExtractionSelectedMimeType,
    providerDiagnostics: options.providerDiagnostics,
    fallbackUsed: options.fallbackUsed
  });

  return new InputResolutionError(message, {
    ...options,
    ...fields,
    source: options.source || fields.sourceType,
    inputUrl: options.inputUrl || null
  });
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function getTelegramFileUrl(bot, fileId, source = "telegram_image") {
  let file;

  try {
    file = await withTimeout(
      bot.getFile(fileId),
      TELEGRAM_FILE_TIMEOUT_MS,
      "Telegram file lookup timed out."
    );
  } catch (error) {
    throw new InputResolutionError(`Could not download Telegram media: ${error.message}`, {
      status: "failed",
      rejectionReason: "telegram_download_error",
      source
    });
  }

  if (!file?.file_path) {
    throw new InputResolutionError("Could not resolve Telegram file URL.", {
      status: "failed",
      rejectionReason: "telegram_download_error",
      source
    });
  }

  return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
}

export function isDirectImageUrl(url) {
  return IMAGE_EXTENSION_PATTERN.test(url);
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isPrivateIPv4(address) {
  const parts = address.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase();

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isPrivateIPv4(normalized.slice("::ffff:".length));
  }

  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);

  return (
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00 ||
    normalized.startsWith("2001:db8:")
  );
}

function isPrivateAddress(address) {
  const type = net.isIP(address);

  if (type === 4) {
    return isPrivateIPv4(address);
  }

  if (type === 6) {
    return isPrivateIPv6(address);
  }

  return true;
}

async function validateSafePublicUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("URL is not valid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();

  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost URLs are not allowed.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private or internal network URLs are not allowed.");
    }

    return parsed.toString();
  }

  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true
  });

  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Private or internal network URLs are not allowed.");
  }

  return parsed.toString();
}

async function safeFetchWithRedirects(url, options = {}, { timeoutMs = REQUEST_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await validateSafePublicUrl(currentUrl);

    const response = await fetchWithTimeout(currentUrl, {
      ...options,
      redirect: "manual"
    }, timeoutMs);

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");

      await cancelBody(response);

      if (!location) {
        throw new Error("Redirect response did not include a target URL.");
      }

      currentUrl = new URL(location, currentUrl).toString();
      await validateSafePublicUrl(currentUrl);
      continue;
    }

    return {
      response,
      finalUrl: response.url || currentUrl
    };
  }

  throw new Error("Too many redirects while fetching URL.");
}

function normalizedMimeType(response) {
  return String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

function responseSize(response) {
  const contentRange = response.headers.get("content-range");
  const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];

  if (rangeSize) {
    return Number(rangeSize);
  }

  const contentLength = response.headers.get("content-length");
  return contentLength ? Number(contentLength) : null;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // Best-effort stream cleanup only.
  }
}

function validateImageResponse(response, finalUrl) {
  if (!response.ok && response.status !== 206) {
    throw new Error(`Image probe failed with status ${response.status}.`);
  }

  const mimeType = normalizedMimeType(response);

  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(mimeType ? `Unsupported image MIME type: ${mimeType}.` : "Image MIME type could not be verified.");
  }

  const size = responseSize(response);

  if (Number.isFinite(size) && size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is larger than ${MAX_IMAGE_BYTES} bytes.`);
  }

  return {
    url: finalUrl,
    mimeType,
    sizeBytes: Number.isFinite(size) ? size : null
  };
}

async function probeImageUrl(url) {
  let lastError = null;

  for (const method of ["HEAD", "GET"]) {
    let response = null;

    try {
      const result = await safeFetchWithRedirects(url, {
        method,
        headers: {
          Accept: "image/jpeg,image/png,image/webp,image/gif",
          "User-Agent": BROWSER_USER_AGENT,
          ...(method === "GET" ? { Range: "bytes=0-0" } : {})
        }
      });
      response = result.response;
      const finalUrl = result.finalUrl;
      const validation = validateImageResponse(response, finalUrl);
      await cancelBody(response);
      return validation;
    } catch (error) {
      if (response) {
        await cancelBody(response);
      }
      lastError = error;
    }
  }

  throw lastError || new Error("Image URL could not be validated.");
}

function classifyHost(url) {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();

  if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it") {
    return "reddit";
  }

  if (host === "twitter.com" || host === "x.com" || host.endsWith(".twitter.com") || host === "t.co") {
    return "twitter";
  }

  if (host === "facebook.com" || host === "fb.watch" || host.endsWith(".facebook.com")) {
    return "facebook";
  }

  if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") {
    return "instagram";
  }

  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return "tiktok";
  }

  return "direct_url";
}

function ensureSocialEnabled(source, settings, url) {
  const sourceType = platformSourceType(source);

  if (source === "reddit" && !settings.enableReddit) {
    throw inputError("This feature is not available right now.", {
      rejectionReason: "unsupported_source",
      source: sourceType,
      sourceType,
      inputUrl: url,
      previewExtractionMethod: "reddit:disabled",
      previewExtractionError: "reddit_links_disabled",
      previewExtractionCandidateCount: 0
    });
  }

  if (source === "twitter" && !settings.enableTwitter) {
    throw inputError("This feature is not available right now.", {
      rejectionReason: "unsupported_source",
      source: sourceType,
      sourceType,
      inputUrl: url,
      previewExtractionMethod: "twitter:disabled",
      previewExtractionError: "twitter_links_disabled",
      previewExtractionCandidateCount: 0
    });
  }

  if (source === "facebook" && !settings.enableFacebook) {
    throw inputError("This feature is not available right now.", {
      rejectionReason: "unsupported_source",
      source: sourceType,
      sourceType,
      inputUrl: url,
      previewExtractionMethod: "facebook:disabled",
      previewExtractionError: "facebook_links_disabled",
      previewExtractionCandidateCount: 0
    });
  }
}

function ensureGenericLinksEnabled(settings, url) {
  if (settings.enableGenericLinks === false) {
    throw inputError("This feature is not available right now.", {
      rejectionReason: "unsupported_source",
      source: GENERIC_SOURCE_TYPE,
      sourceType: GENERIC_SOURCE_TYPE,
      inputUrl: url,
      previewExtractionMethod: "generic:disabled",
      previewExtractionError: "generic_links_disabled",
      previewExtractionCandidateCount: 0
    });
  }
}

function resolveLinkSource(url, settings) {
  let source;

  try {
    source = classifyHost(url);
  } catch {
    throw inputError("That URL is not valid.", {
      rejectionReason: "invalid_url",
      source: "url",
      sourceType: GENERIC_SOURCE_TYPE,
      inputUrl: url,
      previewExtractionMethod: "url_validation",
      previewExtractionError: "invalid_url",
      previewExtractionCandidateCount: 0
    });
  }

  if (source !== "direct_url") {
    ensureSocialEnabled(source, settings, url);
    return {
      source,
      sourceType: platformSourceType(source)
    };
  }

  ensureGenericLinksEnabled(settings, url);
  return {
    source,
    sourceType: GENERIC_SOURCE_TYPE
  };
}

function galleryDlPythonPath() {
  if (process.env.GALLERY_DL_PYTHON) {
    return process.env.GALLERY_DL_PYTHON;
  }

  const localVenvPython = path.resolve(process.cwd(), ".venv", "bin", "python");
  if (existsSync(localVenvPython)) {
    return localVenvPython;
  }

  const localWindowsVenvPython = path.resolve(process.cwd(), ".venv", "Scripts", "python.exe");
  if (existsSync(localWindowsVenvPython)) {
    return localWindowsVenvPython;
  }

  return process.platform === "win32" ? "python" : "python3";
}

async function fetchGalleryDlMetadata(url, { sourceType, trustedUser = false } = {}) {
  try {
    // Validate the submitted URL before passing it to an external extractor process.
    await validateSafePublicUrl(url);

    const galleryDlArgs = ["-m", "gallery_dl", "--get-urls", "--quiet"];
    if (process.env.GALLERY_DL_COOKIES_FILE) {
      galleryDlArgs.push("--cookies", process.env.GALLERY_DL_COOKIES_FILE);
    }
    galleryDlArgs.push(url);

    let stdout = "";
    try {
      const result = await execFileAsync(
        galleryDlPythonPath(),
        galleryDlArgs,
        {
          timeout: GALLERY_DL_TIMEOUT_MS,
          maxBuffer: MAX_GALLERY_DL_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8"
        }
      );
      stdout = result.stdout;
    } catch (error) {
      // Keep URLs already emitted if an extractor exits non-zero after a partial result.
      if (typeof error.stdout !== "string" || !error.stdout.trim()) {
        throw error;
      }
      stdout = error.stdout;
    }

    const candidates = [...new Set(String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//i.test(line)))]
      .slice(0, MAX_GALLERY_DL_CANDIDATES);

    // gallery-dl can return videos as well as images. Validate the actual response
    // MIME type instead of trusting the URL extension.
    const images = [];
    for (let index = 0; index < candidates.length; index += 4) {
      const batch = candidates.slice(index, index + 4);
      const validated = await Promise.all(batch.map(async (imageUrl) => {
        try {
          const image = await probeImageUrl(imageUrl);
          return { url: image.url, source: "gallery-dl", mimeType: image.mimeType };
        } catch {
          return null;
        }
      }));
      images.push(...validated.filter(Boolean));
    }

    const metadata = {
      ok: images.length > 0,
      images,
      bestImage: images[0]?.url || null,
      diagnostics: {
        adapterUsed: "gallery-dl",
        errors: images.length ? [] : [candidates.length ? "No supported image files were found." : "gallery-dl returned no media URLs."]
      }
    };

    logPreviewExtraction(images.length ? "info" : "warn", {
      url,
      sourceType,
      extractorUsed: GALLERY_DL_METHOD,
      candidateCount: candidates.length,
      imageCount: images.length,
      filteredImageCount: images.length,
      bestImage: metadata.bestImage,
      selectedImage: metadata.bestImage,
      selectedImageUrl: metadata.bestImage,
      provider: "gallery-dl",
      status: metadata.ok ? "success" : "failed",
      trustedUser,
      failureReason: metadata.ok ? null : metadata.diagnostics.errors[0]
    });

    return metadata;
  } catch (error) {
    const reason = error.code === "ENOENT"
      ? "gallery-dl or Python is not installed. Check the Render build command."
      : error.killed || error.code === "ETIMEDOUT"
        ? "gallery-dl timed out while extracting this post."
        : error.message;

    logPreviewExtraction("warn", {
      url,
      sourceType,
      extractorUsed: GALLERY_DL_METHOD,
      candidateCount: 0,
      status: "failed",
      trustedUser,
      failureReason: reason,
      errorStack: error.stack
    });

    return {
      ok: false,
      images: [],
      bestImage: null,
      diagnostics: {
        adapterUsed: "gallery-dl",
        errors: [reason]
      }
    };
  }
}

function urlInputPayload({
  url,
  imageUrl,
  sourceType,
  method,
  candidateCount,
  mimeType,
  providerDiagnostics = null,
  fallbackUsed = null,
  bestImageUrl = null,
  filteredImageCount = null,
  telegramPreviewUsed = false,
  telegramFileId = null,
  telegramFileUrl = null,
  selectedTelegramFileId = null,
  autoSelectedSingleImage = false
}) {
  const hasTelegramFileId = Boolean(telegramFileId);
  const persistentImageUrl = hasTelegramFileId ? null : imageUrl;

  return {
    source: sourceType,
    sourceType,
    inputType: sourceType,
    inputUrl: url,
    extractedImageUrl: persistentImageUrl,
    inputSourceDomain: sourceDomain(url),
    previewExtractionMethod: method,
    previewExtractionStatus: "success",
    previewExtractionError: null,
    previewExtractionCandidateCount: Number.isFinite(candidateCount) ? candidateCount : null,
    previewExtractionSelectedMimeType: mimeType || null,
    provider: providerDiagnostics?.platform || null,
    bestImageUrl: bestImageUrl || null,
    selectedImageUrl: persistentImageUrl,
    imageCount: Number.isFinite(candidateCount) ? candidateCount : null,
    filteredImageCount: Number.isFinite(filteredImageCount) ? filteredImageCount : null,
    telegramPreviewUsed: Boolean(telegramPreviewUsed || fallbackUsed === "telegram_preview"),
    inputFileId: telegramFileId || null,
    inputTelegramFileId: telegramFileId || null,
    inputTelegramFileUrl: hasTelegramFileId ? null : telegramFileUrl || null,
    inputImageUrl: persistentImageUrl,
    inputThumbnail: persistentImageUrl,
    inputPreview: persistentImageUrl,
    selectedTelegramFileId,
    autoSelectedSingleImage: Boolean(autoSelectedSingleImage),
    imageUrl,
    providerDiagnostics,
    fallbackUsed
  };
}

async function resolveDirectImageInput(url) {
  try {
    const validation = await probeImageUrl(url);

    logPreviewExtraction("info", {
      url,
      sourceType: DIRECT_IMAGE_SOURCE_TYPE,
      extractorUsed: "direct:image_url",
      candidateCount: 1,
      selectedImageUrl: validation.url,
      status: "success"
    });

    return urlInputPayload({
      url,
      imageUrl: validation.url,
      sourceType: DIRECT_IMAGE_SOURCE_TYPE,
      method: "direct:image_url",
      candidateCount: 1,
      mimeType: validation.mimeType
    });
  } catch (error) {
    throw inputError("That URL is not a safe, supported image URL.", {
      rejectionReason: /not allowed|localhost|private|internal|credentials|valid/i.test(error.message)
        ? "invalid_url"
        : "invalid_media",
      source: DIRECT_IMAGE_SOURCE_TYPE,
      sourceType: DIRECT_IMAGE_SOURCE_TYPE,
      inputUrl: url,
      previewExtractionMethod: "direct:image_url",
      previewExtractionError: error.message,
      previewExtractionCandidateCount: 1
    });
  }
}

function photoCandidates(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value.sizes)) {
    return value.sizes;
  }

  return [value];
}

function largestTelegramPhoto(value) {
  return photoCandidates(value)
    .filter((photo) => photo?.file_id)
    .sort((a, b) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0))[0] || null;
}

function telegramPreviewFileId(message = {}) {
  const page = message.web_page || message.webPage || null;

  if (!page || typeof page !== "object") {
    return null;
  }

  const photo = largestTelegramPhoto(page.photo || page.thumbnail);
  if (photo?.file_id) {
    return photo.file_id;
  }

  const nestedThumbnail = [
    page.animation?.thumbnail,
    page.video?.thumbnail,
    page.document?.thumbnail,
    page.audio?.thumbnail
  ].map(largestTelegramPhoto).find(Boolean);

  if (nestedThumbnail?.file_id) {
    return nestedThumbnail.file_id;
  }

  if (page.document?.mime_type?.startsWith("image/") && page.document.file_id) {
    return page.document.file_id;
  }

  return null;
}

export async function resolveTelegramPreviewFallback(message, bot, url, {
  metadata = null,
  sourceType = TELEGRAM_PREVIEW_SOURCE_TYPE,
  trustedUser = false,
  reason = "fallback"
} = {}) {
  const fileId = telegramPreviewFileId(message);

  if (!fileId) {
    return null;
  }

  try {
    const imageUrl = await getTelegramFileUrl(bot, fileId, TELEGRAM_PREVIEW_SOURCE_TYPE);
    const providerDiagnostics = providerDiagnosticsFromMetadata(metadata);

    logPreviewExtraction("info", {
      url,
      sourceType: TELEGRAM_PREVIEW_SOURCE_TYPE,
      extractorUsed: TELEGRAM_PREVIEW_METHOD,
      candidateCount: 1,
      selectedImageUrl: imageUrl,
      fallbackUsed: "telegram_preview",
      telegramPreviewUsed: true,
      trustedUser,
      providerDiagnostics,
      status: "success"
    });

    return urlInputPayload({
      url,
      imageUrl,
      sourceType: TELEGRAM_PREVIEW_SOURCE_TYPE,
      method: `${TELEGRAM_PREVIEW_METHOD}:${reason}`,
      candidateCount: 1,
      mimeType: "image/telegram-preview",
      providerDiagnostics,
      fallbackUsed: "telegram_preview",
      bestImageUrl: metadata?.bestImage || null,
      filteredImageCount: filterAndRankDiscoveredImages(metadata || {}).length,
      telegramPreviewUsed: true,
      telegramFileId: fileId
    });
  } catch (error) {
    logPreviewExtraction("warn", {
      url,
      sourceType,
      extractorUsed: TELEGRAM_PREVIEW_METHOD,
      candidateCount: 1,
      fallbackUsed: "telegram_preview",
      trustedUser,
      failureReason: error.message,
      errorStack: error.stack
    });
    return null;
  }
}

function metadataUnavailableError(url, metadata, sourceType) {
  const providerDiagnostics = providerDiagnosticsFromMetadata(metadata);
  const blocked = isProviderBlocked(metadata);
  const errors = metadataErrors(metadata);
  const reason = blocked
    ? "provider_blocked"
    : metadata?.ok === false
      ? (/not allowed|localhost|private|internal|credentials|valid|protocol/i.test(errors.join(" "))
        ? "invalid_url"
        : "metadata_fetch_error")
      : "invalid_media";
  const message = blocked
    ? "I could not extract a suitable image from this link. If Telegram shows a preview image, I will try to use it. Otherwise, send the image directly."
    : metadata?.ok === false
      ? "I could not open this link. Try another link or send the image directly."
      : "I could not find a suitable image inside this link. Send the image directly and I will analyze it.";

  return inputError(message, {
    status: "failed",
    rejectionReason: reason,
    source: sourceType,
    sourceType,
    inputUrl: url,
    previewExtractionMethod: GALLERY_DL_METHOD,
    previewExtractionError: errors.join("; ") || providerDiagnostics?.reason || message,
    previewExtractionCandidateCount: Array.isArray(metadata?.images) ? metadata.images.length : 0,
    providerDiagnostics
  });
}

async function buildInputFromMetadataImage({
  url,
  imageUrl,
  sourceType,
  metadata,
  method,
  candidateCount,
  fallbackUsed = null,
  filteredImageCount = null,
  bestImageUrl = null,
  autoSelectedSingleImage = false
}) {
  const providerDiagnostics = providerDiagnosticsFromMetadata(metadata);
  const resolvedBestImageUrl = bestImageUrl || metadata?.bestImage || null;
  const resolvedFilteredImageCount = Number.isFinite(filteredImageCount)
    ? filteredImageCount
    : filterAndRankDiscoveredImages(metadata || {}).length;

  try {
    const validation = await probeImageUrl(imageUrl);

    logPreviewExtraction("info", {
      url,
      sourceType,
      extractorUsed: method,
      candidateCount,
      imageCount: candidateCount,
      filteredImageCount: resolvedFilteredImageCount,
      bestImage: resolvedBestImageUrl,
      selectedImage: validation.url,
      selectedImageUrl: validation.url,
      fallbackUsed,
      providerDiagnostics,
      status: "success"
    });

    return urlInputPayload({
      url,
      imageUrl: validation.url,
      sourceType,
      method,
      candidateCount,
      mimeType: validation.mimeType,
      providerDiagnostics,
      fallbackUsed,
      bestImageUrl: resolvedBestImageUrl,
      filteredImageCount: resolvedFilteredImageCount,
      autoSelectedSingleImage
    });
  } catch (error) {
    throw inputError("I found an image in that link, but could not load it safely. Send the image directly or try another link.", {
      status: "failed",
      rejectionReason: /not allowed|localhost|private|internal|credentials|valid/i.test(error.message)
        ? "invalid_url"
        : "invalid_media",
      source: sourceType,
      sourceType,
      inputUrl: url,
      extractedImageUrl: imageUrl,
      previewExtractionMethod: method,
      previewExtractionError: error.message,
      previewExtractionCandidateCount: candidateCount,
      providerDiagnostics,
      bestImageUrl: resolvedBestImageUrl,
      selectedImageUrl: imageUrl,
      imageCount: candidateCount,
      filteredImageCount: resolvedFilteredImageCount,
      fallbackUsed
    });
  }
}

async function resolveMetadataBestInput(url, message, bot, settings, { trustedUser = false } = {}) {
  const { sourceType } = resolveLinkSource(url, settings);
  const metadata = await fetchGalleryDlMetadata(url, { sourceType, trustedUser });
  const selectedImage = selectAnalysisImage(metadata);
  const imageCount = Array.isArray(metadata.images) ? metadata.images.length : 0;
  const filteredImages = filterAndRankDiscoveredImages(metadata);
  const filteredImageCount = filteredImages.length;
  const needsFallback = metadata.ok === false || isProviderBlocked(metadata) || !selectedImage;

  if (needsFallback) {
    const fallback = await resolveTelegramPreviewFallback(message, bot, url, {
      metadata,
      sourceType,
      trustedUser,
      reason: isProviderBlocked(metadata) ? "provider_blocked" : "metadata_failed"
    });

    if (fallback) {
      return fallback;
    }

    throw metadataUnavailableError(url, metadata, sourceType);
  }

  try {
    return await buildInputFromMetadataImage({
      url,
      imageUrl: selectedImage.url,
      sourceType,
      metadata,
      method: GALLERY_DL_SELECTED_METHOD,
      candidateCount: imageCount || 1,
      filteredImageCount,
      bestImageUrl: metadata.bestImage || null
    });
  } catch (error) {
    const fallback = await resolveTelegramPreviewFallback(message, bot, url, {
      metadata,
      sourceType,
      trustedUser,
      reason: "image_probe_failed"
    });

    if (fallback) {
      return fallback;
    }

    throw error;
  }
}

function numericDimension(value) {
  const numberValue = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeImageAsset(image, { isBestImage = false } = {}) {
  if (typeof image === "string") {
    return {
      url: image,
      width: null,
      height: null,
      source: "bestImage",
      score: null,
      confidence: null,
      title: null,
      alt: null,
      isBestImage
    };
  }

  if (!image || typeof image !== "object") {
    return null;
  }

  const url = image.url || image.secureUrl;

  if (!url) {
    return null;
  }

  return {
    url,
    width: numericDimension(image.width),
    height: numericDimension(image.height),
    source: image.source || image.metadata?.source || image.metadata?.discoveredFrom || "metadata",
    score: Number.isFinite(Number(image.score)) ? Number(image.score) : null,
    confidence: Number.isFinite(Number(image.confidence)) ? Number(image.confidence) : null,
    title: image.title || null,
    alt: image.alt || null,
    isBestImage
  };
}

function normalizedImageKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

function imageArea(image) {
  return Number.isFinite(image.width) && Number.isFinite(image.height) ? image.width * image.height : 0;
}

function imageQualityScore(image) {
  if (Number.isFinite(image.score)) {
    return image.score;
  }

  if (Number.isFinite(image.confidence)) {
    return image.confidence;
  }

  return 0;
}

function mergeImageAssets(current, next) {
  const currentArea = imageArea(current);
  const nextArea = imageArea(next);
  const preferNext = nextArea > currentArea || (nextArea === currentArea && imageQualityScore(next) > imageQualityScore(current));
  const base = preferNext ? next : current;
  const fallback = preferNext ? current : next;

  return {
    ...base,
    width: base.width ?? fallback.width,
    height: base.height ?? fallback.height,
    source: base.source || fallback.source,
    score: base.score ?? fallback.score,
    confidence: base.confidence ?? fallback.confidence,
    title: base.title || fallback.title,
    alt: base.alt || fallback.alt,
    isBestImage: Boolean(current.isBestImage || next.isBestImage)
  };
}

function isPublicImageUrl(image) {
  if (!image?.url) {
    return false;
  }

  return /^https?:\/\//i.test(image.url);
}

function imageSearchText(image = {}) {
  return [
    image.url,
    image.source,
    image.title,
    image.alt
  ].filter(Boolean).join(" ");
}

function isWeakImage(image) {
  return WEAK_IMAGE_TEXT_PATTERN.test(imageSearchText(image).toLowerCase());
}

function hasTinyKnownDimensions(image) {
  return (Number.isFinite(image.width) && image.width < 200) || (Number.isFinite(image.height) && image.height < 200);
}

function isUsefulImage(image, { allowTiny = false } = {}) {
  return isPublicImageUrl(image) && !isWeakImage(image) && (allowTiny || !hasTinyKnownDimensions(image));
}

function compareImagesByAreaThenQuality(left, right) {
  return imageArea(right) - imageArea(left) || imageQualityScore(right) - imageQualityScore(left);
}

function normalizedImageCandidates(metadata = {}) {
  const candidatesByUrl = new Map();
  const rawImages = Array.isArray(metadata.images) ? metadata.images : [];
  const inputs = [
    ...rawImages.map((image) => ({ image, isBestImage: false })),
    ...(metadata.bestImage ? [{ image: metadata.bestImage, isBestImage: true }] : [])
  ];

  inputs.forEach(({ image, isBestImage }) => {
    const normalized = normalizeImageAsset(image, { isBestImage });

    if (!normalized || !isPublicImageUrl(normalized)) {
      return;
    }

    const key = normalizedImageKey(normalized.url);
    const current = candidatesByUrl.get(key);
    candidatesByUrl.set(key, current ? mergeImageAssets(current, normalized) : normalized);
  });

  return [...candidatesByUrl.values()];
}

export function resolveMaxDiscoveredImages(settings = {}) {
  const value = Number(settings.maxDiscoveredImages);

  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_DISCOVERED_IMAGES;
  }

  return Math.min(MAX_DISCOVERED_IMAGES_LIMIT, Math.max(1, Math.floor(value)));
}

export function filterAndRankDiscoveredImages(metadata = {}) {
  const candidates = normalizedImageCandidates(metadata).filter((image) => !isWeakImage(image));
  const usefulImages = candidates.filter((image) => isUsefulImage(image));
  const displayImages = usefulImages.length ? usefulImages : candidates.filter((image) => isUsefulImage(image, { allowTiny: true }));

  return displayImages.sort(compareImagesByAreaThenQuality);
}

export function selectAnalysisImage(metadata = {}) {
  const candidates = normalizedImageCandidates(metadata);
  const firstBest = candidates.find((image) => image.isBestImage);

  if (firstBest && isUsefulImage(firstBest)) {
    return firstBest;
  }

  return filterAndRankDiscoveredImages(metadata)[0] || null;
}

function hasDirectTelegramImage(message = {}) {
  return Boolean(getLargestPhoto(message) || (message.document?.mime_type?.startsWith("image/") && message.document.file_id));
}

export function shouldOfferTrustedLinkSelection(message = {}) {
  const [url] = extractUrls(message);
  return Boolean(url && !hasDirectTelegramImage(message) && !isDirectImageUrl(url));
}

export function trustedLinkSelectionResult({ url, source, sourceType, metadata, bestInput, images = [] } = {}) {
  const safeImages = Array.isArray(images) ? images : [];

  if (safeImages.length === 1) {
    return {
      type: "input",
      input: {
        ...bestInput,
        autoSelectedSingleImage: true
      }
    };
  }

  return {
    type: "selection",
    url,
    source,
    sourceType,
    metadata,
    bestInput,
    images: safeImages
  };
}

export async function resolveTrustedLinkSelection(message, bot, settings, { trustedUser = false } = {}) {
  const [url] = extractUrls(message);

  if (!url || !shouldOfferTrustedLinkSelection(message)) {
    return null;
  }

  const { source, sourceType } = resolveLinkSource(url, settings);
  const metadata = await fetchGalleryDlMetadata(url, { sourceType, trustedUser });
  const selectedImage = selectAnalysisImage(metadata);
  const imageCount = Array.isArray(metadata.images) ? metadata.images.length : 0;
  const filteredImages = filterAndRankDiscoveredImages(metadata);
  const filteredImageCount = filteredImages.length;
  const needsFallback = metadata.ok === false || isProviderBlocked(metadata) || !selectedImage;

  if (needsFallback) {
    const fallback = await resolveTelegramPreviewFallback(message, bot, url, {
      metadata,
      sourceType,
      trustedUser,
      reason: isProviderBlocked(metadata) ? "provider_blocked" : "metadata_failed"
    });

    if (fallback) {
      return {
        type: "input",
        input: fallback
      };
    }

    throw metadataUnavailableError(url, metadata, sourceType);
  }

  let bestInput;

  try {
    bestInput = await buildInputFromMetadataImage({
      url,
      imageUrl: selectedImage.url,
      sourceType,
      metadata,
      method: GALLERY_DL_SELECTED_METHOD,
      candidateCount: imageCount || 1,
      filteredImageCount,
      bestImageUrl: metadata.bestImage || null,
      autoSelectedSingleImage: filteredImageCount === 1
    });
  } catch (error) {
    const fallback = await resolveTelegramPreviewFallback(message, bot, url, {
      metadata,
      sourceType,
      trustedUser,
      reason: "image_probe_failed"
    });

    if (fallback) {
      return {
        type: "input",
        input: fallback
      };
    }

    throw error;
  }

  return trustedLinkSelectionResult({
    url,
    source,
    sourceType,
    metadata,
    bestInput,
    images: filteredImages
  });
}

export async function resolveDiscoveredImageInput({ url, sourceType, metadata, image, candidateCount }) {
  return buildInputFromMetadataImage({
    url,
    imageUrl: image.url,
    sourceType,
    metadata,
    method: GALLERY_DL_SELECTED_METHOD,
    candidateCount
  });
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
      inputTelegramFileId: photo.file_id,
      inputTelegramFileUrl: null,
      inputImageUrl: null,
      inputThumbnail: null,
      inputPreview: null,
      imageUrl
    };
  }

  if (message.document?.mime_type?.startsWith("image/") && message.document.file_id) {
    const imageUrl = await getTelegramFileUrl(bot, message.document.file_id);

    return {
      source: isForwarded(message) ? "forwarded_image" : "telegram_image",
      inputType: isForwarded(message) ? "telegram_forward" : "image",
      inputUrl: null,
      inputFileId: message.document.file_id,
      inputTelegramFileId: message.document.file_id,
      inputTelegramFileUrl: null,
      inputImageUrl: null,
      inputThumbnail: null,
      inputPreview: null,
      imageUrl
    };
  }

  const [url] = extractUrls(message);

  if (!url) {
    return null;
  }

  if (isDirectImageUrl(url)) {
    return resolveDirectImageInput(url);
  }

  let source;

  try {
    source = classifyHost(url);
  } catch {
    throw inputError("That URL is not valid.", {
      rejectionReason: "invalid_url",
      source: "url",
      sourceType: GENERIC_SOURCE_TYPE,
      inputUrl: url,
      previewExtractionMethod: "url_validation",
      previewExtractionError: "invalid_url",
      previewExtractionCandidateCount: 0
    });
  }

  if (source === "direct_url") {
    try {
      return await resolveDirectImageInput(url);
    } catch (error) {
      if (error instanceof InputResolutionError && error.rejectionReason === "invalid_url") {
        throw error;
      }
    }
  }

  return resolveMetadataBestInput(url, message, bot, settings);
}
