import { tool } from "@opencode-ai/plugin"
import fs from "node:fs/promises"
import path from "node:path"

const INPUT_ROOT = "/workspace/hackathon/input"
const OUTPUT_ROOT = "/workspace/hackathon/output"

async function safeInputPath(relativePath: string) {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed")
  }

  const candidate = path.resolve(INPUT_ROOT, relativePath)

  if (
    candidate !== INPUT_ROOT &&
    !candidate.startsWith(INPUT_ROOT + path.sep)
  ) {
    throw new Error("Path escapes the allowed input directory")
  }

  const real = await fs.realpath(candidate)

  if (
    real !== INPUT_ROOT &&
    !real.startsWith(INPUT_ROOT + path.sep)
  ) {
    throw new Error("Resolved path escapes the allowed input directory")
  }

  return real
}

async function walk(dir: string, base = INPUT_ROOT): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const result: string[] = []

  for (const entry of entries) {
    const full = path.join(dir, entry.name)

    if (entry.isSymbolicLink()) {
      continue
    }

    if (entry.isDirectory()) {
      result.push(...await walk(full, base))
    } else if (entry.isFile()) {
      result.push(path.relative(base, full))
    }
  }

  return result
}

export const list = tool({
  description:
    "List files available in the approved Korean culture/history input dataset.",

  args: {},

  async execute() {
    const files = await walk(INPUT_ROOT)
    return files.sort().join("\n")
  }
})

export const read = tool({
  description:
    "Read one approved Korean culture/history input file. Only relative paths returned by culture_list are accepted.",

  args: {
    path: tool.schema.string().describe(
      "Relative path inside the approved input directory"
    )
  },

  async execute(args) {
    const file = await safeInputPath(args.path)

    const stat = await fs.stat(file)

    if (!stat.isFile()) {
      throw new Error("Requested path is not a regular file")
    }

    if (stat.size > 1024 * 1024) {
      throw new Error("File exceeds 1 MiB safety limit")
    }

    return await fs.readFile(file, "utf8")
  }
})

export const search = tool({
  description:
    "Search text in the approved Korean culture/history dataset.",

  args: {
    query: tool.schema.string()
      .min(1)
      .max(200)
      .describe("Text to search for")
  },

  async execute(args) {
    const files = await walk(INPUT_ROOT)

    const supported = files.filter((file) =>
      /\.(md|txt|json|csv)$/i.test(file)
    )

    const query = args.query.toLowerCase()
    const matches: string[] = []

    for (const relative of supported) {
      if (matches.length >= 50) break

      try {
        const full = await safeInputPath(relative)
        const stat = await fs.stat(full)

        if (stat.size > 1024 * 1024) {
          continue
        }

        const content = await fs.readFile(full, "utf8")
        const lines = content.split(/\r?\n/)

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            matches.push(
              `${relative}:${i + 1}: ${lines[i].slice(0, 300)}`
            )

            if (matches.length >= 50) break
          }
        }
      } catch {
        // Skip unreadable files.
      }
    }

    if (matches.length === 0) {
      return "No matches found."
    }

    return matches.join("\n")
  }
})

export const save = tool({
  description:
    "Save the final agent result to the approved output directory.",

  args: {
    content: tool.schema.string().describe(
      "Final answer to save"
    )
  },

  async execute(args) {
    const target = path.join(OUTPUT_ROOT, "final-answer.md")

    await fs.writeFile(target, args.content, {
      encoding: "utf8"
    })

    return "OK"
  }
})

type EvidenceSource = {
  id: string
  path: string
  date: string | null
  excerpt: string
  value: string | null
  authority: "HIGH" | "MEDIUM" | "LOW"
  freshness: "HIGH" | "MEDIUM" | "LOW"
  specificity: number
  relevance: number
  score: number
}

function dateFromText(text: string, pathName: string): string | null {
  return text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ??
    pathName.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null
}

function authorityFromText(text: string, pathName: string): EvidenceSource["authority"] {
  const source = `${pathName}\n${text}`
  if (/상인회 공지|공식\s*(공지|자료|기록)|관공서|기관\s*공지/.test(source)) return "HIGH"
  if (/블로그|커뮤니티|광고|초안|draft|cache/i.test(source)) return "LOW"
  return "MEDIUM"
}

function daysBetween(from: string, to: string): number | undefined {
  const first = Date.parse(`${from}T00:00:00Z`)
  const second = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(first) || Number.isNaN(second)) return undefined
  return Math.abs(second - first) / 86_400_000
}

function freshnessFromDate(date: string | null, asOf: string): EvidenceSource["freshness"] {
  if (!date) return "LOW"
  const days = daysBetween(date, asOf)
  if (days === undefined) return "LOW"
  if (days <= 7) return "HIGH"
  if (days <= 365) return "MEDIUM"
  return "LOW"
}

