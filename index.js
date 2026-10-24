require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const { containsProfanity } = require('./badwords');
const { checkForbidden, loadBlocklist } = require('./forbidden');

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

// Токен берём из VK_TOKEN или из стандартных переменных хостингов: на
// бесплатном тарифе Bothost, например, токен из поля "Bot Token" попадает в
// BOT_TOKEN, а своих переменных окружения там нет.
const TOKEN =
  process.env.VK_TOKEN ||
  process.env.VK_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.API_TOKEN ||
  process.env.TOKEN;
// ID сообщества указывать необязательно: если не задан, бот узнает его сам по токену.
let GROUP_ID = Math.abs(Number(process.env.VK_GROUP_ID)) || 0;
const API_VERSION = '5.199';
const CHAT_PEER_START = 2000000000; // peer_id беседы всегда больше этого числа

// Репосты записей из этих сообществ НЕ удаляем. Задаётся переменной
// ALLOWED_GROUP_IDS (id через запятую, без минуса) и/или файлом
// allowed_groups.txt (по одному id на строке). По умолчанию пусто — удаляются
// репосты из любых сообществ.
const ALLOWED_GROUPS_FILE = process.env.ALLOWED_GROUPS_FILE || path.join(__dirname, 'allowed_groups.txt');

function parseGroupList(text) {
  return String(text)
    .split(/[\s,;]+/)
    .filter((x) => x && !x.startsWith('#'))
    .map((x) => Math.abs(Number(x)))
    .filter(Boolean);
}

const ALLOWED_GROUP_IDS = new Set(parseGroupList(process.env.ALLOWED_GROUP_IDS || ''));

function loadAllowedGroups(filePath) {
  try {
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    for (const id of parseGroupList(lines)) ALLOWED_GROUP_IDS.add(id);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать allowed_groups.txt:', e.message);
  }
}

const BLOCKLIST_FILE = process.env.BLOCKLIST_FILE || path.join(__dirname, 'blocklist.txt');

// Пишется один раз, когда бота добавляют в беседу.
const BOT_ADDED_TEXT =
  'пр братва, админку дайти пж и всё топчик будит одяяяяя, ' +
  'иногда могу удалять сообщения ошибочно, но лучше уж так';

// Если удалить сообщение VK отказался (обычно автор — админ беседы), этого
// автора не трогаем столько времени, чтобы не долбить VK бесполезными запросами.
const REFUSED_COOLDOWN_MS = 5 * 60 * 1000;

