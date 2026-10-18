// Limitador en memoria (ventana deslizante). Suficiente para un solo proceso.
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private max: number, private windowMs: number) {}

  /** true si la petición está permitida (y la registra). */
  allow(key: string, now = Date.now()): boolean {
    const from = now - this.windowMs
    const arr = (this.hits.get(key) ?? []).filter(t => t > from)
    if (arr.length >= this.max) { this.hits.set(key, arr); return false }
    arr.push(now)
    this.hits.set(key, arr)
    if (this.hits.size > 10_000) this.sweep(now)
    return true
  }

  private sweep(now: number) {
    for (const [k, arr] of this.hits) {
      const live = arr.filter(t => t > now - this.windowMs)
      if (live.length) this.hits.set(k, live); else this.hits.delete(k)
    }
  }
}
