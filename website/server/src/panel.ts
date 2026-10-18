// Panel de métricas: HTML estático que pide el ADMIN_TOKEN y consulta /api/admin/*.
// El token se guarda solo en sessionStorage. La página no contiene datos.
export const PANEL_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Panel · Betan</title>
<style>
:root{--bg:#f2f5f8;--card:#fff;--ink:#0f2a43;--mut:#475a6d;--line:#d3dce5;--pri:#1f4fd8}
@media(prefers-color-scheme:dark){:root{--bg:#0b1826;--card:#122437;--ink:#e8eef5;--mut:#a6b5c5;--line:#24405b;--pri:#6f93ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:20px}
h1{margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 10px}.mut{color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
table{width:100%;border-collapse:collapse}td,th{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:.78rem;text-transform:uppercase;color:var(--mut)}td.n{text-align:right;white-space:nowrap}
.bar{height:8px;background:var(--pri);border-radius:4px;min-width:2px}.big{font-size:2rem;font-weight:800}
input,select,button{font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}button{cursor:pointer;font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
</style></head><body><main>
<h1>Panel de la web</h1><p class="mut">Interacciones anónimas (solo visitantes que aceptaron las cookies) y solicitudes recibidas.</p>
<div class="row"><input id="tok" type="password" placeholder="ADMIN_TOKEN" autocomplete="off"><select id="days"><option value="7">7 días</option><option value="30" selected>30 días</option><option value="90">90 días</option><option value="365">365 días</option></select><button id="go">Cargar</button><a id="csv" href="#" class="mut">Descargar leads (CSV)</a></div>
<p id="msg" class="mut"></p><div id="out" class="grid"></div>
<script>
const $=id=>document.getElementById(id);$('tok').value=sessionStorage.getItem('bt')||'';
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function table(title,rows,cols,total){const mx=Math.max(1,...rows.map(r=>r[cols[cols.length-1]]));
 return '<div class="card"><h2>'+title+'</h2>'+(rows.length?'<table>'+rows.map(r=>'<tr>'+cols.slice(0,-1).map(c=>'<td>'+esc(r[c])+'</td>').join('')+'<td class="n">'+esc(r[cols[cols.length-1]])+(total?' <span class="mut">('+Math.round(100*r[cols[cols.length-1]]/total)+'%)</span>':'')+'</td><td style="width:90px"><div class="bar" style="width:'+Math.round(90*r[cols[cols.length-1]]/mx)+'px"></div></td></tr>').join('')+'</table>':'<p class="mut">Sin datos</p>')+'</div>'}
async function load(){const t=$('tok').value.trim();sessionStorage.setItem('bt',t);$('msg').textContent='Cargando…';
 const h={Authorization:'Bearer '+t},d=$('days').value;
 const [r,l]=await Promise.all([fetch('/api/admin/summary?days='+d,{headers:h}),fetch('/api/admin/leads?limit=15',{headers:h})]);
 if(!r.ok){$('msg').textContent=r.status==401?'Token incorrecto.':'Error '+r.status;$('out').innerHTML='';return}
 const s=await r.json(),leads=(await l.json()).data||[];$('msg').textContent='';const f=s.formFunnel,hv=f.homeViews||1,sc=s.activeSeconds;
 $('out').innerHTML=
 '<div class="card"><h2>Resumen</h2><div class="big">'+s.views+'</div><div class="mut">visitas medidas</div><p>Tiempo activo: mediana <b>'+(sc.p50==null?'—':Math.round(sc.p50)+' s')+'</b> · p75 <b>'+(sc.p75==null?'—':Math.round(sc.p75)+' s')+'</b></p></div>'+
 '<div class="card"><h2>Embudo del formulario (portada)</h2><table>'+[['Visitas a la portada',f.homeViews],['Llegan a «Contacto»',f.reachedContact],['Empiezan el formulario',f.started],['Lo envían',f.submitted],['Enviado con éxito',f.success],['Lo abandonan',f.abandoned]].map(x=>'<tr><td>'+x[0]+'</td><td class="n">'+x[1]+' <span class="mut">('+Math.round(100*x[1]/hv)+'%)</span></td></tr>').join('')+'</table></div>'+
 table('Dispositivo (m=móvil, t=tablet, d=escritorio)',s.devices,['device','n'],s.views)+table('Origen',s.referrers,['ref','n'],s.views)+table('Páginas',s.pages,['path','n'])+
 table('Secciones vistas (visitas que llegan)',s.sections,['target','n'],s.views)+table('Profundidad de scroll (% de visitas)',s.scroll.sort((a,b)=>a.target-b.target),['target','n'],s.views)+
 table('Clics',s.clicks.map(c=>({k:c.target+(c.label?' · '+c.label:''),n:c.n})),['k','n'])+table('FAQ abiertas',s.faq,['label','n'])+
 table('Campos completados',f.fieldsCompleted,['field','n'])+table('Errores de validación',f.invalidFields,['field','n'])+table('Errores JS',s.errors,['target','label','n'])+
 '<div class="card" style="grid-column:1/-1"><h2>Últimas solicitudes</h2>'+(leads.length?'<table><tr><th>Fecha</th><th>Tipo</th><th>Hotel</th><th>Nombre</th><th>Email</th><th>Correo</th></tr>'+leads.map(x=>'<tr><td>'+esc(x.created_at)+'</td><td>'+esc(x.kind)+'</td><td>'+esc(x.hotel)+'</td><td>'+esc(x.name)+'</td><td>'+esc(x.email)+'</td><td>'+esc(x.mail_status)+'</td></tr>').join('')+'</table>':'<p class="mut">Sin solicitudes</p>')+'</div>'}
$('go').onclick=load;$('csv').onclick=async e=>{e.preventDefault();const r=await fetch('/api/admin/leads.csv',{headers:{Authorization:'Bearer '+$('tok').value.trim()}});if(!r.ok)return;const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='leads.csv';a.click()};
if($('tok').value)load();
</script></main></body></html>`
