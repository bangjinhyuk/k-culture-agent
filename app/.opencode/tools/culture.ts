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

    return "Saved result to /workspace/hackathon/output/final-answer.md"
  }
})
