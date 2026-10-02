// Panel de chat con el agente IA local (qwen2.5:3b via Ollama)

const QUICK_ACTIONS = [
  { label: 'Llegadas hoy',   msg: '¿Cuáles son las llegadas de hoy?' },
  { label: 'Salidas hoy',    msg: '¿Cuáles son las salidas de hoy?' },
  { label: 'Ocupación',      msg: 'Dame un resumen del día de hoy' },
  { label: 'Disponibilidad', msg: '¿Qué habitaciones hay libres esta semana?' },
]

const TOOL_LABELS = {
  get_today_summary:    '📊 Consultando resumen del día…',
  search_reservations:  '🔍 Buscando reservas…',
  get_reservation:      '📋 Cargando reserva…',
  get_arrivals:         '↓ Consultando llegadas…',
  get_departures:       '↑ Consultando salidas…',
  check_in:             '✓ Realizando check-in…',
  check_out:            '✓ Realizando check-out…',
  get_availability:     '🛏 Consultando disponibilidad…',
  create_invoice:       '🧾 Generando factura…',
  navigate:             '→ Navegando…',
}

let messages = []
let isOpen   = false
let thinking = false

export function initAgent() {
  // Botón flotante
  const btn = document.createElement('button')
  btn.id        = 'agent-fab'
  btn.innerHTML = '✦'
  btn.title     = 'Asistente IA'
  btn.onclick   = togglePanel
  document.body.appendChild(btn)

  // Panel
  const panel = document.createElement('div')
  panel.id        = 'agent-panel'
  panel.innerHTML = `
    <div id="agent-header">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">✦</span>
        <div>
          <div style="font-weight:600;font-size:14px">Asistente Betania</div>
          <div style="font-size:11px;color:var(--text2)">qwen2.5:3b · local</div>
        </div>
      </div>
      <button id="agent-close" class="btn btn-ghost btn-sm">✕</button>
    </div>
    <div id="agent-messages"></div>
    <div id="agent-quick">
      ${QUICK_ACTIONS.map(a =>
        `<button class="agent-quick-btn" data-msg="${a.msg}">${a.label}</button>`
      ).join('')}
    </div>
    <div id="agent-input-row">
      <textarea id="agent-input" placeholder="Escribe aquí… (Enter para enviar)" rows="1"></textarea>
      <button id="agent-send">↑</button>
    </div>`
  document.body.appendChild(panel)

  document.getElementById('agent-close').onclick = togglePanel

  const input = document.getElementById('agent-input')
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  })

  document.getElementById('agent-send').onclick = sendMessage

  document.querySelectorAll('.agent-quick-btn').forEach(b => {
    b.onclick = () => {
      document.getElementById('agent-input').value = b.dataset.msg
      sendMessage()
    }
  })

  // Mensaje de bienvenida
  addMessage('assistant', '¡Hola! Soy el asistente del Hotel Betania. Puedo ayudarte con check-ins, buscar reservas, consultar disponibilidad y más. ¿Qué necesitas?')
}

function togglePanel() {
  isOpen = !isOpen
  document.getElementById('agent-panel').classList.toggle('open', isOpen)
  if (isOpen) setTimeout(() => document.getElementById('agent-input').focus(), 100)
}

function addMessage(role, content, isThinking = false) {
  const wrap = document.getElementById('agent-messages')
  const div  = document.createElement('div')
  div.className = `agent-msg agent-msg-${role}${isThinking ? ' agent-thinking' : ''}`
  div.innerHTML = formatContent(content)
  wrap.appendChild(div)
  wrap.scrollTop = wrap.scrollHeight
  return div
}

function addAction(label) {
  const wrap = document.getElementById('agent-messages')
  const div  = document.createElement('div')
  div.className = 'agent-action'
  div.textContent = label
  wrap.appendChild(div)
  wrap.scrollTop = wrap.scrollHeight
  return div
}

function formatContent(text) {
  // Markdown mínimo: negrita, saltos de línea, listas
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>')
    .replace(/^[-•] (.+)/gm, '<span class="agent-li">• $1</span>')
}

async function sendMessage() {
  if (thinking) return
  const input   = document.getElementById('agent-input')
  const text    = input.value.trim()
  if (!text) return

  input.value  = ''
  input.style.height = 'auto'

  addMessage('user', text)
  messages.push({ role: 'user', content: text })

  thinking = true
  document.getElementById('agent-send').disabled = true

  const thinkingDiv = addMessage('assistant', '…', true)

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    })

    if (!res.ok) throw new Error(`Error ${res.status}`)
    const data = await res.json()

    // Quitar el "pensando…"
    thinkingDiv.remove()

    // Mostrar acciones ejecutadas
    for (const action of (data.actions ?? [])) {
      const label = TOOL_LABELS[action.tool] ?? `⚙ ${action.tool}`
      const chip  = addAction(label.replace('…', ' ✓'))
    }

    // Navegar si el agente lo pide
    if (data.navigate?.view) {
      window.goTo(data.navigate.view, data.navigate.id)
    }

    // Respuesta final
    const reply = data.text || '(sin respuesta)'
    addMessage('assistant', reply)
    messages.push({ role: 'assistant', content: reply })

  } catch (err) {
    thinkingDiv.remove()
    addMessage('assistant', `⚠ Error: ${err.message}`)
  } finally {
    thinking = false
    document.getElementById('agent-send').disabled = false
    document.getElementById('agent-input').focus()
  }
}
