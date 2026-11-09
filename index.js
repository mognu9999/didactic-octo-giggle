require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const { containsProfanity } = require('./badwords');
const { containsLgbt } = require('./lgbt');
const { loadCustomWords, addCustomWord, removeCustomWord, containsCustomWord } = require('./userwords');
const { checkForbidden, loadBlocklist } = require('./forbidden');
const { createStore } = require('./streaks');

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
// репосты из любых сообществ (кроме репостов от админов и владельца беседы).
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

// Файл с текстом для команды /правила (лежит в репозитории рядом с index.js).
const RULES_FILE_CANDIDATES = [
  process.env.RULES_FILE,
  path.join(__dirname, 'Правила short.txt'),
  path.join(__dirname, 'Правила_short.txt'),
  path.join(__dirname, 'rules.txt'),
].filter(Boolean);

// Где хранить счёт кристаллов и сколько кристаллов даётся за одно сообщение.
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const CRYSTALS_PER_MESSAGE = Number(process.env.CRYSTALS_PER_MESSAGE) || 1;

// Слова, добавленные командой /запретить (лежат рядом со статистикой, чтобы
// один и тот же Volume хранил и то и другое).
const WORDS_FILE = process.env.WORDS_FILE || path.join(path.dirname(STATS_FILE), 'custom_words.txt');

// Серии (огоньки) тоже лежат рядом со статистикой.
const STREAKS_FILE = process.env.STREAKS_FILE || path.join(path.dirname(STATS_FILE), 'streaks.json');
const streaks = createStore();

// В каких единицах VK считает смещения жирного шрифта. По умолчанию — UTF-16
// (как индексы строк в JS). Если жирное съезжает на 1-2 символа из-за эмодзи,
// поставьте FORMAT_UNITS=codepoints.
const FORMAT_UNITS = String(process.env.FORMAT_UNITS || 'utf16').toLowerCase();

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
// Исключение из беседы и список админов беседы
// ---------------------------------------------------------------------------

const kickRefusedUntil = new Map(); // "peerId:userId" -> время, до которого не пытаемся

// Исключает участника из беседы. Ничего в чат не пишет.
async function kickUser(peerId, userId, reason) {
  const key = `${peerId}:${userId}`;
  const now = Date.now();
  if ((kickRefusedUntil.get(key) || 0) > now) return false;
  try {
    await callApi('messages.removeChatUser', {
      chat_id: peerId - CHAT_PEER_START,
      member_id: userId,
    });
    console.log(`[kick] peer=${peerId} user=${userId} причина="${reason}"`);
    return true;
  } catch (e) {
    kickRefusedUntil.set(key, now + REFUSED_COOLDOWN_MS);
    console.error(
      `[kick] не удалось исключить (peer=${peerId}, user=${userId}, причина "${reason}"): ${e.message}. ` +
        'Сообщество должно быть админом беседы, а исключаемый — не админом.'
    );
    return false;
  }
}

// Админы и владелец беседы. Список кэшируется, чтобы не дёргать VK на каждое сообщение.
const ADMIN_CACHE_MS = 15 * 1000;
const adminCache = new Map(); // peerId -> { at, ids:Set }
const adminPending = new Map(); // peerId -> Promise

async function getChatAdmins(peerId) {
  const cached = adminCache.get(peerId);
  if (cached && Date.now() - cached.at < ADMIN_CACHE_MS) return cached.ids;
  if (adminPending.has(peerId)) return adminPending.get(peerId);

  const p = (async () => {
    try {
      const res = await callApi('messages.getConversationMembers', { peer_id: peerId, group_id: GROUP_ID });
      const ids = new Set(
        ((res && res.items) || []).filter((m) => m.is_admin || m.is_owner).map((m) => m.member_id)
      );
      adminCache.set(peerId, { at: Date.now(), ids });
      return ids;
    } catch (e) {
      console.error(
        `[admins] не удалось получить список админов (peer=${peerId}): ${e.message}. ` +
          'Проверьте, что сообщество — администратор беседы.'
      );
      const ids = new Set();
      adminCache.set(peerId, { at: Date.now(), ids });
      return ids;
    } finally {
      adminPending.delete(peerId);
    }
  })();
  adminPending.set(peerId, p);
  return p;
}

