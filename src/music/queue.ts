import { createAudioPlayer, createAudioResource, AudioPlayerStatus, type AudioResource } from '@discordjs/voice'
import type { GuildTextBasedChannel } from 'discord.js'
import type { VoiceConnection } from '@discordjs/voice'
import { streamSoundcloud, resolveSoundcloudUrl, type SoundcloudConfig } from '../providers/soundcloud'

export type SongSource = 'soundcloud'
export type LoopMode = 'off' | 'one' | 'all'

export interface Song {
  title: string
  url: string
  source: SongSource
  durationSec?: number
  artist?: string
  album?: string
  thumbnailUrl?: string
}

export interface GuildQueue {
  textChannel: GuildTextBasedChannel
  connection: VoiceConnection
  player: ReturnType<typeof createAudioPlayer>
  songs: Song[]
  loop: LoopMode
  volume: number
  current?: Song
  currentResource?: AudioResource
  startedAt?: number
  pausedAt?: number
  nowPlayingMessageId?: string
  nowPlayingUpdating?: boolean
  lastProgressSec?: number
  nowPlayingToken?: number
  idleTimeoutMs?: number
  idleTimer?: NodeJS.Timeout
}

const queues = new Map<string, GuildQueue>()

export function getQueue(guildId: string): GuildQueue | undefined {
  return queues.get(guildId)
}

export function setQueue(guildId: string, queue: GuildQueue): void {
  queues.set(guildId, queue)
}

export function deleteQueue(guildId: string): void {
  queues.delete(guildId)
}

function applyVolume(queue: GuildQueue): void {
  if (!queue.currentResource?.volume) return
  const vol = Math.max(0, Math.min(queue.volume, 200)) / 100
  queue.currentResource.volume.setVolume(vol)
}

export async function playNext(
  guildId: string,
  scConfig: SoundcloudConfig,
  sendNowPlaying?: (queue: GuildQueue, song: Song) => Promise<void>
): Promise<void> {
  const serverQueue = queues.get(guildId)
  if (!serverQueue) return

  if (serverQueue.songs.length === 0) {
    serverQueue.current = undefined
    serverQueue.currentResource = undefined
    serverQueue.startedAt = undefined
    serverQueue.pausedAt = undefined
    serverQueue.lastProgressSec = undefined
    if (serverQueue.idleTimeoutMs && serverQueue.idleTimeoutMs > 0) {
      if (serverQueue.idleTimer) clearTimeout(serverQueue.idleTimer)
      serverQueue.idleTimer = setTimeout(() => {
        serverQueue.connection.destroy()
        queues.delete(guildId)
      }, serverQueue.idleTimeoutMs)
    } else {
      serverQueue.connection.destroy()
      queues.delete(guildId)
    }
    return
  }

  const song = serverQueue.songs[0]

  try {
    if (!song?.url) {
      throw new Error('URL da musica invalida ou ausente.')
    }

    let streamResult
    if (song.source === 'soundcloud') {
      const resolvedUrl = await resolveSoundcloudUrl(song.url, scConfig)
      streamResult = await streamSoundcloud(resolvedUrl, scConfig)
    } else {
      throw new Error('Fonte nao suportada.')
    }

    const resource = createAudioResource(streamResult.stream, {
      inputType: streamResult.type,
      inlineVolume: true
    })

    serverQueue.current = song
    serverQueue.currentResource = resource
    serverQueue.startedAt = Date.now()
    serverQueue.pausedAt = undefined
    serverQueue.lastProgressSec = undefined
    serverQueue.nowPlayingToken = (serverQueue.nowPlayingToken ?? 0) + 1
    if (serverQueue.idleTimer) {
      clearTimeout(serverQueue.idleTimer)
      serverQueue.idleTimer = undefined
    }

    applyVolume(serverQueue)

    serverQueue.player.play(resource)
    serverQueue.connection.subscribe(serverQueue.player)

    serverQueue.player.once(AudioPlayerStatus.Idle, () => {
      if (serverQueue.loop === 'one') {
        void playNext(guildId, scConfig, sendNowPlaying)
        return
      }

      const finished = serverQueue.songs.shift()
      if (serverQueue.loop === 'all' && finished) {
        serverQueue.songs.push(finished)
      }

      void playNext(guildId, scConfig, sendNowPlaying)
    })

    if (sendNowPlaying) {
      await sendNowPlaying(serverQueue, song)
    } else {
      await serverQueue.textChannel.send(`🎵 Tocando agora: **${song.title}**`)
    }
  } catch (err) {
    console.error('Erro ao tocar musica:', err)
    serverQueue.songs.shift()
    void playNext(guildId, scConfig, sendNowPlaying)
  }
}

export function createQueue(textChannel: GuildTextBasedChannel, connection: VoiceConnection): GuildQueue {
  const player = createAudioPlayer()
  player.on('error', err => {
    console.error('Player error:', err)
  })

  return { textChannel, connection, player, songs: [], loop: 'off', volume: 100 }
}

export function setVolume(queue: GuildQueue, volume: number): void {
  queue.volume = Math.max(0, Math.min(volume, 200))
  applyVolume(queue)
}

export function pause(queue: GuildQueue): void {
  if (queue.player.pause()) {
    queue.pausedAt = Date.now()
  }
}

export function resume(queue: GuildQueue): void {
  if (queue.player.unpause()) {
    if (queue.pausedAt && queue.startedAt) {
      const delta = Date.now() - queue.pausedAt
      queue.startedAt += delta
    }
    queue.pausedAt = undefined
  }
}

export function setLoop(queue: GuildQueue, mode: LoopMode): void {
  queue.loop = mode
}

export function getProgress(queue: GuildQueue): { elapsedSec: number; durationSec?: number } {
  if (!queue.startedAt) return { elapsedSec: 0, durationSec: queue.current?.durationSec }
  const now = queue.pausedAt ?? Date.now()
  const elapsedSec = Math.max(0, Math.floor((now - queue.startedAt) / 1000))
  return { elapsedSec, durationSec: queue.current?.durationSec }
}

export function formatProgress(elapsedSec: number, durationSec?: number): string {
  if (!durationSec || durationSec <= 0) return `${formatTime(elapsedSec)} / ??`
  return `${formatTime(elapsedSec)} / ${formatTime(durationSec)}`
}

export function formatProgressBar(elapsedSec: number, durationSec?: number, size = 15): string {
  if (!durationSec || durationSec <= 0) return '⬜'.repeat(size)
  const ratio = Math.min(1, Math.max(0, elapsedSec / durationSec))
  const filled = Math.round(ratio * size)
  return '🟩'.repeat(filled) + '⬜'.repeat(size - filled)
}

export function formatTime(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
