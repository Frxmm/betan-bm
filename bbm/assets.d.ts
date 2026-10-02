// Assets embebidos en el binario (bun build --compile) — el import devuelve la ruta del archivo
declare module '*.pdf' {
  const path: string
  export default path
}
