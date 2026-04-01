import type { GuildMember, APIInteractionGuildMember, VoiceBasedChannel } from 'discord.js'

export type InteractionMember = GuildMember | APIInteractionGuildMember | null

export function getInteractionMemberId(member: InteractionMember): string | null {
  if (!member) return null
  if ('id' in member) return member.id
  if ('user' in member && member.user?.id) return member.user.id
  return null
}

export function getInteractionVoiceChannelId(member: InteractionMember): string | null {
  if (!member) return null
  return 'voice' in member ? member.voice.channelId : null
}

export function getInteractionVoiceChannel(member: InteractionMember): VoiceBasedChannel | null {
  if (!member) return null
  return 'voice' in member ? member.voice.channel : null
}
