/*
 * QX 的 $response.body 给的是 base64 字符串（不是 Uint8Array），
 * 所以这版多了一步 base64 ↔ bytes 的转换，其他逻辑和主版一样。
 */
(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    enabled: true,
    mode: "response",
    latitude: 37.3349,
    longitude: -122.00902,
    horizontalAccuracy: 39,
    verticalAccuracy: 1000,
    altitude: 530,
    unknownValue4: 3,
    motionActivityType: 63,
    motionActivityConfidence: 467,
    failOpen: true,
    debug: false
  };

  var APPLE_WLOC_PREFIX = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  var APPLE_WLOC_MARKER = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  var ROOT_DROP_FIELDS = { 3: true, 4: true, 33: true };
  var CELL_RESPONSE_FIELDS = { 22: true, 24: true };
  var LOCATION_REPLACED_FIELDS = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 11: true, 12: true };

  // ========== Byte Utilities ==========

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total), offset = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], offset); offset += parts[i].length; }
    return out;
  }

  function findBytes(bytes, marker) {
    if (!bytes || !marker || marker.length === 0) return -1;
    for (var i = 0; i <= bytes.length - marker.length; i++) {
      var ok = true;
      for (var j = 0; j < marker.length; j++) { if (bytes[i + j] !== marker[j]) { ok = false; break; } }
      if (ok) return i;
    }
    return -1;
  }

  function hexPreview(bytes, limit) {
    if (!bytes) return "<none>";
    var out = [], max = Math.min(bytes.length, limit || 16);
    for (var i = 0; i < max; i++) out.push(("0" + bytes[i].toString(16)).slice(-2));
    return out.join("");
  }

  // ========== Base64 (QX 专用) ==========

  function base64ToBytes(b64) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var lookup = {}, i;
    for (i = 0; i < alphabet.length; i++) lookup[alphabet[i]] = i;
    b64 = b64.replace(/[^A-Za-z0-9\+\/]/g, "");
    var len = b64.length, out = [], padding = 0;
    if (len > 0 && b64[len - 1] === "=") padding++;
    if (len > 1 && b64[len - 2] === "=") padding++;
    var bufLen = (len / 4) * 3 - padding;
    var buf = new Uint8Array(bufLen), pos = 0;
    for (i = 0; i < len; i += 4) {
      var enc1 = lookup[b64[i]], enc2 = lookup[b64[i + 1]], enc3 = lookup[b64[i + 2]], enc4 = lookup[b64[i + 3]];
      var chr1 = (enc1 << 2) | (enc2 >> 4);
      var chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
      var chr3 = ((enc3 & 3) << 6) | enc4;
      buf[pos++] = chr1;
      if (enc3 !== 64) buf[pos++] = chr2;
      if (enc4 !== 64) buf[pos++] = chr3;
    }
    return buf;
  }

  function bytesToBase64(bytes) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      var triplet = (b0 << 16) | (b1 << 8) | b2;
      out += alphabet[(triplet >> 18) & 0x3f] + alphabet[(triplet >> 12) & 0x3f];
      out += i + 1 < bytes.length ? alphabet[(triplet >> 6) & 0x3f] : "=";
      out += i + 2 < bytes.length ? alphabet[triplet & 0x3f] : "=";
    }
    return out;
  }

  // ========== Varint / Protobuf ==========

  function encodeVarintUnsigned(value) {
    var v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) throw new Error("negative unsigned varint");
    var out = [];
    while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
    out.push(Number(v));
    return new Uint8Array(out);
  }

  function encodeVarintSignedInt64(value) {
    var v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (v < 0n) v = BigInt.asUintN(64, v);
    return encodeVarintUnsigned(v);
  }

  function decodeVarint(bytes, offset) {
    var result = 0n, shift = 0n, current = offset;
    while (current < bytes.length) {
      var b = bytes[current]; current += 1;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value: result, offset: current };
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
    throw new Error("unterminated varint");
  }

  function makeKey(fieldNumber, wireType) {
    return encodeVarintUnsigned((BigInt(fieldNumber) << 3n) | BigInt(wireType));
  }

  function makeVarintField(fieldNumber, value) {
    return concatBytes([makeKey(fieldNumber, 0), encodeVarintSignedInt64(value)]);
  }

  function makeLengthDelimitedField(fieldNumber, payload) {
    return concatBytes([makeKey(fieldNumber, 2), encodeVarintUnsigned(payload.length), payload]);
  }

  function parseFields(bytes) {
    var fields = [], offset = 0;
    while (offset < bytes.length) {
      var keyStart = offset;
      var key = decodeVarint(bytes, offset);
      offset = key.offset;
      var fieldNumber = Number(key.value >> 3n), wireType = Number(key.value & 0x7n);
      if (fieldNumber === 0) throw new Error("protobuf field number 0");
      var valueStart = offset, valueEnd;
      if (wireType === 0) { valueEnd = decodeVarint(bytes, offset).offset; }
      else if (wireType === 1) { valueEnd = offset + 8; }
      else if (wireType === 2) { var lenInfo = decodeVarint(bytes, offset); valueStart = lenInfo.offset; valueEnd = valueStart + Number(lenInfo.value); }
      else if (wireType === 5) { valueEnd = offset + 4; }
      else throw new Error("unsupported wire type: " + wireType);
      if (valueEnd > bytes.length) throw new Error("field exceeds buffer");
      fields.push({ fieldNumber: fieldNumber, wireType: wireType, keyStart: keyStart, valueStart: valueStart, valueEnd: valueEnd, raw: bytes.slice(keyStart, valueEnd), valueBytes: bytes.slice(valueStart, valueEnd) });
      offset = valueEnd;
    }
    return fields;
  }

  function firstFieldByNumber(fields, fieldNumber) {
    for (var i = 0; i < fields.length; i++) { if (fields[i].fieldNumber === fieldNumber) return fields[i]; }
    return null;
  }

  function signedVarintFieldValue(field) {
    if (!field || field.wireType !== 0) return null;
    return BigInt.asIntN(64, decodeVarint(field.valueBytes, 0).value);
  }

  function tryParseFields(bytes) {
    try { if (!bytes || bytes.length === 0) return null; var f = parseFields(bytes); return f.length > 0 ? f : null; }
    catch (e) { return null; }
  }

  function isCellResponseField(fieldNumber) { return CELL_RESPONSE_FIELDS[fieldNumber] === true; }

  // ========== ARPC ==========

  function readUInt16BE(bytes, offset) { return (bytes[offset] << 8) | bytes[offset + 1]; }
  function readUInt32BE(bytes, offset) { return ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0; }
  function writeUInt16BE(value) { return new Uint8Array([(value >> 8) & 0xff, value & 0xff]); }
  function writeUInt32BE(value) { return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]); }

  function asciiBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0x7f;
    return out;
  }

  function readPascalString(bytes, state) {
    var length = readUInt16BE(bytes, state.offset); state.offset += 2;
    var chars = [];
    for (var i = 0; i < length; i++) chars.push(String.fromCharCode(bytes[state.offset + i]));
    state.offset += length;
    return chars.join("");
  }

  function writePascalString(value) { return concatBytes([writeUInt16BE(value.length), asciiBytes(value)]); }

  function parseArpc(bytes) {
    var state = { offset: 0 };
    var version = readUInt16BE(bytes, state.offset); state.offset += 2;
    var locale = readPascalString(bytes, state);
    var appIdentifier = readPascalString(bytes, state);
    var osVersion = readPascalString(bytes, state);
    var functionId = readUInt32BE(bytes, state.offset); state.offset += 4;
    var payloadLength = readUInt32BE(bytes, state.offset); state.offset += 4;
    if (state.offset + payloadLength > bytes.length) throw new Error("ARPC payload exceeds buffer");
    return { version: version, locale: locale, appIdentifier: appIdentifier, osVersion: osVersion, functionId: functionId, payload: bytes.slice(state.offset, state.offset + payloadLength) };
  }

  function serializeArpc(arpc) {
    return concatBytes([writeUInt16BE(arpc.version), writePascalString(arpc.locale), writePascalString(arpc.appIdentifier), writePascalString(arpc.osVersion), writeUInt32BE(arpc.functionId), writeUInt32BE(arpc.payload.length), arpc.payload]);
  }

  // ========== Location Patching ==========

  function coordToInt(value) { return Math.trunc(Number(value) * 100000000); }

  function patchLocation(locationPayload, config) {
    var parts = [], fields = locationPayload.length ? parseFields(locationPayload) : [];
    for (var i = 0; i < fields.length; i++) { if (!LOCATION_REPLACED_FIELDS[fields[i].fieldNumber]) parts.push(fields[i].raw); }
    parts.push(makeVarintField(1, coordToInt(config.latitude)));
    parts.push(makeVarintField(2, coordToInt(config.longitude)));
    parts.push(makeVarintField(3, config.horizontalAccuracy));
    parts.push(makeVarintField(4, config.unknownValue4));
    parts.push(makeVarintField(5, config.altitude));
    parts.push(makeVarintField(6, config.verticalAccuracy));
    parts.push(makeVarintField(11, config.motionActivityType));
    parts.push(makeVarintField(12, config.motionActivityConfidence));
    return concatBytes(parts);
  }

  function patchWifiDevice(wifiPayload, config) {
    var fields = parseFields(wifiPayload), parts = [], patchedLocation = false;
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === 2 && fields[i].wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchLocation(fields[i].valueBytes, config))); patchedLocation = true;
      } else parts.push(fields[i].raw);
    }
    if (!patchedLocation) parts.push(makeLengthDelimitedField(2, patchLocation(new Uint8Array([]), config)));
    return concatBytes(parts);
  }

  function patchCellTower(cellPayload, config) {
    var fields = parseFields(cellPayload), parts = [], patchedLocation = false;
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === 5 && fields[i].wireType === 2) {
        parts.push(makeLengthDelimitedField(5, patchLocation(fields[i].valueBytes, config))); patchedLocation = true;
      } else parts.push(fields[i].raw);
    }
    if (!patchedLocation) parts.push(makeLengthDelimitedField(5, patchLocation(new Uint8Array([]), config)));
    return concatBytes(parts);
  }

  function patchAppleWLocPayload(payload, config) {
    var fields = parseFields(payload), parts = [], wifiCount = 0, cellCount = 0;
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) { parts.push(makeLengthDelimitedField(2, patchWifiDevice(field.valueBytes, config))); wifiCount += 1; }
      else if (isCellResponseField(field.fieldNumber) && field.wireType === 2) { parts.push(makeLengthDelimitedField(field.fieldNumber, patchCellTower(field.valueBytes, config))); cellCount += 1; }
      else if (!ROOT_DROP_FIELDS[field.fieldNumber]) parts.push(field.raw);
    }
    return { payload: concatBytes(parts), wifiCount: wifiCount, cellCount: cellCount };
  }

  // ========== Response Extraction ==========

  function extractPrefixedAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 10) return null;
    if (responseBytes[0] !== 0x00 || responseBytes[1] !== 0x01) return null;
    if (responseBytes[6] !== 0x00 || responseBytes[7] !== 0x00) return null;
    var payloadLength = readUInt16BE(responseBytes, 8), payloadOffset = 10;
    if (payloadLength <= 0 || payloadOffset + payloadLength > responseBytes.length) return null;
    var payload = responseBytes.slice(payloadOffset, payloadOffset + payloadLength);
    if (tryParseFields(payload) === null) return null;
    return { kind: "synthetic", payload: payload, prefix: responseBytes.slice(0, 8), suffix: responseBytes.slice(payloadOffset + payloadLength) };
  }

  function extractAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 2) throw new Error("Apple WLoc response too short");
    var prefixed = extractPrefixedAppleWLocPayload(responseBytes);
    if (prefixed) return prefixed;
    try {
      var arpc = parseArpc(responseBytes);
      if (arpc.payload.length > 0 && tryParseFields(arpc.payload) !== null) return { kind: "arpc", payload: arpc.payload, arpc: arpc };
    } catch (e) {}
    var markerIdx = findBytes(responseBytes, APPLE_WLOC_MARKER);
    if (markerIdx >= 0) {
      var lenOffset = markerIdx + APPLE_WLOC_MARKER.length;
      if (lenOffset + 2 <= responseBytes.length) {
        var realLen = readUInt16BE(responseBytes, lenOffset), realPayloadOffset = lenOffset + 2;
        if (realLen > 0 && realPayloadOffset + realLen <= responseBytes.length) {
          var candidatePayload = responseBytes.slice(realPayloadOffset, realPayloadOffset + realLen);
          if (tryParseFields(candidatePayload) !== null) return { kind: "marker", payload: candidatePayload, prefix: responseBytes.slice(0, markerIdx), markerAndLen: responseBytes.slice(markerIdx, realPayloadOffset), suffix: responseBytes.slice(realPayloadOffset + realLen) };
        }
      }
    }
    if (responseBytes.length > 0) { var tag = responseBytes[0]; var fn = tag >> 3, wt = tag & 0x7; if (fn > 0 && (wt === 0 || wt === 2)) return { kind: "bare", payload: responseBytes }; }
    throw new Error("missing Apple WLoc response prefix");
  }

  function buildAppleWLocResponse(payload, prefix) {
    return concatBytes([prefix || APPLE_WLOC_PREFIX, writeUInt16BE(payload.length), payload]);
  }

  function spoofAppleResponse(responseBytes, config) {
    var extraction = extractAppleWLocPayload(responseBytes);
    var patched = patchAppleWLocPayload(extraction.payload, config);
    var response;
    if (extraction.kind === "arpc") {
      response = serializeArpc({ version: extraction.arpc.version, locale: extraction.arpc.locale, appIdentifier: extraction.arpc.appIdentifier, osVersion: extraction.arpc.osVersion, functionId: extraction.arpc.functionId, payload: patched.payload });
    } else if (extraction.kind === "marker") {
      var newLenBytes = writeUInt16BE(patched.payload.length);
      response = concatBytes([extraction.prefix, extraction.markerAndLen.slice(0, APPLE_WLOC_MARKER.length), newLenBytes, patched.payload, extraction.suffix]);
    } else {
      response = buildAppleWLocResponse(patched.payload, extraction.prefix);
    }
    return { response: response, payload: patched.payload, wifiCount: patched.wifiCount, cellCount: patched.cellCount, kind: extraction.kind };
  }

  function patchedPayloadSummary(payload) {
    try {
      var rootFields = parseFields(payload), parts = [];
      var wifi = firstFieldByNumber(rootFields, 2);
      if (wifi && wifi.wireType === 2) {
        var wifiLoc = firstFieldByNumber(parseFields(wifi.valueBytes), 2);
        parts.push("firstWifi=" + (wifiLoc ? (Number(signedVarintFieldValue(firstFieldByNumber(parseFields(wifiLoc.valueBytes), 1))) / 100000000).toFixed(8) + "," + (Number(signedVarintFieldValue(firstFieldByNumber(parseFields(wifiLoc.valueBytes), 2))) / 100000000).toFixed(8) : "<missing>"));
      }
      return parts.length ? parts.join(", ") : "no location fields";
    } catch (err) { return "summary failed: " + err.message; }
  }

  // ========== Config ==========

  function normalizeConfig(input) {
    var cfg = {}, key;
    for (key in DEFAULT_CONFIG) { if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) cfg[key] = DEFAULT_CONFIG[key]; }
    input = input || {};
    for (key in input) { if (Object.prototype.hasOwnProperty.call(input, key)) cfg[key] = input[key]; }
    cfg.enabled = cfg.enabled !== false;
    var modeStr = String(cfg.mode || "response").toLowerCase();
    cfg.mode = (modeStr === "inspect") ? "inspect" : "response";
    cfg.latitude = Number(cfg.latitude); cfg.longitude = Number(cfg.longitude);
    cfg.horizontalAccuracy = Math.trunc(Number(cfg.horizontalAccuracy));
    cfg.verticalAccuracy = Math.trunc(Number(cfg.verticalAccuracy));
    cfg.altitude = Math.trunc(Number(cfg.altitude));
    cfg.unknownValue4 = Math.trunc(Number(cfg.unknownValue4));
    cfg.motionActivityType = Math.trunc(Number(cfg.motionActivityType));
    cfg.motionActivityConfidence = Math.trunc(Number(cfg.motionActivityConfidence));
    cfg.failOpen = cfg.failOpen !== false;
    cfg.debug = cfg.debug === true || String(cfg.debug).toLowerCase() === "true";
    if (!Number.isFinite(cfg.latitude) || cfg.latitude < -90 || cfg.latitude > 90) throw new Error("invalid latitude");
    if (!Number.isFinite(cfg.longitude) || cfg.longitude < -180 || cfg.longitude > 180) throw new Error("invalid longitude");
    return cfg;
  }

  function loadConfig() {
    // 与 SR 对齐：从 $argument 读运行时配置。QX $argument 是 URL query string 形式
    // (例如 module 配置里 argument=mode=response&latitude=...&debug=true)
    // QX 不支持 $httpClient，所以 configUrl 这条路在 QX 上不存在；仅支持
    // 模块 inline argument。
    var raw = (typeof $argument !== "undefined" && $argument) || "";
    var args = parseArgumentStringQX(raw);
    var merged = mergeConfig(DEFAULT_CONFIG, args);
    return normalizeConfig(merged);
  }

  function parseArgumentStringQX(arg) {
    var out = {};
    if (!arg || typeof arg !== "string") return out;
    var pairs = arg.split(/[&;]/);
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (!p) continue;
      var eq = p.indexOf("=");
      var k = eq >= 0 ? p.slice(0, eq) : p;
      var v = eq >= 0 ? p.slice(eq + 1) : "true";
      try { out[decodeURIComponent(k)] = decodeURIComponent(v); }
      catch (e) { out[k] = v; }
    }
    return out;
  }

  function mergeConfig(base, extra) {
    var out = {}, key;
    for (key in base) { if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key]; }
    extra = extra || {};
    for (key in extra) { if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key]; }
    return out;
  }

  // ========== QX Entry Point ==========
  // 与 location-spoofer.js (runShadowrocket) 的设计对齐：
  //   * 4 源 fallback 读 body（bodyBytes > body > rawBody > binaryBody）
  //   * 同步加载 config（QX 无 $httpClient）
  //   * 自动处理 gzip/deflate/br 压缩
  //   * headersWithBinaryBody 工具：复制原头、过滤掉按 body 重算的字段
  //   * 集中 $done 调用，便于排错
  //   * mode dispatch：response / inspect / probe / request

  // ---------- body 解码工具（对齐 SR 的 messageBodyToBytes） ----------

  function bytesFromBinaryString(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
    return out;
  }

  function bodyToBytes(body) {
    if (body == null) return null;
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body === "string") return bytesFromBinaryString(body);
    if (typeof body === "object" && typeof body.length === "number") return new Uint8Array(body);
    if (typeof body === "object" && body.bytes && typeof body.bytes.length === "number") return new Uint8Array(body.bytes);
    if (typeof body === "object" && body.data && typeof body.data.length === "number") return new Uint8Array(body.data);
    return null;
  }

  function readQXResponseBytes() {
    // 路径 1：bodyBytes（QX 主流 v1.0.19+）
    var bb = typeof $response.bodyBytes !== "undefined" ? $response.bodyBytes : null;
    if (bb) {
      var b = bodyToBytes(bb);
      if (b && b.length > 0) return { bytes: b, source: "bodyBytes" };
    }

    // 路径 2：body (旧版 base64 / 文本)
    var raw = $response && $response.body;
    var b2 = bodyToBytes(raw);
    if (b2 && b2.length > 0) return { bytes: b2, source: "body" };

    // 路径 3：rawBody / binaryBody 别名
    if ($response) {
      var b3 = bodyToBytes($response.rawBody) || bodyToBytes($response.binaryBody);
      if (b3 && b3.length > 0) return { bytes: b3, source: "rawBody/binaryBody" };
    }

    if (bb !== null && bb !== undefined) return { bytes: null, source: "bodyBytes(empty)" };
    return { bytes: null, source: "unavailable" };
  }

  // ---------- headers 工具（对齐 SR 的 headersWithBinaryBody） ----------

  function headersWithBinaryBody(sourceHeaders, length) {
    var headers = {};
    sourceHeaders = sourceHeaders || {};
    for (var key in sourceHeaders) {
      if (!Object.prototype.hasOwnProperty.call(sourceHeaders, key)) continue;
      var lower = key.toLowerCase();
      if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding") continue;
      headers[key] = sourceHeaders[key];
    }
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(length);
    return headers;
  }

  // ---------- 解压（对齐 SR 的 decompressBody） ----------

  function decompressBody(body, contentEncoding) {
    if (!body || !contentEncoding) return body;
    var enc = String(contentEncoding).toLowerCase();
    if (enc === "identity" || enc === "") return body;
    try {
      if (typeof $utils !== "undefined") {
        if (enc.indexOf("gzip") >= 0 && $utils.ungzip) return $utils.ungzip(body);
        if (enc.indexOf("deflate") >= 0 && $utils.inflate) return $utils.inflate(body);
        if (enc.indexOf("br") >= 0 && $utils.brotliDecompress) return $utils.brotliDecompress(body);
      }
    } catch (e) {
      if (typeof console !== "undefined") console.log("Location spoofer decompress failed (" + enc + "): " + e.message);
    }
    return body;
  }

  // ---------- $done 封装（对齐 SR 的 doneWriteResponse / donePassThrough） ----------

  function donePassThrough() { $done({}); }

  function doneRewriteResponse(uint8, info) {
    var sourceHeaders = (typeof $response !== "undefined" && $response.headers) || {};
    var headers = headersWithBinaryBody(sourceHeaders, uint8.byteLength);
    if (info && info.debug) {
      headers["X-Location-Spoofer-Wifi-Count"] = String(info.wifiCount || 0);
      headers["X-Location-Spoofer-Cell-Count"] = String(info.cellCount || 0);
    }
    // QX 支持 $done({headers, bodyBytes})，新版本生效
    $done({
      headers: headers,
      bodyBytes: uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
    });
  }

  // ---------- 主入口（对齐 SR 的 runShadowrocket） ----------

  function runQX() {
    var hasResponse = typeof $response !== "undefined";
    var hasRequest = typeof $request !== "undefined";
    if (!hasRequest && !hasResponse) return;

    var config = loadConfig();

    try {
      if (!config.enabled) { donePassThrough(); return; }

      // mode = inspect：只打印 payload 信息，不改 body
      if (config.mode === "inspect" && hasResponse) {
        if (config.debug) {
          var readProbe = readQXResponseBytes();
          console.log("Location spoofer QX inspect source: " + readProbe.source);
          if (readProbe.bytes) {
            console.log("Location spoofer QX inspect body: len=" + readProbe.bytes.length + ", head=" + hexPreview(readProbe.bytes, 48));
            try {
              var ext = extractAppleWLocPayload(readProbe.bytes);
              console.log("Location spoofer QX inspect extraction: kind=" + ext.kind + ", payloadLen=" + ext.payload.length);
            } catch (e) { console.log("Location spoofer QX inspect extraction failed: " + e.message); }
          }
        }
        donePassThrough();
        return;
      }

      if (hasResponse) {
        if (config.mode !== "response") { donePassThrough(); return; }

        var readResult = readQXResponseBytes();
        if (config.debug) console.log("Location spoofer QX body source: " + readResult.source);

        if (!readResult.bytes || readResult.bytes.length < 2) {
          if (config.debug) console.log("Location spoofer QX body too short or " + readResult.source);
          donePassThrough();
          return;
        }

        // 处理 Content-Encoding（对齐 SR 第 1248 行）
        var srcHeaders = ($response && $response.headers) || {};
        var contentEncoding = null;
        for (var hk in srcHeaders) {
          if (Object.prototype.hasOwnProperty.call(srcHeaders, hk) && hk.toLowerCase() === "content-encoding") {
            contentEncoding = srcHeaders[hk];
            break;
          }
        }
        if (contentEncoding && readResult.bytes) {
          // QX 的 $utils.ungzip 接受字符串并返回 binary string，再转回 Uint8Array
          var decoded = decompressBody($response.body, contentEncoding);
          if (decoded && decoded !== $response.body) {
            var decBytes = bodyToBytes(decoded);
            if (decBytes && decBytes.length > 0) readResult.bytes = decBytes;
          }
        }

        if (config.debug) console.log("Location spoofer QX response: " + readResult.bytes.length + " bytes, head=" + hexPreview(readResult.bytes, 32));

        var result = spoofAppleResponse(readResult.bytes, config);
        if (config.debug) {
          console.log("Location spoofer patched " + result.wifiCount + " wifi, " + result.cellCount + " cell, kind=" + result.kind + ", response=" + result.response.length + " bytes");
          console.log("Location spoofer locations: " + patchedPayloadSummary(result.payload));
          console.log("Location spoofer QX writing bodyBytes=" + result.response.byteLength + " with rewritten headers");
        }

        doneRewriteResponse(result.response, {
          wifiCount: result.wifiCount,
          cellCount: result.cellCount,
          debug: config.debug
        });
        return;
      }

      // 没有 $response（QX 在 script-request-body 这种模式才会出现，目前不用）
      donePassThrough();
    } catch (err) {
      if (config.debug) console.log("Location spoofer failed: " + err.message);
      donePassThrough();
    }
  }

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    base64ToBytes: base64ToBytes,
    bytesToBase64: bytesToBase64,
    patchAppleWLocPayload: patchAppleWLocPayload,
    spoofAppleResponse: spoofAppleResponse,
    extractAppleWLocPayload: extractAppleWLocPayload,
    parseArpc: parseArpc,
    coordToInt: coordToInt
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    runQX();
  }
}());
