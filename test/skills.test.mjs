import { test } from "node:test"
import assert from "node:assert/strict"
import { webSkillPrompt } from "../src/skills.mjs"

const user = (content) => ({ role: "user", content })
const withWidgetTool = [{ type: "function", function: { name: "show_widget", description: "", parameters: {} } }]

test("no injection for an unrelated request", () => {
  assert.equal(webSkillPrompt({ messages: [user("帮我写个快排")] }), "")
})

test("an upstream /app skill path gets an environment correction", () => {
  const text = webSkillPrompt({ messages: [{ role: "system", content: "Skill: /app/.agents/skills/kimi-widget/SKILL.md" }, user("做个卡片")] })
  assert.match(text, /不是运行在 Kimi 网页\/桌面容器里/)
  assert.match(text, /SKILL\.md/)
})

test("a card request without a client widget tool gets the widget recipe", () => {
  const text = webSkillPrompt({ messages: [user("把北京天气做成一个组件卡片")] })
  assert.match(text, /kimi-widget/)
  assert.match(text, /内联/)
})

test("a card request with a client widget tool only gets the environment note", () => {
  const text = webSkillPrompt({ messages: [{ role: "system", content: "see /app/.agents/skills/x/SKILL.md" }, user("做个卡片")], tools: withWidgetTool })
  assert.match(text, /运行环境校正/)
  assert.doesNotMatch(text, /kimi-widget/)
})

test("a bare SKILL.md mention from another client is left alone", () => {
  assert.equal(webSkillPrompt({ messages: [{ role: "system", content: "Read SKILL.md before answering." }, user("写个快排")] }), "")
})

test("KIMI_WEB_SKILLS=0 disables the injection", () => {
  const old = process.env.KIMI_WEB_SKILLS
  try {
    process.env.KIMI_WEB_SKILLS = "0"
    assert.equal(webSkillPrompt({ messages: [user("做个卡片")] }), "")
  } finally {
    if (old === undefined) delete process.env.KIMI_WEB_SKILLS
    else process.env.KIMI_WEB_SKILLS = old
  }
})
