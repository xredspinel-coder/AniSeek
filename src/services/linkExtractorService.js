import { lookup } from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";

const IMAGE_EXTENSION_PATTERN = /\.(gif|jpe?g|png|webp)(\?.*)?$/i;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_HTML_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 8_000;
const TELEGRAM_FILE_TIMEOUT_MS = 12_000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AniSeekBot/1.0";
const DIRECT_IMAGE_SOURCE_TYPE = "direct_image_url";
const GENERIC_SOURCE_TYPE = "generic_link_preview";
const PLATFORM_SOURCE_TYPES = {
  reddit: "reddit_preview",
  twitter: "twitter_preview",
  facebook: "facebook_preview"
};

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
      previewExtractionSelectedMimeType = null
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

function previewFields({
  url,
  sourceType = GENERIC_SOURCE_TYPE,
  method = null,
  status = "failed",
  error = null,
  candidateCount = null,
  selectedImageUrl = null,
  mimeType = null
} = {}) {
  return {
    sourceType,
    extractedImageUrl: selectedImageUrl || null,
    inputSourceDomain: sourceDomain(url),
    previewExtractionMethod: method,
    previewExtractionStatus: status,
    previewExtractionError: error,
    previewExtractionCandidateCount: Number.isFinite(candidateCount) ? candidateCount : null,
    previewExtractionSelectedMimeType: mimeType || null
  };
}

function logPreviewExtraction(level, details = {}) {
  const payload = {
    url: details.url || null,
    domain: details.domain || sourceDomain(details.url) || null,
    extractorUsed: details.extractorUsed || details.method || null,
    imageCandidateCount: Number.isFinite(details.candidateCount) ? details.candidateCount : null,
    selectedImageUrl: details.selectedImageUrl || null,
    failureReason: details.failureReason || null,
    sourceType: details.sourceType || null
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
    mimeType: options.previewExtractionSelectedMimeType
  });

  return new InputResolutionError(message, {
    ...options,
    ...fields,
    source: options.source || fields.sourceType,
    inputUrl: options.inputUrl || null
  });
}

