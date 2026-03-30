import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  getVoiceConnection,
  VoiceConnection
} from '@discordjs/voice'
import type { VoiceBasedChannel } from 'discord.js'
import { logger } from '../utils/logger'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function voiceCtx(channelOrGuildId: VoiceBasedChannel | string, channelId?: string): string {
  if (typeof channelOrGuildId === 'string') {
    return [`guildId=${channelOrGuildId}`, channelId ? `channelId=${channelId}` : ''].filter(Boolean).join(' ')
  }
  return `guildId=${channelOrGuildId.guild.id} channelId=${channelOrGuildId.id}`
}

export function bindVoiceConnectionResilience(
  connection: VoiceConnection,
  onConnectionLost?: () => void
): void {
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ])
    } catch (err) {
      logger.warn(
        `Voice disconnected and reconnection failed ${voiceCtx(connection.joinConfig.guildId, connection.joinConfig.channelId ?? undefined)}`,
        err
      )
      connection.destroy()
      onConnectionLost?.()
    }
  })

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    logger.warn(`Voice connection destroyed ${voiceCtx(connection.joinConfig.guildId, connection.joinConfig.channelId ?? undefined)}`)
    onConnectionLost?.()
  })
}

export async function connectToChannel(channel: VoiceBasedChannel, onConnectionLost?: () => void): Promise<VoiceConnection> {
  logger.info(`Connecting to voice channel ${voiceCtx(channel)}`)
  for (let i = 0; i < 4; i++) {
    const existing = getVoiceConnection(channel.guild.id)
    if (existing) {
      logger.info(`Destroying existing voice connection before reconnect ${voiceCtx(channel)}`)
      existing.destroy()
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true
    })

    connection.on('error', err => {
      logger.error(`Voice connection error ${voiceCtx(channel)}`, err)
    })
    bindVoiceConnectionResilience(connection, onConnectionLost)

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 25_000)
      logger.info(`Voice connection ready ${voiceCtx(channel)}`)
      return connection
    } catch (err) {
      logger.warn(`Voice connection attempt failed ${voiceCtx(channel)} attempt=${i + 1}/4`, err)
      connection.destroy()
      await wait(1200)
    }
  }

  throw new Error('Could not connect to the voice channel (Ready state not reached).')
}
