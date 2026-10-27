// roundtrip 测试：编码 ChatRequest → 手动解码核对字段；解码合成 ChatResponse 帧。
import test from "node:test";
import assert from "node:assert/strict";
import {
  varint, field, bytesField, strField, concat, fields, pick, pickStr, pickNum,
  encodeChatRequest, decodeChatResponse, reasonToError,
} from "../src/kimi-proto.mjs";
import { createFrameParser, envelope } from "../src/kimi-connect.mjs";

test("varint 基础", () => {
  assert.deepEqual([...varint(0)], [0]);
  assert.deepEqual([...varint(1)], [1]);
  assert.deepEqual([...varint(127)], [127]);
  assert.deepEqual([...varint(128)], [0x80, 0x01]);
  assert.deepEqual([...varint(300)], [0xac, 0x02]);
});

test("ChatRequest 编码 roundtrip", () => {
  const req = encodeChatRequest({
    chatId: "c123",
    scenario: 1,
    useSearch: true,
    prompt: "你好，世界",
    options: { speed: 5, thinking: false, model: "" },
  });
  const fls = fields(req);
  assert.equal(pickStr(fls, 1), "c123");               // chat_id
  assert.equal(pickNum(fls, 2), 1);                    // scenario CHAT
  assert.ok(pick(fls, 3), "tools 存在");
  const msg = pick(fls, 4);
  assert.ok(msg);
  const mf = fields(msg);
  assert.equal(pickNum(mf, 2), 2);                     // role=user
  const blk = pick(mf, 6);
  const bf = fields(blk);
  assert.equal(pickStr(fields(pick(bf, 3)), 1), "你好，世界");
});

test("ChatResponse 解码：文本 append + done", () => {
  // 手工构造：op=append(2), block{text{content:"hi"}}
  const textBlock = strField(1, "hi");
  const block = bytesField(3, textBlock);
  block.set(varint(1 << 3 | 2), 0); // 修正 id 字段占位——见下，直接重建
  // 干净构造
  const blk2 = concat([strField(1, "b1"), bytesField(3, strField(1, "hi"))]);
  const resp = concat([
    field(1 << 3 | 0, 2),       // op=append
    bytesField(5, blk2),        // block
    field(9 << 3 | 0, 0),       // done（空消息，wire 0）
  ]);
  const out = decodeChatResponse(resp);
  assert.equal(out.op, 2);
  assert.equal(out.block.id, "b1");
  assert.equal(out.block.text.content, "hi");
  assert.ok(out.done);
});

test("ChatResponse 解码：search + 引用", () => {
  const page = concat([strField(1, "标题"), strField(2, "https://example.com")]);
  const searchBlk = concat([bytesField(1, new TextEncoder().encode("kw")), bytesField(2, page)]);
  const blk = concat([bytesField(4, searchBlk)]);
  const chunk = concat([strField(1, "ref1"), bytesField(2, page), strField(3, "1")]);
  const ref = concat([strField(1, "r1"), strField(2, "m1"), bytesField(3, chunk)]);
  const resp = concat([
    bytesField(5, blk),
    bytesField(6, ref),
  ]);
  const out = decodeChatResponse(resp);
  assert.equal(out.block.search.keywords[0], "kw");
  assert.equal(out.block.search.webPages[0].title, "标题");
  assert.equal(out.ref.search.refIndex, "1");
});

test("ChatResponse 错误 reason 映射", () => {
  const errBlk = concat([field(1 << 3 | 0, 16)]); // REASON_RATE_LIMIT_EXCEEDED
  const blk = concat([bytesField(7, errBlk)]);
  const resp = bytesField(5, blk);
  const out = decodeChatResponse(resp);
  assert.equal(out.block.error.reason, 16);
  assert.equal(reasonToError(16), "rate_limited");
  assert.equal(reasonToError(1), "content_filter");
});

test("ChatResponse 解码：message.status 字段号 5（role=4）", () => {
  // ChatMessage{id=1, role=4(user=2), status=5(COMPLETED=2)}
  const msg = concat([strField(1, "m1"), field(4 << 3 | 0, 2), field(5 << 3 | 0, 2)]);
  const resp = concat([bytesField(4, msg)]);
  const out = decodeChatResponse(resp);
  assert.equal(out.message.id, "m1");
  assert.equal(out.message.status, 2); // COMPLETED；若误读 role(4=2,user) 不会是 2？user 也是 2——用 GENERATING 区分
  const msg2 = concat([strField(1, "m2"), field(4 << 3 | 0, 2), field(5 << 3 | 0, 1)]);
  const out2 = decodeChatResponse(concat([bytesField(4, msg2)]));
  assert.equal(out2.message.status, 1); // GENERATING；role=2 时若读错字段会是 2
});

test("ChatResponse 解码：web_search ToolBlock 的 contents.searchResult", () => {
  // 实测形状（2026-10-27）：ToolBlock{1=tool_call_id, 2=name, 3=args, 8=status, 6=contents[]}，
  // contents 里 web_search 结果落在 field 4 = search_result{1=index, 2=SearchResultBase, 3=ref_key}。
  const page = concat([strField(1, "杭州天气"), strField(2, "https://example.com/w"), strField(6, "晴 18-25°C")]);
  const sr = concat([strField(1, "1"), bytesField(2, page), strField(3, "web_search:1#0")]);
  const content = bytesField(4, sr);
  const tool = concat([
    strField(1, "web_search:1"), strField(2, "web_search"),
    strField(3, '{"queries":["杭州天气"]}'), field(8 << 3 | 0, 3),
    bytesField(6, content),
  ]);
  const blk = concat([strField(1, "b1"), bytesField(11, tool)]);
  const out = decodeChatResponse(concat([bytesField(5, blk)]));
  assert.equal(out.block.tool.toolCallId, "web_search:1");
  assert.equal(out.block.tool.name, "web_search");
  assert.equal(out.block.tool.status, 3);
  const got = out.block.tool.contents[0].searchResult;
  assert.equal(got.index, "1");
  assert.equal(got.base.url, "https://example.com/w");
  assert.equal(got.base.title, "杭州天气");
  assert.equal(got.refKey, "web_search:1#0");
});

test("connect 信封 frame parser", () => {
  const payload = new TextEncoder().encode("abc");
  const env = envelope(payload);
  assert.equal(env[0], 0);
  assert.equal(new DataView(env.buffer).getUint32(1, false), 3);
  const parser = createFrameParser();
  // 分两个 chunk 馈入，验证跨块缓冲
  parser.feed(env.subarray(0, 4));
  assert.equal(parser.take(), null);
  parser.feed(env.subarray(4));
  const f = parser.take();
  assert.equal(new TextDecoder().decode(f.payload), "abc");
  // 尾帧
  const endPayload = new TextEncoder().encode(JSON.stringify({ metadata: {} }));
  parser.feed(envelope(endPayload, 0x02));
  const e = parser.take();
  assert.ok(e.end);
  assert.deepEqual(e.end.metadata, {});
});
