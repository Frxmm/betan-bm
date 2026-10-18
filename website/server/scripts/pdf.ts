// Genera ../descargas/pliego-de-condiciones-betan.pdf imprimiendo /condiciones con Chromium.
// Uso: bun run pdf   (CHROME_BIN para indicar el ejecutable; por defecto `chromium`)
import { openDb } from '../src/db'
import { createApp } from '../src/app'
import { config } from '../src/config'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const app = createApp(openDb(':memory:'))
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch })
const out = `${config.staticDir}/descargas/pliego-de-condiciones-betan.pdf`
mkdirSync(`${config.staticDir}/descargas`, { recursive: true })

const bin = process.env.CHROME_BIN ?? 'chromium'
// Perfil temporal propio: si ya hay un Chromium abierto con el perfil por defecto, el nuevo
// delega en él y termina sin generar nada (o se queda esperando). El timeout evita bloquear el deploy.
const profile = `${tmpdir()}/betan-pdf-${process.pid}`
const proc = Bun.spawn([bin, '--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', '--disable-background-networking',
  `--print-to-pdf=${out}`, `http://127.0.0.1:${server.port}/condiciones`], { stdout: 'ignore', stderr: 'pipe' })
const timer = setTimeout(() => proc.kill(9), 45_000)
const code = await proc.exited
clearTimeout(timer)
rmSync(profile, { recursive: true, force: true })
server.stop(true)
if (code !== 0 || !(await Bun.file(out).exists())) { console.error('No se pudo generar el PDF:', await new Response(proc.stderr).text()); process.exit(1) }
console.log(`PDF generado: ${out} (${(Bun.file(out).size / 1024).toFixed(0)} KB)`)
