# ScavBot

A chill Discord music bot focused on SoundCloud playback, built for friends but ready for public use.  
It ships with a clean player UI and queue controls.  
As we are Arena Breakout Infinite players, it also includes a randomizer for loadouts in that game.

Feel free to use and modify as you like. Contributions are welcome!

## Screenshots
<img src="/docs/screenshots/player.png" width="600" />
<img src="/docs/screenshots/query.png" width="600" />
<img src="/docs/screenshots/queue.png" width="600" />

## Requirements
- Node.js >= 22.12.0
- `yt-dlp` available in PATH
- `ffmpeg` installed

## Setup
Create a `.env` file:

```env
DISCORD_TOKEN="your_token"
YTDLP_COOKIES_FILE="/path/to/soundcloud_cookies.txt"
YTDLP_USER_AGENT="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
YTDLP_BIN="/usr/local/bin/yt-dlp"
IDLE_DISCONNECT_MINUTES=15

# Optional: welcome sound when someone joins a voice channel
# WELCOME_ENABLED=true
# WELCOME_MP3_DIR="/path/to/mp3"
# WELCOME_COOLDOWN_SEC=30

# Optional: Spotify autocomplete (faster results)
# ENABLE_SPOTIFY=true
# SPOTIFY_CLIENT_ID="your_client_id"
# SPOTIFY_CLIENT_SECRET="your_client_secret"

# Optional: autocomplete tuning
# AUTOCOMPLETE_ENABLED=true
# AUTOCOMPLETE_MIN_CHARS=2
# AUTOCOMPLETE_LIMIT=10

# Optional: faster command registration in a single server
# GUILD_ID=123456789012345678
# CLEAR_GUILD_COMMANDS=1

# DEBUG=1
```

## Install & Run

```bash
npm install
npm run check
npm run build
npm start
```

## Quality Scripts
- `npm run typecheck` – TypeScript validation only
- `npm run lint` – ESLint over `src/**/*.ts`
- `npm run format` – Prettier formatting
- `npm run check` – Typecheck + lint

## Clear Guild Commands
Use this if you see duplicated commands in a server:

1) Set `GUILD_ID` and `CLEAR_GUILD_COMMANDS=1` in `.env`
2) Run the bot once
3) Remove `CLEAR_GUILD_COMMANDS`

## Slash Commands
- `/play` – Search + play SoundCloud (autocomplete)
- `/queue` – Show queue (embed)
- `/pause`
- `/resume`
- `/skip`
- `/stop`
- `/leave`
- `/volume` – Set 0–200
- `/loop` – off | one | all
- `/test_sound` – Audio test
- `/abi_random` – ABI loadout randomizer (map, helmet, armor, weapon)
  Options: `showimages`, `forchannel`
- `/vote_kick` – Start a vote to kick someone from your current voice channel

## Lyrics Button
The player includes a **Lyrics** button that fetches lyrics from:
- **LRCLIB** (primary)
- **lyrics.ovh** (fallback)

No API key required.

## Notes
- When the queue ends, the bot stays in standby and disconnects after `IDLE_DISCONNECT_MINUTES`.
- Autocomplete runs through Discord slash commands. If your server is slow, you can disable it via `AUTOCOMPLETE_ENABLED=false`.
- Spotify is optional. When enabled, autocomplete uses Spotify but playback still happens via SoundCloud.
- ABI randomizer uses a local dataset. Edit `src/abi/data.ts` to customize items.
- Vote kick timeout is configurable via `VOTE_KICK_TIMEOUT_SEC` (minimum 300 seconds).
- Vote kick guardrails: `VOTE_KICK_USER_COOLDOWN_SEC`, `VOTE_KICK_CHANNEL_COOLDOWN_SEC`, `VOTE_KICK_TARGET_COOLDOWN_SEC`, `VOTE_KICK_RATE_LIMIT_WINDOW_SEC`, `VOTE_KICK_RATE_LIMIT_MAX`, `VOTE_KICK_EXCLUDED_ROLE_IDS`.