if (require.main === module && !TOKEN) {
  console.error('Не найден токен сообщества VK (VK_TOKEN или BOT_TOKEN).');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// Голосовые сообщения и видеокружки: удаляются ВСЕ, без проверки содержимого
// ---------------------------------------------------------------------------

// Голосовое сообщение в VK — вложение типа audio_message (это точно известно).
const VOICE_TYPES = new Set(['audio_message']);

// Видеокружок (видеосообщение). Как именно VK отдаёт его боту, я проверить не
// смог, поэтому он распознаётся по нескольким признакам сразу:
//   1) отдельный тип вложения с "кружочным" названием;
//   2) вложение video с пометкой кружка внутри;
//   3) квадратное короткое видео (кружки записываются квадратными).
// Если кружки всё равно проскакивают, включите DELETE_ALL_VIDEOS=1 — тогда
// удаляется вообще любое видео.
const CIRCLE_TYPES = new Set([
  'video_message', 'circle', 'circle_video', 'video_circle', 'round_video', 'video_note', 'videomessage', 'video_msg',
]);
const CIRCLE_FLAG_KEYS = ['is_circle', 'circle', 'is_video_message', 'video_message', 'is_round', 'round', 'is_vm'];
const CIRCLE_MAX_SECONDS = 120;
const DELETE_ALL_VIDEOS = /^(1|true|yes|да)$/i.test(String(process.env.DELETE_ALL_VIDEOS || ''));

// Вложения, о которых точно известно, что это не кружок и не голосовое. Всё
// остальное при встрече пишется в лог (названия полей, без содержимого), чтобы
// можно было увидеть, как VK на самом деле называет новые типы вложений.
const KNOWN_TYPES = new Set([
  'photo', 'video', 'audio', 'doc', 'link', 'wall', 'sticker', 'gift', 'graffiti', 'poll', 'market',
  'market_album', 'story', 'podcast', 'article', 'narrative', 'wall_reply', 'geo', 'audio_message',
]);

function voiceEvidence(att) {
  return att && VOICE_TYPES.has(att.type) ? `type=${att.type}` : null;
}

function circleEvidence(att) {
  if (!att || !att.type) return null;
  if (CIRCLE_TYPES.has(att.type)) return `type=${att.type}`;
  if (att.type !== 'video') return null;
  const v = att.video || {};
  for (const key of CIRCLE_FLAG_KEYS) if (v[key]) return `video.${key}`;
  const vtype = String(v.type || '');
  if (CIRCLE_TYPES.has(vtype) || vtype === 'round') return `video.type=${vtype}`;
  const w = Number(v.width);
  const h = Number(v.height);
  if (w > 0 && h > 0 && Math.abs(w - h) <= 2 && !(Number(v.duration) > CIRCLE_MAX_SECONDS)) {
    return `квадратное видео ${w}x${h}, ${v.duration === undefined ? '?' : v.duration} с`;
  }
  return null;
}

// Раз в минуту пишем в лог не больше нескольких строк про непонятные вложения.
let unknownLogWindow = 0;
let unknownLogCount = 0;
function logUnknownAttachment(att) {
  const now = Date.now();
  if (now - unknownLogWindow > 60 * 1000) {
    unknownLogWindow = now;
    unknownLogCount = 0;
  }
  if (unknownLogCount++ >= 5) return;
  const inner = att && att.type && att[att.type] && typeof att[att.type] === 'object' ? att[att.type] : {};
  const q = (x) => (x === undefined || x === null ? '?' : x);
  const v = att.type === 'video' ? `, ${q(inner.width)}x${q(inner.height)}, ${q(inner.duration)} с` : '';
  console.log(
    `[attach] type=${att && att.type} поля=[${Object.keys(att || {}).join(',')}] ` +
      `внутри=[${Object.keys(inner).join(',')}]${v}`
  );
}

// Возвращает причину удаления или null.
function inspectMedia(attachments) {
  for (const att of attachments) {
    const voice = voiceEvidence(att);
    if (voice) return 'голосовое сообщение';
    const circle = circleEvidence(att);
    if (circle) return `видеокружок (${circle})`;
    if (DELETE_ALL_VIDEOS && att && att.type === 'video') return 'видео (включён DELETE_ALL_VIDEOS)';
  }
  // Ничего не найдено — но, если встретились видео или незнакомые типы вложений,
  // запишем в лог, как они выглядят (для диагностики).
  for (const att of attachments) {
    if (att && (att.type === 'video' || !KNOWN_TYPES.has(att.type))) logUnknownAttachment(att);
  }
  return null;
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

  // 0) Голосовые сообщения и видеокружки — удаляем всегда, чьи бы они ни были.
  const mediaReason = inspectMedia(attachments);
  if (mediaReason) return mediaReason;

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

}

// ---------------------------------------------------------------------------
// Long Poll: получаем события от VK
// ---------------------------------------------------------------------------

// Если VK_GROUP_ID не задан — спрашиваем у VK, какому сообществу принадлежит токен.
async function resolveGroupId() {
  if (GROUP_ID) return GROUP_ID;
  const res = await callApi('groups.getById', {});
  const group = Array.isArray(res) ? res[0] : res && res.groups && res.groups[0];
  const id = group && Math.abs(Number(group.id));
  if (!id) throw new Error('VK не вернул id сообщества. Проверьте, что токен — ключ именно сообщества.');
  GROUP_ID = id;
  return GROUP_ID;
}

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

async function start() {
  try {
    await resolveGroupId();
    console.log(`Сообщество: club${GROUP_ID}`);
  } catch (err) {
    console.error('Не удалось определить сообщество:', err.message);
    process.exit(1);
  }
  loadAllowedGroups(ALLOWED_GROUPS_FILE);
  const custom = loadBlocklist(BLOCKLIST_FILE);
  console.log(`Свой список запрещённых слов (blocklist.txt): ${custom} записей`);
  if (ALLOWED_GROUP_IDS.size) {
    console.log(`Репосты разрешены из сообществ: ${[...ALLOWED_GROUP_IDS].join(', ')}`);
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
  circleEvidence,
  groupOfRepost,
  deleteLooksOk,
  refusedUntil,
  BOT_ADDED_TEXT,
  resolveGroupId,
  parseGroupList,
  loadAllowedGroups,
  ALLOWED_GROUP_IDS,
  _config: () => ({ TOKEN, GROUP_ID }),
  _setApi: (fn) => {
    callApi = fn;
  },
};
