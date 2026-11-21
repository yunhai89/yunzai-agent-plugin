/**
 * 萌娘百科移动端 gRPC 客户端（零第三方依赖）。
 *
 * 背景：mobile.moegirl.org.cn 的 H5 /api/* 被 Cloudflare 托管挑战保护；
 * 同源业务后端 grpc.moegirl.org.cn 无 CF 挑战，可直接 HTTP/2 + protobuf。
 * 本文件只负责 wire format 与 unary gRPC 调用，业务字段解析在 api.js。
 *
 * 注意：服务端经常在响应体发完后不主动结束 stream，因此采用
 * “收到完整帧后静默 quietMs 即收尾”的策略；trailers 到达时立即收尾。
 */
import http2 from 'node:http2'
import zlib from 'node:zlib'

/* ────────────────────────── protobuf wire format ────────────────────────── */

export function varint(n) {
  const out = []
  let v = BigInt(n)
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n }
  out.push(Number(v))
  return Buffer.from(out)
}

const tag = (field, wire) => varint((field << 3) | wire)
export const encVarint = (field, v) => Buffer.concat([tag(field, 0), varint(v)])
export const encBytes = (field, b) => Buffer.concat([tag(field, 2), varint(b.length), b])
export const encString = (field, s) => encBytes(field, Buffer.from(String(s), 'utf8'))
export const encMsg = (field, msg) => encBytes(field, msg)

export function readVarint(buf, pos) {
  let r = 0n
  let shift = 0n
  let b
  do {
    if (pos >= buf.length) throw new Error('protobuf varint 越界')
    b = buf[pos++]
    r |= BigInt(b & 0x7f) << shift
    shift += 7n
  } while (b & 0x80)
  return [r, pos]
}

/** 解码为 [{ field, wire, value }]；wire=2 时 value 为 Buffer */
export function decode(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    let k
    ;[k, pos] = readVarint(buf, pos)
    const field = Number(k >> 3n)
    const wire = Number(k & 7n)
    if (wire === 0) {
      let v
      ;[v, pos] = readVarint(buf, pos)
      out.push({ field, wire, value: Number(v) })
    } else if (wire === 2) {
      let l
      ;[l, pos] = readVarint(buf, pos)
      l = Number(l)
      if (pos + l > buf.length) throw new Error('protobuf bytes 越界')
      out.push({ field, wire, value: buf.slice(pos, pos + l) })
      pos += l
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error('protobuf fixed64 越界')
      out.push({ field, wire, value: buf.readBigUInt64LE(pos) })
      pos += 8
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error('protobuf fixed32 越界')
      out.push({ field, wire, value: buf.readUInt32LE(pos) })
      pos += 4
    } else {
      throw new Error('不支持的 protobuf wire type ' + wire)
    }
  }
  return out
}

export const all = (fields, n) => fields.filter((f) => f.field === n).map((f) => f.value)
export const one = (fields, n) => {
  const f = fields.find((x) => x.field === n)
  return f ? f.value : undefined
}
export const s = (fields, n) => {
  const v = one(fields, n)
  return v === undefined ? undefined : Buffer.isBuffer(v) ? v.toString('utf8') : v
}
export const num = (fields, n) => {
  const v = one(fields, n)
  return v === undefined ? undefined : Number(v)
}

/** 当子消息猜一下（未定型字段） */
export function tryMsg(buf) {
  try { const d = decode(buf); return d.length ? d : null } catch { return null }
}

/** 可打印 UTF-8 文本优先按字符串处理，否则当作子消息 */
export function isText(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return false
  const str = buf.toString('utf8')
  if (Buffer.byteLength(str, 'utf8') !== buf.length) return false
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(str)
}

export const strOrMsg = (buf) => (buf === undefined ? undefined : (isText(buf) ? buf.toString('utf8') : undefined))

/** 字段既可能是纯文本，也可能是包裹了一层子消息的富文本——取出可读文本 */
export function textOf(v) {
  if (v === undefined) return undefined
  if (!Buffer.isBuffer(v)) return v
  if (isText(v)) return v.toString('utf8')
  try {
    for (const f of decode(v)) if (f.wire === 2 && isText(f.value)) return f.value.toString('utf8')
  } catch { /* noop */ }
  return undefined
}

/* ────────────────────────── gRPC over HTTP/2 ────────────────────────── */

function frame(payload) {
  const h = Buffer.alloc(5)
  h[0] = 0
  h.writeUInt32BE(payload.length, 1)
  return Buffer.concat([h, payload])
}

