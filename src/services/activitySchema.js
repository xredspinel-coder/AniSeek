const TRACE_MOE_MEDIA_PATTERN = /^https:\/\/api\.trace\.moe\/(?:image|video)\//i;
const TELEGRAM_FILE_URL_PATTERN = /^https:\/\/api\.telegram\.org\/file\/bot/i;

function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstPresent(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();

      if (trimmed) {
        return trimmed;
      }
    } else if (value !== null && value !== undefined) {
      return value;
    }
  }

  return null;
}

function firstNonTraceUrl(...values) {
  return firstPresent(...values.filter((value) => !isTraceMoeMediaUrl(value)));
}

function firstPermanentUrl({ hasFileId = false } = {}, ...values) {
  return firstPresent(...values.filter((value) => {
    if (isTraceMoeMediaUrl(value)) {
      return false;
    }

    if (hasFileId && isTelegramFileUrl(value)) {
      return false;
    }

    return true;
  }));
}

function sourceDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function mediaValue(activity, key, ...fallbacks) {
  const media = asRecord(activity.media);

  if (hasOwn(media, key)) {
    return firstPresent(media[key]);
  }

  return firstPresent(...fallbacks);
}

export function isTraceMoeMediaUrl(url) {
  return typeof url === "string" && TRACE_MOE_MEDIA_PATTERN.test(url.trim());
}

export function isTelegramFileUrl(url) {
  return typeof url === "string" && TELEGRAM_FILE_URL_PATTERN.test(url.trim());
}

export function normalizeActivityInput(activity = {}) {
  const input = asRecord(activity.input);
  const media = asRecord(activity.media);
  const userInput = asRecord(activity.userInput);
  const url = firstPresent(input.url, activity.inputUrl, userInput.url);
  const telegramFileId = firstPresent(
    input.telegramFileId,
    media.inputTelegramFileId,
    activity.inputTelegramFileId,
    activity.inputFileId,
    userInput.fileId
  );
  const telegramFileUrl = firstPresent(input.telegramFileUrl, media.inputTelegramFileUrl, activity.inputTelegramFileUrl);
  const selectedImageUrl = firstPermanentUrl({ hasFileId: Boolean(telegramFileId) },
    input.selectedImageUrl,
    activity.selectedImageUrl,
    media.selectedImageUrl,
    activity.extractedImageUrl,
    media.extractedImageUrl
  );
  const preview = firstPermanentUrl({ hasFileId: Boolean(telegramFileId) },
    input.preview,
    activity.inputPreview,
    media.inputPreview,
    activity.inputImageUrl,
    media.inputImageUrl
  );
  const thumbnail = firstPermanentUrl({ hasFileId: Boolean(telegramFileId) },
    input.thumbnail,
    activity.inputThumbnail,
    media.inputThumbnail
  );
  const extractedImageUrl = firstPermanentUrl({ hasFileId: Boolean(telegramFileId) },
    input.extractedImageUrl,
    activity.extractedImageUrl,
    media.extractedImageUrl,
    selectedImageUrl
  );

  return {
    type: firstPresent(input.type, activity.inputType, activity.source),
    source: firstPresent(input.source, activity.source),
    sourceType: firstPresent(input.sourceType, activity.sourceType, activity.source),
    text: firstPresent(input.text, userInput.text, typeof activity.userInput === "string" ? activity.userInput : null),
    url,
    domain: firstPresent(input.domain, activity.inputSourceDomain, userInput.inputSourceDomain, sourceDomain(url)),
    telegramFileId,
    telegramFileUrl: telegramFileId ? null : telegramFileUrl,
    thumbnail,
    preview,
    extractedImageUrl,
    selectedImageUrl,
    bestImageUrl: firstNonTraceUrl(input.bestImageUrl, activity.bestImageUrl, media.bestImageUrl),
    telegramPreviewUsed: Boolean(input.telegramPreviewUsed || activity.telegramPreviewUsed || activity.fallbackUsed === "telegram_preview"),
    provider: firstPresent(input.provider, activity.provider, activity.providerDiagnostics?.platform),
    providerDiagnostics: input.providerDiagnostics || activity.providerDiagnostics || null,
    imageCount: activity.imageCount ?? input.imageCount ?? activity.previewExtractionCandidateCount ?? null,
    filteredImageCount: activity.filteredImageCount ?? input.filteredImageCount ?? null
  };
}

