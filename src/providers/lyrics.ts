export type LyricsResult = {
  source: 'lrclib' | 'lyrics.ovh'
  title?: string
  artist?: string
  lyrics: string
  url?: string
}

export async function fetchLyrics(title: string, artist?: string): Promise<LyricsResult | null> {
  const lrclib = await fetchFromLrclib(title, artist)
  if (lrclib) return lrclib
  return fetchFromLyricsOvh(title, artist)
}

async function fetchFromLrclib(title: string, artist?: string): Promise<LyricsResult | null> {
  const params = new URLSearchParams({ track_name: title })
  if (artist) params.set('artist_name', artist)

  const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`)
  if (!res.ok) return null
  const data = await res.json() as any
  const lyrics = (data?.lyrics || data?.plain_lyrics || '').trim()
  if (!lyrics) return null

  return {
    source: 'lrclib',
    title: data?.track_name || title,
    artist: data?.artist_name || artist,
    lyrics,
    url: data?.track_url || undefined
  }
}

async function fetchFromLyricsOvh(title: string, artist?: string): Promise<LyricsResult | null> {
  if (!artist) return null
  const encodedArtist = encodeURIComponent(artist)
  const encodedTitle = encodeURIComponent(title)
  const res = await fetch(`https://api.lyrics.ovh/v1/${encodedArtist}/${encodedTitle}`)
  if (!res.ok) return null
  const data = await res.json() as any
  const lyrics = (data?.lyrics || '').trim()
  if (!lyrics) return null
  return {
    source: 'lyrics.ovh',
    title,
    artist,
    lyrics
  }
}
