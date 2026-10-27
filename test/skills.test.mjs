import { test } from "node:test"
import assert from "node:assert/strict"
import { cardTitle, extractHtmlCard, webSkillPrompt } from "../src/skills.mjs"

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

test("extractHtmlCard cuts the outermost inline-styled element out of the prose", () => {
  const text = "北京今天晴。\n\n<section style=\"padding:20px\"><div><h2>北京天气</h2></div><p>16℃</p></section>\n\n以上。"
  const card = extractHtmlCard(text)
  assert.ok(card)
  assert.match(card.html, /^<section/)
  assert.match(card.html, /<\/section>$/)
  assert.match(card.html, /<\/div><p>16℃<\/p><\/section>$/, "nested same-tag elements must not cut early")
  assert.equal(card.text, "北京今天晴。\n\n以上。")
  assert.equal(cardTitle(card.html), "北京天气")
})

test("extractHtmlCard unwraps a fenced html block", () => {
  const card = extractHtmlCard("看这个：\n\n\u0060\u0060\u0060html\n<div style=\"color:red\"><p>hi</p></div>\n\u0060\u0060\u0060\n")
  assert.ok(card)
  assert.equal(card.html, '<div style="color:red"><p>hi</p></div>')
  assert.equal(card.text, "看这个：")
})

test("extractHtmlCard ignores prose, tables and unstyled markup", () => {
  assert.equal(extractHtmlCard("| a | b |\n|---|---|\n| 1 | 2 |"), null)
  assert.equal(extractHtmlCard("<div>plain</div>"), null)
  assert.equal(extractHtmlCard("<section style=\"padding:20px\"><p>unclosed</p>"), null)
  assert.equal(extractHtmlCard(""), null)
  assert.equal(cardTitle("<p>no heading</p>"), "")
})
