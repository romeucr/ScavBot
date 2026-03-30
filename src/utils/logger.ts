export function makeDebugLogger(enabled: boolean) {
  return (message: string, ...args: unknown[]) => {
    if (!enabled) return
    if (args.length) {
      console.log(message, ...args)
    } else {
      console.log(message)
    }
  }
}

type LogLevel = 'info' | 'warn' | 'error'

function write(level: LogLevel, message: string, ...args: unknown[]) {
  if (level === 'info') {
    console.log(message, ...args)
    return
  }
  if (level === 'warn') {
    console.warn(message, ...args)
    return
  }
  console.error(message, ...args)
}

export const logger = {
  info(message: string, ...args: unknown[]) {
    write('info', message, ...args)
  },
  warn(message: string, ...args: unknown[]) {
    write('warn', message, ...args)
  },
  error(message: string, ...args: unknown[]) {
    write('error', message, ...args)
  }
}