/**
 * Compare approved documents with transparent, deterministic components.
 * This is deliberately separate from model judgement so a conflict can be
 * displayed and audited as structured JSON in the UI.
 */
export const evidence_score = tool({
  description:
    "Score and compare approved input documents for one factual claim. Use when sources conflict or recency/authority determines the answer. `sources_json` must be a JSON array of relative input paths, for example [\"local/market_notice_2026-10-06.txt\", \"local/market_blog_cache_2025.md\"]. Returns structured JSON with the selected source, excluded sources, component scores, confidence, and conflict flag.",

  args: {
    claim: tool.schema.string().min(3).max(300).describe("Factual claim being compared"),
    sources_json: tool.schema.string().min(5).max(4000).describe("JSON array of relative paths returned by culture_list"),
    as_of: tool.schema.string().max(10).optional().describe("Optional YYYY-MM-DD date relevant to the user's request")
  },

  async execute(args) {
    let paths: string[]
    try {
      const parsed = JSON.parse(args.sources_json)
      if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 10 || !parsed.every((p) => typeof p === "string")) {
        throw new Error()
      }
      paths = [...new Set(parsed)]
    } catch {
      throw new Error("sources_json must be a JSON array containing 2 to 10 approved relative paths")
    }

    const asOf = /^20\d{2}-\d{2}-\d{2}$/.test(args.as_of ?? "")
      ? args.as_of!
      : new Date().toISOString().slice(0, 10)
    const claimTerms = args.claim.toLowerCase().split(/\s+/).filter((term) => term.length >= 2)
    const sources: EvidenceSource[] = []

    for (const [index, relativePath] of paths.entries()) {
      const file = await safeInputPath(relativePath)
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > 1024 * 1024) {
        throw new Error(`Invalid evidence file: ${relativePath}`)
      }
      const content = await fs.readFile(file, "utf8")
      const date = dateFromText(content, relativePath)
      const authority = authorityFromText(content, relativePath)
      const freshness = freshnessFromDate(date, asOf)
      const authorityScore = authority === "HIGH" ? 40 : authority === "MEDIUM" ? 25 : 10
      const freshnessScore = freshness === "HIGH" ? 30 : freshness === "MEDIUM" ? 15 : 5
      const hasTime = /\b\d{1,2}:\d{2}\s*[–~-]\s*\d{1,2}:\d{2}\b/.test(content)
      const exactDate = date === asOf || (date !== null && daysBetween(date, asOf)! <= 7)
      const specificity = Math.min(20, (hasTime ? 10 : 0) + (exactDate ? 10 : 0))
      const matchingTerms = claimTerms.filter((term) => content.toLowerCase().includes(term)).length
      const relevance = Math.min(10, matchingTerms >= 2 ? 10 : matchingTerms === 1 || hasTime ? 6 : 2)
      const time = content.match(/\b\d{1,2}:\d{2}\s*[–~-]\s*\d{1,2}:\d{2}\b/)?.[0]?.replace(/\s/g, "") ?? null
      const excerptLine = content.split(/\r?\n/).find((line) => time ? line.includes(time.replace("–", "–")) : line.trim()) ?? content
      sources.push({
        id: `source-${String.fromCharCode(97 + index)}`,
        path: relativePath,
        date,
        excerpt: excerptLine.trim().slice(0, 300),
        value: time,
        authority,
        freshness,
        specificity,
        relevance,
        score: authorityScore + freshnessScore + specificity + relevance
      })
    }

    const ranked = [...sources].sort((a, b) => b.score - a.score)
    const selected = ranked[0]
    const values = new Set(sources.map((source) => source.value).filter(Boolean))
    const conflict = values.size > 1
    const gap = selected.score - (ranked[1]?.score ?? 0)
    const confidence = selected.score >= 75 && gap >= 15 ? "high" : selected.score >= 50 ? "medium" : "low"
    const freshnessDays = selected.date ? daysBetween(selected.date, asOf) : undefined
    const reason = `${selected.authority === "HIGH" ? "공식 출처" : selected.authority === "MEDIUM" ? "검토 가능한 출처" : "비공식 출처"}이며 ${freshnessDays !== undefined ? `${Math.round(freshnessDays)}일 전 자료` : "날짜를 확인할 수 없는 자료"}로, authority·freshness·specificity·relevance 합계가 가장 높습니다.`

    return JSON.stringify({
      claim: args.claim,
      as_of: asOf,
      conflict,
      selected,
      excluded: ranked.slice(1),
      confidence,
      reason,
      scoring: "authority + freshness + specificity + relevance"
    }, null, 2)
  }
})
