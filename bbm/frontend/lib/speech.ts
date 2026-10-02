// ─── Voz — helpers compartidos (Web Speech API nativa, sin dependencias) ──────
// Usado por AgentFloat.tsx (asistente flotante) y AdminQuickStats.tsx (chat
// de voz del resumen rápido de dirección) — misma limpieza de texto y mismo
// tono de voz en los dos sitios.
export function stripForSpeech(text: string): string {
  return text
    // Emoji y símbolos decorativos que la síntesis de voz no debe intentar pronunciar.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
    // Marcado (markdown) que se quita sin dejar rastro (no debe sonar "guión" ni nada).
    .replace(/[*_`#>~^]/g, '')
    // El % sí debe leerse (es un dato, no un signo decorativo) — se convierte
    // a palabra antes de que la limpieza de abajo lo borre.
    .replace(/%/g, ' por ciento ')
    // Resto de signos/caracteres especiales que el motor de voz suele deletrear
    // ("guión", "barra", "asterisco"...) — se cambian por un espacio, no se
    // borran del todo, para no pegar dos palabras que quedarían separadas por
    // el símbolo (ej. "24/9/2026" no debe sonar "2492026").
    .replace(/[-/\\|[\](){}"'`:;*@&$=+<>]/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  try {
    window.speechSynthesis.cancel() // corta lo anterior si seguía hablando
    const utter = new SpeechSynthesisUtterance(stripForSpeech(text))
    utter.lang = 'es-ES'
    utter.rate = 1.3 // más rápido que el 1.0 por defecto, sigue siendo inteligible
    window.speechSynthesis.speak(utter)
  } catch { /* ignore */ }
}

export const SpeechRecognitionCtor: any =
  (typeof window !== 'undefined' && ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)) || null
