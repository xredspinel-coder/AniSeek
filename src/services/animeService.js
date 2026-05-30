import { formatTimeRange } from "../utils/formatTime.js";

const TRACE_MOE_SEARCH_URL = "https://api.trace.moe/search";
const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
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

async function readJson(response, label) {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${label} failed with ${response.status}: ${detail.slice(0, 180)}`);
  }

  return response.json();
}

export async function fetchAniListAnime(anilistId) {
  if (!anilistId) {
    return {
      id: null,
      title: "Unknown anime",
      url: null
    };
  }

  const query = `
    query AniSeekAnime($id: Int!) {
      Media(id: $id, type: ANIME) {
        id
        siteUrl
        title {
          english
          romaji
          native
        }
      }
    }
  `;

  const response = await fetchWithTimeout(ANILIST_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      query,
      variables: {
        id: Number(anilistId)
      }
    })
  });
  const data = await readJson(response, "AniList request");
  const media = data.data?.Media;

  if (!media) {
    return {
      id: anilistId,
      title: `AniList #${anilistId}`,
      url: `https://anilist.co/anime/${anilistId}`
    };
  }

  return {
    id: media.id,
    title: media.title?.english || media.title?.romaji || media.title?.native || `AniList #${media.id}`,
    url: media.siteUrl || `https://anilist.co/anime/${media.id}`
  };
}

export async function searchAnimeScene(imageUrl) {
  const traceUrl = `${TRACE_MOE_SEARCH_URL}?url=${encodeURIComponent(imageUrl)}`;
  const response = await fetchWithTimeout(traceUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "AniSeekBot/1.0"
    }
  });
  const data = await readJson(response, "trace.moe request");
  const best = data.result?.[0];

  if (!best) {
    throw new Error("trace.moe did not return a match for this image.");
  }

  const rawAniList = best.anilist;
  const anilistId = typeof rawAniList === "object" ? rawAniList?.id : rawAniList;
  const anime = await fetchAniListAnime(anilistId);
  const similarity = Math.round((Number(best.similarity) || 0) * 1000) / 10;

  return {
    animeTitle: anime.title,
    anilistId: anime.id || anilistId || null,
    anilistUrl: anime.url || (anilistId ? `https://anilist.co/anime/${anilistId}` : null),
    episode: best.episode ?? null,
    from: best.from ?? null,
    to: best.to ?? null,
    formattedTime: Number.isFinite(best.from) && Number.isFinite(best.to)
      ? formatTimeRange(best.from, best.to)
      : null,
    similarity,
    videoUrl: best.video || null,
    imageUrl: best.image || null
  };
}
