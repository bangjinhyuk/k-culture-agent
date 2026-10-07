const $ = (selector) => document.querySelector(selector)
const goal = $("#goal")
const runButton = $("#run")
const modelSelect = $("#model")
const trace = $("#trace")
const result = $("#result")
const evidence = $("#evidence")
const runState = $("#run-state")
const healthBadge = $("#health-badge")
const security = $("#security")
const policyState = $("#policy-state")
const turnTabs = $("#turn-tabs")
const sessionList = $("#session-list")
const newSessionButton = $("#new-session")
const scoreSection = $("#score-section")
const scoreResult = $("#score-result")
const securityVerification = $("#security-verification")
const introPanel = $("#intro-panel")
const demoPanel = $("#demo-panel")

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
}
// Markdown renderer for the agent answer. Input is HTML-escaped first, so model output cannot inject markup.
function inlineMarkdown(value) {
  const codes = []
  const text = escapeHtml(value)
    .replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000` })
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[index]}</code>`)
}
function renderList(items) {
  let html = ""
  const stack = []
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul"
    while (stack.length && item.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`
    const top = stack[stack.length - 1]
    if (top && top.indent === item.indent) {
      html += "</li>"
      if (top.tag !== tag) { html += `</${stack.pop().tag}><${tag}>`; stack.push({ indent: item.indent, tag }) }
    } else {
      html += `<${tag}>`; stack.push({ indent: item.indent, tag })
    }
    html += `<li>${inlineMarkdown(item.text)}`
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`
  return html
}
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
function tableCells(line) { return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()) }
function renderMarkdown(value) {
  const lines = value.replace(/\r/g, "").split("\n")
  const out = []
  const startsBlock = (line, next) => /^\s*(```|#{1,6}\s|>)/.test(line) || LIST_ITEM.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next))
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^\s*```/.test(line)) {
      const code = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      i++
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`)
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length
      out.push(`<h${level}>${inlineMarkdown(line.replace(/^#+\s+/, "").replace(/\s+#+\s*$/, ""))}</h${level}>`)
      i++
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>"); i++
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const head = tableCells(line)
      const rows = []
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(tableCells(lines[i]))
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((_, col) => `<td>${inlineMarkdown(row[col] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`)
    } else if (/^\s*>/.test(line)) {
      const quote = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""))
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`)
    } else if (LIST_ITEM.test(line)) {
      const items = []
      for (; i < lines.length && lines[i].trim() && LIST_ITEM.test(lines[i]); i++) {
        const [, indent, marker, text] = lines[i].match(LIST_ITEM)
        items.push({ indent: indent.replace(/\t/g, "    ").length, ordered: /\d/.test(marker), text })
      }
      out.push(renderList(items))
    } else {
      const paragraph = []
      for (; i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines[i], lines[i + 1])); i++) paragraph.push(lines[i].trim())
      out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`)
    }
  }
  return out.join("")
}
function addTrace(title, detail = "", kind = "success") {
  if (trace.querySelector(".empty")) trace.innerHTML = ""
  const item = document.createElement("div")
  item.className = `trace-item ${kind}`
  item.innerHTML = `<span class="trace-mark">${kind === "running" ? "●" : kind === "warning" ? "!" : "✓"}</span><div><strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</div>`
  trace.append(item)
  trace.scrollTop = trace.scrollHeight
}
function describeTool(part) {
  const input = part.state?.input || {}
  if (part.tool === "culture_list") return ["데이터셋 목록 조회", "culture_list()"]
  if (part.tool === "culture_search") return ["자료 검색", `culture_search(${JSON.stringify(input.query || "")})`]
  if (part.tool === "culture_read") return ["근거 파일 읽기", input.path || "허용된 데이터셋 파일"]
  if (part.tool === "culture_save") return ["결과 저장", "허용된 output 경로"]
  if (part.tool === "culture_evidence_score") return ["Evidence Scoring", "출처 신뢰도 · 최신성 · 구체성 · 관련성"]
  return [part.tool || "도구 사용", ""]
}

function readScore(part) {
  if (part.tool !== "culture_evidence_score") return null
  const output = part.state?.output
  if (typeof output !== "string") return null
  try { return JSON.parse(output) } catch { return null }
}
function scoreSource(source) {
  if (!source) return ""
  const meta = [source.authority, source.freshness, source.score !== undefined ? `${source.score}/100` : ""].filter(Boolean).join(" · ")
  return `<b>${escapeHtml(source.value || source.path || "선택 자료")}</b><span>${escapeHtml(source.path || "")}</span><small>${escapeHtml(meta)}${source.date ? ` · ${escapeHtml(source.date)}` : ""}</small>`
}
function renderScore(score) {
  if (!score) { scoreSection.hidden = true; scoreResult.innerHTML = ""; return }
  scoreSection.hidden = false
  const excluded = Array.isArray(score.excluded) ? score.excluded : []
  scoreResult.innerHTML = `<div class="score-live"><div class="selected-live"><span>선택 · ${escapeHtml(score.confidence || "unrated")} confidence</span>${scoreSource(score.selected)}<small>${escapeHtml(score.reason || "")}</small></div><div class="excluded-live"><span>${score.conflict ? "충돌 발견 · 배제" : "비교한 자료"}</span>${excluded.length ? excluded.map(scoreSource).join("") : "<small>배제된 자료 없음</small>"}</div></div>`
}

