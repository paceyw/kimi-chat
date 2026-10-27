// kimi-proto.mjs — 手写 protobuf wire 编解码（零依赖），仅覆盖 Kimi Chat 需要的消息子集。
// 字段号/枚举值来自 PROTOCOL.md（前端 descriptor 被动解码，2026-10-26）。
// 编码约定：非可选字段只在有值时写出；proto3 默认值（0/""/false）省略。

// ---------- 底层 wire ----------
export function varint(n) {
  if (n < 0) throw new Error("varint underflow");
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Uint8Array.from(out);
}

export function field(key, payload) {
  // key = (field_number << 3) | wire_type
  const head = varint(key);
  const body = typeof payload === "number" ? varint(payload) : payload;
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export function bytesField(num, u8) {
  const len = varint(u8.length);
  const out = new Uint8Array(1 + 8 + u8.length); // 上界足够
  let i = 0;
  out.set(varint(num << 3 | 2), i); i += varint(num << 3 | 2).length;
  out.set(len, i); i += len.length;
  out.set(u8, i);
  return out.subarray(0, i + u8.length);
}

export function strField(num, s) {
  return bytesField(num, new TextEncoder().encode(s));
}

export function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

// ---------- 解码 ----------
export function* iterateFields(buf, start = 0, end = buf.length) {
  let i = start;
  const dv = buf instanceof DataView ? buf : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (i < end) {
    let key = 0, shift = 0;
    for (;;) {
      const b = buf[i++];
      key |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const num = key >>> 3, wt = key & 7;
    if (wt === 0) {
      let v = 0n, sh = 0n;
      for (;;) {
        const b = buf[i++];
        v |= BigInt(b & 0x7f) << sh;
        if (!(b & 0x80)) break;
        sh += 7n;
      }
      yield { num, wt, v };
    } else if (wt === 2) {
      let len = 0, sh = 0;
      for (;;) {
        const b = buf[i++];
        len |= (b & 0x7f) << sh;
        if (!(b & 0x80)) break;
        sh += 7;
      }
      yield { num, wt, buf: buf.subarray(i, i + len) };
      i += len;
    } else if (wt === 5) {
      yield { num, wt, buf: buf.subarray(i, i + 4) };
      i += 4;
    } else if (wt === 1) {
      yield { num, wt, buf: buf.subarray(i, i + 8) };
      i += 8;
    } else {
      throw new Error(`unsupported wire type ${wt} at ${i}`);
    }
  }
}

export function fields(buf) { return [...iterateFields(buf)]; }

export function pick(fls, num) { return fls.find(f => f.num === num && f.wt === 2)?.buf; }
export function pickStr(fls, num) { const b = pick(fls, num); return b ? new TextDecoder().decode(b) : ""; }
export function pickNum(fls, num) { const f = fls.find(f => f.num === num && f.wt === 0); return f ? Number(f.v) : 0; }
export function pickAll(fls, num) { return fls.filter(f => f.num === num && f.wt === 2).map(f => f.buf); }
export function has(fls, num) { return fls.some(f => f.num === num); }

// ---------- Kimi 消息常量 ----------
export const SCENARIO = { CHAT: 1, THINK: 2, DEEP_RESEARCH: 3, K2: 5, K2D5: 9, K3: 13, OK_COMPUTER: 6 };
// Speed 枚举（2026-10-27 真机实测钉死，勿再改）：ChatRequestOptions.speed 只有 1 和 5 被上游接受——
//   speed=1 通过、5 通过；3 与 7 → enum.defined_only 报错（不在枚举里）；10 → "Invalid parameter"。
// Model.speed_options 里出现的 1/3/5/7 是展示刻度，不能回填到请求（3/7 会被拒）。
export const SPEED = { STANDARD: 1, FAST: 5 };
export const REASONING_EFFORT = { NONE: 1, MINIMAL: 2, LOW: 3, MEDIUM: 4, HIGH: 5, XHIGH: 6, MAX: 7 };
export const CONTEXT_LENGTH = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6, XXL: 7 };
export const OPERATOR = { SET: 1, APPEND: 2 };
export const REASON_PATTERNS = {
  rate_limited: [9, 10, 16, 6, 7, 8, 11, 12, 13],
  content_filter: [1],
  length: [2],
  overloaded: [3, 19],
  cancelled: [17],
};

export function reasonToError(reason) {
  for (const [kind, list] of Object.entries(REASON_PATTERNS)) {
    if (list.includes(reason)) return kind;
  }
  return "upstream_error";
}

// ---------- ChatRequest 编码 ----------
// ChatRequest{chat_id=1 str, scenario=2 enum, tools=3 rep, message=4, options=5, kimiplus_id=6 str, project_id=7 str}
// Tool{type=1 enum, search=2 {force=1 bool}}
// ChatMessage{role=2 enum(user=2), blocks=6 rep Block}
// Block{text=3 {content=1 str}}
// ChatRequestOptions{thinking=3 bool, system_prompt=4 str, enable_plugin=7 bool, reasoning_effort=8, context_length=9, model=10 str, speed=15}
export function encodeChatRequest({ chatId, kimiplusId, scenario, useSearch, prompt, options = {} }) {
  const parts = [];
  if (chatId) parts.push(strField(1, chatId));
  if (kimiplusId) parts.push(strField(6, kimiplusId));
  if (scenario) parts.push(field(2 << 3 | 0, scenario));
  if (useSearch) {
    // tools[0] = {type: SEARCH(1), search: {force: <searchForce>}}
    // force=false 让服务端自行决定（网页默认）；force=true 每次强制联网。
    const search = field(1 << 3 | 0, options.searchForce ? 1 : 0)
    const tool = concat([field(1 << 3 | 0, 1), bytesField(2, search)]) // type=SEARCH + search{}
    parts.push(bytesField(3, tool));
  }
  // message = {role:user(2), blocks:[{text:{content}}]}
  const textBlock = strField(1, prompt);       // TextBlock.content=1
  const block = bytesField(3, textBlock);      // Block.text=3
  const message = concat([
    field(2 << 3 | 0, 2),                      // role=user=2
    bytesField(6, block),                      // blocks[0]
  ]);
  parts.push(bytesField(4, message));
  // options
  const opt = [];
  if (options.thinking) opt.push(field(3 << 3 | 0, 1));
  if (options.systemPrompt) opt.push(strField(4, options.systemPrompt));
  if (options.enablePlugin) opt.push(field(7 << 3 | 0, 1));
  if (options.reasoningEffort) opt.push(field(8 << 3 | 0, options.reasoningEffort));
  if (options.contextLength) opt.push(field(9 << 3 | 0, options.contextLength));
  if (options.model) opt.push(strField(10, options.model));
  if (options.speed) opt.push(field(15 << 3 | 0, options.speed));
  parts.push(bytesField(5, concat(opt)));
  return concat(parts);
}

// ---------- ChatResponse 解码 ----------
// ChatResponse{op=1, mask=2, event_offset=11, chat=3, message=4, block=5, ref=6, usage=7, notification=8, done=9, heartbeat=10}
// Block{id=1 str, message_id=2 str, text=3{content=1,tips=2}, search=4{keywords=1 rep,web_pages=2 rep}, think=6{content=1,summary=2}, error=7{reason=1,localized_message=2,severity=3}, tool=11, artifact=12, stage=15, multi_stage=16}
export function decodeChatResponse(buf) {
  const fls = fields(buf);
  const out = { op: 0, eventOffset: 0 };
  out.op = pickNum(fls, 1);
  out.eventOffset = pickNum(fls, 11);
  const chat = pick(fls, 3);
  if (chat) {
    const cf = fields(chat);
    out.chat = { id: pickStr(cf, 1), name: pickStr(cf, 2) };
  }
  const message = pick(fls, 4);
  if (message) {
    const mf = fields(message);
    out.message = { id: pickStr(mf, 1), status: pickNum(mf, 5) }; // status=5（role=4）
  }
  const block = pick(fls, 5);
  if (block) {
    const bf = fields(block);
    out.block = { id: pickStr(bf, 1), messageId: pickStr(bf, 2) };
    const text = pick(bf, 3);
    if (text) out.block.text = { content: pickStr(fields(text), 1), tips: pickStr(fields(text), 2) };
    const think = pick(bf, 6);
    if (think) out.block.think = { content: pickStr(fields(think), 1), summary: pickStr(fields(think), 2) };
    const search = pick(bf, 4);
    if (search) {
      const sf = fields(search);
      out.block.search = {
        keywords: pickAll(sf, 1).map(k => new TextDecoder().decode(k)),
        webPages: pickAll(sf, 2).map(wp => decodeSearchResultBase(wp)),
      };
    }
    const error = pick(bf, 7);
    if (error) {
      const ef = fields(error);
      out.block.error = { reason: pickNum(ef, 1), message: pickStr(ef, 2), severity: pickNum(ef, 3) };
    }
    const tool = pick(bf, 11);
    if (tool) out.block.tool = decodeToolBlock(tool);
    const artifact = pick(bf, 12);
    if (artifact) out.block.artifact = decodeArtifactBlock(artifact);
  }
  const ref = pick(fls, 6);
  if (ref) {
    const rf = fields(ref);
    out.ref = { id: pickStr(rf, 1), messageId: pickStr(rf, 2) };
    const s = pick(rf, 3);
    if (s) {
      const ss = fields(s);
      out.ref.search = {
        id: pickStr(ss, 1),
        base: pick(ss, 2) ? decodeSearchResultBase(pick(ss, 2)) : null,
        refIndex: pickStr(ss, 3),
      };
    }
  }
  const usage = pick(fls, 7);
  if (usage) {
    const uf = fields(usage);
    out.usage = {};
    const r = pick(uf, 1); // Usage.research = 1
    if (r) {
      const rr = fields(r);
      out.usage.research = { id: pickStr(rr, 1), name: pickStr(rr, 2), limit: pickNum(rr, 5), used: pickNum(rr, 6), remain: pickNum(rr, 7) };
    }
  }
  const notification = pick(fls, 8);
  if (notification) {
    const nf = fields(notification);
    out.notification = { type: pickNum(nf, 1), message: pickStr(nf, 2) };
  }
  if (has(fls, 9)) out.done = {};
  if (has(fls, 10)) out.heartbeat = true;
  return out;
}

function decodeSearchResultBase(buf) {
  const f = fields(buf);
  return {
    title: pickStr(f, 1), url: pickStr(f, 2), siteName: pickStr(f, 3),
    iconUrl: pickStr(f, 4), coverUrl: pickStr(f, 5), snippet: pickStr(f, 6),
    publishTime: pick(f, 7), // Timestamp 消息，暂不深解
    keyword: pickStr(f, 11),
  };
}

function decodeToolBlock(buf) {
  const f = fields(buf);
  const out = { toolCallId: pickStr(f, 1), name: pickStr(f, 2), args: pickStr(f, 3), status: pickNum(f, 8) };
  const contents = pickAll(f, 6);
  if (contents.length) out.contents = contents.map(decodeToolContent);
  return out;
}

// ToolBlockContent{text=1, resource_link=2, image=3, search_result=4, slides=5, memory=6, goods=7, mutable_text=8, web_open_url=9}
// search_result{index=1 str, base=2 SearchResultBase, ref_key=3 str}——web_search 工具的结果就落在这里
// （实测 2026-10-27：web_search ToolBlock 完成帧 contents.field4 逐条带 SearchResultBase）。
function decodeToolContent(buf) {
  const f = fields(buf);
  const out = {};
  const text = pick(f, 1);
  if (text) out.text = new TextDecoder().decode(text);
  const link = pick(f, 2);
  if (link) { const lf = fields(link); out.resourceLink = { title: pickStr(lf, 1), uri: pickStr(lf, 2) } }
  const image = pick(f, 3);
  if (image) { const imf = fields(image); out.image = { url: pickStr(imf, 1), caption: pickStr(imf, 2) } }
  const sr = pick(f, 4);
  if (sr) {
    const sf = fields(sr);
    out.searchResult = {
      index: pickStr(sf, 1),
      base: pick(sf, 2) ? decodeSearchResultBase(pick(sf, 2)) : null,
      refKey: pickStr(sf, 3),
    };
  }
  const mutable = pick(f, 8);
  if (mutable) out.mutableText = new TextDecoder().decode(mutable);
  const web = pick(f, 9);
  if (web) out.webOpenUrl = new TextDecoder().decode(web);
  return out;
}

function decodeArtifactBlock(buf) {
  const f = fields(buf);
  return { artifactId: pickStr(f, 1), type: pickNum(f, 2), version: pickStr(f, 3), content: pickStr(f, 4), title: pickStr(f, 6) };
}


