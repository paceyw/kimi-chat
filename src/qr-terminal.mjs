// qr-terminal.mjs — 把字符串渲染成终端可扫的二维码（Unicode 半块 + 静区）。
// 用 vendored qrcode-generator（MIT）编码；只做文本渲染，无 DOM/无网络。
import qrcode from "./qrcode-generator.mjs"

// 终端多为深色底：二维码的"深色模块"应显示为空（露出背景），"浅色模块"显示为亮块。
// 白底终端/浅色主题用 darkTheme:false 切换。
export function qrToTerminal(text, { margin = 2, darkTheme = true } = {}) {
  const qr = qrcode(0, "M") // typeNumber 0 = 自动选版本，纠错 M
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  // 返回该模块是否应画成"亮块"
  const bright = (r, c) => {
    const inside = r >= 0 && r < size && c >= 0 && c < size
    const dark = inside ? qr.isDark(r, c) : false
    return darkTheme ? !dark : dark
  }
  const lines = []
  for (let r = -margin; r < size + margin; r += 2) {
    let line = ""
    for (let c = -margin; c < size + margin; c += 2) {
      const top = bright(r, c)
      const bot = bright(r + 1, c)
      line += top && bot ? "█" : top ? "▀" : bot ? "▄" : " "
    }
    lines.push(line)
  }
  return lines.join("\n")
}

export function qrLines(text, opts) {
  return qrToTerminal(text, opts).split("\n")
}
