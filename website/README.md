# Web de marketing de Betan BM

Una sola página estática: `index.html` (HTML + CSS + JS inline, sin build ni dependencias).
Solo carga Google Fonts (Bricolage Grotesque y Hanken Grotesk). Peso total ~145 KB sin comprimir
(~100 KB transferidos con gzip), modo claro/oscuro, `prefers-reduced-motion` respetado.

## Ver en local
Basta con abrir `index.html` en el navegador. Para servirla por HTTP:

    cd website
    bunx serve .                  # http://localhost:3000
    # o: python3 -m http.server 8080

## Caddy
    betan.example.com {
        root * /ruta/a/betan-bm/website
        file_server
        encode zstd gzip
    }

## Netlify / Cloudflare Pages
Directorio de publicación: `website`. Sin comando de build.

## Antes de publicar
- Edita la constante `CONFIG` al inicio del `<script>` final (email, WhatsApp, campos del formulario).
  El formulario no tiene backend: abre el correo (mailto) o WhatsApp con los datos rellenos.
- Busca `[DATO REAL]` y `[PLACEHOLDER]` y rellénalos (métricas y cita de Betania, precios orientativos,
  nombres de los hoteles del ejemplo multi-hotel, datos legales, plazos de implantación).
- Cambia `https://betan.example.com/` (canonical, og:url, og:image, schema) por el dominio real.
- `og.svg` es la imagen para redes. Facebook, LinkedIn y WhatsApp no aceptan SVG: exporta un
  `og.png` de 1200x630 (por ejemplo abriéndolo en Chromium y haciendo captura) y cambia `og:image`.
- Lo marcado como "Próximamente" (reembolsos Stripe, envío automático de SES, VERIFACTU, Mossos,
  cerraduras Salto/Nuki/Dormakaba) no debe presentarse como disponible hasta que lo esté.

## Revisar el render
Capturas a 1440/768/390 px en claro y oscuro con Playwright y el Chromium del sistema:

    bun add playwright-core        # en una carpeta temporal
    # script: chromium.launch({ executablePath: "/usr/bin/chromium" }),
    # newContext({ viewport: { width }, colorScheme }), page.screenshot({ fullPage: true })