export function normalizeActivityResult(activity = {}) {
  const result = asRecord(activity.result);
  const botResponse = asRecord(activity.botResponse);

  return {
    animeTitle: firstPresent(result.animeTitle, activity.animeTitle, botResponse.title),
    anilistId: result.anilistId ?? activity.anilistId ?? null,
    anilistUrl: firstPresent(result.anilistUrl, activity.anilistUrl, botResponse.anilistUrl),
    episode: result.episode ?? activity.episode ?? botResponse.episode ?? null,
    similarity: result.similarity ?? activity.similarity ?? botResponse.similarity ?? null,
    from: result.from ?? activity.from ?? null,
    to: result.to ?? activity.to ?? null,
    formattedTime: firstPresent(result.formattedTime, activity.formattedTime, botResponse.time)
  };
}

export function normalizeTraceMoe(activity = {}) {
  const traceMoe = asRecord(activity.traceMoe);
  const botResponse = asRecord(activity.botResponse);
  const media = asRecord(activity.media);
  const nestedMatchTrace = asRecord(activity.traceMoeResult || activity.match?.traceMoe);
  const imageUrl = firstPresent(
    traceMoe.imageUrl,
    nestedMatchTrace.imageUrl,
    activity.traceMoeImageUrl,
    isTraceMoeMediaUrl(activity.imageUrl) ? activity.imageUrl : null,
    isTraceMoeMediaUrl(activity.resultImageUrl) ? activity.resultImageUrl : null,
    isTraceMoeMediaUrl(media.resultImageUrl) ? media.resultImageUrl : null,
    isTraceMoeMediaUrl(botResponse.imageUrl) ? botResponse.imageUrl : null
  );
  const videoUrl = firstPresent(
    traceMoe.videoUrl,
    nestedMatchTrace.videoUrl,
    activity.traceMoeVideoUrl,
    isTraceMoeMediaUrl(activity.videoUrl) ? activity.videoUrl : null,
    isTraceMoeMediaUrl(activity.resultVideoUrl) ? activity.resultVideoUrl : null,
    isTraceMoeMediaUrl(media.resultVideoUrl) ? media.resultVideoUrl : null,
    isTraceMoeMediaUrl(botResponse.videoUrl) ? botResponse.videoUrl : null
  );

  return {
    imageUrl: imageUrl || null,
    videoUrl: videoUrl || null,
    raw: traceMoe.raw || nestedMatchTrace.raw || activity.traceMoeRaw || null
  };
}

