import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import fs from "node:fs/promises"

// Fonctionne aussi bien depuis src/ (tsx) que depuis build/ (node)
const TASKS_PATH = new URL("../src/data/tasks.json", import.meta.url)

type Task = {
  id: number
  title: string
  state: string
  deadline: string
  start: string
}

const server = new McpServer({
  name: "test",
  version: "1.0.0",
})

// ---------- Helpers ----------

async function readTasks(): Promise<Task[]> {
  return JSON.parse(await fs.readFile(TASKS_PATH, "utf-8")) as Task[]
}

async function createTask(task: {
  title: string
  state: string
  deadline?: string | undefined
  start?: string | undefined
}): Promise<number> {
  const tasks = await readTasks()
  const id = Math.max(0, ...tasks.map((t) => Number(t.id))) + 1

  tasks.push({
    id,
    title: task.title,
    state: task.state,
    deadline: task.deadline ?? "",
    start: task.start ?? "",
  })

  await fs.writeFile(TASKS_PATH, JSON.stringify(tasks, null, 2))
  return id
}

// ---------- Resources ----------

server.resource(
  "tasks",
  "tasks://all",
  {
    description: "Get all tasks data from the database",
    title: "Tasks",
    mimeType: "application/json",
  },
  async (uri) => {
    const tasks = await readTasks()
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(tasks),
          mimeType: "application/json",
        },
      ],
    }
  }
)

server.resource(
  "task-details",
  new ResourceTemplate("tasks://{taskId}", { list: undefined }),
  {
    description: "Get task details data from the database",
    title: "Task Details",
    mimeType: "application/json",
  },
  async (uri, { taskId }) => {
    const tasks = await readTasks()
    const task = tasks.find((t) => t.id === parseInt(taskId as string))

    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(task ?? { error: "Task not found" }),
          mimeType: "application/json",
        },
      ],
    }
  }
)

// ---------- Tools ----------

server.tool(
  "create-task",
  "Create new task in the database",
  {
    title: z.string(),
    state: z.enum(["not started", "incomplete", "done"]),
    deadline: z.string().optional(),
    start: z.string().optional(),
  },
  {
    title: "Create Task",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async (params) => {
    try {
      const id = await createTask(params)
      return {
        content: [{ type: "text", text: `Task ${id} created successfully` }],
      }
    } catch (error) {
      console.error(error) // stderr, jamais console.log en stdio
      return {
        content: [{ type: "text", text: "Failed to create task" }],
        isError: true,
      }
    }
  }
)

server.tool(
  "create-random-task",
  "Create a random task with fake data",
  {
    title: "Create Random Task",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async () => {
    try {
      // Sampling : le client (VS Code, etc.) fait générer le texte par un LLM
      const response = await server.server.createMessage({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Generate fake task data. The task should have a realistic title, state (one of: not started, incomplete, done), deadline and start (format YYYY-MM-DD). Return this data as a JSON object with keys title, state, deadline, start, with no other text or formatting so it can be used with JSON.parse.",
            },
          },
        ],
        maxTokens: 1024,
      })

      if (response.content.type !== "text") {
        return {
          content: [{ type: "text", text: "Failed to generate task data" }],
          isError: true,
        }
      }

      const fakeTask = JSON.parse(
        response.content.text
          .trim()
          .replace(/^\s*```json\s*/, "")
          .replace(/\s*```\s*$/, "")
          .trim()
      )

      const id = await createTask(fakeTask)
      return {
        content: [{ type: "text", text: `Task ${id} created successfully` }],
      }
    } catch (error) {
      console.error(error)
      return {
        content: [{ type: "text", text: "Failed to create random task" }],
        isError: true,
      }
    }
  }
)

// ---------- Prompts ----------

server.prompt(
  "generate-fake-task",
  "Generate a fake task based on the given title",
  {
    title: z.string(),
  },
  ({ title }) => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Generate a fake task with the title ${title}. The task should have a realistic description, priority, and status.`,
          },
        },
      ],
    }
  }
)

// ---------- Démarrage ----------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error("Erreur fatale :", error)
  process.exit(1)
})