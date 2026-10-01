import "dotenv/config"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { confirm, input, select } from "@inquirer/prompts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CreateMessageRequestSchema,
  type Prompt,
  type PromptMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { generateText, jsonSchema, stepCountIs, tool as aiTool } from "ai"

// ---------- Configuration ----------

// Le premier modèle est essayé en premier, les suivants servent de secours
// en cas de 503 (modèle saturé). Tu peux changer le premier via GEMINI_MODEL dans .env
const MODELS = [
  process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
  "gemini-2.5-flash",
]

const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY ?? "",
})

const mcp = new Client(
  {
    name: "text-client-video",
    version: "1.0.0",
  },
  { capabilities: { sampling: {} } }
)

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/server.js"],
  stderr: "ignore",
})

// ---------- LLM avec fallback ----------

async function withFallback<T>(
  fn: (modelName: string) => Promise<T>
): Promise<{ result: T; modelName: string }> {
  let lastError: unknown
  for (const modelName of MODELS) {
    try {
      return { result: await fn(modelName), modelName }
    } catch (error) {
      lastError = error
      console.error(
        `Modèle ${modelName} indisponible :`,
        error instanceof Error ? error.message : error
      )
    }
  }
  throw lastError
}

async function generate(prompt: string) {
  const { result, modelName } = await withFallback(async (name) => {
    const { text } = await generateText({
      model: google(name),
      prompt,
      maxRetries: 4,
    })
    return text
  })
  return { text: result, modelName }
}

// ---------- Sampling (le serveur demande une génération au client) ----------

mcp.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  const prompt = request.params.messages
    .flatMap((m) => {
      const content = Array.isArray(m.content) ? m.content : [m.content]
      return content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text"
        )
        .map((item) => item.text)
    })
    .join("\n")

  const ok = await confirm({
    message: `Le serveur demande une génération LLM :\n${prompt}\nAutoriser ?`,
    default: true,
  })
  if (!ok) throw new Error("Sampling refusé par l'utilisateur")

  const { text, modelName } = await generate(prompt)

  return {
    role: "assistant" as const,
    model: modelName,
    stopReason: "endTurn",
    content: { type: "text" as const, text },
  }
})

// ---------- Programme principal ----------

async function main() {
  await mcp.connect(transport)

  const [{ tools }, { prompts }, { resources }, { resourceTemplates }] =
    await Promise.all([
      mcp.listTools(),
      mcp.listPrompts(),
      mcp.listResources(),
      mcp.listResourceTemplates(),
    ])

  console.log("You are connected to the MCP server!")

  while (true) {
    const option = await select({
      message: "What would you like to do",
      choices: ["Query", "Tools", "Resources", "Prompts", "Exit"],
    })

    try {
      switch (option) {
        case "Query":
          await handleQuery(tools)
          break
        case "Tools":
          await chooseTool(tools)
          break
        case "Resources":
          await chooseResource(resources, resourceTemplates)
          break
        case "Prompts":
          await choosePrompt(prompts)
          break
        case "Exit":
          await mcp.close()
          process.exit(0)
      }
    } catch (error) {
      console.error("Erreur :", error instanceof Error ? error.message : error)
    }
  }
}

// ---------- Menus ----------

async function chooseTool(tools: Tool[]) {
  const toolName = await select({
    message: "Select a tool",
    choices: tools.map((t) => ({
      name: t.annotations?.title || t.name,
      value: t.name,
      description: t.description ?? "",
    })),
  })
  const tool = tools.find((t) => t.name === toolName)
  if (tool == null) {
    console.error("Tool not found")
    return
  }
  await handleTool(tool)
}

async function chooseResource(
  resources: Array<{
    name: string
    uri: string
    description?: string | undefined
  }>,
  resourceTemplates: Array<{
    name: string
    uriTemplate: string
    description?: string | undefined
  }>
) {
  const resourceURI = await select({
    message: "Select a resource",
    choices: [
      ...resources.map((r) => ({
        name: r.name,
        value: r.uri,
        description: r.description ?? "",
      })),
      ...resourceTemplates.map((t) => ({
        name: t.name,
        value: t.uriTemplate,
        description: t.description ?? "",
      })),
    ],
  })
  await handleResource(resourceURI)
}

