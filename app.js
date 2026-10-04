// app.js — WordBuddy 网页管理台（Web Serial + asset/* 协议）
// 功能：连接 CH343 → 下载词书 / 下载音频（预置 + 用户导入 mp3）

const RAW_CHUNK_SIZE = 8192;
const WRITE_SLICE_BYTES = 128;
const WRITE_GAP_MS = 2; // 1ms 会让 Web Serial 底层报 UnknownError（写太快驱动顶不住），2ms 才稳
const BAUD = 2000000;

// ---- FNV-1a 64（BigInt，和固件一致）----
function fnv1a64(text) {
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (const b of new TextEncoder().encode(text)) {
    h ^= BigInt(b);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

// 按原始字节算（块校验和 / 文件校验和用；词哈希用上面的字符串版）
function fnv1a64Bytes(bytes) {
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

// ---- Web Serial 状态 ----
let port = null, writer = null;
const ackWaiters = []; // { phase, index, resolve, reject, timer }
let connected = false;

function log(msg) {
  const el = $('dl-log');
  if (!el) return;
  el.style.display = 'block';
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

async function connect() {
  if (!('serial' in navigator)) { alert('需要 Chrome/Edge，且是 localhost/HTTPS'); return; }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD });
    writer = port.writable.getWriter();
    const info = port.getInfo?.() || {};
    connected = true;
    log(`已连接 VID=0x${(info.usbVendorId ?? 0).toString(16)} PID=0x${(info.usbProductId ?? 0).toString(16)}`);
    updateDeviceUI();
    readLoop();
  } catch (e) {
    connected = false;
    updateDeviceUI();
  }
}

// 后台读行：把串口字节流切成 JSON 行，分发到 ack waiter
async function readLoop() {
  const reader = port.readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch (e) { /* 非 JSON 行（日志）忽略 */ }
      }
    }
  } catch (e) { /* 连接断开 */ }
}

function onLine(msg) {
  if (msg.topic !== 'asset/ack') return;
  const { phase, index, ok } = msg.payload || {};
  const i = ackWaiters.findIndex((w) => w.phase === phase && (w.index ?? null) === (index ?? null));
  if (i < 0) return;
  const w = ackWaiters.splice(i, 1)[0];
  clearTimeout(w.timer);
  if (ok === false) w.reject(msg.payload); else w.resolve(msg.payload);
}

function waitAck(phase, index, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = ackWaiters.findIndex((w) => w.phase === phase && (w.index ?? null) === (index ?? null));
      if (i >= 0) ackWaiters.splice(i, 1);
      reject(new Error(`等待 ${phase} 超时`));
    }, timeoutMs);
    ackWaiters.push({ phase, index, resolve, reject, timer });
  });
}

async function sendLine(obj) {
  await writePaced(enc.encode(JSON.stringify(obj) + '\n'), 64);
}

async function writePaced(bytes, sliceBytes = WRITE_SLICE_BYTES) {
  for (let off = 0; off < bytes.length; off += sliceBytes) {
    await writer.write(bytes.subarray(off, off + sliceBytes));
    if (WRITE_GAP_MS > 0) await new Promise((r) => setTimeout(r, WRITE_GAP_MS));
  }
}

// ---- asset/* 命令 ----
const transferId = () => `p4-${Date.now()}`;

async function sendWithRetry(line, phase, index, attempts = 3, timeoutMs = 30000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const p = waitAck(phase, index, timeoutMs);
    await sendLine(line);
    try {
      return await p;
    } catch (e) {
      if (attempt === attempts) throw e;
      log(`  ${phase} 重试 ${attempt}/${attempts - 1}（${e.message}）`);
    }
  }
}

async function assetBegin(tid, totalBytes) {
  await sendWithRetry(
    { topic: 'asset/begin', payload: { transferId: tid, totalBytes, format: 'wordbook-v1' } },
    'begin'
  );
}

async function assetRawChunk(tid, path, chunk, index) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await assetRawChunkOnce(tid, path, chunk, index);
      return;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      log(`  块 #${index} 重试 ${attempt}/${MAX_ATTEMPTS - 1}（${e.message}）`);
      await recoverRawStream(chunk.length);
    }
  }
}

