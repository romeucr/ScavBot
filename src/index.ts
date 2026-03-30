import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type VoiceBasedChannel,
  type ButtonInteraction,
  MessageFlags,
  type GuildMember
} from 'discord.js'
import { setDefaultResultOrder } from 'node:dns'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, StreamType } from '@discordjs/voice'
import { loadDotEnvFile, getEnv } from './utils/env'
import { makeDebugLogger, logger } from './utils/logger'
import { connectToChannel } from './voice/connect'
import {
  createQueue,
  setQueue,
  getQueue,
  deleteQueue,
  playNext,
  setVolume,
  pause,
  resume,
  setLoop,
  getProgress,
  formatProgress,
  formatTime,
  type Song,
  type LoopMode
} from './music/queue'
import { playTestTone } from './music/testTone'
import { fetchSoundcloudInfo, searchSoundcloud } from './providers/soundcloud'
import { fetchSpotifyOembed, isSpotifyUrl, isSpotifyTrackUrl, searchSpotifyTracks, validateSpotifyCredentials } from './providers/spotify'
import { fetchLyrics } from './providers/lyrics'
import { rollLoadout, type AbiLoadout } from './abi/randomizer'
import { buildControlsRows, buildNowPlayingEmbed, formatStatus } from './discord/ui/playerUi'
import { ensureUserCanControlPlayback } from './discord/voiceGuard'
import { getAbiSession, setAbiSession } from './features/abi/session'

loadDotEnvFile()
setDefaultResultOrder('ipv4first')

const DEBUG_ENABLED = getEnv('DEBUG') === '1'
const debugLog = makeDebugLogger(DEBUG_ENABLED)

const token = getEnv('DISCORD_TOKEN')
if (!token) {
  throw new Error('DISCORD_TOKEN environment variable not set.')
}

const scConfig = {
  cookiesFile: getEnv('YTDLP_COOKIES_FILE'),
  userAgent: getEnv('YTDLP_USER_AGENT'),
  ytdlpPath: getEnv('YTDLP_BIN'),
  debugLog
}

const idleMinutes = Number(getEnv('IDLE_DISCONNECT_MINUTES') || '15')
const idleTimeoutMs = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60 * 1000 : 0
const spotifyEnabled = (getEnv('ENABLE_SPOTIFY') || 'false').toLowerCase() === 'true'
const autocompleteMinChars = Math.max(1, Number(getEnv('AUTOCOMPLETE_MIN_CHARS') || '2'))
const autocompleteLimit = Math.max(1, Math.min(10, Number(getEnv('AUTOCOMPLETE_LIMIT') || '10')))
const playQueryMaxLength = Math.max(20, Number(getEnv('PLAY_QUERY_MAX_LENGTH') || '180'))
const nowPlayingUpdateIntervalMs = Math.max(3_000, Number(getEnv('NOW_PLAYING_UPDATE_MS') || '5_000'))
const abiForChannelCooldownMs = Math.max(5_000, Number(getEnv('ABI_FORCHANNEL_COOLDOWN_MS') || '30_000'))
const welcomeCooldownSec = Number(getEnv('WELCOME_COOLDOWN_SEC') || '10')
const welcomeCooldownMs = Number.isFinite(welcomeCooldownSec) && welcomeCooldownSec > 0 ? welcomeCooldownSec * 1000 : 0
const welcomeMp3Dir = getEnv('WELCOME_MP3_DIR') || path.resolve(process.cwd(), 'src', 'music', 'mp3')
const welcomeEnabled = (getEnv('WELCOME_ENABLED') || 'true').toLowerCase() === 'true'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
})

type SearchSession = {
  id: string
  userId: string
  guildId: string
  items: { title: string; url: string; artist?: string; durationSec?: number }[]
  createdAt: number
}

const searchSessions = new Map<string, SearchSession>()
const SEARCH_TTL_MS = 2 * 60 * 1000

type AutocompleteItem = { title: string; url: string; artist?: string; album?: string; durationSec?: number }
type AutocompleteSession = {
  id: string
  userId: string
  guildId: string
  items: AutocompleteItem[]
  createdAt: number
}

const autocompleteSessions = new Map<string, AutocompleteSession>()
const autocompleteCache = new Map<string, { items: AutocompleteItem[]; at: number }>()
const autocompleteInflight = new Map<string, Promise<AutocompleteItem[]>>()
const AUTOCOMPLETE_CACHE_MS = 30_000
const AUTOCOMPLETE_TTL_MS = 60 * 1000

const lastWelcomeAt = new Map<string, number>()
const abiForChannelLastRun = new Map<string, number>()

function createSearchSession(userId: string, guildId: string, items: SearchSession['items']): SearchSession {
  const id = crypto.randomUUID()
  const session: SearchSession = { id, userId, guildId, items, createdAt: Date.now() }
  searchSessions.set(id, session)
  setTimeout(() => searchSessions.delete(id), SEARCH_TTL_MS)
  return session
}

