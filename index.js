require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const { containsProfanity } = require('./badwords');
const { checkForbidden, loadBlocklist } = require('./forbidden');

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

const TOKEN = process.env.VK_TOKEN;
const GROUP_ID = Number(process.env.VK_GROUP_ID);
const API_VERSION = '5.199';
const CHAT_PEER_START = 2000000000; // peer_id беседы всегда больше этого числа

// Репосты записей из этих сообществ НЕ удаляем (id через запятую, без минуса).
// По умолчанию пусто — удаляются репосты из любых сообществ.
const ALLOWED_GROUP_IDS = new Set(
  String(process.env.ALLOWED_GROUP_IDS || '')
    .split(',')
    .map((x) => Math.abs(Number(x.trim())))
    .filter(Boolean)
);

const BLOCKLIST_FILE = process.env.BLOCKLIST_FILE || path.join(__dirname, 'blocklist.txt');
const MODEL_PATH = process.env.VOSK_MODEL_PATH || path.join(__dirname, 'model-ru');
const TMP_DIR = path.join(__dirname, 'tmp');

// Пишется один раз, когда бота добавляют в беседу.
const BOT_ADDED_TEXT =
  'пр братва, админку дайти пж и всё топчик будит одяяяяя, ' +
  'иногда могу удалять сообщения ошибочно, но лучше уж так';

// Если удалить сообщение VK отказался (обычно автор — админ беседы), этого
// автора не трогаем столько времени, чтобы не долбить VK бесполезными запросами.
const REFUSED_COOLDOWN_MS = 5 * 60 * 1000;

