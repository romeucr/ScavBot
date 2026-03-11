import { Readable } from 'node:stream'
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, entersState } from '@discordjs/voice'
import { PermissionsBitField } from 'discord.js'
import type { VoiceBasedChannel, GuildMember } from 'discord.js'
import { connectToChannel } from '../voice/connect'

function createSineWaveStream(durationSec = 5, freq = 440, volume = 0.2) {
  const sampleRate = 48000
  const totalSamples = Math.floor(sampleRate * durationSec)
  let currentSample = 0

  return new Readable({
    read() {
      if (currentSample >= totalSamples) {
        this.push(null)
        return
      }

      const frameSamples = Math.min(960, totalSamples - currentSample)
      const buffer = Buffer.alloc(frameSamples * 4)

      for (let i = 0; i < frameSamples; i++) {
        const t = (currentSample + i) / sampleRate
        const sampleValue = Math.round(Math.sin(2 * Math.PI * freq * t) * volume * 32767)
        const offset = i * 4
        buffer.writeInt16LE(sampleValue, offset)
        buffer.writeInt16LE(sampleValue, offset + 2)
      }

      currentSample += frameSamples
      this.push(buffer)
    }
  })
}

export async function playTestTone(channel: VoiceBasedChannel, member: GuildMember): Promise<void> {
  const perms = channel.permissionsFor(member)
  const missing: string[] = []

  if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('ViewChannel')
  if (!perms?.has(PermissionsBitField.Flags.Connect)) missing.push('Connect')
  if (!perms?.has(PermissionsBitField.Flags.Speak)) missing.push('Speak')

  if (missing.length) {
    throw new Error(`Faltam permissoes no canal de voz: ${missing.join(', ')}`)
  }

  const connection = await connectToChannel(channel)
  const player = createAudioPlayer()

  player.on('error', err => {
    console.error('Player error:', err)
  })

  const resource = createAudioResource(createSineWaveStream(5, 440, 0.2), {
    inputType: StreamType.Raw
  })

  connection.subscribe(player)
  player.play(resource)
  await entersState(player, AudioPlayerStatus.Playing, 5_000)

  player.once(AudioPlayerStatus.Idle, () => {
    connection.destroy()
  })
}
