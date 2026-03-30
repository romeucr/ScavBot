import type { GuildMember, Guild } from 'discord.js'
import type { GuildQueue } from '../music/queue'

export function ensureUserCanControlPlayback(
  member: GuildMember | null,
  queue: GuildQueue | undefined,
  guild: Guild
): string | null {
  if (!member) return 'Could not resolve your member context.'
  const userVoice = member.voice.channel
  if (!userVoice) return 'Join a voice channel first!'
  if (!queue) return null

  const botVoiceId = guild.members.me?.voice.channelId
  if (botVoiceId && userVoice.id !== botVoiceId) {
    return 'You must be in the same voice channel as the bot.'
  }

  return null
}
