import { spawn } from 'node:child_process'
import { StreamType } from '@discordjs/voice'
import { Readable } from 'node:stream'

export interface SoundcloudConfig {
  cookiesFile?: string
  userAgent?: string
  ytdlpPath?: string
  debugLog?: (message: string, ...args: unknown[]) => void
}

export interface SoundcloudInfo {
  title: string
  url: string
  durationSec?: number
  artist?: string
  album?: string
  thumbnailUrl?: string
}

export interface SoundcloudSearchItem {
  title: string
  url: string
  artist?: string
  durationSec?: number
}

interface StreamResult {
  stream: Readable
  type: StreamType
}

function runYtDlp(args: string[], config?: SoundcloudConfig): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const bin = config?.ytdlpPath || 'yt-dlp'
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''

    proc.stdout.on('data', chunk => {
      out += chunk.toString()
    })
    proc.stderr.on('data', chunk => {
      err += chunk.toString()
    })

    proc.once('error', reject)
    proc.once('close', code => {
      resolve({ stdout: out, stderr: err, code: code ?? 1 })
    })
  })
}

async function resolveSearchUrl(query: string, config: SoundcloudConfig): Promise<string> {
  const args = ['--print', 'webpage_url', '--flat-playlist', '--no-playlist']

  if (config.cookiesFile) {
    args.push('--cookies', config.cookiesFile)
  }
  if (config.userAgent) {
    args.push('--user-agent', config.userAgent)
  }

  args.push(`scsearch1:${query}`)

  const { stdout, stderr, code } = await runYtDlp(args, config)
  const firstLine = stdout.trim().split(/\r?\n/)[0]
  if (code === 0 && firstLine) return firstLine

  throw new Error(`yt-dlp search failed (exit ${code}): ${stderr.trim()}`)
}

export async function resolveSoundcloudUrl(input: string, config: SoundcloudConfig): Promise<string> {
  if (/^scsearch1:/i.test(input)) {
    const query = input.replace(/^scsearch1:/i, '').trim()
    if (!query) throw new Error('Empty query for SoundCloud search.')
    return resolveSearchUrl(query, config)
  }

  if (/^(sc|soundcloud):/i.test(input)) {
    const query = input.replace(/^(sc|soundcloud):/i, '').trim()
    if (!query) throw new Error('Empty query for SoundCloud search.')
    return resolveSearchUrl(query, config)
  }

  if (!/^https?:\/\//i.test(input)) {
    const query = input.trim()
    if (!query) throw new Error('Empty query for SoundCloud search.')
    return resolveSearchUrl(query, config)
  }

  return input
}

export async function fetchSoundcloudInfo(input: string, config: SoundcloudConfig): Promise<SoundcloudInfo> {
  const resolvedUrl = await resolveSoundcloudUrl(input, config)

  const args = [
    '--print',
    '%(title)s|%(duration)s|%(uploader)s|%(artist)s|%(album)s|%(thumbnail)s',
    '--no-playlist'
  ]

  if (config.cookiesFile) {
    args.push('--cookies', config.cookiesFile)
  }
  if (config.userAgent) {
    args.push('--user-agent', config.userAgent)
  }

  args.push(resolvedUrl)

  const { stdout } = await runYtDlp(args, config)
  const line = stdout.trim().split(/\r?\n/)[0]
  if (!line) {
    return { title: resolvedUrl, url: resolvedUrl }
  }

  const [title, durationRaw, uploader, artist, album, thumbnail] = line.split('|')
  const durationSec = durationRaw && durationRaw !== 'NA' ? Number(durationRaw) : undefined
  const artistName = (artist || uploader || '').trim()
  const albumName = (album || '').trim()
  const thumb = (thumbnail || '').trim()

  return {
    title: title || resolvedUrl,
    url: resolvedUrl,
    durationSec: Number.isFinite(durationSec) ? durationSec : undefined
    ,
    artist: artistName || undefined,
    album: albumName || undefined,
    thumbnailUrl: thumb || undefined
  }
}

export async function searchSoundcloud(query: string, config: SoundcloudConfig, limit = 5): Promise<SoundcloudSearchItem[]> {
  const safeLimit = Math.max(1, Math.min(limit, 10))
  const args = [
    '--flat-playlist',
    '--print',
    '%(title)s|%(uploader)s|%(webpage_url)s|%(duration)s'
  ]

  if (config.cookiesFile) {
    args.push('--cookies', config.cookiesFile)
  }
  if (config.userAgent) {
    args.push('--user-agent', config.userAgent)
  }

  args.push(`scsearch${safeLimit}:${query}`)

  const { stdout } = await runYtDlp(args, config)
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)

  return lines.map(line => {
    const [title, uploader, url, durationRaw] = line.split('|')
    const durationSec = durationRaw && durationRaw !== 'NA' ? Number(durationRaw) : undefined
    return {
      title: title || url,
      url,
      artist: (uploader || '').trim() || undefined,
      durationSec: Number.isFinite(durationSec) ? durationSec : undefined
    }
  })
}

export function streamSoundcloud(url: string, config: SoundcloudConfig): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-f',
      'bestaudio',
      '-o',
      '-',
      '--no-playlist',
      '--no-progress'
    ]

    if (config.userAgent) {
      args.push('--user-agent', config.userAgent)
    }
    if (config.cookiesFile) {
      args.push('--cookies', config.cookiesFile)
    }

    args.push(url)

    const bin = config.ytdlpPath || 'yt-dlp'
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      if (text.trim()) {
        config.debugLog?.(`yt-dlp stderr: ${text.trim()}`)
      }
    })

    const ffmpeg = spawn(
      'ffmpeg',
      ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )

    let ffmpegErr = ''
    ffmpeg.stderr.on('data', chunk => {
      ffmpegErr += chunk.toString()
    })

    proc.once('error', reject)
    ffmpeg.once('error', reject)

    proc.stdout.pipe(ffmpeg.stdin)

    ffmpeg.stdin.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
      reject(err)
    })

    proc.stdout.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') return
      reject(err)
    })

    ffmpeg.stdout.once('data', () => {
      resolve({ stream: ffmpeg.stdout as Readable, type: StreamType.Raw })
    })

    proc.once('close', code => {
      if (code !== 0 && !stderr.includes('has already been downloaded')) {
        reject(new Error(`yt-dlp failed (exit ${code}): ${stderr.trim()}`))
      }
    })

    ffmpeg.once('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed (exit ${code}): ${ffmpegErr.trim()}`))
      }
    })
  })
}