export function normalizeActivityMedia(activity = {}, input = normalizeActivityInput(activity)) {
  const media = asRecord(activity.media);
  const recordInput = asRecord(activity.input);
  const selectedTelegramFileId = firstPresent(media.selectedTelegramFileId, activity.selectedTelegramFileId, recordInput.selectedTelegramFileId);
  const selectedTelegramFileUrl = firstPresent(media.selectedTelegramFileUrl, activity.selectedTelegramFileUrl, recordInput.selectedTelegramFileUrl);
  const inputTelegramFileId = firstPresent(media.inputTelegramFileId, input.telegramFileId, activity.inputTelegramFileId, activity.inputFileId);
  const inputTelegramFileUrl = firstPresent(media.inputTelegramFileUrl, input.telegramFileUrl, activity.inputTelegramFileUrl);
  const sentPhotoFileId = firstPresent(media.sentPhotoFileId, activity.sentPhotoFileId);
  const sentVideoFileId = firstPresent(media.sentVideoFileId, activity.sentVideoFileId);
  const sentAnimationFileId = firstPresent(media.sentAnimationFileId, activity.sentAnimationFileId);
  const dashboardImageFileId = firstPresent(
    media.dashboardImageFileId,
    selectedTelegramFileId,
    inputTelegramFileId,
    sentPhotoFileId
  );
  const dashboardImageUrl = firstPermanentUrl({ hasFileId: Boolean(dashboardImageFileId) },
    media.dashboardImageUrl,
    media.botImageUrl,
    selectedTelegramFileUrl,
    inputTelegramFileUrl,
    input.preview,
    input.thumbnail,
    input.selectedImageUrl
  );
  const dashboardVideoFileId = firstPresent(media.dashboardVideoFileId, sentVideoFileId, sentAnimationFileId);
  const dashboardVideoUrl = firstPermanentUrl({ hasFileId: Boolean(dashboardVideoFileId) },
    media.dashboardVideoUrl,
    media.botVideoUrl
  );

  return {
    inputTelegramFileId: inputTelegramFileId || null,
    inputTelegramFileUrl: inputTelegramFileId ? null : inputTelegramFileUrl || null,
    selectedTelegramFileId: selectedTelegramFileId || null,
    selectedTelegramFileUrl: selectedTelegramFileId ? null : selectedTelegramFileUrl || null,
    sentPhotoFileId: sentPhotoFileId || null,
    sentVideoFileId: sentVideoFileId || null,
    sentAnimationFileId: sentAnimationFileId || null,
    dashboardImageFileId: dashboardImageFileId || null,
    dashboardImageUrl: dashboardImageUrl || null,
    dashboardVideoFileId: dashboardVideoFileId || null,
    dashboardVideoUrl: dashboardVideoUrl || null
  };
}

export function normalizeActivityForStorage(activity = {}, { id = null, timestamp = null } = {}) {
  const input = normalizeActivityInput(activity);
  const result = normalizeActivityResult(activity);
  const media = normalizeActivityMedia(activity, input);
  const traceMoe = normalizeTraceMoe(activity);
  const status = activity.status === "error" ? "failed" : activity.status || "success";
  const createdAt = activity.createdAt || timestamp || null;
  const updatedAt = activity.updatedAt || timestamp || null;

  return {
    id: firstPresent(activity.id, id),
    userId: activity.userId ? String(activity.userId) : input.telegramId || null,
    user: activity.user || null,
    input,
    result,
    media,
    traceMoe,
    botResponse: activity.botResponse || null,
    status,
    error: activity.error || null,
    rejectionReason: activity.rejectionReason || null,
    createdAt,
    updatedAt,

    source: input.source,
    sourceType: input.sourceType,
    inputType: input.type,
    inputUrl: input.url,
    inputSourceDomain: input.domain,
    extractedImageUrl: input.extractedImageUrl,
    selectedImageUrl: input.selectedImageUrl,
    bestImageUrl: input.bestImageUrl,
    telegramPreviewUsed: input.telegramPreviewUsed,
    previewExtractionMethod: activity.previewExtractionMethod || null,
    previewExtractionStatus: activity.previewExtractionStatus || null,
    previewExtractionError: activity.previewExtractionError || null,
    previewExtractionCandidateCount: activity.previewExtractionCandidateCount ?? input.imageCount ?? null,
    previewExtractionSelectedMimeType: activity.previewExtractionSelectedMimeType || null,
    providerDiagnostics: input.providerDiagnostics,
    provider: input.provider,
    imageCount: input.imageCount,
    filteredImageCount: input.filteredImageCount,
    previewFallbackUsed: activity.fallbackUsed || activity.previewFallbackUsed || null,
    inputFileId: input.telegramFileId,
    inputTelegramFileId: input.telegramFileId,
    inputTelegramFileUrl: input.telegramFileUrl,
    inputImageUrl: input.preview,
    inputThumbnail: input.thumbnail,
    inputPreview: input.preview,
    userInput: activity.userInput || null,
    animeTitle: result.animeTitle,
    anilistId: result.anilistId,
    anilistUrl: result.anilistUrl,
    episode: result.episode,
    from: result.from,
    to: result.to,
    formattedTime: result.formattedTime,
    similarity: result.similarity
  };
}
