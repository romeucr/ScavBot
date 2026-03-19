import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type VoiceBasedChannel,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  MessageFlags
} from 'discord.js'
import { setDefaultResultOrder } from 'node:dns'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, StreamType } from '@discordjs/voice'
import { loadDotEnvFile, getEnv } from './utils/env'
import { makeDebugLogger } from './utils/logger'
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
  formatProgressBar,
  type Song,
  type LoopMode
} from './music/queue'
import { playTestTone } from './music/testTone'
import { fetchSoundcloudInfo, searchSoundcloud } from './providers/soundcloud'
import { fetchSpotifyOembed, isSpotifyUrl, isSpotifyTrackUrl, searchSpotifyTracks, validateSpotifyCredentials } from './providers/spotify'
import { rollLoadout, type AbiLoadout } from './abi/randomizer'

loadDotEnvFile()
setDefaultResultOrder('ipv4first')

const DEBUG_ENABLED = getEnv('DEBUG') === '1'
const debugLog = makeDebugLogger(DEBUG_ENABLED)

const token = getEnv('DISCORD_TOKEN')
if (!token) {
  throw new Error('Variavel de ambiente DISCORD_TOKEN nao definida.')
}

const scConfig = {
  cookiesFile: getEnv('YTDLP_COOKIES_FILE'),
  userAgent: getEnv('YTDLP_USER_AGENT'),
  debugLog
}

const idleMinutes = Number(getEnv('IDLE_DISCONNECT_MINUTES') || '15')
const idleTimeoutMs = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60 * 1000 : 0
const spotifyEnabled = (getEnv('ENABLE_SPOTIFY') || 'false').toLowerCase() === 'true'
const welcomeCooldownSec = Number(getEnv('WELCOME_COOLDOWN_SEC') || '10')
const welcomeCooldownMs = Number.isFinite(welcomeCooldownSec) && welcomeCooldownSec > 0 ? welcomeCooldownSec * 1000 : 0
const welcomeMp3Dir = getEnv('WELCOME_MP3_DIR') || path.resolve(process.cwd(), 'src', 'music', 'mp3')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
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

type AutocompleteItem = { title: string; url: string; artist?: string; durationSec?: number }
type AutocompleteSession = {
  id: string
  userId: string
  guildId: string
  items: AutocompleteItem[]
  createdAt: number
}

const autocompleteSessions = new Map<string, AutocompleteSession>()
const AUTOCOMPLETE_TTL_MS = 60 * 1000

const lastWelcomeAt = new Map<string, number>()

type AbiSession = {
  loadout: AbiLoadout
  showImages: boolean
  label?: string
  updatedAt: number
}
const abiSessions = new Map<string, AbiSession>()
const ABI_SESSION_TTL_MS = 10 * 60 * 1000

function setAbiSession(guildId: string, userId: string, session: AbiSession) {
  const key = `${guildId}:${userId}`
  abiSessions.set(key, session)
  setTimeout(() => {
    const existing = abiSessions.get(key)
    if (existing && Date.now() - existing.updatedAt >= ABI_SESSION_TTL_MS) {
      abiSessions.delete(key)
    }
  }, ABI_SESSION_TTL_MS + 1000)
}

function getAbiSession(guildId: string, userId: string): AbiSession | undefined {
  const key = `${guildId}:${userId}`
  const session = abiSessions.get(key)
  if (!session) return undefined
  if (Date.now() - session.updatedAt > ABI_SESSION_TTL_MS) {
    abiSessions.delete(key)
    return undefined
  }
  return session
}

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

