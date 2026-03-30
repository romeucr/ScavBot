import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js'
import {
  formatProgress,
  formatProgressBar,
  getProgress,
  type GuildQueue,
  type Song
} from '../../music/queue'

export function buildControlsRows(queue?: GuildQueue, disabled = false) {
  const isPaused = queue?.player.state.status === 'paused'
  const loopLabel = queue?.loop === 'one' ? 'Loop: 1' : queue?.loop === 'all' ? 'Loop: Queue' : 'Loop: Off'
  const volumeLabel = `Vol: ${queue?.volume ?? 100}%`

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(isPaused ? 'resume' : 'pause').setLabel(isPaused ? 'Resume' : 'Pause').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('loop').setLabel(loopLabel).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('status').setLabel('Status').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
  )

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('vol_down').setLabel('Vol -').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('vol_up').setLabel('Vol +').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('vol_level').setLabel(volumeLabel).setStyle(ButtonStyle.Secondary).setDisabled(true)
  )

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('lyrics').setLabel('Lyrics').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
  )

  return [row1, row2, row3]
}

export function buildNowPlayingEmbed(queue: GuildQueue, song: Song) {
  const { elapsedSec, durationSec } = getProgress(queue)
  const bar = formatProgressBar(elapsedSec, durationSec)
  const time = formatProgress(elapsedSec, durationSec)

  const embed = new EmbedBuilder()
    .setTitle(`🎵 Now playing: ${song.title}`)
    .setColor(0xff5500)
    .addFields(
      { name: 'Artist', value: song.artist || 'Unknown', inline: true },
      { name: 'Album', value: song.album || 'Unknown', inline: true },
      { name: 'Progress', value: `${bar} \`${time}\`` }
    )

  if (song.thumbnailUrl) {
    embed.setThumbnail(song.thumbnailUrl)
  }

  return embed
}

export function formatStatus(queue: GuildQueue): string {
  const current = queue.current
  if (!current) return 'Nothing playing.'

  const { elapsedSec, durationSec } = getProgress(queue)
  const bar = formatProgressBar(elapsedSec, durationSec)
  const time = formatProgress(elapsedSec, durationSec)

  return [
    `Now playing: **${current.title}**`,
    `Artist: ${current.artist || 'Unknown'}`,
    `Album: ${current.album || 'Unknown'}`,
    `${bar} \`${time}\``,
    `Volume: ${queue.volume}% | Loop: ${queue.loop}`,
    `In queue: ${Math.max(0, queue.songs.length - 1)}`
  ].join('\n')
}
