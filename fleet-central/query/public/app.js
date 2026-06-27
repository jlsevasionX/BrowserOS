const $ = (s) => document.querySelector(s)
const status = (m) => { $('#status').textContent = m || '' }

function getToken() {
  let t = localStorage.getItem('fleet_token')
  if (!t) {
    t = prompt('Query token (Bearer):') || ''
    localStorage.setItem('fleet_token', t)
  }
  return t
}

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } })
  if (res.status === 401) {
    localStorage.removeItem('fleet_token')
    throw new Error('unauthorized — reload to re-enter token')
  }
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

function commonQuery() {
  const now = Date.now()
  const span = Number($('#range').value)
  const p = new URLSearchParams({ from: String(now - span), to: String(now) })
  for (const k of ['device', 'channel', 'os']) {
    const v = $(`#${k}`).value
    if (v) p.set(k === 'device' ? 'device_id' : k, v)
  }
  return p
}

function table(rows, cols, opts = {}) {
  const t = document.createElement('table')
  t.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>`
  const tb = document.createElement('tbody')
  for (const r of rows) {
    const tr = document.createElement('tr')
    if (opts.onClick) { tr.className = 'clickable'; tr.onclick = () => opts.onClick(r) }
    for (const c of cols) {
      const td = document.createElement('td')
      td.textContent = String(c.get(r))
      tr.appendChild(td)
    }
    tb.appendChild(tr)
  }
  t.appendChild(tb)
  return t
}

function lineChart(el, points) {
  el.innerHTML = ''
  if (!points.length) { el.textContent = 'No data'; return }
  const xs = points.map((p, i) => i)
  const ys = points.map((p) => p.navigations)
  const labels = points.map((p) => p.bucket)
  // eslint-disable-next-line no-undef
  new uPlot(
    { width: el.clientWidth || 800, height: 240,
      scales: { x: { time: false } },
      axes: [{ values: (_u, vals) => vals.map((v) => labels[v] ?? '') }, {}],
      series: [{}, { label: 'navigations', stroke: '#5ab0ff', width: 2 }] },
    [xs, ys], el,
  )
}

const renderers = {
  async usage(el) {
    const { data } = await api(`/v1/insights/usage?bucket=hour&${commonQuery()}`)
    el.innerHTML = '<h3>Navigations</h3><div id="navchart" class="uplot"></div><h3>Top hosts</h3>'
    lineChart($('#navchart'), data.navigations)
    el.appendChild(table(data.top_hosts, [
      { label: 'Host', get: (r) => r.host || '(none)' },
      { label: 'Requests', get: (r) => r.requests },
    ]))
  },
  async agent(el) {
    const { data } = await api(`/v1/insights/agent-activity?${commonQuery()}`)
    el.innerHTML = '<h3>Tools</h3>'
    el.appendChild(table(data.tools, [
      { label: 'Tool', get: (r) => r.tool || '(none)' },
      { label: 'Execs', get: (r) => r.executions },
      { label: 'Error rate', get: (r) => `${(r.error_rate * 100).toFixed(1)}%` },
      { label: 'p50 ms', get: (r) => r.p50_ms.toFixed(0) },
      { label: 'p95 ms', get: (r) => r.p95_ms.toFixed(0) },
    ]))
    const h = document.createElement('h3'); h.textContent = 'MCP scopes'; el.appendChild(h)
    el.appendChild(table(data.mcp_scopes, [
      { label: 'Scope', get: (r) => r.scope_id || '(none)' },
      { label: 'Requests', get: (r) => r.requests },
    ]))
  },
  async health(el) {
    const { data } = await api(`/v1/insights/health?${commonQuery()}`)
    el.innerHTML = `<h3>Status families</h3>`
    el.appendChild(table(data.status_families, [
      { label: 'Family', get: (r) => r.status_family },
      { label: 'Count', get: (r) => r.count },
    ]))
    const h1 = document.createElement('h3'); h1.textContent = `Errors captured: ${data.error_count}`
    el.appendChild(h1)
    const h2 = document.createElement('h3'); h2.textContent = 'Top failing hosts'; el.appendChild(h2)
    el.appendChild(table(data.top_failing_hosts, [
      { label: 'Host', get: (r) => r.host || '(none)' },
      { label: 'Failures', get: (r) => r.failures },
    ]))
    const h3 = document.createElement('h3'); h3.textContent = 'Slowest requests'; el.appendChild(h3)
    el.appendChild(table(data.slowest, [
      { label: 'URL', get: (r) => r.url || '(none)' },
      { label: 'Total ms', get: (r) => r.total_ms.toFixed(0) },
    ]))
  },
  async explore(el) {
    const { data } = await api(`/v1/events?limit=100&${commonQuery()}`)
    el.innerHTML = '<h3>Recent events</h3>'
    el.appendChild(table(data, [
      { label: 'Time', get: (r) => r.ts },
      { label: 'Type', get: (r) => r.type },
      { label: 'Host', get: (r) => r.host || '' },
      { label: 'URL', get: (r) => (r.url || '').slice(0, 80) },
    ], {
      onClick: async (r) => {
        el.querySelectorAll('pre').forEach((p) => p.remove())
        const { data: full } = await api(`/v1/events/${encodeURIComponent(r.event_id)}`)
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(full, null, 2)
        el.appendChild(pre)
        pre.scrollIntoView({ behavior: 'smooth' })
      },
    }))
  },
}

let current = 'usage'
async function render() {
  const el = $(`#${current}`)
  status('Loading…')
  try { await renderers[current](el); status('') }
  catch (e) { status(String(e.message || e)); el.innerHTML = `<p>${e.message || e}</p>` }
}

async function loadFacets() {
  try {
    const { data } = await api('/v1/meta')
    const fill = (sel, vals) => {
      for (const v of vals) {
        const o = document.createElement('option'); o.value = v; o.textContent = v
        $(sel).appendChild(o)
      }
    }
    fill('#device', data.devices)
    fill('#channel', data.channels)
    fill('#os', data.oses)
  } catch (e) { status(String(e.message || e)) }
}

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'))
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'))
    b.classList.add('active')
    current = b.dataset.tab
    $(`#${current}`).classList.add('active')
    render()
  }
}
$('#reload').onclick = render
$('#range').onchange = render
for (const k of ['device', 'channel', 'os']) $(`#${k}`).onchange = render

await loadFacets()
await render()