client.once('clientReady', () => {
  console.log('Bot online')
  console.log('Dica: defina DEBUG=1 no .env para logs detalhados.')

  const guildId = getEnv('GUILD_ID')
  const clearGuild = getEnv('CLEAR_GUILD_COMMANDS') === '1'

  if (guildId && clearGuild) {
    client.guilds.fetch(guildId).then(guild => guild.commands.set([])).then(() => {
      console.log('Comandos do guild limpos. Remova CLEAR_GUILD_COMMANDS do .env.')
    }).catch(err => {
      console.error('Falha ao limpar comandos do guild:', err)
    })
    return
  }

  const commandData = [
    {
      name: 'toca',
      description: 'Tocar uma musica do SoundCloud',
      options: [
        {
          name: 'query',
          description: 'Nome ou link da musica',
          type: 3,
          required: true,
          autocomplete: true
        }
      ]
    }
    ,
    { name: 'pause', description: 'Pausar a musica' },
    { name: 'resume', description: 'Retomar a musica' },
    { name: 'skip', description: 'Pular a musica atual' },
    { name: 'stop', description: 'Parar e limpar a fila' },
    { name: 'leave', description: 'Sair do canal de voz' },
    {
      name: 'volume',
      description: 'Definir volume (0-200)',
      options: [
        { name: 'valor', description: 'Volume de 0 a 200', type: 4, required: true }
      ]
    },
    {
      name: 'loop',
      description: 'Configurar loop',
      options: [
        { name: 'modo', description: 'off | one | all', type: 3, required: true,
          choices: [
            { name: 'off', value: 'off' },
            { name: 'one', value: 'one' },
            { name: 'all', value: 'all' }
          ]
        }
      ]
    },
    { name: 'status', description: 'Mostrar status da musica' },
    { name: 'queue', description: 'Mostrar a fila' },
    { name: 'teste_som', description: 'Teste de audio' },
    {
      name: 'abi_random',
      description: 'Gerar loadout aleatorio do ABI',
      options: [
        { name: 'showimages', description: 'Mostrar imagens dos itens', type: 5, required: false },
        { name: 'forchannel', description: 'Gerar para todos no canal de voz', type: 5, required: false }
      ]
    }
  ]

  if (guildId) {
    client.guilds.fetch(guildId).then(guild => guild.commands.set(commandData)).catch(err => {
      console.error('Falha ao registrar comandos no guild:', err)
    })
  } else if (client.application) {
    client.application.commands.set(commandData).catch(err => {
      console.error('Falha ao registrar comandos globais:', err)
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

function buildControlsRows(queue?: ReturnType<typeof getQueue>, disabled = false) {
  const isPaused = queue?.player.state.status === 'paused'
  const loopLabel = queue?.loop === 'one' ? 'Loop: 1' : queue?.loop === 'all' ? 'Loop: Fila' : 'Loop: Off'
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

  return [row1, row2]
}

function buildNowPlayingEmbed(queue: NonNullable<ReturnType<typeof getQueue>>, song: Song) {
  const { elapsedSec, durationSec } = getProgress(queue)
  const bar = formatProgressBar(elapsedSec, durationSec)
  const time = formatProgress(elapsedSec, durationSec)

  const embed = new EmbedBuilder()
    .setTitle(`🎵 Tocando agora: ${song.title}`)
    .setColor(0xff5500)
    .addFields(
      { name: 'Artista', value: song.artist || 'Desconhecido', inline: true },
      { name: 'Album', value: song.album || 'Desconhecido', inline: true },
      { name: 'Progresso', value: `${bar} \`${time}\`` }
    )

  if (song.thumbnailUrl) {
    embed.setThumbnail(song.thumbnailUrl)
  }

  return embed
}

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
    } catch {
      // ignore
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
  } catch {
    // ignore
  }
  queue.nowPlayingMessageId = undefined
}

function formatStatus(queue: NonNullable<ReturnType<typeof getQueue>>): string {
  const current = queue.current
  if (!current) return 'Nada tocando.'

  const { elapsedSec, durationSec } = getProgress(queue)
  const bar = formatProgressBar(elapsedSec, durationSec)
  const time = formatProgress(elapsedSec, durationSec)

  return [
    `Tocando: **${current.title}**`,
    `Artista: ${current.artist || 'Desconhecido'}`,
    `Album: ${current.album || 'Desconhecido'}`,
    `${bar} \`${time}\``,
    `Volume: ${queue.volume}% | Loop: ${queue.loop}`,
    `Na fila: ${Math.max(0, queue.songs.length - 1)}`
  ].join('\n')
}

async function updateNowPlayingLoop(queue: NonNullable<ReturnType<typeof getQueue>>, token: number, messageId: string) {
  while (queue.current && queue.nowPlayingMessageId) {
    if (queue.nowPlayingToken !== token || queue.nowPlayingMessageId !== messageId) {
      break
    }
    if (queue.nowPlayingUpdating) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      continue
    }

    try {
      const { elapsedSec } = getProgress(queue)
      if (queue.lastProgressSec === elapsedSec) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        continue
      }

      queue.nowPlayingUpdating = true
      const msg = await queue.textChannel.messages.fetch(messageId)
      const embed = buildNowPlayingEmbed(queue, queue.current)
      await msg.edit({ embeds: [embed], components: buildControlsRows(queue) })
      queue.lastProgressSec = elapsedSec
      queue.nowPlayingUpdating = false
    } catch {
      queue.nowPlayingUpdating = false
      break
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
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
    msg.delete().catch(() => {})
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

function listWelcomeMp3s(): string[] {
  try {
    return fs.readdirSync(welcomeMp3Dir)
      .filter(file => file.toLowerCase().endsWith('.mp3'))
      .map(file => path.join(welcomeMp3Dir, file))
  } catch {
    return []
  }
}

function pickRandom<T>(items: T[]): T | undefined {
  if (!items.length) return undefined
  const idx = Math.floor(Math.random() * items.length)
  return items[idx]
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
  } catch {
    // ignore
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
      await interaction.reply({ content: 'Somente quem pediu pode usar este botao.', flags: MessageFlags.Ephemeral })
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
      await interaction.reply({ content: 'Somente quem pediu pode usar este botao.', flags: MessageFlags.Ephemeral })
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
    await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
    return
  }

  try {
    if (id === 'pause') pause(queue)
    if (id === 'resume') resume(queue)
    if (id === 'skip') queue.player.stop()
    if (id === 'stop') {
      queue.songs = []
      queue.player.stop()
      queue.current = undefined
      queue.currentResource = undefined
      queue.startedAt = undefined
      queue.pausedAt = undefined
      queue.lastProgressSec = undefined
      await disableNowPlaying(queue)
      queue.connection.destroy()
      deleteQueue(interaction.guild.id)
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

    const rows = buildControlsRows(queue)
    await interaction.update({ components: rows })
    if (queue.nowPlayingMessageId && (id === 'pause' || id === 'resume' || id === 'loop')) {
      const token = queue.nowPlayingToken ?? 0
      void updateNowPlayingLoop(queue, token, queue.nowPlayingMessageId)
    }
  } catch (err) {
    console.error('Erro no botao:', err)
    const msg = 'Falha ao executar o comando.'
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

  if (interaction.commandName !== 'toca') return
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'query') return

  const query = String(focused.value || '').trim()
  if (!query) {
    await interaction.respond([])
    return
  }

  try {
    const spotifyId = getEnv('SPOTIFY_CLIENT_ID')
    const spotifySecret = getEnv('SPOTIFY_CLIENT_SECRET')

    let items: AutocompleteItem[] = []
    if (spotifyEnabled && spotifyId && spotifySecret) {
      try {
        const results = await searchSpotifyTracks(query, 5, spotifyId, spotifySecret)
        items = results.map(r => ({
          title: r.title,
          url: r.url,
          artist: r.artist,
          durationSec: r.durationSec
        }))
      } catch (err) {
        console.warn('Spotify search falhou, usando SoundCloud:', err)
        items = await searchSoundcloud(query, scConfig, 5)
      }
    } else {
      items = await searchSoundcloud(query, scConfig, 5)
    }

    if (!items.length) {
      await interaction.respond([])
      return
    }

    const session = createAutocompleteSession(interaction.user.id, interaction.guild.id, items)
    const choices = items.map((item, idx) => {
      const duration = item.durationSec ? ` - ${formatProgress(0, item.durationSec).split('/')[1].trim()}` : ''
      const artist = item.artist ? `${item.artist} - ` : ''
      const name = `${artist}${item.title}${duration}`.slice(0, 100)
      return { name, value: `scid:${session.id}:${idx}` }
    })

    await interaction.respond(choices)
  } catch (err) {
    console.error('Erro no autocomplete:', err)
    await interaction.respond([])
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  if (!interaction.guild) return
  const command = interaction.commandName

  if (command === 'toca') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    const raw = interaction.options.getString('query', true)
    const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
    if (!voiceChannel) {
      await interaction.editReply({ content: 'Entre em um canal de voz primeiro!' })
      return
    }

    try {
      let info
      if (raw.startsWith('scid:')) {
        const [, id, idxRaw] = raw.split(':')
        const idx = Number(idxRaw)
        const session = autocompleteSessions.get(id)
        if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guild.id) {
          await interaction.editReply({ content: 'Selecao expirada. Tente novamente.' })
          return
        }
        const item = session.items[idx]
        if (!item) {
          await interaction.editReply({ content: 'Selecao invalida.' })
          return
        }
        const spotifyId = getEnv('SPOTIFY_CLIENT_ID')
        const spotifySecret = getEnv('SPOTIFY_CLIENT_SECRET')
        if (spotifyEnabled && spotifyId && spotifySecret && isSpotifyUrl(item.url)) {
          const query = `${item.title} ${item.artist || ''}`.trim()
          const results = await searchSoundcloud(query, scConfig, 5)
          if (!results.length) {
            await interaction.editReply({ content: 'Nao encontrei essa faixa no SoundCloud.' })
            return
          }
          info = await fetchSoundcloudInfo(results[0].url, scConfig)
        } else {
          info = await fetchSoundcloudInfo(item.url, scConfig)
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
          await interaction.editReply({ content: 'Nao encontrei essa faixa no SoundCloud.' })
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
              }
            }
          } catch (err) {
            console.warn('Spotify search falhou, usando SoundCloud:', err)
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
      if (!existingQueue) {
        const connection = await connectToChannel(voiceChannel)
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

      await interaction.editReply({ content: `✅ Adicionado: **${song.title}**` })
    } catch (err) {
      console.error('Erro ao tocar via /toca:', err)
      try {
        await interaction.editReply({ content: 'Erro ao tocar a selecao.' })
      } catch {
        // ignore
      }
    }
    return
  }

  if (command === 'abi_random') {
    const showImages = interaction.options.getBoolean('showimages') ?? false
    const forChannel = interaction.options.getBoolean('forchannel') ?? false

    if (forChannel) {
      const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
      if (!voiceChannel) {
        await interaction.reply({ content: 'Entre em um canal de voz primeiro!', flags: MessageFlags.Ephemeral })
        return
      }
      const members = voiceChannel.members.filter(member => !member.user.bot)
      if (!members.size) {
        await interaction.reply({ content: 'Nao encontrei usuarios no canal de voz.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
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
      await interaction.reply({ content: 'Fila vazia.', flags: MessageFlags.Ephemeral })
      return
    }
    const upcoming = queue.songs.slice(0, 10)
    const lines = upcoming.map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`)
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'status') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    await sendStatus(queue, interaction)
    return
  }

  if (command === 'pause') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    pause(queue)
    await interaction.reply({ content: '⏸️ Pausado.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'resume') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    resume(queue)
    await interaction.reply({ content: '▶️ Retomado.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'skip') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    queue.player.stop()
    await interaction.reply({ content: '⏭️ Pulando.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'stop') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    queue.songs = []
    queue.player.stop()
    queue.current = undefined
    queue.currentResource = undefined
    queue.startedAt = undefined
    queue.pausedAt = undefined
    queue.lastProgressSec = undefined
    await disableNowPlaying(queue)
    queue.connection.destroy()
    deleteQueue(interaction.guild.id)
    await interaction.reply({ content: '⏹️ Musica parada.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'leave') {
    if (!queue) {
      await interaction.reply({ content: 'Nao estou em um canal de voz.', flags: MessageFlags.Ephemeral })
      return
    }

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
    deleteQueue(interaction.guild.id)
    await interaction.reply({ content: '👋 Saindo do canal de voz.', flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'volume') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    const value = interaction.options.getInteger('valor', true)
    setVolume(queue, value)
    await interaction.reply({ content: `Volume ajustado para ${queue.volume}%`, flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'loop') {
    if (!queue) {
      await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
      return
    }
    const mode = interaction.options.getString('modo', true)
    const resolved = resolveLoopMode(mode)
    if (!resolved) {
      await interaction.reply({ content: 'Modo invalido. Use off | one | all', flags: MessageFlags.Ephemeral })
      return
    }
    setLoop(queue, resolved)
    await interaction.reply({ content: `Loop ajustado para: ${queue.loop}`, flags: MessageFlags.Ephemeral })
    return
  }

  if (command === 'teste_som') {
    const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
    if (!voiceChannel) {
      await interaction.reply({ content: 'Entre em um canal de voz primeiro!', flags: MessageFlags.Ephemeral })
      return
    }
    const botMember = interaction.guild.members.me
    if (!botMember) {
      await interaction.reply({ content: 'Nao consegui verificar permissoes do bot.', flags: MessageFlags.Ephemeral })
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

    await interaction.reply({ content: 'Iniciando teste de audio (5 segundos)...', flags: MessageFlags.Ephemeral })
    try {
      await playTestTone(voiceChannel, interaction.member as any)
    } catch (err) {
      console.error('Erro no teste de audio:', err)
      await interaction.followUp({ content: 'Falha no teste de audio.', flags: MessageFlags.Ephemeral })
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
    await interaction.reply({ content: 'Selecao expirada. Tente novamente.', flags: MessageFlags.Ephemeral })
    return
  }

  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: 'Somente quem pediu pode selecionar.', flags: MessageFlags.Ephemeral })
    return
  }

  const idx = Number(interaction.values[0])
  const item = session.items[idx]
  if (!item) {
    await interaction.reply({ content: 'Selecao invalida.', flags: MessageFlags.Ephemeral })
    return
  }

  const voiceChannel = interaction.member && 'voice' in interaction.member ? interaction.member.voice.channel : null
  if (!voiceChannel) {
    await interaction.reply({ content: 'Entre em um canal de voz primeiro!', flags: MessageFlags.Ephemeral })
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
    if (!existingQueue) {
      const connection = await connectToChannel(voiceChannel)
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

    await interaction.editReply({ content: `✅ Adicionado: **${song.title}**`, components: [] })
  } catch (err) {
    console.error('Erro ao tocar selecao:', err)
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'Erro ao tocar a selecao.', flags: MessageFlags.Ephemeral })
      } else {
        await interaction.reply({ content: 'Erro ao tocar a selecao.', flags: MessageFlags.Ephemeral })
      }
    } catch {
      // ignore
    }
  }
})

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild) return
  if (!newState.member || newState.member.user.bot) return
  if (oldState.channelId === newState.channelId) return
  if (!newState.channel) return
  if (getQueue(newState.guild.id)) return

  try {
    await playWelcomeSound(newState.channel as VoiceBasedChannel, newState.guild.id)
  } catch (err) {
    console.error('Erro ao tocar som de entrada:', err)
  }
})

client.login(token)