// Conversation state: one session holds several turns (prompt + OpenCode events). The panels show the active turn.
let current = null
let active = 0
let stream = null

function resetPanels() {
  trace.innerHTML = '<div class="empty">목표를 입력하면 OpenCode의 도구 실행 과정이 표시됩니다.</div>'
  result.className = "result empty"; result.textContent = "Agent의 최종 답변이 이곳에 표시됩니다."
  evidence.className = "evidence empty"; evidence.textContent = "아직 읽은 파일이 없습니다."
  renderScore(null)
  runState.textContent = "대기 중"; runState.className = "run-state"
  turnTabs.hidden = true; turnTabs.innerHTML = ""
}
function priorReadCount() {
  if (!current) return 0
  const files = new Set()
  current.turns.slice(0, active).forEach((turn) => {
    turn.events.forEach((event) => {
      const path = event.type === "tool_use" && event.part?.tool === "culture_read"
        ? event.part.state?.input?.path : null
      if (path) files.add(path)
    })
  })
  return files.size
}
function renderTurn(turn) {
  trace.innerHTML = ""
  addTrace("목표 수신", turn.prompt, turn.finished ? "success" : "running")
  const files = new Map()
  let answer = ""
  let score = null
  for (const event of turn.events) {
    if (event.type === "tool_use" && event.part) {
      const [title, detail] = describeTool(event.part)
      addTrace(title, detail)
      if (event.part.tool === "culture_read" && event.part.state?.input?.path) {
        const path = event.part.state.input.path
        const output = event.part.state?.output
        files.set(path, Boolean(files.get(path)) || (typeof output === "string" && output.includes("[UNTRUSTED_REFERENCE_DETECTED]")))
      }
      score = readScore(event.part) || score
    } else if (event.type === "text" && event.part?.text) {
      answer = event.part.text
    }
  }
  if (files.size >= 2) addTrace("복수 출처 읽음", `${files.size}개 파일 읽음`, "success")
  if (answer) addTrace("최종 답변 생성")
  if (turn.finished) turn.error ? addTrace("Agent 실행 중단", turn.error, "warning") : addTrace("완료")
  if (answer) { result.className = "result"; result.innerHTML = renderMarkdown(answer) }
  else {
    result.className = "result empty"
    result.textContent = turn.finished ? (turn.error || "Agent 실행이 완료되지 않았습니다.") : "Agent가 조사 중입니다…"
  }
  if (files.size) {
    evidence.className = "evidence"
    evidence.innerHTML = [...files].map(([file, injection]) => {
      return `<div class="evidence-item${injection ? " injection-evidence" : ""}"><span>${injection ? "⚠" : "✓"}</span><code>${escapeHtml(file)}</code>${injection ? '<b>Prompt Injection 감지</b>' : ""}</div>`
    }).join("")
  }
  else {
    const previous = priorReadCount()
    evidence.className = "evidence empty"
    evidence.textContent = previous
      ? `이번 실행에서는 파일을 새로 읽지 않았습니다. 이전 실행에서 읽은 ${previous}개 파일은 상단 실행 탭에서 확인할 수 있습니다.`
      : "이번 실행에서 읽은 파일이 없습니다."
  }
  renderScore(score)
  runState.textContent = !turn.finished ? "● Agent 실행 중" : turn.error ? "중단됨" : "완료"
  runState.className = `run-state ${!turn.finished ? "running" : turn.error ? "" : "done"}`
}
function render() {
  if (!current || !current.turns.length) { resetPanels(); return }
  turnTabs.hidden = current.turns.length < 2
  turnTabs.innerHTML = current.turns.map((turn, index) => `<button type="button" class="turn-tab${index === active ? " active" : ""}" data-turn="${index}" title="${escapeHtml(turn.prompt)}">${index + 1}. ${escapeHtml(turn.prompt)}</button>`).join("")
  renderTurn(current.turns[active])
  runButton.disabled = current.turns.some((turn) => !turn.finished)
}
function attachStream(session, turn) {
  stream?.close()
  turn.events = [] // the server replays every event of the run
  const events = stream = new EventSource(`/api/runs/${turn.runId}/events`)
  const live = () => current === session && session.turns[active] === turn
  events.addEventListener("opencode", (message) => { turn.events.push(JSON.parse(message.data)); if (live()) renderTurn(turn) })
  events.addEventListener("runtime", (message) => { if (live()) addTrace("Runtime output", JSON.parse(message.data).message, "warning") })
  events.addEventListener("complete", (message) => {
    const done = JSON.parse(message.data)
    events.close(); if (stream === events) stream = null
    turn.finished = true; turn.error = done.ok ? null : (done.error || "Unknown error")
    if (current === session) render()
    loadSessions()
  })
}
async function startRun() {
  const prompt = goal.value.trim()
  if (!prompt) { goal.focus(); return }
  runButton.disabled = true
  try {
    const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, sessionId: current?.id, model: modelSelect.value }) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || "Could not start the agent")
    if (!current || current.id !== body.sessionId) current = { id: body.sessionId, turns: [] }
    const turn = { runId: body.runId, prompt, model: modelSelect.value, events: [], finished: false, error: null }
    current.turns.push(turn); active = current.turns.length - 1
    goal.value = ""
    render(); attachStream(current, turn); loadSessions()
  } catch (error) {
    runButton.disabled = false
    trace.innerHTML = ""; addTrace("Agent를 시작할 수 없음", error.message, "warning")
    result.className = "result empty"; result.textContent = error.message
  }
}
async function openSession(id) {
  const response = await fetch(`/api/sessions/${id}`)
  if (!response.ok) { await loadSessions(); return }
  stream?.close(); stream = null
  current = await response.json(); active = current.turns.length - 1
  render()
  const last = current.turns[active]
  if (last && !last.finished) attachStream(current, last)
  renderSessionList()
}
function newSession() {
  stream?.close(); stream = null
  current = null; active = 0
  render(); renderSessionList(); runButton.disabled = false; goal.focus()
}
function switchMainTab(name) {
  const isIntro = name === "intro"
  introPanel.hidden = !isIntro
  demoPanel.hidden = isIntro
  document.querySelectorAll("[data-main-tab]").forEach((button) => button.classList.toggle("active", button.dataset.mainTab === name))
}
async function runSecurityAttempt(kind) {
  const labels = kind === "secret"
    ? { attempt: "/workspace/hackathon/secrets/service_key.env", policy: "OpenShell Filesystem Policy" }
    : { attempt: "https://validation-kculture.example", policy: "OpenShell Network Policy" }
  securityVerification.hidden = false
  securityVerification.innerHTML = `<div class="verification-title">SECURITY VERIFICATION</div><div class="verification-grid"><div><span>Attempt</span><code>${escapeHtml(labels.attempt)}</code></div><div><span>Result</span><b>검증 중…</b></div><div><span>Enforced by</span><b>${labels.policy}</b></div></div>`
  try {
    const response = await fetch(`/api/security/attempt-${kind}`, { method: "POST" })
    const body = await response.json()
    const result = body.blocked ? "🚫 ACCESS DENIED" : "⚠ 정책 확인 필요"
    securityVerification.innerHTML = `<div class="verification-title">SECURITY VERIFICATION</div><div class="verification-grid"><div><span>Attempt</span><code>${escapeHtml(body.attempt || labels.attempt)}</code></div><div><span>Result</span><b class="${body.blocked ? "denied" : ""}">${result}</b></div><div><span>Enforced by</span><b>${escapeHtml(body.enforcedBy || labels.policy)}</b></div></div>`
  } catch (error) {
    securityVerification.innerHTML = `<div class="verification-title">SECURITY VERIFICATION</div><p class="empty">검증 요청 실패: ${escapeHtml(error.message)}</p>`
  }
}
async function deleteSession(id) {
  const response = await fetch(`/api/sessions/${id}`, { method: "DELETE" })
  if (!response.ok) { alert((await response.json()).error || "삭제하지 못했습니다."); return }
  if (current?.id === id) newSession()
  loadSessions()
}
let sessions = []
function formatTime(ms) { return new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }
function renderSessionList() {
  if (!sessions.length) { sessionList.innerHTML = '<div class="empty">아직 대화가 없습니다.</div>'; return }
  sessionList.innerHTML = sessions.map((item) => `<div class="session-item${item.id === current?.id ? " active" : ""}" role="button" tabindex="0" data-session="${escapeHtml(item.id)}"><span class="session-title">${escapeHtml(item.title || "(제목 없음)")}</span><button type="button" class="session-delete" data-delete="${escapeHtml(item.id)}" aria-label="대화 삭제">×</button><span class="session-meta">${item.running ? '<span class="session-live">● 실행 중</span> · ' : ""}${item.turns}턴 · ${formatTime(item.updatedAt)}</span></div>`).join("")
}
async function loadSessions() {
  try { sessions = (await (await fetch("/api/sessions")).json()).sessions } catch { return }
  renderSessionList()
}
function policyPath(paths, target) { return paths.includes(target) }
function securityRow(title, items, tone = "green") { return `<section class="security-block"><h3>${title}</h3>${items.map(([label, value]) => `<div class="security-line"><span>${escapeHtml(label)}</span><b class="${tone}">${escapeHtml(value)}</b></div>`).join("")}</section>` }
async function loadSecurity() {
  try {
    const data = await (await fetch("/api/security")).json()
    if (!data.ok) throw new Error(data.error)
    const ro = data.policy.filesystem.readOnly, rw = data.policy.filesystem.readWrite
    const endpoints = data.policy.network.endpoints.map((endpoint) => `${endpoint.host}:${endpoint.port}`).join(", ") || "허용 endpoint 없음"
    security.innerHTML = securityRow("Filesystem", [
      ["input", policyPath(ro, "/workspace/hackathon/input") ? "읽기 전용" : "권한 없음"],
      ["output", policyPath(rw, "/workspace/hackathon/output") ? "읽기 · 쓰기" : "권한 없음"],
      ["restricted", data.policy.filesystem.restrictedByAllowlist ? "차단됨" : "정책 확인 필요"],
      ["secrets", data.policy.filesystem.restrictedByAllowlist ? "차단됨" : "정책 확인 필요"],
    ]) + securityRow("Network", [
      ["허용 endpoint", endpoints],
      ["외부 접근", "정책 범위로 제한"],
    ], "blue") + securityRow("Agent guardrails", [
      ["도구 권한", data.agent.customToolsOnly ? "culture_* 전용" : "설정 확인 필요"],
      ["Injection 방어", data.agent.guardrails ? "활성화" : "설정 확인 필요"],
    ])
    policyState.textContent = "● Policy 적용됨"; policyState.className = "policy-state good"
  } catch (error) {
    security.innerHTML = `<div class="empty">Security policy를 읽을 수 없습니다: ${escapeHtml(error.message)}</div>`
    policyState.textContent = "정책 조회 불가"; policyState.className = "policy-state bad"
  }
}
async function loadHealth() {
  try {
    const response = await fetch("/api/health")
    if (!response.ok) throw new Error()
    healthBadge.className = "status-badge online"; healthBadge.innerHTML = "<span></span>OpenShell 보호 중"
  } catch {
    healthBadge.className = "status-badge offline"; healthBadge.innerHTML = "<span></span>Agent 오프라인"
  }
}
runButton.addEventListener("click", startRun)
newSessionButton.addEventListener("click", newSession)
document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", () => switchMainTab(button.dataset.mainTab)))
turnTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-turn]")
  if (tab && current) { active = Number(tab.dataset.turn); render() }
})
sessionList.addEventListener("click", (event) => {
  const del = event.target.closest("[data-delete]")
  if (del) { deleteSession(del.dataset.delete); return }
  const item = event.target.closest("[data-session]")
  if (item) openSession(item.dataset.session)
})
sessionList.addEventListener("keydown", (event) => {
  const item = event.target.closest("[data-session]")
  if (item && event.target === item && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openSession(item.dataset.session) }
})
document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", () => {
  if (current?.turns.some((turn) => !turn.finished)) return
  // 각 데모는 이전 대화의 기억을 재사용하지 않는다. 화면의 근거 목록이 이 실행의 실제 읽기 결과만 보여주도록 한다.
  newSession()
  switchMainTab("demo")
  goal.value = button.dataset.demo
  startRun()
}))
$("#attempt-network")?.addEventListener("click", () => runSecurityAttempt("network"))
$("#attempt-secret")?.addEventListener("click", () => runSecurityAttempt("secret"))
async function loadModels() {
  try {
    const { models, default: fallback } = await (await fetch("/api/models")).json()
    const saved = (() => { try { return localStorage.getItem("model") } catch { return null } })()
    modelSelect.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}"${m.available ? "" : " disabled"}>${escapeHtml(m.label)}${m.available ? "" : " (꺼짐)"}</option>`).join("")
    const usable = models.filter((m) => m.available).map((m) => m.id)
    modelSelect.value = usable.includes(saved) ? saved : (usable.includes(fallback) ? fallback : usable[0] || fallback)
  } catch { modelSelect.innerHTML = "" }
}
modelSelect.addEventListener("change", () => { try { localStorage.setItem("model", modelSelect.value) } catch {} })
loadModels(); loadHealth(); loadSecurity(); loadSessions()
