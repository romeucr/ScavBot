import { entersState, joinVoiceChannel, VoiceConnectionStatus, getVoiceConnection, VoiceConnection } from '@discordjs/voice'
import type { VoiceBasedChannel } from 'discord.js'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function connectToChannel(channel: VoiceBasedChannel): Promise<VoiceConnection> {
  for (let i = 0; i < 4; i++) {
    const existing = getVoiceConnection(channel.guild.id)
    if (existing) existing.destroy()

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true
    })

    connection.on('error', err => {
      console.error('Erro na conexao de voz:', err)
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 25_000)
      return connection
    } catch (err) {
      console.warn('Tentativa de conexao de voz falhou:', err)
      connection.destroy()
      await wait(1200)
    }
  }

  throw new Error('Nao foi possivel conectar ao canal de voz (estado Ready nao atingido).')
}