function getSearchSession(id: string): SearchSession | undefined {
  const session = searchSessions.get(id)
  if (!session) return undefined
  if (Date.now() - session.createdAt > SEARCH_TTL_MS) {
    searchSessions.delete(id)
    return undefined
  }
  return session
}

function createAutocompleteSession(userId: string, guildId: string, items: AutocompleteItem[]): AutocompleteSession {
  const id = crypto.randomUUID()
  const session: AutocompleteSession = { id, userId, guildId, items, createdAt: Date.now() }
  autocompleteSessions.set(id, session)
  setTimeout(() => autocompleteSessions.delete(id), AUTOCOMPLETE_TTL_MS)
  return session
}

function buildAutocompleteChoices(items: AutocompleteItem[], sessionId: string) {
  return items.map((item, idx) => {
    const duration = item.durationSec ? ` - ${formatProgress(0, item.durationSec).split('/')[1].trim()}` : ''
    const artist = item.artist ? `${item.artist} - ` : ''
    const name = `${artist}${item.title}${duration}`.slice(0, 100)
    return { name, value: `scid:${sessionId}:${idx}` }
  })
}

client.once('clientReady', () => {
  console.log('Bot online')
  console.log('Tip: set DEBUG=1 in .env for detailed logs.')

  const guildId = getEnv('GUILD_ID')
  const clearGuild = getEnv('CLEAR_GUILD_COMMANDS') === '1'

  if (guildId && clearGuild) {
    client.guilds.fetch(guildId).then(guild => guild.commands.set([])).then(() => {
      console.log('Comandos do guild limpos. Remova CLEAR_GUILD_COMMANDS do .env.')
    }).catch(err => {
      console.error('Failed to clear guild commands:', err)
    })
    return
  }

  const commandData = [
    {
      name: 'play',
      description: 'Play a track from SoundCloud',
      options: [
        {
          name: 'query',
          description: 'Track name or link',
          type: 3,
          required: true,
          autocomplete: true
        }
      ]
    },
    { name: 'pause', description: 'Pause playback' },
    { name: 'resume', description: 'Resume playback' },
    { name: 'skip', description: 'Skip current track' },
    { name: 'stop', description: 'Stop and clear the queue' },
    { name: 'leave', description: 'Leave the voice channel' },
    {
      name: 'volume',
      description: 'Set volume (0-200)',
      options: [
        { name: 'value', description: 'Volume from 0 to 200', type: 4, required: true }
      ]
    },
    {
      name: 'loop',
      description: 'Set loop mode',
      options: [
        { name: 'mode', description: 'off | one | all', type: 3, required: true,
          choices: [
            { name: 'off', value: 'off' },
            { name: 'one', value: 'one' },
            { name: 'all', value: 'all' }
          ]
        }
      ]
    },
    { name: 'status', description: 'Show playback status' },
    { name: 'queue', description: 'Show queue' },
    { name: 'test_sound', description: 'Audio test' },
    {
      name: 'abi_random',
      description: 'Generate a random ABI loadout',
      options: [
        { name: 'showimages', description: 'Show item images', type: 5, required: false },
        { name: 'forchannel', description: 'Generate for everyone in the voice channel', type: 5, required: false }
      ]
    }
  ]

  if (guildId) {
    client.guilds.fetch(guildId).then(guild => guild.commands.set(commandData)).catch(err => {
      console.error('Failed to register guild commands:', err)
    })
  } else if (client.application) {
    client.application.commands.set(commandData).catch(err => {
      console.error('Failed to register global commands:', err)
    })
  }

  const spotifyId = getEnv('SPOTIFY_CLIENT_ID')
  const spotifySecret = getEnv('SPOTIFY_CLIENT_SECRET')
  if (spotifyEnabled && spotifyId && spotifySecret) {
    validateSpotifyCredentials(spotifyId, spotifySecret)
      .then(() => console.log('Spotify auth OK'))
      .catch(err => console.error('Spotify auth falhou:', err))
  }
})

client.on('error', err => {
  console.error('Client error:', err)
})


function buildAbiEmbed(loadout: AbiLoadout, title?: string) {
  const fields = [
    { name: 'Map', value: loadout.map.name, inline: true },
    { name: 'Helmet', value: loadout.helmet.name, inline: true },
    { name: 'Headset', value: loadout.headset.name, inline: true },
    { name: 'Armor', value: loadout.armor.name, inline: true },
    { name: 'Weapon', value: loadout.weapon.name, inline: true }
  ]

  if (loadout.chestRig) {
    fields.splice(4, 0, { name: 'Chest Rig', value: loadout.chestRig.name, inline: true })
  }

  return new EmbedBuilder()
    .setTitle(title || 'Random build')
    .setColor(0xf1c40f)
    .addFields(fields)
}

