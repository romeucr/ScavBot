import type { Guild } from 'discord.js'
import type { GuildQueue } from '../music/queue'
import { getInteractionVoiceChannelId, type InteractionMember } from './interactionMember'

export function ensureUserCanControlPlayback(
  member: InteractionMember,
  queue: GuildQueue | undefined,
  guild: Guild
): string | null {
  const voiceChannelId = getInteractionVoiceChannelId(member)
  if (!voiceChannelId) return 'Join a voice channel first!'
  if (!queue) return null

  const botVoiceId = guild.members.me?.voice.channelId
  if (botVoiceId && voiceChannelId !== botVoiceId) {
    return 'You must be in the same voice channel as the bot.'
  }

  return null
}