async function isChatAdmin(peerId, userId) {
  return (await getChatAdmins(peerId)).has(userId);
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

const LGBT_REASON = 'ЛГБТ-тематика';
const REPOST_REASON = 'репост из сообщества';

// Собираем текст и вложения из самого сообщения и из пересланных в нём
// (рекурсивно): переслать чужой мат — всё равно что написать его самому.
function collect(message, depth = 0, acc = { texts: [], attachments: [] }) {
  if (!message || depth > 5) return acc;
  if (message.text) acc.texts.push(message.text);
  for (const att of message.attachments || []) acc.attachments.push(att);
  for (const fwd of message.fwd_messages || []) collect(fwd, depth + 1, acc);
  // Сообщение, на которое ответили (reply), тоже может нести текст/вложения,
  // но оно уже лежит в чате отдельно и проверяется само — поэтому его не собираем.
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
  const custom = containsCustomWord(text);
  if (custom) return `запрещённое слово из /запретить: ${custom}`;
  const forbidden = checkForbidden(text);
  if (forbidden) return `запрещённый контент: ${forbidden}`;
  return null;
}

// Возвращает причину, по которой сообщение надо удалить, или null.
// options.allowReposts — не считать нарушением репост из сообщества (для админов беседы).
function inspectMessage(message, options = {}) {
  const { texts, attachments } = collect(message);

  // 0) Голосовые сообщения и видеокружки — удаляем всегда, чьи бы они ни были.
  const mediaReason = inspectMedia(attachments);
  if (mediaReason) return mediaReason;

  // Тексты репостов тоже проверяем.
  for (const att of attachments) texts.push(...wallTexts(att));

  // 1) ЛГБТ-тематика — удаляем сообщение и исключаем автора.
  for (const text of texts) {
    if (containsLgbt(text)) return LGBT_REASON;
  }

  // 2) Репост из сообщества — удаляем сразу, без разбора текста.
  if (!options.allowReposts) {
    for (const att of attachments) {
      const groupId = groupOfRepost(att);
      if (groupId && !ALLOWED_GROUP_IDS.has(groupId)) return REPOST_REASON;
    }
  }

  // 3) Мат, оскорбления, запрещённый контент.
  for (const text of texts) {
    const reason = checkText(text);
    if (reason) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Кристаллы: каждое (не удалённое) сообщение участника = CRYSTALS_PER_MESSAGE
// ---------------------------------------------------------------------------

let stats = {}; // peerId -> userId -> { messages, crystals }
let statsDirty = false;
let statsTimer = null;
let persistStats = false; // включается только в start(), чтобы тесты не писали файлы

function loadStats(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data && typeof data === 'object') stats = data;
    console.log(`Статистика кристаллов загружена: ${Object.keys(stats).length} бесед`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать stats.json:', e.message);
  }
}

function saveStatsNow() {
  if (!persistStats || !statsDirty) return;
  statsDirty = false;
  const tmp = `${STATS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(stats));
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) {
    statsDirty = true;
    console.error('Не удалось сохранить stats.json:', e.message);
  }
}

function scheduleStatsSave() {
  statsDirty = true;
  if (!persistStats || statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    saveStatsNow();
  }, 5000);
  if (statsTimer.unref) statsTimer.unref();
}

function getStat(peerId, userId) {
  const chat = stats[peerId] || (stats[peerId] = {});
  return chat[userId] || (chat[userId] = { messages: 0, crystals: 0 });
}

function addCrystals(peerId, userId) {
  const rec = getStat(peerId, userId);
  rec.messages += 1;
  rec.crystals += CRYSTALS_PER_MESSAGE;
  scheduleStatsSave();
}

function pluralCrystals(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'кристалл';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'кристалла';
  return 'кристаллов';
}

const nameCache = new Map(); // userId -> "Имя Фамилия"
async function getUserName(userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    const res = await callApi('users.get', { user_ids: userId });
    const u = Array.isArray(res) ? res[0] : null;
    if (u) {
      const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
      if (name) {
        nameCache.set(userId, name);
        return name;
      }
    }
  } catch (e) {
    console.error('Не удалось получить имя пользователя:', e.message);
  }
  return `id${userId}`;
}

// ---------------------------------------------------------------------------
// Команды: правила, бан, кристаллы, монетка, огонёк, серии, обнять, снежок, /запретить, /разрешить
// ---------------------------------------------------------------------------

function sendMessage(peerId, text, extra = {}) {
  return callApi('messages.send', {
    peer_id: peerId,
    random_id: crypto.randomInt(1, 2147483647),
    message: text,
    disable_mentions: 1,
    ...extra,
  });
}

// Ответ именно reply-ем на сообщение пользователя. Если VK reply не принял —
// отправляем обычным сообщением, чтобы ответ не потерялся.
async function replyTo(message, text, extra = {}) {
  try {
    return await sendMessage(message.peer_id, text, {
      ...extra,
      forward: {
        peer_id: message.peer_id,
        conversation_message_ids: [message.conversation_message_id],
        is_reply: true,
      },
    });
  } catch (e) {
    if (e.vkCode === undefined) throw e;
    console.error(`[reply] reply не удался (${e.message}), отправляю обычным сообщением`);
    return sendMessage(message.peer_id, text, extra);
  }
}

// Слова-команды пишутся без слэша ("кристаллы", "монетка 100", "обнять", "серии"...),
// слэш в начале тоже допустим. Только /запретить и /разрешить — всегда со слэшем.
// Команда должна занимать ВСЁ сообщение, поэтому обычные фразы со словом "монетка" не срабатывают.
const TARGET_SRC =
  '(?:\\[id\\d+\\|[^\\]]*\\]|@[A-Za-z0-9_.]{2,}|(?:https?:\\/\\/)?(?:m\\.)?vk\\.(?:com|ru)\\/[A-Za-z0-9_.]{2,}|[A-Za-z][A-Za-z0-9_.]{2,31})';
const SLASH_RE = /^\/(запретить|разрешить)(?:@\S+)?(?:\s+([\s\S]*))?$/i;
const SIMPLE_RE = /^\/?(правила|бан|огоньки|серии)[.!\s]*$/i;
const COIN_RE = /^\/?монетка(?:\s+([\s\S]*))?$/i;
const TOKEN_RE = new RegExp(`^${TARGET_SRC}$`, 'i');
// Фразы-приглашения: "го агонь", "огонёк" (+ ник до или после), "обнять", "снежок".
const SOCIAL = [
  { cmd: 'огонек', phrase: 'го\\s+[ао]г[оа]нь|огон[её]к' },
  { cmd: 'кристаллы', phrase: 'кристаллы' },
  { cmd: 'обнять', phrase: 'обнять' },
  { cmd: 'снежок', phrase: 'снежок' },
].map(({ cmd, phrase }) => ({
  cmd,
  re: new RegExp(`^\\/?(?:(${TARGET_SRC})\\s+)?(?:${phrase})(?:\\s+(${TARGET_SRC}))?[.!…\\s]*$`, 'i'),
}));

// "монетка 100 @user": только числа и упоминания, чтобы не ловить обычные фразы.
function validCoinArgs(args) {
  if (!args) return true;
  const tokens = args.replace(/\[id\d+\|[^\]]*\]/g, 'M').trim().split(/\s+/);
  return tokens.length <= 4 && tokens.every((t) => /^\d{1,12}$/.test(t) || t === 'M' || TOKEN_RE.test(t));
}

// "/запретить слово" -> { cmd: 'запретить', args: 'слово' }
function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  let m = SLASH_RE.exec(t);
  if (m) return { cmd: m[1].toLowerCase(), args: (m[2] || '').trim() };
  m = SIMPLE_RE.exec(t);
  if (m) return { cmd: m[1].toLowerCase(), args: '' };
  m = COIN_RE.exec(t);
  if (m) {
    const args = (m[1] || '').trim();
    return validCoinArgs(args) ? { cmd: 'монетка', args } : null;
  }
  for (const { cmd, re } of SOCIAL) {
    m = re.exec(t);
    if (m) return { cmd, args: (m[1] || m[2] || '').trim() };
  }
  return null;
}

// Сообщение, на которое ответил автор команды (reply или единственное пересланное).
function replyTarget(message) {
  if (message.reply_message) return message.reply_message;
  if (Array.isArray(message.fwd_messages) && message.fwd_messages.length === 1) return message.fwd_messages[0];
  return null;
}

// --- /правила ---------------------------------------------------------------

// Текст по умолчанию. Если рядом с index.js лежит непустой "Правила short.txt"
// (или RULES_FILE) — берётся текст из файла.
const DEFAULT_RULES_TEXT = `🔊 Правила официального комьюнити
ООО «Я ТЕБЯ НИКОГДА НЕ ПРЕДАМ. 3»:

▪️ Уважайте участников и их мнения.
▪️ Запрещены: оскорбления, спам, реклама, политика, ложь о компании
ООО «Я ТЕБЯ НИКОГДА НЕ ПРЕДАМ. 3».
▪️ Запрещена публикация в официальном комьюнити информации и материалов запрещённых к публикации в информационном пространстве на территории Российской Федерации.
▪️ Ссылки, розыгрыши и призывы к сделкам — только с одобрения админов.
▪️ Фишинг, мошенничество и токсичность — строго запрещены.
▪️ Админы никогда не пишут первыми. Будьте внимательны!

⚠️ Негативные высказывания о компании
ООО «Я ТЕБЯ НИКОГДА НЕ ПРЕДАМ. 3» или провокации:
— 1-й раз: предупреждение и удаление сообщения.
— 2-й раз: бан без возврата.

Спасибо, что соблюдаете правила и помогаете сохранить безопасную атмосферу в нашем сообществе!

Команда 
ООО «Я ТЕБЯ НИКОГДА НЕ ПРЕДАМ. 3» 🖤`;

function loadRulesText() {
  for (const file of RULES_FILE_CANDIDATES) {
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
      if (text) return text;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`Не удалось прочитать ${file}:`, e.message);
    }
  }
  return DEFAULT_RULES_TEXT.replace(/\r\n?/g, '\n').trim();
}

// Название компании: от «ООО» (или «Общество с ограниченной ответственностью»)
// до закрывающей «»». Находит ВСЕ вхождения. Возвращает [{ start, end }] —
// индексы в строке JS (end не включительно).
function findCompanyNames(text) {
  const re = /(?:ООО|Общество с ограниченной ответственностью)\s*«[^»]*»/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

function toUnits(text, from, to) {
  const part = text.slice(from, to);
  return FORMAT_UNITS === 'codepoints' ? Array.from(part).length : part.length;
}

function buildBoldFormat(text) {
  const items = findCompanyNames(text).map(({ start, end }) => ({
    type: 'bold',
    offset: toUnits(text, 0, start),
    length: toUnits(text, start, end),
  }));
  return items.length ? { version: '1', items } : null;
}

async function handleRulesCommand(message) {
  const text = loadRulesText();
  const format = buildBoldFormat(text);
  const extra = format ? { format_data: format } : {};
  try {
    await sendMessage(message.peer_id, text, extra);
  } catch (e) {
    if (e.vkCode === undefined || !format) throw e;
    // Если VK не принял форматирование — всё равно отправляем правила, но без жирного.
    console.error(`[rules] VK не принял format_data (${e.message}), отправляю без жирного`);
    await sendMessage(message.peer_id, text);
  }
}

// --- /бан -------------------------------------------------------------------

async function handleBanCommand(message) {
  const peerId = message.peer_id;
  const adminId = message.from_id;
  if (!(await isChatAdmin(peerId, adminId))) return; // банить могут только админы и владелец

  const target = replyTarget(message);
  const targetId = target && target.from_id;
  if (!(targetId > 0)) {
    console.log(`[ban] peer=${peerId}: /бан без ответа на сообщение участника — ничего не делаю`);
    return;
  }
  if (targetId === adminId) return;
  if (await isChatAdmin(peerId, targetId)) {
    console.log(`[ban] peer=${peerId}: ${targetId} — админ беседы, исключить нельзя`);
    return;
  }
  await kickUser(peerId, targetId, `команда /бан от ${adminId}`);
}

// --- /запретить и /разрешить ------------------------------------------------

// Удаляет только что отправленное ботом сообщение через delayMs.
// res — ответ messages.send (число message_id или объект/массив с ids).
function deleteSentLater(peerId, res, delayMs) {
  const item = Array.isArray(res) ? res[0] : res;
  let params = null;
  if (item && typeof item === 'object') {
    if (item.conversation_message_id) params = { peer_id: peerId, cmids: String(item.conversation_message_id) };
    else if (item.message_id) params = { message_ids: String(item.message_id) };
  } else if (typeof item === 'number' && item > 0) {
    params = { message_ids: String(item) };
  }
  if (!params) return;
  const timer = setTimeout(() => {
    callApi('messages.delete', { ...params, delete_for_all: 1, group_id: GROUP_ID }).catch((e) =>
      console.error('[words] не удалось удалить сообщение бота:', e.message)
    );
  }, delayMs);
  if (timer.unref) timer.unref();
}

const SELF_DELETE_MS = 5000;

async function handleWordCommand(cmd, message, args) {
  if (!(await isChatAdmin(message.peer_id, message.from_id))) return; // только админы и владелец
  // Любой ответ на эти команды бот сам удаляет через 5 секунд.
  const say = async (text) => deleteSentLater(message.peer_id, await replyTo(message, text), SELF_DELETE_MS);

  if (!args) return say(`Укажите слово: /${cmd} слово`);
  if (cmd === 'запретить') {
    const r = addCustomWord(args);
    if (r.status === 'added') {
      console.log(`[words] добавлено "${r.word}" (админ ${message.from_id})`);
      return say(`Слово «${r.word}» добавлено в список удаляемых.`);
    }
    if (r.status === 'exists') return say(`Слово «${r.word}» уже в списке.`);
    if (r.status === 'too_long') return say('Слишком длинно (максимум 100 символов).');
    return say('Слишком короткое слово: нужно минимум 3 символа.');
  }
  const r = removeCustomWord(args);
  if (r.status === 'removed') {
    console.log(`[words] убрано "${r.word}" (админ ${message.from_id})`);
    return say(`Слово «${r.word}» убрано из списка.`);
  }
  return say(`Слова «${r.word}» нет в списке, добавленном через /запретить.`);
}

// --- кристаллы ----------------------------------------------------------------

function peekCrystals(peerId, userId) {
  const chat = stats[peerId];
  return (chat && chat[userId] && chat[userId].crystals) || 0;
}

// "кристаллы" — свой баланс. С reply или ником/упоминанием — баланс этого пользователя.
async function handleCrystalsCommand(message, token) {
  const target = await resolveTarget(message, token);
  if (target.notFound && target.bare) return; // это просто слово в чате, а не команда
  if (target.notFound) {
    return replyTo(message, 'Не нашёл такого пользователя. Проверьте username или ответьте на его сообщение.');
  }
  if (!target.id || target.id === message.from_id) {
    const n = peekCrystals(message.peer_id, message.from_id);
    return replyTo(message, `💎 У вас ${n} ${pluralCrystals(n)}`);
  }
  const names = await getUserNames([target.id]);
  const n = peekCrystals(message.peer_id, target.id);
  return replyTo(message, `у ${names.get(target.id)} ${n} ${pluralCrystals(n)}`);
}

// --- /м: бросок монетки на кристаллы ----------------------------------------

const duels = new Map(); // id -> { peerId, challengerId, opponentId, amount, at }
const DUEL_TTL_MS = 10 * 60 * 1000;

function pruneDuels() {
  const now = Date.now();
  for (const [id, d] of duels) if (now - d.at > DUEL_TTL_MS) duels.delete(id);
}

// "100 @durov", "[id1|Павел] 50", "durov 100" -> { amount, mentionId, screen }
function parseDuelArgs(args) {
  let rest = String(args || '');
  let mentionId = null;
  let screen = null;

  const mention = /\[id(\d+)\|[^\]]*\]/.exec(rest);
  if (mention) {
    mentionId = Number(mention[1]);
    rest = rest.replace(mention[0], ' ');
  } else {
    const link = /(?:@|vk\.com\/|vk\.ru\/)([A-Za-z0-9_.]{2,})/i.exec(rest);
    if (link) {
      screen = link[1];
      rest = rest.replace(link[0], ' ');
    }
  }

  let amount = null;
  const num = /(?<![\w.\-])(\d{1,12})(?![\w.])/.exec(rest);
  if (num) {
    amount = Number(num[1]);
    rest = rest.replace(num[0], ' ');
  }

  // Ник без "@": "/м 100 durov"
  if (!mentionId && !screen) {
    const bare = rest.trim();
    if (/^[A-Za-z0-9_.]{2,}$/.test(bare)) screen = bare;
  }
  return { amount, mentionId, screen };
}

async function handleDuelCommand(message, args) {
  const peerId = message.peer_id;
  const challengerId = message.from_id;
  const parsed = parseDuelArgs(args);

  // Кто соперник: reply на сообщение > упоминание > username.
  let opponentId = null;
  const target = replyTarget(message);
  if (target && target.from_id > 0) {
    opponentId = target.from_id;
  } else if (parsed.mentionId) {
    opponentId = parsed.mentionId;
  } else if (parsed.screen) {
    try {
      const res = await callApi('users.get', { user_ids: parsed.screen });
      if (Array.isArray(res) && res[0] && res[0].id) opponentId = res[0].id;
    } catch (e) {
      /* не нашли */
    }
    if (!opponentId) return replyTo(message, 'Не нашёл такого пользователя. Проверьте username или ответьте на его сообщение.');
  }

  if (!opponentId) {
    return replyTo(
      message,
      'Ответьте на сообщение пользователя, с которым хотите подкинуть монетку, или укажите его username'
    );
  }
  if (opponentId === challengerId) return replyTo(message, 'Нельзя кидать монетку с самим собой.');

  const amount = parsed.amount;
  if (!amount || !Number.isSafeInteger(amount) || amount < 1) {
    return replyTo(message, 'Укажите ставку в кристаллах, например: монетка 100');
  }

  const mine = getStat(peerId, challengerId).crystals;
  if (mine < amount) {
    return replyTo(message, `Не хватает кристаллов: у вас ${mine} ${pluralCrystals(mine)}, а ставка ${amount}.`);
  }
  const theirs = getStat(peerId, opponentId).crystals;
  const [challengerName, opponentName] = await Promise.all([getUserName(challengerId), getUserName(opponentId)]);
  if (theirs < amount) {
    return replyTo(message, `У ${opponentName} не хватает кристаллов: ${theirs} ${pluralCrystals(theirs)}, а ставка ${amount}.`);
  }

  pruneDuels();
  const id = crypto.randomBytes(6).toString('hex');
  duels.set(id, { peerId, challengerId, opponentId, amount, at: Date.now() });

  const keyboard = {
    inline: true,
    buttons: [
      [
        { action: { type: 'callback', label: 'Кидаем', payload: JSON.stringify({ duel: id, act: 'yes' }) }, color: 'positive' },
        { action: { type: 'callback', label: 'Нет', payload: JSON.stringify({ duel: id, act: 'no' }) }, color: 'negative' },
      ],
    ],
  };
  await replyTo(
    message,
    `🪙 ${challengerName} предлагает [id${opponentId}|${opponentName}] подкинуть монетку на ${amount} ${pluralCrystals(amount)}. Кидаем?`,
    { keyboard, disable_mentions: 0 }
  );
}

async function runCoinFlip(duel) {
  const { peerId, challengerId, opponentId, amount } = duel;
  const [challengerName, opponentName] = await Promise.all([getUserName(challengerId), getUserName(opponentId)]);

  // Дальше до списания нет await — два броска не смогут одновременно потратить одни и те же кристаллы.
  const a = getStat(peerId, challengerId);
  const b = getStat(peerId, opponentId);
  if (a.crystals < amount || b.crystals < amount) {
    const who = a.crystals < amount ? challengerName : opponentName;
    return sendMessage(peerId, `Бросок отменён: у ${who} уже не хватает кристаллов на ставку.`);
  }

  const challengerWins = crypto.randomInt(2) === 0;
  const winner = challengerWins ? a : b;
  const loser = challengerWins ? b : a;
  loser.crystals -= amount;
  winner.crystals += amount;
  scheduleStatsSave();

  const winnerName = challengerWins ? challengerName : opponentName;
  const loserName = challengerWins ? opponentName : challengerName;
  console.log(`[coin] peer=${peerId} победитель=${challengerWins ? challengerId : opponentId} ставка=${amount}`);
  await sendMessage(
    peerId,
    `🪙 Монетка подброшена! Побеждает ${winnerName}.\n` +
      `${loserName} теряет ${amount} ${pluralCrystals(amount)}, они переходят к ${winnerName}.\n` +
      `Теперь у ${winnerName}: ${winner.crystals} ${pluralCrystals(winner.crystals)}.`
  );
}

// Нажатие инлайн-кнопки (событие message_event).
async function handleEvent(ev) {
  const answer = (text) =>
    callApi('messages.sendMessageEventAnswer', {
      event_id: ev.event_id,
      user_id: ev.user_id,
      peer_id: ev.peer_id,
      event_data: text ? { type: 'show_snackbar', text } : undefined,
    }).catch((e) => console.error('[event] не удалось ответить на нажатие:', e.message));

  let payload = ev.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      payload = null;
    }
  }
  if (payload && payload.fire) return handleFireEvent(ev, payload, answer);
  if (!payload || !payload.duel) return answer();

  pruneDuels();
  const duel = duels.get(payload.duel);
  if (!duel || duel.peerId !== ev.peer_id) return answer('Этот бросок уже недействителен');

  if (payload.act === 'no') {
    if (ev.user_id !== duel.opponentId && ev.user_id !== duel.challengerId) return answer('Эта кнопка не для вас');
    duels.delete(payload.duel);
    await answer();
    await sendMessage(duel.peerId, 'Пользователь отменил бросок монетки');
    return;
  }
  if (payload.act === 'yes') {
    if (ev.user_id !== duel.opponentId) return answer('Принять бросок может только тот, кого вызвали');
    duels.delete(payload.duel);
    await answer();
    await runCoinFlip(duel);
    return;
  }
  return answer();
}

// --- общие помощники для новых команд ---------------------------------------

// Имена по id одним запросом (с кэшем): Map(id -> "Имя Фамилия").
async function getUserNames(ids) {
  const out = new Map();
  const missing = [];
  for (const id of new Set(ids)) {
    if (nameCache.has(id)) out.set(id, nameCache.get(id));
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    try {
      const res = await callApi('users.get', { user_ids: chunk.join(',') });
      for (const u of Array.isArray(res) ? res : []) {
        const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
        if (name) {
          nameCache.set(u.id, name);
          out.set(u.id, name);
        }
      }
    } catch (e) {
      console.error('Не удалось получить имена пользователей:', e.message);
    }
  }
  for (const id of ids) if (!out.has(id)) out.set(id, `id${id}`);
  return out;
}

// Кого имел в виду автор: reply на сообщение > упоминание [id1|..] > @username / ссылка / ник.
async function resolveTarget(message, token) {
  const t = replyTarget(message);
  if (t && t.from_id > 0) return { id: t.from_id };
  if (!token) return { id: null, none: true };
  const mention = /^\[id(\d+)\|/.exec(token);
  if (mention) return { id: Number(mention[1]) };
  const bare = !/^(@|https?:|m\.|vk\.)/i.test(token);
  const screen = token.replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:m\.)?vk\.(?:com|ru)\//i, '');
  try {
    const res = await callApi('users.get', { user_ids: screen });
    if (Array.isArray(res) && res[0] && res[0].id) return { id: res[0].id };
  } catch (e) {
    /* не нашли */
  }
  return { id: null, notFound: true, bare };
}

// Длинные списки режем на несколько сообщений (лимит VK — 4096 символов).
async function sendChunks(peerId, header, lines) {
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3500) {
      await sendMessage(peerId, chunk);
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) await sendMessage(peerId, chunk);
}

async function streakLines(list) {
  const ids = list.flatMap((s) => [s.a, s.b]);
  const names = await getUserNames(ids);
  return list.map((s) => `${names.get(s.a)} и ${names.get(s.b)} 🔥${s.days}`);
}

// --- картинки для /обнять и /снежок -----------------------------------------
// VK не принимает SVG как фото, поэтому рядом с .svg лежит готовый .png
// (картинка одна и та же для всех, её не нужно генерировать на лету).
// PNG загружается в VK один раз, дальше переиспользуется.

const ASSETS_DIR = path.join(__dirname, 'assets');
const pictureCache = new Map(); // kind -> "photo-123_456_key"

async function realUploadPicture(kind, peerId) {
  if (typeof fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('нужен Node.js 18 или новее');
  }
  const buf = fs.readFileSync(path.join(ASSETS_DIR, `${kind}.png`));
  const server = await callApi('photos.getMessagesUploadServer', { peer_id: peerId });
  const form = new FormData();
  form.append('photo', new Blob([buf], { type: 'image/png' }), `${kind}.png`);
  const resp = await fetch(server.upload_url, { method: 'POST', body: form });
  const up = await resp.json();
  const saved = await callApi('photos.saveMessagesPhoto', { photo: up.photo, server: up.server, hash: up.hash });
  const p = Array.isArray(saved) ? saved[0] : null;
  if (!p) throw new Error('VK не сохранил фото');
  return `photo${p.owner_id}_${p.id}${p.access_key ? `_${p.access_key}` : ''}`;
}
let uploadPicture = realUploadPicture;

// Отправляет текст с картинкой. Если картинку загрузить не удалось
// (например, у ключа нет права на фото) — отправляет просто текст.
async function sendWithPicture(message, text, kind, extra = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let attachment = pictureCache.get(kind);
    if (!attachment) {
      try {
        attachment = await uploadPicture(kind, message.peer_id);
        pictureCache.set(kind, attachment);
      } catch (e) {
        console.error(
          `[picture] не удалось загрузить картинку ${kind}: ${e.message}. ` +
            'Проверьте, что у ключа сообщества включено право на «Фотографии».'
        );
        break;
      }
    }
    try {
      return await replyTo(message, text, { ...extra, attachment });
    } catch (e) {
      if (e.vkCode === undefined) throw e;
      pictureCache.delete(kind); // вдруг вложение устарело — загрузим заново
      console.error(`[picture] VK не принял вложение ${kind}: ${e.message}`);
    }
  }
  return replyTo(message, text, extra);
}

// --- огонёк (серии) ---------------------------------------------------------

async function handleFireInvite(message, targetId) {
  const peerId = message.peer_id;
  const fromId = message.from_id;
  const r = streaks.createInvite(peerId, fromId, targetId);
  const names = await getUserNames([fromId, targetId]);
  if (r.status === 'exists') {
    return replyTo(message, `У вас уже есть серия с ${names.get(targetId)} 🔥${r.streak.days}`);
  }
  if (r.status === 'pending') {
    return replyTo(message, `Предложение для ${names.get(targetId)} уже отправлено. Ждём ответа 🔥`);
  }
  const id = r.invite.id;
  const keyboard = {
    inline: true,
    buttons: [
      [
        { action: { type: 'callback', label: 'Принять', payload: JSON.stringify({ fire: id, act: 'ok' }) }, color: 'positive' },
        { action: { type: 'callback', label: 'Отказаться', payload: JSON.stringify({ fire: id, act: 'no' }) }, color: 'negative' },
      ],
    ],
  };
  await replyTo(
    message,
    `[id${targetId}|${names.get(targetId)}] вааау😻, ${names.get(fromId)} предлагает вам растить серию🥰`,
    { keyboard, disable_mentions: 0 }
  );
}

async function handleFireEvent(ev, payload, answer) {
  const inv = streaks.getInvite(payload.fire);
  if (!inv || inv.peerId !== ev.peer_id) return answer('Это предложение уже недействительно');
  if (ev.user_id !== inv.to) return answer('Это предложение адресовано не вам');

  if (payload.act === 'no') {
    streaks.removeInvite(inv.id);
    await answer();
    const names = await getUserNames([inv.from]);
    await sendMessage(inv.peerId, `[id${inv.from}|${names.get(inv.from)}], эх, извините пользователь не хочет общ с вами`, {
      disable_mentions: 0,
    });
    return;
  }
  if (payload.act === 'ok') {
    const s = streaks.accept(inv.id);
    await answer();
    if (!s) return;
    const names = await getUserNames([s.a, s.b]);
    await sendMessage(s.peerId, `одяяяя, ${names.get(s.a)} и ${names.get(s.b)} запускают серию!🔥`);
    return;
  }
  return answer();
}

async function handleStreaksList(message) {
  const list = streaks.listStreaks(message.peer_id);
  if (!list.length) {
    return replyTo(
      message,
      'В этом чате пока нет серий. Ответьте на сообщение пользователя словами «го агонь» или «огонёк», чтобы предложить ему серию 🔥'
    );
  }
  await sendChunks(message.peer_id, 'Серии чата:', await streakLines(list));
}

// Вызывается раз в 30 секунд: полночь, напоминания, завершение серий.
async function runStreakTick(now = Date.now()) {
  let events;
  try {
    events = streaks.tick(now);
  } catch (e) {
    console.error('Ошибка планировщика серий:', e);
    return;
  }
  for (const ev of events) {
    try {
      if (ev.type === 'ended') {
        const s = ev.streak;
        const names = await getUserNames([s.a, s.b]);
        await sendMessage(
          s.peerId,
          `${names.get(s.a)} и ${names.get(s.b)} к сожалению ваша серия завершена, восстановить её никак не удастся, только начать заново.`
        );
      } else if (ev.type === 'fading') {
        const header =
          ev.kind === 'midnight'
            ? 'Серии чата угасают.. Не оставьте общение во тьме..'
            : 'Серии чата нужно обновить! Ответьте (reply) друг другу, чтобы огонёк не погас:';
        await sendChunks(ev.peerId, header, await streakLines(ev.streaks));
      }
    } catch (e) {
      console.error('[streaks] не удалось отправить сообщение в беседу:', e.message);
    }
  }
}

// --- /обнять и /снежок ------------------------------------------------------

const SOCIAL_HINTS = {
  огонек: 'Ответьте на сообщение пользователя или укажите его username, чтобы предложить ему огонёк 🔥',
  обнять: 'Ответьте на сообщение пользователя или укажите его username, чтобы обнять его 🤗',
  снежок: 'Ответьте на сообщение пользователя или укажите его username, чтобы кинуть в него снежок ❄️',
};

async function handleSocialCommand(cmd, message, token) {
  const target = await resolveTarget(message, token);
  if (!target.id) {
    if (target.notFound && target.bare) return; // это просто слово в чате, а не команда
    if (target.notFound) return replyTo(message, 'Не нашёл такого пользователя. Проверьте username или ответьте на его сообщение.');
    return replyTo(message, SOCIAL_HINTS[cmd]);
  }
  if (target.id === message.from_id) return replyTo(message, 'Выберите другого пользователя 🙂');

  if (cmd === 'огонек') return handleFireInvite(message, target.id);

  const names = await getUserNames([message.from_id, target.id]);
  const who = names.get(message.from_id);
  const whom = `[id${target.id}|${names.get(target.id)}]`;
  if (cmd === 'обнять') {
    return sendWithPicture(message, `${who} обнимает ${whom}`, 'hug', { disable_mentions: 0 });
  }
  return sendWithPicture(message, `${who} кидает снежок в ${whom}`, 'snowball', { disable_mentions: 0 });
}

async function handleCommand({ cmd, args }, message) {
  if (cmd === 'правила') return handleRulesCommand(message);
  if (cmd === 'бан') return handleBanCommand(message);
  if (cmd === 'кристаллы') return handleCrystalsCommand(message, args);
  if (cmd === 'монетка') return handleDuelCommand(message, args);
  if (cmd === 'огоньки' || cmd === 'серии') return handleStreaksList(message);
  if (cmd === 'огонек' || cmd === 'обнять' || cmd === 'снежок') return handleSocialCommand(cmd, message, args);
  if (cmd === 'запретить' || cmd === 'разрешить') return handleWordCommand(cmd, message, args);
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

  // Команды (см. parseCommand). Команда без аргументов выполняется сразу.
  // Команда с аргументами, вложениями или пересланными сообщениями сначала
  // проходит обычную проверку (иначе через неё можно было бы протащить
  // запрещённое). Исключение — /запретить и /разрешить от админов: слово,
  // которое они вносят в список, не должно считаться нарушением.
  const parsed = edited ? null : parseCommand(message.text);
  const hasExtras =
    (message.attachments && message.attachments.length > 0) ||
    (message.fwd_messages && message.fwd_messages.length > 0);
  let skipCheck = false;
  if (parsed && !hasExtras) {
    const adminWordCmd = parsed.cmd === 'запретить' || parsed.cmd === 'разрешить';
    if (!parsed.args) skipCheck = true;
    else if (adminWordCmd && (await isChatAdmin(peerId, message.from_id))) skipCheck = true;
  }

  // Горячий путь: проверка — это только регулярки, без сетевых запросов,
  // а удаление — один запрос к VK.
  let reason = skipCheck ? null : inspectMessage(message);

  // Репост из сообщества от админа/владельца беседы — не трогаем (остальные
  // проверки текста для него всё равно действуют).
  if (reason === REPOST_REASON && (await isChatAdmin(peerId, message.from_id))) {
    reason = inspectMessage(message, { allowReposts: true });
  }

  if (reason === LGBT_REASON) {
    // Сообщение удаляем, автора исключаем из беседы.
    await Promise.all([removeMessage(message, reason), kickUser(peerId, message.from_id, reason)]);
    return;
  }
  if (reason) return removeMessage(message, reason);

  // Сообщение прошло проверку. Reply на сообщение другого участника
  // поддерживает серию (огонёк) между ними, если она есть.
  if (!edited && message.reply_message) {
    streaks.recordReply(peerId, message.from_id, message.reply_message.from_id);
  }

  // Команда — выполняем (кристаллы за неё не дают).
  if (parsed) return handleCommand(parsed, message);

  // Обычное сообщение — начисляем кристаллы (правки не считаются).
  if (!edited) addCrystals(peerId, message.from_id);
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
  } else if (update.type === 'message_event') {
    handleEvent(obj).catch((e) => console.error('Ошибка обработки нажатия кнопки:', e));
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
  const nWords = loadCustomWords(WORDS_FILE);
  console.log(`Слова из /запретить (${WORDS_FILE}): ${nWords}`);
  loadStats(STATS_FILE);
  persistStats = true;
  const nStreaks = streaks.load(STREAKS_FILE);
  streaks.setPersist(true);
  console.log(`Серии (${STREAKS_FILE}): ${nStreaks}`);
  setInterval(() => runStreakTick(), 30 * 1000);
  const flush = () => {
    saveStatsNow();
    streaks.flush();
  };
  process.on('SIGTERM', () => {
    flush();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    flush();
    process.exit(0);
  });
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
  findCompanyNames,
  loadRulesText,
  parseCommand,
  parseDuelArgs,
  handleEvent,
  duels,
  getStat,
  loadCustomWordsForTests: loadCustomWords,
  pluralCrystals,
  deleteSentLater,
  streaks,
  runStreakTick,
  getUserNames,
  _setUploader: (fn) => {
    uploadPicture = fn;
  },
  _config: () => ({ TOKEN, GROUP_ID }),
  _setApi: (fn) => {
    callApi = fn;
  },
};
