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
let sourceFiles = new Set()
let showedMultipleSources = false

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
function updateEvidence() {
  if (!sourceFiles.size) return
  evidence.classList.remove("empty")
  evidence.innerHTML = [...sourceFiles].map((file) => `<div class="evidence-item"><span>✓</span><code>${escapeHtml(file)}</code></div>`).join("")
  if (sourceFiles.size >= 2 && !showedMultipleSources) {
    showedMultipleSources = true
    addTrace("Multiple sources reviewed", `${sourceFiles.size} files read`, "success")
  }
}
function describeTool(part) {
  const input = part.state?.input || {}
  if (part.tool === "culture_list") return ["Dataset scanned", "culture_list()"]
  if (part.tool === "culture_search") return ["Search", `culture_search(${JSON.stringify(input.query || "")})`]
  if (part.tool === "culture_read") return ["Read", input.path || "Approved dataset file"]
  if (part.tool === "culture_save") return ["Result saved", "Approved output directory"]
  return [part.tool || "Tool used", ""]
}
function processOpenCodeEvent(event) {
  if (event.type === "tool_use" && event.part) {
    const [title, detail] = describeTool(event.part)
    addTrace(title, detail)
    if (event.part.tool === "culture_read" && event.part.state?.input?.path) {
      sourceFiles.add(event.part.state.input.path)
      updateEvidence()
    }
  }
  if (event.type === "text" && event.part?.text) {
    result.classList.remove("empty")
    result.innerHTML = renderMarkdown(event.part.text)
    addTrace("Final answer generated")
  }
}
function setRunning(running) {
  runButton.disabled = running
  runState.textContent = running ? "● Agent running" : "Completed"
  runState.className = `run-state ${running ? "running" : "done"}`
}
async function startRun() {
  const prompt = goal.value.trim()
  if (!prompt) { goal.focus(); return }
  trace.innerHTML = ""
  result.className = "result empty"
  result.textContent = "The agent is working…"
  evidence.className = "evidence empty"
  evidence.textContent = "No source files read yet."
  sourceFiles = new Set(); showedMultipleSources = false
  setRunning(true)
  addTrace("Goal received", prompt, "running")
  try {
    const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || "Could not start the agent")
    const events = new EventSource(`/api/runs/${body.runId}/events`)
    events.addEventListener("opencode", (message) => processOpenCodeEvent(JSON.parse(message.data)))
    events.addEventListener("runtime", (message) => addTrace("Runtime output", JSON.parse(message.data).message, "warning"))
    events.addEventListener("complete", (message) => {
      const done = JSON.parse(message.data)
      events.close(); setRunning(false)
      if (done.ok) addTrace("Completed")
      else { addTrace("Agent run stopped", done.error || "Unknown error", "warning"); result.className = "result empty"; result.textContent = done.error || "Agent run did not complete." }
    })
    events.onerror = () => { if (events.readyState === EventSource.CLOSED) return }
  } catch (error) {
    setRunning(false)
    addTrace("Could not start Agent", error.message, "warning")
    result.className = "result empty"; result.textContent = error.message
  }
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
document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", () => { goal.value = button.dataset.demo; goal.focus() }))
loadHealth(); loadSecurity()
