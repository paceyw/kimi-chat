// Agent UI Protocol v1 - the client-facing declarative component contract.
// Enveloped as reserved-prefix tool calls (kimi_ui__render / kimi_ui__patch)
// emitted by the provider; the host intercepts, renders, synthesizes virtual
// tool results. Unknown components degrade to text summaries.

export const UI_TOOL_PREFIX = "kimi_ui__"
export const UI_PROTOCOL_VERSION = 1

export const UI_COMPONENTS = {
  "search-results": {
    props: {
      type: "object",
      required: ["query", "results"],
      properties: {
        query: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "url"],
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
              favicon: { type: "string" },
            },
          },
        },
      },
    },
  },
  "citation-list": {
    props: {
      type: "object",
      required: ["citations"],
      properties: {
        citations: {
          type: "array",
          items: {
            type: "object",
            required: ["index", "title", "url"],
            properties: {
              index: { type: "integer", minimum: 1 },
              title: { type: "string" },
              url: { type: "string" },
              quote: { type: "string" },
            },
          },
        },
      },
    },
  },
  "agent-timeline": {
    props: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["kind", "label"],
            properties: {
              kind: { type: "string", enum: ["search", "read", "think", "tool", "write", "done", "error"] },
              label: { type: "string" },
              detail: { type: "string" },
              url: { type: "string" },
              at: { type: "number" },
            },
          },
        },
      },
    },
  },
  "data-table": {
    props: {
      type: "object",
      required: ["columns", "rows"],
      properties: {
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: {} } },
        title: { type: "string" },
      },
    },
  },
  "data-chart": {
    props: {
      type: "object",
      required: ["kind", "points"],
      properties: {
        kind: { type: "string", enum: ["line", "bar"] },
        title: { type: "string" },
        points: {
          type: "array",
          items: {
            type: "object",
            required: ["x"],
            properties: { x: {}, y: {} },
          },
        },
      },
    },
  },
  "preview-card": {
    props: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "string" },
        url: { type: "string" },
        image: { type: "string" },
      },
    },
  },
  // Kimi 网页/桌面「组件卡片」的等价物：模型直接产出的自包含 HTML 片段。
  // 宿主应把它渲染在**沙箱 iframe**里（srcdoc + 禁网/禁脚本），不要直接注入主文档。
  "html-card": {
    props: {
      type: "object",
      required: ["html"],
      properties: {
        html: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
        height: { type: "integer", minimum: 120 },
      },
    },
  },
}

export const UI_OPS = ["create", "patch", "complete", "remove", "error"]

// Minimal JSON-Schema-subset validator (type/required/properties/items/
// enum/minimum). Enough for the whitelist above; not a general validator.
export function validateProps(component, props) {
  const spec = UI_COMPONENTS[component]
  if (!spec) return `unknown component '${component}'`
  const errors = []
  checkSchema(props, spec.props, "$", errors)
  return errors.length ? errors.join("; ") : null
}

function checkSchema(value, schema, path, errors) {
  if (!schema) return
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${path}: expected object`); return }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) checkSchema(value[key], sub, `${path}.${key}`, errors)
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return }
    value.forEach((item, i) => checkSchema(item, schema.items, `${path}[${i}]`, errors))
  } else if (schema.type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string`)
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) errors.push(`${path}: expected integer`)
  } else if (schema.type === "number") {
    if (typeof value !== "number") errors.push(`${path}: expected number`)
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: expected one of ${schema.enum.join("|")}`)
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) errors.push(`${path}: below minimum`)
}

export function uiEvent(op, { surfaceId, itemId, seq, component, props }) {
  if (!UI_OPS.includes(op)) throw new Error(`invalid UI op '${op}'`)
  if (!surfaceId || !itemId || !Number.isInteger(seq)) throw new Error("UI event requires surfaceId, itemId and integer seq")
  if ((op === "create" || op === "patch") && !component) throw new Error(`UI op '${op}' requires component`)
  const event = { v: UI_PROTOCOL_VERSION, surfaceId, itemId, seq, op }
  if (component) event.component = component
  if (props !== undefined) event.props = props
  return event
}

// Wrap a UI event as an OpenAI tool_call arguments string (the envelope).
export function uiToolCall(event, { id, index = 0 } = {}) {
  const name = event.op === "patch" ? `${UI_TOOL_PREFIX}patch` : `${UI_TOOL_PREFIX}render`
  return { id: id ?? `kimi_ui_${event.seq}`, type: "function", function: { name, arguments: JSON.stringify(event) }, index }
}