async function choosePrompt(prompts: Prompt[]) {
  const promptName = await select({
    message: "Select a prompt",
    choices: prompts.map((p) => ({
      name: p.name,
      value: p.name,
      description: p.description ?? "",
    })),
  })
  const prompt = prompts.find((p) => p.name === promptName)
  if (prompt == null) {
    console.error("Prompt not found.")
    return
  }
  await handlePrompt(prompt)
}

// ---------- Tools ----------

async function handleTool(tool: Tool) {
  const args: Record<string, unknown> = {}
  const required = new Set(tool.inputSchema.required ?? [])

  for (const [key, value] of Object.entries(
    tool.inputSchema.properties ?? {}
  )) {
    const prop = value as { type?: string; enum?: string[] }
    const isRequired = required.has(key)

    // Valeurs limitées (z.enum) : liste de choix
    if (prop.enum) {
      args[key] = await select({
        message: `Select ${key}:`,
        choices: prop.enum.map((v) => ({ name: v, value: v })),
      })
      continue
    }

    const answer = await input({
      message: `Enter value for ${key} (${prop.type ?? "string"})${
        isRequired ? "" : " [optional]"
      }:`,
    })

    // Champ optionnel laissé vide : on ne l'envoie pas
    if (answer === "" && !isRequired) continue

    args[key] =
      prop.type === "number" || prop.type === "integer"
        ? Number(answer)
        : prop.type === "boolean"
          ? answer === "true"
          : answer
  }

  try {
    const res = await mcp.callTool({
      name: tool.name,
      arguments: args,
    })
    const content = res.content as Array<{ type: string; text?: string }>
    console.log(content[0]?.text ?? "(pas de réponse)")
  } catch (error) {
    console.error("Erreur :", error instanceof Error ? error.message : error)
  }
}

// ---------- Resources ----------

async function handleResource(uri: string) {
  let finalUri = uri
  const paramMatches = uri.match(/{[^}]+}/g)

  if (paramMatches != null) {
    for (const paramMatch of paramMatches) {
      const paramName = paramMatch.replace("{", "").replace("}", "")
      const paramValue = await input({
        message: `Enter value for ${paramName}:`,
      })
      finalUri = finalUri.replace(paramMatch, paramValue)
    }
  }

  const res = await mcp.readResource({ uri: finalUri })
  const content = res.contents[0]
  if (content == null || !("text" in content)) {
    console.error("Resource returned no text content.")
    return
  }

  try {
    console.log(JSON.stringify(JSON.parse(content.text), null, 2))
  } catch {
    console.log(content.text)
  }
}

// ---------- Prompts ----------

async function handlePrompt(prompt: Prompt) {
  const args: Record<string, string> = {}
  for (const arg of prompt.arguments ?? []) {
    args[arg.name] = await input({
      message: `Enter value for ${arg.name}:`,
    })
  }

  const response = await mcp.getPrompt({
    name: prompt.name,
    arguments: args,
  })

  for (const message of response.messages) {
    const result = await handleServerMessagePrompt(message)
    if (result) console.log(result)
  }
}

async function handleServerMessagePrompt(message: PromptMessage) {
  if (message.content.type !== "text") return

  console.log(message.content.text)
  const run = await confirm({
    message: "Would you like to run the above prompt",
    default: true,
  })
  if (!run) return

  try {
    const { text } = await generate(message.content.text)
    return text
  } catch {
    console.error("Tous les modèles ont échoué, réessaie plus tard.")
  }
}

// ---------- Query : le LLM choisit lui-même les tools MCP ----------

async function handleQuery(tools: Tool[]) {
  const query = await input({ message: "Enter your query" })

  const aiTools = Object.fromEntries(
    tools.map((t) => [
      t.name,
      aiTool({
        description: t.description ?? "",
        inputSchema: jsonSchema(
          t.inputSchema as Parameters<typeof jsonSchema>[0]
        ),
        execute: async (args: unknown) => {
          const res = await mcp.callTool({
            name: t.name,
            arguments: args as Record<string, unknown>,
          })
          return res.content
        },
      }),
    ])
  )

  try {
    const { result } = await withFallback(async (name) => {
      const { text } = await generateText({
        model: google(name),
        prompt: query,
        tools: aiTools,
        stopWhen: stepCountIs(5),
        maxRetries: 4,
      })
      return text
    })
    console.log(result)
  } catch {
    console.error("Tous les modèles ont échoué, réessaie plus tard.")
  }
}

main().catch((error) => {
  console.error("Erreur fatale :", error)
  process.exit(1)
})