if (require.main === module && (!TOKEN || !GROUP_ID)) {
  console.error('Заполните VK_TOKEN и VK_GROUP_ID (переменные окружения / файл .env)');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Голосовые (необязательно): Vosk. Если не установлен — бот работает с текстом.
// ---------------------------------------------------------------------------

let vosk = null;
let voskModel = null;
try {
  vosk = require('vosk');
  if (fs.existsSync(MODEL_PATH)) {
    vosk.setLogLevel(-1);
    voskModel = new vosk.Model(MODEL_PATH);
    console.log('Модель Vosk загружена, проверка голосовых включена');
  }
} catch (e) {
  vosk = null;
}

// ---------------------------------------------------------------------------
// Быстрый клиент VK API (свой, без очередей/лимитеров сторонних библиотек).
// Keep-alive: соединение с api.vk.com переиспользуется, без нового TLS
// рукопожатия на каждый запрос — это заметно экономит время.
// ---------------------------------------------------------------------------

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const http = axios.create({ timeout: 10000, httpsAgent });

function toParam(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function realCallApi(method, params = {}, attempts = 3) {
  const body = new URLSearchParams();
  body.set('access_token', TOKEN);
  body.set('v', API_VERSION);
  for (const [key, value] of Object.entries(params)) {
    const s = toParam(value);
    if (s !== undefined) body.set(key, s);
  }
  const payload = body.toString();

  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const { data } = await http.post(`https://api.vk.com/method/${method}`, payload, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (data.error) {
        const err = new Error(`[${data.error.error_code}] ${data.error.error_msg}`);
        err.vkCode = data.error.error_code;
        // 6 — слишком часто, 9 — флуд-контроль, 10 — внутренняя ошибка VK: повторяем
        if ([6, 9, 10].includes(err.vkCode) && i < attempts - 1) {
          lastError = err;
          await sleep(150 * (i + 1));
          continue;
        }
        throw err;
      }
      return data.response;
    } catch (e) {
      if (e.vkCode !== undefined) throw e; // ошибка VK — повторять бессмысленно
      lastError = e; // сетевая ошибка — пробуем ещё раз
      if (i < attempts - 1) {
        await sleep(100 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// Вынесено в переменную, чтобы в тестах можно было подменить на заглушку.
let callApi = realCallApi;

// ---------------------------------------------------------------------------
// Удаление
// ---------------------------------------------------------------------------

function deleteMessage(peerId, cmid) {
  return callApi('messages.delete', {
    peer_id: peerId,
    cmids: String(cmid),
    delete_for_all: 1,
    group_id: GROUP_ID,
  });
}

// VK может ответить "успехом" на запрос и при этом отказать по конкретному
// сообщению (например, если автор — админ беседы). Проверяем сам ответ.
function deleteLooksOk(res) {
  if (res === undefined || res === null || res === 0 || res === false) return false;
  try {
    if (JSON.stringify(res).includes('"error"')) return false;
  } catch (e) {
    /* ignore */
  }
  if (typeof res === 'object') {
    const values = Array.isArray(res)
      ? res.map((x) => (x && typeof x === 'object' && 'response' in x ? x.response : x))
      : Object.values(res);
    if (values.some((v) => v === 0 || v === false)) return false;
  }
  return true;
}

const refusedUntil = new Map(); // "peerId:userId" -> время, до которого не пытаемся
const lastRefusalLog = new Map(); // peerId -> когда последний раз писали в лог

function logRefusal(peerId, text) {
  const now = Date.now();
  if (now - (lastRefusalLog.get(peerId) || 0) < 60 * 1000) return;
  lastRefusalLog.set(peerId, now);
  console.error(text);
}

// Только удаляет. Ничего в чат не пишет.
async function removeMessage(message, reason) {
  const t0 = Date.now();
  const peerId = message.peer_id;
  const key = `${peerId}:${message.from_id}`;
  if ((refusedUntil.get(key) || 0) > t0) return false;

  let res;
  try {
    res = await deleteMessage(peerId, message.conversation_message_id);
  } catch (e) {
    if (e.vkCode !== undefined) refusedUntil.set(key, t0 + REFUSED_COOLDOWN_MS);
    logRefusal(
      peerId,
      `[delete] не удалось удалить (peer=${peerId}, причина "${reason}"): ${e.message}. ` +
        'Проверьте, что сообщество — администратор этой беседы.'
    );
    return false;
  }

  if (!deleteLooksOk(res)) {
    refusedUntil.set(key, t0 + REFUSED_COOLDOWN_MS);
    logRefusal(
      peerId,
      `[delete] VK отказал в удалении (peer=${peerId}, user=${message.from_id}, причина "${reason}"): ` +
        `${JSON.stringify(res)}. Вероятно, автор — админ беседы.`
    );
    return false;
  }

  console.log(`[delete] peer=${peerId} user=${message.from_id} причина="${reason}" ${Date.now() - t0} мс`);
  return true;
}

// ---------------------------------------------------------------------------
// Проверка содержимого сообщения
// ---------------------------------------------------------------------------

// Собираем текст и вложения из самого сообщения и из пересланных в нём
// (рекурсивно): переслать чужой мат — всё равно что написать его самому.
function collect(message, depth = 0, acc = { texts: [], attachments: [] }) {
  if (!message || depth > 5) return acc;
  if (message.text) acc.texts.push(message.text);
  for (const att of message.attachments || []) acc.attachments.push(att);
  for (const fwd of message.fwd_messages || []) collect(fwd, depth + 1, acc);
  return acc;
}

// Репост записи со стены сообщества: вложение wall, у которого стена —
// сообщества (owner_id < 0).
function groupOfRepost(att) {
  if (!att || att.type !== 'wall' || !att.wall) return null;
  const w = att.wall;
  const owner = typeof w.owner_id === 'number' ? w.owner_id : w.from_id;
  const groupId = owner < 0 ? -owner : typeof w.from_id === 'number' && w.from_id < 0 ? -w.from_id : null;
  return groupId;
}

function wallTexts(att) {
  const w = att && att.type === 'wall' ? att.wall : null;
  if (!w) return [];
  const out = [];
  if (w.text) out.push(w.text);
  for (const c of w.copy_history || []) if (c && c.text) out.push(c.text);
  return out;
}

function checkText(text) {
  if (!text) return null;
  if (containsProfanity(text, { strict: true })) return 'мат/оскорбление';
  const forbidden = checkForbidden(text);
  if (forbidden) return `запрещённый контент: ${forbidden}`;
  return null;
}

// Возвращает причину, по которой сообщение надо удалить, или null.
function inspectMessage(message) {
  const { texts, attachments } = collect(message);

  // 1) Репост из сообщества — удаляем сразу, без разбора текста.
  for (const att of attachments) {
    const groupId = groupOfRepost(att);
    if (groupId && !ALLOWED_GROUP_IDS.has(groupId)) return 'репост из сообщества';
  }

  // 2) Текст сообщения, пересланных сообщений и записей-репостов.
  for (const att of attachments) texts.push(...wallTexts(att));
  for (const text of texts) {
    const reason = checkText(text);
    if (reason) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Голосовые (только если установлен Vosk и есть модель)
// ---------------------------------------------------------------------------

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    axios({ url, method: 'GET', responseType: 'stream' })
      .then((response) => {
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      })
      .catch(reject);
  });
}

function convertOggToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outputPath]);
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${stderr}`))));
    ff.on('error', reject);
  });
}

function transcribeWav(wavPath) {
  const rec = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 });
  try {
    rec.acceptWaveform(fs.readFileSync(wavPath).subarray(44));
    return JSON.parse(rec.finalResult()).text || '';
  } finally {
    rec.free();
  }
}

async function transcribeVoice(link) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const stamp = `${Date.now()}_${crypto.randomInt(1, 2147483647)}`;
  const ogg = path.join(TMP_DIR, `${stamp}.ogg`);
  const wav = path.join(TMP_DIR, `${stamp}.wav`);
  try {
    await downloadFile(link, ogg);
    await convertOggToWav(ogg, wav);
    return transcribeWav(wav);
  } finally {
    fs.unlink(ogg, () => {});
    fs.unlink(wav, () => {});
  }
}

// ---------------------------------------------------------------------------
// Главный обработчик
// ---------------------------------------------------------------------------

async function handleAction(message) {
  const action = message.action;
  if (!action || action.type !== 'chat_invite_user') return;
  // Добавили самого бота (member_id = -id сообщества) — просим админку.
  if ((action.member_id || message.from_id) !== -GROUP_ID) return;
  console.log(`[chat] бота добавили в беседу peer=${message.peer_id}`);
  await callApi('messages.send', {
    peer_id: message.peer_id,
    random_id: crypto.randomInt(1, 2147483647),
    message: BOT_ADDED_TEXT,
  });
}

// edited = true — событие "сообщение отредактировано": дописать мат уже после
// отправки тоже не получится.
async function handleMessage(message, edited = false) {
  const peerId = message.peer_id;
  if (!(peerId > CHAT_PEER_START)) return; // только беседы
  if (message.out === 1) return; // собственные сообщения бота

  if (!edited && message.action) return handleAction(message);

  if (!(message.from_id > 0)) return; // сообщества/боты

  // Горячий путь: проверка — это только регулярки, без сетевых запросов,
  // а удаление — один запрос к VK.
  const reason = inspectMessage(message);
  if (reason) return removeMessage(message, reason);

  // Голосовое сообщение (если доступно распознавание)
  if (!edited && voskModel) {
    const voice = (message.attachments || []).find((a) => a.type === 'audio_message');
    const link = voice && voice.audio_message && voice.audio_message.link_ogg;
    if (link) {
      const transcript = await transcribeVoice(link).catch((e) => {
        console.error('[voice] ошибка расшифровки:', e.message);
        return '';
      });
      const voiceReason = checkText(transcript);
      if (voiceReason) return removeMessage(message, `голосовое: ${voiceReason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Long Poll: получаем события от VK
// ---------------------------------------------------------------------------

async function getLongPollServer() {
  const res = await callApi('groups.getLongPollServer', { group_id: GROUP_ID });
  return { key: res.key, server: res.server, ts: res.ts };
}

function dispatchUpdate(update) {
  const obj = update.object || {};
  if (update.type === 'message_new') {
    handleMessage(obj.message).catch((e) => console.error('Ошибка обработки сообщения:', e));
  } else if (update.type === 'message_edit') {
    handleMessage(obj.message || obj, true).catch((e) => console.error('Ошибка обработки правки:', e));
  }
}

async function longPollLoop() {
  let { key, server, ts } = await getLongPollServer();
  console.log('Бот запущен и слушает беседы (Long Poll)');

  while (true) {
    try {
      const { data } = await http.get(server, {
        params: { act: 'a_check', key, ts, wait: 25 },
        timeout: 30000,
      });

      if (data.failed) {
        if (data.failed === 1) {
          ts = data.ts;
        } else {
          console.warn('Long Poll сессия устарела, переподключаюсь...');
          ({ key, server, ts } = await getLongPollServer());
        }
        continue;
      }

      ts = data.ts;
      // Обработчики запускаются сразу и НЕ блокируют следующий запрос к VK.
      for (const update of data.updates || []) dispatchUpdate(update);
    } catch (err) {
      console.error('Ошибка запроса Long Poll:', err.message);
      await sleep(2000);
    }
  }
}

function start() {
  const custom = loadBlocklist(BLOCKLIST_FILE);
  console.log(`Свой список запрещённых слов (blocklist.txt): ${custom} записей`);
  if (ALLOWED_GROUP_IDS.size) {
    console.log(`Репосты разрешены из сообществ: ${[...ALLOWED_GROUP_IDS].join(', ')}`);
  }
  if (!voskModel) {
    console.warn('Распознавание голосовых не подключено — голосовые сообщения не проверяются.');
  }
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

  longPollLoop().catch((err) => {
    console.error('Не удалось запустить Long Poll. Проверьте токен и права:', err.message);
    process.exit(1);
  });
}

if (require.main === module) start();

// Для автотестов
module.exports = {
  handleMessage,
  dispatchUpdate,
  inspectMessage,
  groupOfRepost,
  deleteLooksOk,
  refusedUntil,
  BOT_ADDED_TEXT,
  _setApi: (fn) => {
    callApi = fn;
  },
};