function buildAbiEmbeds(loadout: AbiLoadout, showImages: boolean, title?: string) {
  const embeds: EmbedBuilder[] = []
  embeds.push(buildAbiEmbed(loadout, title))

  if (!showImages) return embeds

  const thumbColor = 0x1f2a44
  const addThumb = (label: string, item?: { name: string; imageUrl?: string }) => {
    if (!item?.imageUrl) return
    embeds.push(
      new EmbedBuilder()
        .setTitle(label)
        .setDescription(item.name)
        .setColor(thumbColor)
        .setThumbnail(item.imageUrl)
    )
  }

  addThumb('Helmet', loadout.helmet)
  addThumb('Headset', loadout.headset)
  addThumb('Armor', loadout.armor)
  if (loadout.chestRig) addThumb('Chest Rig', loadout.chestRig)
  addThumb('Weapon', loadout.weapon)

  return embeds
}

function buildAbiRows(userId: string, showImages = false) {
  const flag = showImages ? '1' : '0'
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`abi_reroll:${userId}:${flag}`)
      .setLabel('Reroll')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(false),
    new ButtonBuilder()
      .setCustomId(`abi_images:${userId}:1`)
      .setLabel('Mostrar imagens')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(showImages)
  )
  return [row]
}

async function sendNowPlaying(queue: NonNullable<ReturnType<typeof getQueue>>, song: Song) {
  if (queue.nowPlayingMessageId) {
    try {
      const prev = await queue.textChannel.messages.fetch(queue.nowPlayingMessageId)
      await prev.edit({ components: buildControlsRows(queue, true) })
    } catch (err) {
      logger.warn(`Failed to disable previous now-playing controls ${logContext({ messageId: queue.nowPlayingMessageId, channelId: queue.textChannel.id })}`, err)
    }
  }

  const embed = buildNowPlayingEmbed(queue, song)
  const message = await queue.textChannel.send({
    embeds: [embed],
    components: buildControlsRows(queue)
  })
  queue.nowPlayingMessageId = message.id
  const token = queue.nowPlayingToken ?? 0
  void updateNowPlayingLoop(queue, token, message.id)
}

async function disableNowPlaying(queue: NonNullable<ReturnType<typeof getQueue>>) {
  if (!queue.nowPlayingMessageId) return
  queue.nowPlayingToken = (queue.nowPlayingToken ?? 0) + 1
  queue.nowPlayingUpdating = false
  try {
    const msg = await queue.textChannel.messages.fetch(queue.nowPlayingMessageId)
    await msg.edit({ components: buildControlsRows(queue, true) })
  } catch (err) {
    logger.warn(`Failed to disable now-playing controls ${logContext({ messageId: queue.nowPlayingMessageId, channelId: queue.textChannel.id })}`, err)
  }
  queue.nowPlayingMessageId = undefined
}


async function updateNowPlayingLoop(queue: NonNullable<ReturnType<typeof getQueue>>, token: number, messageId: string) {
  while (queue.current && queue.nowPlayingMessageId) {
    if (queue.nowPlayingToken !== token || queue.nowPlayingMessageId !== messageId) {
      break
    }
    if (queue.nowPlayingUpdating) {
      await new Promise(resolve => setTimeout(resolve, nowPlayingUpdateIntervalMs))
      continue
    }

    try {
      const { elapsedSec } = getProgress(queue)
      if (queue.lastProgressSec === elapsedSec) {
        await new Promise(resolve => setTimeout(resolve, nowPlayingUpdateIntervalMs))
        continue
      }

      queue.nowPlayingUpdating = true
      const msg = await queue.textChannel.messages.fetch(messageId)
      const embed = buildNowPlayingEmbed(queue, queue.current)
      await msg.edit({ embeds: [embed], components: buildControlsRows(queue) })
      queue.lastProgressSec = elapsedSec
      queue.nowPlayingUpdating = false
    } catch (err) {
      logger.warn(
        `Now-playing update loop stopped due to message update failure ${logContext({ messageId, channelId: queue.textChannel.id })}`,
        err
      )
      queue.nowPlayingUpdating = false
      break
    }

    await new Promise(resolve => setTimeout(resolve, nowPlayingUpdateIntervalMs))
    if (!queue.current) break
  }
}

async function sendStatus(queue: NonNullable<ReturnType<typeof getQueue>>, interaction?: ButtonInteraction | any, channel?: any) {
  const content = formatStatus(queue)
  if (interaction) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    return
  }

  const msg = await channel.send(content)
  setTimeout(() => {
    msg.delete().catch((err: unknown) => {
      logger.warn(`Failed to delete temporary status message ${logContext({ channelId: channel?.id })}`, err)
    })
  }, 15000)
}