async function getTelegramFileUrl(bot, fileId, source = "telegram_image") {
  let file;

  try {
    file = await bot.getFile(fileId);
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

function isDirectImageUrl(url) {
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

async function readLimitedText(response, maxBytes = MAX_HTML_BYTES) {
  const contentLength = Number(response.headers.get("content-length"));

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`HTML document is larger than ${maxBytes} bytes.`);
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`HTML document is larger than ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`HTML document is larger than ${maxBytes} bytes.`);
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  chunks.forEach((chunk) => {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return new TextDecoder("utf-8").decode(body);
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

async function fetchHtmlPage(url, { sourceType = GENERIC_SOURCE_TYPE, extractor = "generic:metadata" } = {}) {
  try {
    const { response, finalUrl } = await safeFetchWithRedirects(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": BROWSER_USER_AGENT
      }
    });

    if (!response.ok) {
      await cancelBody(response);
      throw new Error(`Page metadata request failed with status ${response.status}.`);
    }

    const contentType = normalizedMimeType(response);

    if (contentType && !["text/html", "application/xhtml+xml"].includes(contentType)) {
      await cancelBody(response);
      throw new Error(`URL returned ${contentType}, not HTML.`);
    }

    return {
      html: await readLimitedText(response),
      finalUrl
    };
  } catch (error) {
    logPreviewExtraction("warn", {
      url,
      sourceType,
      extractorUsed: extractor,
      candidateCount: 0,
      failureReason: error.message
    });

    throw inputError("Could not fetch page metadata for this link.", {
      status: "failed",
      rejectionReason: /not allowed|localhost|private|internal|credentials|valid/i.test(error.message)
        ? "invalid_url"
        : "processing_error",
      source: sourceType,
      sourceType,
      inputUrl: url,
      previewExtractionMethod: extractor,
      previewExtractionError: error.message,
      previewExtractionCandidateCount: 0
    });
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

function numericHint(value) {
  const parsed = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLikelyTinyAsset(url, { width = null, height = null } = {}) {
  const lower = url.toLowerCase();
  const bothDimensionsKnown = Number.isFinite(width) && Number.isFinite(height);

  if (bothDimensionsKnown && (width < 180 || height < 120)) {
    return true;
  }

  if (Number.isFinite(width) && width < 180) {
    return true;
  }

  if (Number.isFinite(height) && height < 120) {
    return true;
  }

  return /favicon|apple-touch-icon|\/icon[-_.]|\bicon\b|sprite|logo|avatar|badge|emoji/.test(lower);
}

function parseLargestSrcsetUrl(value) {
  const candidates = String(value || "")
    .split(",")
    .map((entry) => {
      const [url, descriptor] = entry.trim().split(/\s+/);
      const weight = descriptor?.endsWith("w")
        ? Number.parseInt(descriptor, 10)
        : descriptor?.endsWith("x")
          ? Number.parseFloat(descriptor) * 1000
          : 0;

      return {
        url,
        weight: Number.isFinite(weight) ? weight : 0
      };
    })
    .filter((entry) => entry.url);

  return candidates.sort((a, b) => b.weight - a.weight)[0]?.url || null;
}

function addCandidate(candidates, rawUrl, baseUrl, method, priority, hints = {}) {
  const value = String(rawUrl || "").trim();

  if (!value || /^(?:data|blob|file|javascript):/i.test(value)) {
    return;
  }

  let absoluteUrl;

  try {
    absoluteUrl = new URL(value, baseUrl).toString();
  } catch {
    return;
  }

  const parsed = new URL(absoluteUrl);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return;
  }

  const width = numericHint(hints.width);
  const height = numericHint(hints.height);

  if (method === "html_img" && isLikelyTinyAsset(absoluteUrl, { width, height })) {
    return;
  }

  const areaBoost = Number.isFinite(width) && Number.isFinite(height) ? Math.min(20, (width * height) / 50_000) : 0;

  candidates.push({
    url: absoluteUrl,
    method,
    width,
    height,
    score: priority + areaBoost - (hints.index || 0) / 100
  });
}

function addJsonLdImageCandidates(candidates, value, baseUrl, priority = 70, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    addCandidate(candidates, value, baseUrl, "json_ld_image", priority);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => addJsonLdImageCandidates(candidates, item, baseUrl, priority, depth + 1));
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  if (value.url || value.contentUrl || value["@id"]) {
    addCandidate(candidates, value.url || value.contentUrl || value["@id"], baseUrl, "json_ld_image", priority);
  }

  ["image", "thumbnail", "thumbnailUrl", "contentUrl"].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      addJsonLdImageCandidates(candidates, value[key], baseUrl, priority, depth + 1);
    }
  });

  if (Array.isArray(value["@graph"])) {
    addJsonLdImageCandidates(candidates, value["@graph"], baseUrl, priority - 5, depth + 1);
  }
}

function extractImageCandidates(html, baseUrl, { includeHtmlImages = true } = {}) {
  const $ = cheerio.load(html);
  const candidates = [];
  const metaMethods = new Map([
    ["og:image", { method: "og:image", priority: 100 }],
    ["og:image:secure_url", { method: "og:image:secure_url", priority: 100 }],
    ["twitter:image", { method: "twitter:image", priority: 92 }],
    ["twitter:image:src", { method: "twitter:image:src", priority: 92 }]
  ]);

  $("meta").each((_, element) => {
    const key = String($(element).attr("property") || $(element).attr("name") || "").trim().toLowerCase();
    const config = metaMethods.get(key);

    if (config) {
      addCandidate(candidates, $(element).attr("content"), baseUrl, config.method, config.priority);
    }
  });

  $("link[rel]").each((_, element) => {
    const rel = String($(element).attr("rel") || "").toLowerCase().split(/\s+/);

    if (rel.includes("image_src")) {
      addCandidate(candidates, $(element).attr("href"), baseUrl, "image_src", 84);
    }
  });

  $('script[type*="ld+json"]').each((_, element) => {
    const text = $(element).contents().text().trim();

    if (!text) {
      return;
    }

    try {
      addJsonLdImageCandidates(candidates, JSON.parse(text), baseUrl);
    } catch {
      // Ignore malformed JSON-LD and continue with other metadata.
    }
  });

  if (includeHtmlImages) {
    $("img").slice(0, 80).each((index, element) => {
      const width = $(element).attr("width") || $(element).attr("data-width");
      const height = $(element).attr("height") || $(element).attr("data-height");
      const hints = {
        width,
        height,
        index
      };

      [
        parseLargestSrcsetUrl($(element).attr("srcset")),
        parseLargestSrcsetUrl($(element).attr("data-srcset")),
        $(element).attr("data-full-url"),
        $(element).attr("data-original"),
        $(element).attr("data-lazy-src"),
        $(element).attr("data-src"),
        $(element).attr("src")
      ].forEach((value) => addCandidate(candidates, value, baseUrl, "html_img", 35, hints));
    });
  }

  const seen = new Set();

  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.url)) {
        return false;
      }

      seen.add(candidate.url);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

async function selectUsableImage(url, candidates, { sourceType, extractor }) {
  const candidateCount = candidates.length;
  let lastFailure = "No image candidates were found.";

  for (const candidate of candidates.slice(0, 24)) {
    try {
      const validation = await probeImageUrl(candidate.url);
      const result = {
        imageUrl: validation.url,
        method: candidate.method,
        extractor,
        sourceType,
        candidateCount,
        mimeType: validation.mimeType
      };

      logPreviewExtraction("info", {
        url,
        sourceType,
        extractorUsed: `${extractor}:${candidate.method}`,
        candidateCount,
        selectedImageUrl: validation.url
      });

      return result;
    } catch (error) {
      lastFailure = error.message || String(error);
    }
  }

  logPreviewExtraction("warn", {
    url,
    sourceType,
    extractorUsed: extractor,
    candidateCount,
    failureReason: lastFailure
  });

  throw inputError("Could not find a usable image preview on this page.", {
    rejectionReason: "invalid_media",
    source: sourceType,
    sourceType,
    inputUrl: url,
    previewExtractionMethod: extractor,
    previewExtractionError: lastFailure,
    previewExtractionCandidateCount: candidateCount
  });
}

async function resolvePreviewFromPage(url, page, { sourceType, extractor, includeHtmlImages }) {
  const candidates = extractImageCandidates(page.html, page.finalUrl, {
    includeHtmlImages
  });

  return selectUsableImage(url, candidates, {
    sourceType,
    extractor
  });
}

async function resolvePlatformPreview(url, source) {
  const sourceType = platformSourceType(source);
  const page = await fetchHtmlPage(url, {
    sourceType,
    extractor: `${source}:metadata`
  });

  try {
    return await resolvePreviewFromPage(url, page, {
      sourceType,
      extractor: `${source}:metadata`,
      includeHtmlImages: false
    });
  } catch (error) {
    logPreviewExtraction("warn", {
      url,
      sourceType,
      extractorUsed: `${source}:metadata`,
      candidateCount: Number.isFinite(error.previewExtractionCandidateCount) ? error.previewExtractionCandidateCount : 0,
      failureReason: error.previewExtractionError || error.message
    });
  }

  return resolvePreviewFromPage(url, page, {
    sourceType,
    extractor: `${source}:generic_fallback`,
    includeHtmlImages: true
  });
}

async function resolveGenericPreview(url) {
  const page = await fetchHtmlPage(url, {
    sourceType: GENERIC_SOURCE_TYPE,
    extractor: "generic:metadata"
  });

  return resolvePreviewFromPage(url, page, {
    sourceType: GENERIC_SOURCE_TYPE,
    extractor: "generic:metadata",
    includeHtmlImages: true
  });
}

function ensureSocialEnabled(source, settings, url) {
  const sourceType = platformSourceType(source);

  if (source === "reddit" && !settings.enableReddit) {
    throw inputError("Reddit links are disabled by the current settings.", {
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
    throw inputError("Twitter/X links are disabled by the current settings.", {
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
    throw inputError("Facebook links are disabled by the current settings.", {
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
    throw inputError("Generic website links are disabled by the current settings.", {
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

function urlInputPayload({ url, imageUrl, sourceType, method, candidateCount, mimeType }) {
  return {
    source: sourceType,
    sourceType,
    inputType: sourceType,
    inputUrl: url,
    extractedImageUrl: imageUrl,
    inputSourceDomain: sourceDomain(url),
    previewExtractionMethod: method,
    previewExtractionStatus: "success",
    previewExtractionError: null,
    previewExtractionCandidateCount: Number.isFinite(candidateCount) ? candidateCount : null,
    previewExtractionSelectedMimeType: mimeType || null,
    inputFileId: null,
    inputTelegramFileUrl: null,
    inputImageUrl: imageUrl,
    inputThumbnail: imageUrl,
    inputPreview: imageUrl,
    imageUrl
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
      selectedImageUrl: validation.url
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

  if (isDirectImageUrl(url)) {
    return resolveDirectImageInput(url);
  }

  if (source !== "direct_url") {
    ensureSocialEnabled(source, settings, url);
    const preview = await resolvePlatformPreview(url, source);

    return urlInputPayload({
      url,
      imageUrl: preview.imageUrl,
      sourceType: preview.sourceType,
      method: `${preview.extractor}:${preview.method}`,
      candidateCount: preview.candidateCount,
      mimeType: preview.mimeType
    });
  }

  try {
    return await resolveDirectImageInput(url);
  } catch (error) {
    if (error instanceof InputResolutionError && error.rejectionReason === "invalid_url") {
      throw error;
    }
  }

  ensureGenericLinksEnabled(settings, url);

  const preview = await resolveGenericPreview(url);

  return urlInputPayload({
    url,
    imageUrl: preview.imageUrl,
    sourceType: preview.sourceType,
    method: `${preview.extractor}:${preview.method}`,
    candidateCount: preview.candidateCount,
    mimeType: preview.mimeType
  });
}