/** 从累积的 HTTP/2 body 中切出 gRPC 帧；支持 gzip 压缩帧（flag=1） */
export function frameScan(body) {
  const msgs = []
  let pos = 0
  while (pos + 5 <= body.length) {
    const flag = body[pos]
    const len = body.readUInt32BE(pos + 1)
    const end = pos + 5 + len
    if (end > body.length) break
    let payload = body.slice(pos + 5, end)
    if (flag === 1) {
      try { payload = zlib.gunzipSync(payload) } catch { /* 保留原始帧，交由上层报错 */ }
    }
    msgs.push(payload)
    pos = end
  }
  return { msgs, consumed: pos, complete: pos === body.length && msgs.length > 0 }
}

const unframe = (body) => frameScan(body).msgs

export class GrpcError extends Error {
  constructor(message, { method = '', status = undefined, grpcMessage = '' } = {}) {
    super(message)
    this.name = 'GrpcError'
    this.method = method
    this.status = status
    this.grpcMessage = grpcMessage
  }
}

/**
 * 调用一个 unary 方法。
 * @param {string} method 形如 /moegirl.moepad.MoepadService/SearchEntry
 * @param {Buffer} payload protobuf 消息
 * @param {{host?:string, headers?:object, timeoutMs?:number, quietMs?:number, userAgent?:string}} opts
 */
export function callGrpc(method, payload, { host = 'grpc.moegirl.org.cn', headers = {}, timeoutMs = 20000, quietMs = 1200, userAgent = 'agents-plugin-moegirl/1.0' } = {}) {
  const cleanHost = String(host || 'grpc.moegirl.org.cn').replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://' + cleanHost)
    let done = false
    let clientError = null
    const chunks = []
    let trailers = {}
    let quietTimer = null

    const cleanup = () => {
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(hardTimer)
      try { req?.close() } catch { /* noop */ }
      try { client.close() } catch { /* noop */ }
      try { client.destroy() } catch { /* noop */ }
    }
    const finish = () => {
      if (done) return
      done = true
      cleanup()
      const body = Buffer.concat(chunks)
      resolve({
        status: trailers['grpc-status'] !== undefined ? Number(trailers['grpc-status']) : undefined,
        message: safeDecodeURIComponent(trailers['grpc-message'] || ''),
        trailers,
        messages: unframe(body),
        bytes: body.length,
      })
    }
    const fail = (e) => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }

    const hardTimer = setTimeout(finish, Math.max(3000, Number(timeoutMs) || 20000))
    const req = client.request({
      ':method': 'POST',
      ':path': method,
      'content-type': 'application/grpc',
      'te': 'trailers',
      'grpc-accept-encoding': 'identity',
      'user-agent': userAgent,
      ...headers,
    })
    client.on('error', (e) => { clientError = e })
    req.on('response', (h) => { trailers = { ...h } })
    req.on('trailers', (t) => { trailers = { ...trailers, ...t }; finish() })
    req.on('data', (c) => {
      chunks.push(c)
      // 只有「已解析出完整帧且没有残留半帧」时才认为响应可能结束
      const scan = frameScan(Buffer.concat(chunks))
      if (scan.complete) {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, Math.max(200, Number(quietMs) || 1200))
      }
    })
    req.on('end', finish)
    req.on('error', fail)
    req.setTimeout(Math.max(3000, Number(timeoutMs) || 20000), () => {
      if (clientError) fail(clientError)
      else finish()
    })
    req.end(frame(payload))
  })
}

/**
 * 调用并处理空回 / 非 0 grpc-status。
 * 服务端偶发 status=0 但 0 字节，重试最多 3 次。
 */
export async function callOk(method, payload, opts = {}) {
  let r = await callGrpc(method, payload, opts)
  for (let i = 0; i < 2 && !r.messages.length; i++) {
    await new Promise((res) => setTimeout(res, 400))
    r = await callGrpc(method, payload, opts)
  }
  if (r.status !== undefined && r.status !== 0) {
    throw new GrpcError(`${method} 失败 grpc-status=${r.status}${r.message ? ' ' + r.message : ''}`, {
      method, status: r.status, grpcMessage: r.message,
    })
  }
  return r.messages[0] || Buffer.alloc(0)
}

function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(String(s)) } catch { return String(s) }
}

export const wire = { encString, encVarint, encBytes, encMsg, frame, unframe }