function resolveLoopMode(input?: string): LoopMode | undefined {
  if (!input) return undefined
  const value = input.toLowerCase()
  if (value === 'off') return 'off'
  if (value === 'one' || value === 'song') return 'one'
  if (value === 'all' || value === 'queue' || value === 'fila') return 'all'
  return undefined
}

function getVoiceGuardError(interaction: { member: GuildMember | null; guild: any }, queue?: ReturnType<typeof getQueue>): string | null {
  return ensureUserCanControlPlayback(interaction.member, queue, interaction.guild)
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isSupportedPlayUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    return host.includes('soundcloud.com') || host.includes('spotify.com')
  } catch (err) {
    logger.warn(`Failed to parse URL from /play query ${logContext({ query: value.slice(0, 60) })}`, err)
    return false
  }
}

async function clearQueueAndDisconnect(guildId: string, queue: NonNullable<ReturnType<typeof getQueue>>) {
  queue.songs = []
  queue.player.stop()
  queue.current = undefined
  queue.currentResource = undefined
  queue.startedAt = undefined
  queue.pausedAt = undefined
  queue.lastProgressSec = undefined
  await disableNowPlaying(queue)
  if (queue.idleTimer) {
    clearTimeout(queue.idleTimer)
    queue.idleTimer = undefined
  }
  queue.connection.destroy()
  deleteQueue(guildId)
}

function listWelcomeMp3s(): string[] {
  try {
    return fs.readdirSync(welcomeMp3Dir)
      .filter(file => file.toLowerCase().endsWith('.mp3'))
      .map(file => path.join(welcomeMp3Dir, file))
  } catch (err) {
    logger.warn(`Failed to list welcome MP3 files ${logContext({ directory: welcomeMp3Dir })}`, err)
    return []
  }
}

function pickRandom<T>(items: T[]): T | undefined {
  if (!items.length) return undefined
  const idx = Math.floor(Math.random() * items.length)
  return items[idx]
}

function logContext(ctx: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
}

