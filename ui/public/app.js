const $ = (selector) => document.querySelector(selector)
const goal = $("#goal")
const runButton = $("#run")
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
}
function inlineMarkdown(value) {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>")
}
function renderMarkdown(value) {
  return value.trim().split(/\n{2,}/).map((block) => {
    if (/^[-*] /m.test(block)) return `<ul>${block.split("\n").filter(Boolean).map((line) => `<li>${inlineMarkdown(line.replace(/^[-*] /, ""))}</li>`).join("")}</ul>`
    return `<p>${inlineMarkdown(block).replace(/\n/g, "<br>")}</p>`
  }).join("")
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
  if (part.tool === "culture_list") return ["Dataset scanned", "culture_list()"]
  if (part.tool === "culture_search") return ["Search", `culture_search(${JSON.stringify(input.query || "")})`]
  if (part.tool === "culture_read") return ["Read", input.path || "Approved dataset file"]
  if (part.tool === "culture_save") return ["Result saved", "Approved output directory"]
  return [part.tool || "Tool used", ""]
}

// Conversation state: one session holds several turns (prompt + OpenCode events). The panels show the active turn.
let current = null
let active = 0
let stream = null

function resetPanels() {
  trace.innerHTML = '<div class="empty">Enter a goal to see OpenCode’s observable tool events.</div>'
  result.className = "result empty"; result.textContent = "The agent’s final answer will appear here."
  evidence.className = "evidence empty"; evidence.textContent = "No source files read yet."
  runState.textContent = "Waiting"; runState.className = "run-state"
  turnTabs.hidden = true; turnTabs.innerHTML = ""
}
function renderTurn(turn) {
  trace.innerHTML = ""
  addTrace("Goal received", turn.prompt, turn.finished ? "success" : "running")
  const files = new Set()
  let answer = ""
  for (const event of turn.events) {
    if (event.type === "tool_use" && event.part) {
      const [title, detail] = describeTool(event.part)
      addTrace(title, detail)
      if (event.part.tool === "culture_read" && event.part.state?.input?.path) files.add(event.part.state.input.path)
    } else if (event.type === "text" && event.part?.text) {
      answer = event.part.text
    }
  }
  if (files.size >= 2) addTrace("Multiple sources reviewed", `${files.size} files read`, "success")
  if (answer) addTrace("Final answer generated")
  if (turn.finished) turn.error ? addTrace("Agent run stopped", turn.error, "warning") : addTrace("Completed")
  if (answer) { result.className = "result"; result.innerHTML = renderMarkdown(answer) }
  else {
    result.className = "result empty"
    result.textContent = turn.finished ? (turn.error || "Agent run did not complete.") : "The agent is working…"
  }
  if (files.size) { evidence.className = "evidence"; evidence.innerHTML = [...files].map((file) => `<div class="evidence-item"><span>✓</span><code>${escapeHtml(file)}</code></div>`).join("") }
  else { evidence.className = "evidence empty"; evidence.textContent = "No source files read yet." }
  runState.textContent = !turn.finished ? "● Agent running" : turn.error ? "Stopped" : "Completed"
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
    const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, sessionId: current?.id }) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || "Could not start the agent")
    if (!current || current.id !== body.sessionId) current = { id: body.sessionId, turns: [] }
    const turn = { runId: body.runId, prompt, events: [], finished: false, error: null }
    current.turns.push(turn); active = current.turns.length - 1
    goal.value = ""
    render(); attachStream(current, turn); loadSessions()
  } catch (error) {
    runButton.disabled = false
    trace.innerHTML = ""; addTrace("Could not start Agent", error.message, "warning")
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
    const endpoints = data.policy.network.endpoints.map((endpoint) => `${endpoint.host}:${endpoint.port}`).join(", ") || "No approved endpoint"
    security.innerHTML = securityRow("Filesystem", [
      ["input", policyPath(ro, "/workspace/hackathon/input") ? "READ ONLY" : "NOT GRANTED"],
      ["output", policyPath(rw, "/workspace/hackathon/output") ? "READ / WRITE" : "NOT GRANTED"],
      ["restricted", data.policy.filesystem.restrictedByAllowlist ? "BLOCKED" : "CHECK POLICY"],
      ["secrets", data.policy.filesystem.restrictedByAllowlist ? "BLOCKED" : "CHECK POLICY"],
    ]) + securityRow("Network", [
      ["approved endpoints", endpoints],
      ["external access", "RESTRICTED TO POLICY"],
    ], "blue") + securityRow("Agent guardrails", [
      ["tool permission", data.agent.customToolsOnly ? "culture_* ONLY" : "CHECK CONFIG"],
      ["injection guard", data.agent.guardrails ? "ENABLED" : "CHECK CONFIG"],
    ])
    policyState.textContent = "● Policy effective"; policyState.className = "policy-state good"
  } catch (error) {
    security.innerHTML = `<div class="empty">Security policy could not be read: ${escapeHtml(error.message)}</div>`
    policyState.textContent = "Policy unavailable"; policyState.className = "policy-state bad"
  }
}
async function loadHealth() {
  try {
    const response = await fetch("/api/health")
    if (!response.ok) throw new Error()
    healthBadge.className = "status-badge online"; healthBadge.innerHTML = "<span></span>OpenShell Secured"
  } catch {
    healthBadge.className = "status-badge offline"; healthBadge.innerHTML = "<span></span>Agent Offline"
  }
}
runButton.addEventListener("click", startRun)
newSessionButton.addEventListener("click", newSession)
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
document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", () => { goal.value = button.dataset.demo; goal.focus() }))
loadHealth(); loadSecurity(); loadSessions()