async function assetRawChunkOnce(tid, path, chunk, index) {
  const header = {
    topic: 'asset/raw-chunk',
    payload: { transferId: tid, path, size: chunk.length, checksum: fnv1a64Bytes(chunk), index: String(index) },
  };
  const readyPromise = waitAck('raw-ready', String(index), 3000);
  await sendLine(header);
  await readyPromise;
  const chunkPromise = waitAck('raw-chunk', String(index), 8000);
  await writePaced(chunk);
  await chunkPromise;
}

async function recoverRawStream(size) {
  const zeros = new Uint8Array(size);
  await writePaced(zeros);
  await writer.write(enc.encode('\n'));
}

async function assetFileCommit(tid, path, size, checksum, chunkCount) {
  await sendWithRetry(
    { topic: 'asset/file', payload: { transferId: tid, path, size, checksum, chunkCount } },
    'file'
  );
}

async function assetCommit(tid, fileCount, totalBytes) {
  await sendWithRetry(
    { topic: 'asset/commit', payload: { transferId: tid, fileCount, totalBytes } },
    'commit'
  );
}

async function assetActivate(tid, slot, packId) {
  await sendWithRetry(
    { topic: 'asset/activate', payload: { transferId: tid, slot, packId } },
    'activate'
  );
}

// ---- 发送一个文件（切块 + 每块 raw-chunk）----
async function sendFile(tid, path, bytes, onProgress) {
  let index = 0;
  for (let off = 0; off < bytes.length; off += RAW_CHUNK_SIZE) {
    const chunk = bytes.subarray(off, off + RAW_CHUNK_SIZE);
    await assetRawChunk(tid, path, chunk, index);
    index += 1;
    if (onProgress) onProgress(index, Math.ceil(bytes.length / RAW_CHUNK_SIZE));
  }
  await assetFileCommit(tid, path, bytes.length, fnv1a64Bytes(bytes), index);
  return index;
}

// ---- 通用传输：begin → 逐个文件 → commit → activate ----
async function transferFiles(files, onFileProgress, onStage) {
  const totalBytes = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  const tid = transferId();
  await assetBegin(tid, totalBytes);
  let doneBytes = 0;
  for (const f of files) {
    await sendFile(tid, f.path, new Uint8Array(f.bytes));
    doneBytes += f.bytes.byteLength;
    if (onFileProgress) onFileProgress(doneBytes, totalBytes, f.path);
  }
  await assetCommit(tid, files.length, totalBytes);
  if (onStage) onStage('commit');
  await assetActivate(tid, 1, await sha256Hex(files[0].bytes));
  if (onStage) onStage('done');
}

