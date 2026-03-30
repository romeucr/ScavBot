import type { AbiLoadout } from '../../abi/randomizer'

export type AbiSession = {
  loadout: AbiLoadout
  showImages: boolean
  label?: string
  updatedAt: number
}

const abiSessions = new Map<string, AbiSession>()
const ABI_SESSION_TTL_MS = 10 * 60 * 1000

export function setAbiSession(guildId: string, userId: string, session: AbiSession) {
  const key = `${guildId}:${userId}`
  abiSessions.set(key, session)
  setTimeout(() => {
    const existing = abiSessions.get(key)
    if (existing && Date.now() - existing.updatedAt >= ABI_SESSION_TTL_MS) {
      abiSessions.delete(key)
    }
  }, ABI_SESSION_TTL_MS + 1000)
}

export function getAbiSession(guildId: string, userId: string): AbiSession | undefined {
  const key = `${guildId}:${userId}`
  const session = abiSessions.get(key)
  if (!session) return undefined
  if (Date.now() - session.updatedAt > ABI_SESSION_TTL_MS) {
    abiSessions.delete(key)
    return undefined
  }
  return session
}
