# ScavBot

Bot de musica para Discord com foco em SoundCloud.

## Requisitos
- Node.js >= 22.12.0
- `yt-dlp` disponivel no PATH
- `ffmpeg` instalado

## Configuracao
Crie um arquivo `.env` com:

```env
DISCORD_TOKEN="seu_token"
YTDLP_COOKIES_FILE="/caminho/para/soundcloud_cookies.txt"
YTDLP_USER_AGENT="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
IDLE_DISCONNECT_MINUTES=15
# Opcional: habilitar Spotify (para autocomplete e metadados)
# ENABLE_SPOTIFY=true
# SPOTIFY_CLIENT_ID="seu_client_id"
# SPOTIFY_CLIENT_SECRET="seu_client_secret"
# Opcional: para registrar comandos mais rapido em um servidor especifico
# GUILD_ID=123456789012345678
# DEBUG=1
```

## Instalar e rodar

```bash
npm install
npm run build
npm start
```

## Comandos (Slash)
- `/toca` – Busca no SoundCloud com autocomplete e toca a selecao
- `/queue` – Mostra a fila
- `/pause`
- `/resume`
- `/skip`
- `/stop`
- `/leave`
- `/volume` – Defina de 0 a 200
- `/loop` – off | one | all
- `/status` – Status e progresso
- `/teste_som` – Teste de audio

## Observacoes
- O bot entra em standby quando a fila termina e desconecta apos `IDLE_DISCONNECT_MINUTES`.
- A interface de selecao usa autocomplete do Discord (slash commands).
- Spotify e opcional. Se estiver habilitado, o bot usa Spotify para busca/metadados, mas ainda toca via SoundCloud.