// ---- 下载一本书（book.json + 全部单词发音音频）----
async function downloadBook(bookId, name) {
  if (!port || !writer) { alert('先连接设备'); return; }
  setProgress(0, `准备下载「${name}」…`, '准备中…');
  const dlTitle = $('dl-title');
  if (dlTitle) dlTitle.textContent = `正在把「${name}」装进词搭子…`;

  const bookText = await (await fetch(`${bookId}/book.json`)).text();
  const bookBytes = enc.encode(bookText);
  const files = [{ path: `books/${bookId}/book.json`, bytes: bookBytes }];

  // 从 JSONL 里收集每个词的音频文件名（book.json 每行一个词，带 audio 字段）
  const audioNames = [];
  for (const line of bookText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o.audio) audioNames.push(o.audio);
    } catch (e) { /* 跳过元数据行等 */ }
  }

  // 并行抓取音频（分批，避免浏览器连接耗尽），全部先拿到再统一传输
  const BATCH = 8;
  for (let i = 0; i < audioNames.length; i += BATCH) {
    const batch = audioNames.slice(i, i + BATCH);
    const got = await Promise.all(batch.map(async (name) => {
      const res = await fetch(`audio/${name}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { path: `audio/${name}`, bytes };
    }));
    files.push(...got);
    setProgress(0, `下载音频 ${Math.min(i + BATCH, audioNames.length)}/${audioNames.length}…`, '准备中…');
  }

  try {
    await transferFiles(files,
      (done, total) => setProgress(done / total, `正在写入…`, `${Math.round(done / total * 100)}%`),
      (stage) => { if (stage === 'commit') setProgress(1, '正在校验…', '提交中…'); else if (stage === 'done') setProgress(1, '下载完成', '100%'); });
    log(`「${name}」下载完成（${files.length} 个文件，含发音）`);
    markBookDone(bookId);
    return true;
  } catch (e) {
    setProgress(0, '', '');
    log('下载失败：' + e.message);
    try { await sendLine({ topic: 'asset/abort', payload: { transferId: transferId() } }); } catch (_) {}
    return false;
  }
}

// ---- 下载用户导入的 mp3（裸音频，写入 /sdcard/listening/）----
async function downloadUserMp3(file) {
  if (!port || !writer) { alert('先连接设备'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // 只允许 .mp3；文件名做基础清洗，避免路径穿越
  let name = file.name.replace(/[\\/]/g, '_');
  if (!/\.mp3$/i.test(name)) { alert('只支持 .mp3 文件'); return; }
  const path = `listening/${name}`;
  const files = [{ path, bytes }];
  setProgress(0, `准备导入「${name}」…`, '准备中…');
  const dlTitle = $('dl-title');
  if (dlTitle) dlTitle.textContent = `正在导入「${name}」…`;
  try {
    await transferFiles(files,
      (done, total) => setProgress(done / total, '正在写入…', `${Math.round(done / total * 100)}%`),
      (stage) => { if (stage === 'commit') setProgress(1, '正在校验…', '提交中…'); else if (stage === 'done') setProgress(1, '导入完成', '100%'); });
    log(`「${name}」导入完成（纯音频）`);
    return true;
  } catch (e) {
    setProgress(0, '', '');
    log('导入失败：' + e.message);
    return false;
  }
}

function setProgress(frac, label, pct) {
  const panel = $('dl-panel');
  const bar = $('dl-bar');
  if (!panel || !bar) return;
  panel.style.display = 'block';
  bar.style.width = Math.round(frac * 100) + '%';
  $('dl-status').textContent = label;
  $('dl-pct').textContent = pct || `${Math.round(frac * 100)}%`;
}

// ---- UI 状态 ----
function updateDeviceUI() {
  const dot = $('dev-dot'), status = $('dev-status'), btn = $('btn-connect');
  if (!dot || !status || !btn) return;
  dot.classList.toggle('ok', connected);
  status.textContent = connected ? '已连接 · CH343' : '未连接';
  btn.textContent = connected ? '重新连接' : '连接设备';
  const flow = $('flow-hint');
  if (flow) flow.textContent = connected ? '已连接 · 选一本词书开始吧' : '未连接 · 先到左上角连接设备';
  document.querySelectorAll('.book .dl, .audio-item .btn, .dropzone').forEach((el) => {
    if (el.classList.contains('done')) return;
    el.style.opacity = connected ? '' : '.5';
  });
}

function markBookDone(bookId) {
  const btn = document.querySelector(`.book .dl[data-id="${bookId}"]`);
  if (!btn) return;
  btn.classList.add('done');
  btn.disabled = true;
  btn.textContent = '已下载';
}

// ---- 初始化 ----
async function init() {
  $('btn-connect').addEventListener('click', connect);

  // 词书列表
  try {
    const { books } = await (await fetch('book-list.json')).json();
    const listEl = $('book-list');
    listEl.innerHTML = '';
    for (const b of books) {
      const div = document.createElement('div');
      div.className = 'book';
      div.innerHTML = `
        <div class="name">${b.name}</div>
        <div class="meta"><b>${b.totalWords}</b> 词 · 含音频</div>
        <button class="dl" data-id="${b.id}" data-name="${b.name}">下载这本</button>
      `;
      listEl.appendChild(div);
    }
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.dl');
      if (!btn || btn.disabled) return;
      downloadBook(btn.dataset.id, btn.dataset.name);
    });
  } catch (e) { log('加载词书列表失败：' + e.message); }

  // 用户导入 mp3
  const dz = $('dropzone');
  const fileInput = $('file-input');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) downloadUserMp3(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f) downloadUserMp3(f);
    fileInput.value = '';
  });

  updateDeviceUI();
}

init();
