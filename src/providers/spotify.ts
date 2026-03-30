export interface SpotifyMeta {
  title: string
  artist?: string
  album?: string
  thumbnailUrl?: string
}

export interface SpotifyTrack {
  title: string
  artist?: string
  album?: string
  durationSec?: number
  url: string
}

function normalizeSpotifyUrl(input: string): string | null {
  if (/^spotify:track:/i.test(input)) {
    const id = input.split(':')[2]
    if (!id) return null
    return `https://open.spotify.com/track/${id}`
  }

  if (/^https?:\/\//i.test(input)) return input
  return null
}

export function isSpotifyUrl(input: string): boolean {
  return /open\.spotify\.com\/(track|album|playlist)\//i.test(input) || /^spotify:track:/i.test(input)
}

export function isSpotifyTrackUrl(input: string): boolean {
  return /open\.spotify\.com\/track\//i.test(input) || /^spotify:track:/i.test(input)
}

export async function fetchSpotifyOembed(input: string): Promise<SpotifyMeta> {
  const url = normalizeSpotifyUrl(input)
  if (!url) {
    throw new Error('Invalid Spotify URL.')
  }

  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`
  const res = await fetch(oembedUrl)
  if (!res.ok) {
    throw new Error(`Spotify oEmbed failed: ${res.status}`)
  }

  const data = (await res.json()) as {
    title?: string
    author_name?: string
    thumbnail_url?: string
  }

  return {
    title: data.title || url,
    artist: data.author_name || undefined,
    thumbnailUrl: data.thumbnail_url || undefined
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value
  }

  const safeClientId = clientId.trim().replace(/\r/g, '')
  const safeClientSecret = clientSecret.trim().replace(/\r/g, '')
  if (!safeClientId || !safeClientSecret) {
    throw new Error('Missing or invalid Spotify credentials.')
  }

  if (process.env.DEBUG === '1') {
    console.log(`Spotify client id length: ${safeClientId.length}`)
    console.log(`Spotify client secret length: ${safeClientSecret.length}`)
  }

  const auth = Buffer.from(`${safeClientId}:${safeClientSecret}`).toString('base64')
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  })

  if (!res.ok) {
    throw new Error(`Failed to get Spotify token: ${res.status}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in * 1000
  }

  return data.access_token
}

export async function searchSpotifyTracks(
  query: string,
  limit: number,
  clientId: string,
  clientSecret: string
): Promise<SpotifyTrack[]> {
  const token = await getAccessToken(clientId, clientSecret)
  const safeLimit = Math.max(1, Math.min(limit, 10))
  const params = new URLSearchParams({ q: query, type: 'track', limit: String(safeLimit) })

  const res = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (process.env.DEBUG === '1') {
      console.log(`Spotify search error body: ${body}`)
    }
    throw new Error(`Spotify search failed: ${res.status}`)
  }

  const data = (await res.json()) as any
  const items = data?.tracks?.items ?? []

  return items.map((t: any) => ({
    title: t?.name || 'Unknown',
    artist: t?.artists?.[0]?.name,
    album: t?.album?.name,
    durationSec: t?.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
    url: t?.external_urls?.spotify || t?.uri
  }))
}

export async function validateSpotifyCredentials(clientId: string, clientSecret: string): Promise<void> {
  await getAccessToken(clientId, clientSecret)
}
