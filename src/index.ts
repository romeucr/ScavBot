import {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  MessageFlags
} from 'discord.js'
import { setDefaultResultOrder } from 'node:dns'
import crypto from 'node:crypto'
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

client.once('clientReady', () => {
  console.log('Bot online')
  console.log('Dica: defina DEBUG=1 no .env para logs detalhados.')
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
      { name: 'Progresso', value: `${bar} ${time}` }
    )

  if (song.thumbnailUrl) {
    embed.setThumbnail(song.thumbnailUrl)
  }

  return embed
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
    `${bar} ${time}`,
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

async function sendStatus(queue: NonNullable<ReturnType<typeof getQueue>>, interaction?: ButtonInteraction, channel?: any) {
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return
  if (!interaction.guild) return

  const queue = getQueue(interaction.guild.id)
  if (!queue) {
    await interaction.reply({ content: 'Nada tocando.', flags: MessageFlags.Ephemeral })
    return
  }

  const id = interaction.customId

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
        })
    } else {
      existingQueue.songs.push(song)
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

client.on('messageCreate', async message => {
  if (message.author.bot) return
  if (!message.guild) return

  const prefix = '!'
  if (!message.content.startsWith(prefix)) return

  const args = message.content.slice(prefix.length).trim().split(/ +/)
  const command = (args.shift() || '').toLowerCase()

  if (command === 'toca_essa') {
    const search = args.join(' ')
    if (!search) {
      message.reply('Envie o nome ou link da musica.')
      return
    }

    const voiceChannel = message.member?.voice.channel
    if (!voiceChannel) {
      message.reply('Entre em um canal de voz primeiro!')
      return
    }

    let song: Song | null = null
    const isSoundcloudUrl = /(^|\/\/)(soundcloud\.com|snd\.sc)\//i.test(search)
    const scSearchMatch = search.match(/^(sc|soundcloud):\s*(.+)$/i)

    try {
      if (!isSoundcloudUrl) {
        if (/^https?:\/\//i.test(search)) {
          message.reply('Somente SoundCloud por enquanto. Use um link do SoundCloud ou `sc: termo`.')
          return
        }

        const query = scSearchMatch ? scSearchMatch[2] : search
        const trimmed = query.trim()
        if (!trimmed) {
          message.reply('Envie o termo apos `sc:`.')
          return
        }

        const results = await searchSoundcloud(trimmed, scConfig, 5)
        if (!results.length) {
          message.reply('Nao encontrei resultados no SoundCloud.')
          return
        }

        const session = createSearchSession(message.author.id, message.guild.id, results)
        const options = results.map((item, idx) => ({
          label: item.title.slice(0, 100),
          description: item.artist ? item.artist.slice(0, 100) : 'SoundCloud',
          value: String(idx)
        }))

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`sc_select:${session.id}`)
          .setPlaceholder('Escolha uma musica')
          .addOptions(options)

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)

        await message.reply({ content: 'Escolha uma opcao:', components: [row] })
        return
      }

      const info = await fetchSoundcloudInfo(search, scConfig)
      song = {
        title: info.title,
        url: info.url,
        source: 'soundcloud',
        durationSec: info.durationSec,
        artist: info.artist,
        album: info.album,
        thumbnailUrl: info.thumbnailUrl
      }

      if (!song) {
        message.reply('Erro ao selecionar musica.')
        return
      }

      const existingQueue = getQueue(message.guild.id)
      if (!existingQueue) {
        const connection = await connectToChannel(voiceChannel)
        const queue = createQueue(message.channel as any, connection)
        queue.idleTimeoutMs = idleTimeoutMs
        queue.songs.push(song)
        setQueue(message.guild.id, queue)
        await playNext(message.guild.id, scConfig, async (q, s) => {
          await sendNowPlaying(q, s)
        })
      } else {
        existingQueue.songs.push(song)
        message.channel.send(`✅ Adicionado a fila: **${song.title}**`)
      }
    } catch (err) {
      console.error('Erro ao buscar musica:', err)
      message.reply('Erro ao buscar musica.')
    }
  }

  if (command === 'fila' || command === 'queue') {
    const queue = getQueue(message.guild.id)
    if (!queue || queue.songs.length === 0) {
      message.reply('Fila vazia.')
      return
    }

    const upcoming = queue.songs.slice(0, 10)
    const lines = upcoming.map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`)
    message.reply(lines.join('\n'))
  }

  if (command === 'pause') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nada tocando.')
      return
    }
    pause(queue)
    message.reply('⏸️ Pausado.')
  }

  if (command === 'resume') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nada tocando.')
      return
    }
    resume(queue)
    message.reply('▶️ Retomado.')
  }

  if (command === 'volume') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nada tocando.')
      return
    }

    const value = Number(args[0])
    if (!Number.isFinite(value)) {
      message.reply(`Volume atual: ${queue.volume}% (0-200)`)
      return
    }

    setVolume(queue, value)
    message.reply(`Volume ajustado para ${queue.volume}%`) 
  }

  if (command === 'loop') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nada tocando.')
      return
    }

    const mode = resolveLoopMode(args[0])
    if (!mode) {
      message.reply(`Loop atual: ${queue.loop}. Use off | one | all`) 
      return
    }

    setLoop(queue, mode)
    message.reply(`Loop ajustado para: ${queue.loop}`)
  }

  if (command === 'status' || command === 'progress') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nada tocando.')
      return
    }
    await sendStatus(queue, undefined, message.channel)
  }

  if (command === 'skip') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nada tocando.')
      return
    }
    queue.player.stop()
  }

  if (command === 'stop') {
    const queue = getQueue(message.guild.id)
    if (!queue) return
    queue.songs = []
    queue.player.stop()
    queue.current = undefined
    queue.currentResource = undefined
    queue.startedAt = undefined
    queue.pausedAt = undefined
    queue.lastProgressSec = undefined
    queue.connection.destroy()
    deleteQueue(message.guild.id)
    message.reply('⏹️ Musica parada.')
  }

  if (command === 'leave') {
    const queue = getQueue(message.guild.id)
    if (!queue) {
      message.reply('Nao estou em um canal de voz.')
      return
    }

    queue.songs = []
    queue.player.stop()
    queue.current = undefined
    queue.currentResource = undefined
    queue.startedAt = undefined
    queue.pausedAt = undefined
    queue.lastProgressSec = undefined
    if (queue.idleTimer) {
      clearTimeout(queue.idleTimer)
      queue.idleTimer = undefined
    }
    queue.connection.destroy()
    deleteQueue(message.guild.id)
    message.reply('👋 Saindo do canal de voz.')
  }

  if (command === 'teste_som') {
    const voiceChannel = message.member?.voice.channel
    if (!voiceChannel || !message.member) {
      message.reply('Entre em um canal de voz primeiro!')
      return
    }

    const botMember = message.guild?.members.me
    if (!botMember) {
      message.reply('Nao consegui verificar permissoes do bot.')
      return
    }

    const perms = voiceChannel.permissionsFor(botMember)
    const missing: string[] = []
    if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('ViewChannel')
    if (!perms?.has(PermissionsBitField.Flags.Connect)) missing.push('Connect')
    if (!perms?.has(PermissionsBitField.Flags.Speak)) missing.push('Speak')

    if (missing.length) {
      message.reply(`Faltam permissoes no canal de voz: ${missing.join(', ')}`)
      return
    }

    message.reply('Iniciando teste de audio (5 segundos)...')
    try {
      await playTestTone(voiceChannel, message.member)
    } catch (err) {
      console.error('Erro no teste de audio:', err)
      message.reply('Falha no teste de audio.')
    }
  }
})

client.login(token)
