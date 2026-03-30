import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js'
import {
  formatProgress,
  formatProgressBar,
  formatTime,
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
    new ButtonBuilder().setCustomId('queue').setLabel('Queue').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
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

export function buildQueueEmbed(queue: GuildQueue) {
  const upcoming = queue.songs.slice(0, 10)
  const embed = new EmbedBuilder()
    .setTitle('🎵 Playback Queue')
    .setFooter({ text: `Total in queue: ${queue.songs.length}` })

  if (upcoming.length > 0) {
    const now = upcoming[0]
    const artist = now.artist ? ` — ${now.artist}` : ''
    const duration = now.durationSec ? ` (${formatTime(now.durationSec)})` : ''
    const gap = upcoming.length > 1 ? '\n\u200B' : ''
    embed.addFields({ name: '▶️ Now playing', value: `${now.title}${artist}${duration}${gap}` })
  }

  if (upcoming.length > 1) {
    const nextLines = upcoming.slice(1).map((s, i) => {
      const artist = s.artist ? ` — ${s.artist}` : ''
      const duration = s.durationSec ? ` (${formatTime(s.durationSec)})` : ''
      return `${i + 1}) ${s.title}${artist}${duration}`
    })
    embed.addFields({ name: 'Up next', value: nextLines.join('\n') })
  }

  return embed
}