async function playWelcomeSound(channel: VoiceBasedChannel, guildId: string): Promise<void> {
  if (getQueue(guildId)) return
  if (welcomeCooldownMs > 0) {
    const last = lastWelcomeAt.get(guildId) || 0
    if (Date.now() - last < welcomeCooldownMs) return
  }

  const files = listWelcomeMp3s()
  const file = pickRandom(files)
  if (!file) return

  lastWelcomeAt.set(guildId, Date.now())

  const connection = await connectToChannel(channel)
  const player = createAudioPlayer()
  const resource = createAudioResource(fs.createReadStream(file), { inputType: StreamType.Arbitrary })
  connection.subscribe(player)
  player.play(resource)

  try {
    await entersState(player, AudioPlayerStatus.Playing, 5_000)
    await entersState(player, AudioPlayerStatus.Idle, 60_000)
  } catch (err) {
    logger.warn(`Welcome sound playback did not complete as expected ${logContext({ guildId })}`, err)
  } finally {
    connection.destroy()
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return
  if (!interaction.guild) return

  const id = interaction.customId
  if (id.startsWith('abi_reroll:')) {
    const [, ownerId, flag] = id.split(':')
    if (ownerId && interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the requester can use this button.', flags: MessageFlags.Ephemeral })
      return
    }

    const previous = getAbiSession(interaction.guild.id, interaction.user.id)
    const label = previous?.label
    const loadout = rollLoadout()
    const showImages = flag === '1'
    setAbiSession(interaction.guild.id, interaction.user.id, { loadout, showImages, label, updatedAt: Date.now() })
    const title = label ? `Random build for ${label}` : undefined
    const embeds = buildAbiEmbeds(loadout, showImages, title)
    await interaction.update({ embeds, components: buildAbiRows(ownerId || interaction.user.id, showImages) })
    return
  }

  if (id.startsWith('abi_images:')) {
    const [, ownerId] = id.split(':')
    if (ownerId && interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the requester can use this button.', flags: MessageFlags.Ephemeral })
      return
    }

    const session = getAbiSession(interaction.guild.id, interaction.user.id)
    if (!session) {
      await interaction.reply({ content: 'Sessao expirada. Rode /abi_random novamente.', flags: MessageFlags.Ephemeral })
      return
    }
    session.showImages = true
    session.updatedAt = Date.now()
    setAbiSession(interaction.guild.id, interaction.user.id, session)
    const title = session.label ? `Random build for ${session.label}` : undefined
    const embeds = buildAbiEmbeds(session.loadout, true, title)
    await interaction.update({ embeds, components: buildAbiRows(ownerId || interaction.user.id, true) })
    return
  }

  const queue = getQueue(interaction.guild.id)
  if (!queue) {
    await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
    return
  }
  const guardError = getVoiceGuardError(interaction as any, queue)
  if (guardError) {
    await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
    return
  }

  try {
    if (id === 'pause') pause(queue)
    if (id === 'resume') resume(queue)
    if (id === 'skip') queue.player.stop()
    if (id === 'stop') {
      await clearQueueAndDisconnect(interaction.guild.id, queue)
    }
    if (id === 'loop') {
      const next = queue.loop === 'off' ? 'one' : queue.loop === 'one' ? 'all' : 'off'
      setLoop(queue, next)
    }
    if (id === 'vol_down') {
      setVolume(queue, queue.volume - 10)
      const rows = buildControlsRows(queue)
      await interaction.update({ components: rows })
      return
    }
    if (id === 'vol_up') {
      setVolume(queue, queue.volume + 10)
      const rows = buildControlsRows(queue)
      await interaction.update({ components: rows })
      return
    }
    if (id === 'status') {
      await sendStatus(queue, interaction)
      return
    }
    if (id === 'lyrics') {
      const current = queue.current
      if (!current) {
        await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      try {
        const result = await fetchLyrics(current.title, current.artist)
        if (!result) {
          await interaction.editReply({ content: 'No lyrics found for this track.' })
          return
        }

        const body = result.lyrics.trim().slice(0, 3900)
        const embed = new EmbedBuilder()
          .setTitle(`Lyrics — ${result.title || current.title}`)
          .setDescription(body || 'Lyrics not available.')
          .setFooter({ text: `Source: ${result.source}` })
        if (result.url) embed.setURL(result.url)

        await interaction.editReply({ embeds: [embed] })
      } catch (err) {
        logger.error(
          `Failed to fetch lyrics ${logContext({ guildId: interaction.guild.id, userId: interaction.user.id, customId: id })}`,
          err
        )
        await interaction.editReply({ content: 'Failed to fetch lyrics.' })
      }
      return
    }

    const rows = buildControlsRows(queue)
    await interaction.update({ components: rows })
    if (queue.nowPlayingMessageId && (id === 'pause' || id === 'resume' || id === 'loop')) {
      const token = queue.nowPlayingToken ?? 0
      void updateNowPlayingLoop(queue, token, queue.nowPlayingMessageId)
    }
  } catch (err) {
    logger.error(
      `Button interaction error ${logContext({ guildId: interaction.guild.id, userId: interaction.user.id, customId: id })}`,
      err
    )
    const msg = 'Failed to execute command.'
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral })
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })
    }
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isAutocomplete()) return
  if (!interaction.guild) return

  if (interaction.commandName !== 'play') return
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'query') return

  const query = String(focused.value || '').trim()
  if (!query || query.length < autocompleteMinChars) {
    await interaction.respond([])
    return
  }

  try {
    const spotifyId = getEnv('SPOTIFY_CLIENT_ID')
    const spotifySecret = getEnv('SPOTIFY_CLIENT_SECRET')
    const cacheKey = `${interaction.guild.id}:${interaction.user.id}:${query.toLowerCase()}`

    const cached = autocompleteCache.get(cacheKey)
    if (cached && Date.now() - cached.at < AUTOCOMPLETE_CACHE_MS) {
      const session = createAutocompleteSession(interaction.user.id, interaction.guild.id, cached.items)
      const choices = buildAutocompleteChoices(cached.items, session.id)
      try {
        await interaction.respond(choices)
      } catch (err) {
        logger.warn('Autocomplete cached response failed (likely expired interaction):', err)
      }
      return
    }

    let inflight = autocompleteInflight.get(cacheKey)
    if (!inflight) {
      inflight = (async () => {
        let items: AutocompleteItem[] = []
        if (spotifyEnabled && spotifyId && spotifySecret) {
          const results = await searchSpotifyTracks(query, autocompleteLimit, spotifyId, spotifySecret)
          items = results.map(r => ({
            title: r.title,
            url: r.url,
            artist: r.artist,
            album: r.album,
            durationSec: r.durationSec
          }))
        } else {
          items = await searchSoundcloud(query, scConfig, autocompleteLimit)
        }
        return items
      })()
      autocompleteInflight.set(cacheKey, inflight)
      inflight.then(items => {
        if (items.length) {
          autocompleteCache.set(cacheKey, { items, at: Date.now() })
        }
      }).catch(err => {
        logger.warn('Autocomplete inflight request failed:', err)
      }).finally(() => {
        autocompleteInflight.delete(cacheKey)
      })
    }

    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 1500))
    const result = await Promise.race([inflight, timeout])
    if (!result) {
      try {
        await interaction.respond([])
      } catch (err) {
        logger.warn('Autocomplete timeout response failed (likely expired interaction):', err)
      }
      return
    }
    const items = result

    if (!items.length) {
      try {
        await interaction.respond([])
      } catch (err) {
        logger.warn('Autocomplete empty response failed (likely expired interaction):', err)
      }
      return
    }

    const session = createAutocompleteSession(interaction.user.id, interaction.guild.id, items)
    const choices = buildAutocompleteChoices(items, session.id)

    try {
      await interaction.respond(choices)
    } catch (err) {
      logger.warn('Autocomplete response failed (likely expired interaction):', err)
    }
  } catch (err) {
    logger.error('Autocomplete error:', err)
    try {
      await interaction.respond([])
    } catch (responseErr) {
      logger.warn('Autocomplete fallback response failed (likely expired interaction):', responseErr)
    }
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  if (!interaction.guild) return
  const command = interaction.commandName

  if (command === 'play') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    const raw = interaction.options.getString('query', true)
    if (raw.length > playQueryMaxLength) {
      await interaction.editReply({ content: `Query too long. Max ${playQueryMaxLength} characters.` })
      return
    }
    if (isLikelyUrl(raw) && !isSupportedPlayUrl(raw)) {
      await interaction.editReply({ content: 'Only SoundCloud and Spotify links are supported.' })
      return
    }
    const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
    if (!voiceChannel) {
      await interaction.editReply({ content: 'Join a voice channel first!' })
      return
    }

    try {
      let info
      if (raw.startsWith('scid:')) {
        const [, id, idxRaw] = raw.split(':')
        const idx = Number(idxRaw)
        const session = autocompleteSessions.get(id)
        if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guild.id) {
          await interaction.editReply({ content: 'Selection expired. Try again.' })
          return
        }
        const item = session.items[idx]
        if (!item) {
          await interaction.editReply({ content: 'Invalid selection.' })
          return
        }
        const spotifyId = getEnv('SPOTIFY_CLIENT_ID')
        const spotifySecret = getEnv('SPOTIFY_CLIENT_SECRET')
        if (spotifyEnabled && spotifyId && spotifySecret && isSpotifyUrl(item.url)) {
          const query = `${item.title} ${item.artist || ''}`.trim()
          const results = await searchSoundcloud(query, scConfig, 5)
          if (!results.length) {
            await interaction.editReply({ content: 'Could not find this track on SoundCloud.' })
            return
          }
          info = await fetchSoundcloudInfo(results[0].url, scConfig)
          if (!info.album && item.album) {
            info = { ...info, album: item.album }
          }
        } else {
          info = await fetchSoundcloudInfo(item.url, scConfig)
          if (!info.album && item.album) {
            info = { ...info, album: item.album }
          }
        }
      } else if (isSpotifyUrl(raw)) {
        if (!isSpotifyTrackUrl(raw)) {
          await interaction.editReply({ content: 'Por enquanto, so aceito links de faixa do Spotify.' })
          return
        }

        const meta = await fetchSpotifyOembed(raw)
        const query = `${meta.title} ${meta.artist || ''}`.trim()
        const results = await searchSoundcloud(query, scConfig, 5)
        if (!results.length) {
          await interaction.editReply({ content: 'Could not find this track on SoundCloud.' })
          return
        }
        info = await fetchSoundcloudInfo(results[0].url, scConfig)
      } else {
        const spotifyId = getEnv('SPOTIFY_CLIENT_ID')
        const spotifySecret = getEnv('SPOTIFY_CLIENT_SECRET')
        if (spotifyEnabled && spotifyId && spotifySecret) {
          try {
            const results = await searchSpotifyTracks(raw, 1, spotifyId, spotifySecret)
            if (results.length) {
              const query = `${results[0].title} ${results[0].artist || ''}`.trim()
              const scResults = await searchSoundcloud(query, scConfig, 5)
              if (scResults.length) {
                info = await fetchSoundcloudInfo(scResults[0].url, scConfig)
                if (!info.album && results[0].album) {
                  info = { ...info, album: results[0].album }
                }
              }
            }
          } catch (err) {
            logger.warn(
              `Spotify search failed; fallback to SoundCloud ${logContext({ guildId: interaction.guild.id, userId: interaction.user.id, command })}`,
              err
            )
          }
        } else {
          // no-op
        }

        if (!info) {
          info = await fetchSoundcloudInfo(raw, scConfig)
        }
      }

      const song: Song = {
        title: info.title,
        url: info.url,
        source: 'soundcloud',
        durationSec: info.durationSec,
        artist: info.artist,
        album: info.album,
        thumbnailUrl: info.thumbnailUrl
      }

      const existingQueue = getQueue(interaction.guild.id)
      const guardError = getVoiceGuardError(interaction as any, existingQueue)
      if (guardError) {
        await interaction.editReply({ content: guardError })
        return
      }
      if (!existingQueue) {
        const guildId = interaction.guild.id
        const connection = await connectToChannel(voiceChannel, () => {
          const active = getQueue(guildId)
          if (!active) return
          deleteQueue(guildId)
        })
        const queue = createQueue(interaction.channel as any, connection)
        queue.idleTimeoutMs = idleTimeoutMs
        queue.songs.push(song)
        setQueue(interaction.guild.id, queue)
        await playNext(interaction.guild.id, scConfig, async (q, s) => {
          await sendNowPlaying(q, s)
        }, async q => {
          await disableNowPlaying(q)
        })
      } else {
        existingQueue.songs.push(song)
        if (!existingQueue.current) {
          if (existingQueue.idleTimer) {
            clearTimeout(existingQueue.idleTimer)
            existingQueue.idleTimer = undefined
          }
          await playNext(interaction.guild.id, scConfig, async (q, s) => {
            await sendNowPlaying(q, s)
          }, async q => {
            await disableNowPlaying(q)
          })
        }
      }

      await interaction.editReply({ content: `✅ Added: **${song.title}**` })
    } catch (err) {
      logger.error('Failed to play via /play:', err)
      try {
        await interaction.editReply({ content: 'Failed to play selection.' })
      } catch (editErr) {
        logger.warn('Failed to send /play error reply:', editErr)
      }
    }
    return
  }

  if (command === 'abi_random') {
    const showImages = interaction.options.getBoolean('showimages') ?? false
    const forChannel = interaction.options.getBoolean('forchannel') ?? false

    if (forChannel) {
      const lastRun = abiForChannelLastRun.get(interaction.guild.id) || 0
      const remainingMs = abiForChannelCooldownMs - (Date.now() - lastRun)
      if (remainingMs > 0) {
        const seconds = Math.ceil(remainingMs / 1000)
        await interaction.reply({ content: `Aguarde ${seconds}s para usar forchannel novamente.`, flags: MessageFlags.Ephemeral })
        return
      }
      const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
      if (!voiceChannel) {
        await interaction.reply({ content: 'Join a voice channel first!', flags: MessageFlags.Ephemeral })
        return
      }
      const members = voiceChannel.members.filter(member => !member.user.bot)
      if (!members.size) {
        await interaction.reply({ content: 'No users found in the voice channel.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
      abiForChannelLastRun.set(interaction.guild.id, Date.now())
      const sharedMap = rollLoadout().map
      for (const member of members.values()) {
        const loadout = rollLoadout(sharedMap)
        const title = `Random build for ${member.displayName}`
        setAbiSession(interaction.guild.id, member.user.id, { loadout, showImages, label: member.displayName, updatedAt: Date.now() })
        const embeds = buildAbiEmbeds(loadout, showImages, title)
        await (interaction.channel as any).send({
          embeds,
          components: buildAbiRows(member.user.id, showImages)
        })
      }
      await interaction.editReply({ content: `Gerados ${members.size} loadouts no canal.` })
      return
    }

    const loadout = rollLoadout()
    setAbiSession(interaction.guild.id, interaction.user.id, { loadout, showImages, updatedAt: Date.now() })
    const embeds = buildAbiEmbeds(loadout, showImages)
    await interaction.reply({ embeds, components: buildAbiRows(interaction.user.id, showImages) })
    return
  }

  const queue = getQueue(interaction.guild.id)

  if (command === 'queue') {
    if (!queue || queue.songs.length === 0) {
      await interaction.reply({ content: 'Queue is empty.', flags: MessageFlags.Ephemeral })
      return
    }
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

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'status') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    await sendStatus(queue, interaction)
    return
  }

  if (command === 'pause') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    pause(queue)
    await interaction.reply({ content: '⏸️ Pausado.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'resume') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    resume(queue)
    await interaction.reply({ content: '▶️ Retomado.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'skip') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    queue.player.stop()
    await interaction.reply({ content: '⏭️ Pulando.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'stop') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    await clearQueueAndDisconnect(interaction.guild.id, queue)
    await interaction.reply({ content: '⏹️ Stopped.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'leave') {
    if (!queue) {
      await interaction.reply({ content: 'I am not in a voice channel.', flags: MessageFlags.Ephemeral })
      return
    }
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    await clearQueueAndDisconnect(interaction.guild.id, queue)
    await interaction.reply({ content: '👋 Saindo do canal de voz.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'volume') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    const value = interaction.options.getInteger('value', true)
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    setVolume(queue, value)
    await interaction.reply({ content: `Volume set to ${queue.volume}%`, flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'loop') {
    if (!queue) {
      await interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral })
      return
    }
    const mode = interaction.options.getString('mode', true)
    const guardError = getVoiceGuardError(interaction as any, queue)
    if (guardError) {
      await interaction.reply({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    const resolved = resolveLoopMode(mode)
    if (!resolved) {
      await interaction.reply({ content: 'Modo invalido. Use off | one | all', flags: MessageFlags.Ephemeral })
      return
    }
    setLoop(queue, resolved)
    await interaction.reply({ content: `Loop ajustado para: ${queue.loop}`, flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'test_sound') {
    const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
    if (!voiceChannel) {
      await interaction.reply({ content: 'Join a voice channel first!', flags: MessageFlags.Ephemeral })
      return
    }
    const botMember = interaction.guild.members.me
    if (!botMember) {
      await interaction.reply({ content: 'Could not verify bot permissions.', flags: MessageFlags.Ephemeral })
      return
    }

    const perms = voiceChannel.permissionsFor(botMember)
    const missing: string[] = []
    if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('ViewChannel')
    if (!perms?.has(PermissionsBitField.Flags.Connect)) missing.push('Connect')
    if (!perms?.has(PermissionsBitField.Flags.Speak)) missing.push('Speak')

    if (missing.length) {
      await interaction.reply({ content: `Faltam permissoes no canal de voz: ${missing.join(', ')}`, flags: MessageFlags.Ephemeral })
      return
    }

    await interaction.reply({ content: 'Starting audio test (5 seconds)...', flags: MessageFlags.Ephemeral })
    try {
      await playTestTone(voiceChannel, interaction.member as any)
    } catch (err) {
      logger.error(
        `Audio test failed ${logContext({ guildId: interaction.guild.id, userId: interaction.user.id, command })}`,
        err
      )
      await interaction.followUp({ content: 'Audio test failed.', flags: MessageFlags.Ephemeral })
    }
    return
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return
  if (!interaction.guild) return

  const [prefix, sessionId] = interaction.customId.split(':')
  if (prefix !== 'sc_select' || !sessionId) return

  const session = getSearchSession(sessionId)
  if (!session || session.guildId !== interaction.guild.id) {
    await interaction.reply({ content: 'Selection expired. Try again.', flags: MessageFlags.Ephemeral })
    return
  }

  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: 'Only the requester can select.', flags: MessageFlags.Ephemeral })
    return
  }

  const idx = Number(interaction.values[0])
  const item = session.items[idx]
  if (!item) {
    await interaction.reply({ content: 'Invalid selection.', flags: MessageFlags.Ephemeral })
    return
  }

  const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
  if (!voiceChannel) {
    await interaction.reply({ content: 'Join a voice channel first!', flags: MessageFlags.Ephemeral })
    return
  }

  try {
    await interaction.deferUpdate()

    const info = await fetchSoundcloudInfo(item.url, scConfig)
    const song: Song = {
      title: info.title,
      url: info.url,
      source: 'soundcloud',
      durationSec: info.durationSec,
      artist: info.artist,
      album: info.album,
      thumbnailUrl: info.thumbnailUrl
    }

    const existingQueue = getQueue(interaction.guild.id)
    const guardError = getVoiceGuardError(interaction as any, existingQueue)
    if (guardError) {
      await interaction.followUp({ content: guardError, flags: MessageFlags.Ephemeral })
      return
    }
    if (!existingQueue) {
      const guildId = interaction.guild.id
      const connection = await connectToChannel(voiceChannel, () => {
        const active = getQueue(guildId)
        if (!active) return
        deleteQueue(guildId)
      })
      const queue = createQueue(interaction.channel as any, connection)
      queue.idleTimeoutMs = idleTimeoutMs
      queue.songs.push(song)
      setQueue(interaction.guild.id, queue)
      await playNext(interaction.guild.id, scConfig, async (q, s) => {
        await sendNowPlaying(q, s)
      }, async q => {
        await disableNowPlaying(q)
      })
    } else {
      existingQueue.songs.push(song)
      if (!existingQueue.current) {
        if (existingQueue.idleTimer) {
          clearTimeout(existingQueue.idleTimer)
          existingQueue.idleTimer = undefined
        }
        await playNext(interaction.guild.id, scConfig, async (q, s) => {
          await sendNowPlaying(q, s)
        }, async q => {
          await disableNowPlaying(q)
        })
      }
    }

    await interaction.editReply({ content: `✅ Added: **${song.title}**`, components: [] })
  } catch (err) {
    logger.error('Failed to play selection:', err)
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'Failed to play selection.', flags: MessageFlags.Ephemeral })
      } else {
        await interaction.reply({ content: 'Failed to play selection.', flags: MessageFlags.Ephemeral })
      }
    } catch (responseErr) {
      logger.warn('Failed to send select-menu playback error reply:', responseErr)
    }
  }
})

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!welcomeEnabled) return
  if (!newState.guild) return
  if (!newState.member || newState.member.user.bot) return
  if (oldState.channelId === newState.channelId) return
  if (!newState.channel) return
  if (getQueue(newState.guild.id)) return

  try {
    await playWelcomeSound(newState.channel as VoiceBasedChannel, newState.guild.id)
  } catch (err) {
    logger.error(
      `Failed to play welcome sound ${logContext({ guildId: newState.guild.id, userId: newState.member?.id })}`,
      err
    )
  }
})

void client.login(token)
