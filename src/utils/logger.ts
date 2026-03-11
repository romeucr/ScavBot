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
