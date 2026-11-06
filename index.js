require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const { containsProfanity } = require('./badwords');
const { containsLgbt } = require('./lgbt');
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

// Список слов, добавленных командой /запретить (удаляются без бана).
const STOPWORDS_FILE = process.env.STOPWORDS_FILE || path.join(__dirname, 'stopwords.json');

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
  const forbidden = checkForbidden(text);
  if (forbidden) return `запрещённый контент: ${forbidden}`;
  const stop = checkStopwords(text);
  if (stop) return `запрещённое слово: ${stop}`;
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
// Команды: /правила, /бан, /кр
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

// Команды без аргументов ("/правила", "/бан", "/кр") принимаются только в точном
// виде — иначе сообщение идёт на обычную проверку. Команды "/запретить",
// "/разрешить" и "/м" принимают аргументы.
const ARG_COMMANDS = new Set(['запретить', 'разрешить', 'м']);
function parseCommand(text) {
  const m = /^\/(правила|бан|кр|запретить|разрешить|м)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const args = (m[2] || '').trim();
  if (args && !ARG_COMMANDS.has(cmd)) return null;
  return { cmd, args };
}

function loadRulesText() {
  for (const file of RULES_FILE_CANDIDATES) {
    try {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
      if (text) return text;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`Не удалось прочитать ${file}:`, e.message);
    }
  }
  return null;
}

// Название компании: от первой заглавной буквы «О» до закрывающей «»».
// Учитывает вложенные кавычки: «ООО «Ромашка «Плюс»»» закроется на последней.
// Возвращает { offset, length } или null.
function findCompanyName(text) {
  const start = text.indexOf('О');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '«') depth++;
    else if (ch === '»') {
      depth--;
      if (depth <= 0) return { offset: start, length: i - start + 1 };
    }
  }
  return null;
}

async function handleRulesCommand(message) {
  const text = loadRulesText();
  if (!text) {
    console.error('[rules] файл с правилами не найден или пуст: положите "Правила short.txt" рядом с index.js');
    return;
  }
  const extra = {};
  const name = findCompanyName(text);
  if (name) {
    // Смещения в UTF-16, как и индексы строк в JS — совпадает с тем, что ждёт VK.
    extra.format_data = {
      version: '1',
      items: [{ type: 'bold', offset: name.offset, length: name.length }],
    };
  }
  await sendMessage(message.peer_id, text, extra);
}

async function handleBanCommand(message) {
  const peerId = message.peer_id;
  const adminId = message.from_id;
  if (!(await isChatAdmin(peerId, adminId))) return; // банить могут только админы и владелец

  const target =
    message.reply_message ||
    (Array.isArray(message.fwd_messages) && message.fwd_messages.length === 1 ? message.fwd_messages[0] : null);
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

async function handleCrystalsCommand(message) {
  const rec = getStat(message.peer_id, message.from_id);
  const name = await getUserName(message.from_id);
  await sendMessage(message.peer_id, `${name} у вас ${rec.crystals} ${pluralCrystals(rec.crystals)}`);
}

// ---------------------------------------------------------------------------
// Стоп-слова: /запретить и /разрешить (только для админов и владельца беседы)
// ---------------------------------------------------------------------------
// Правила те же, что в blocklist.txt: слово ловится с начала и с любым окончанием
// ("реклам" поймает "реклама", "рекламу"), "$" в конце — слово целиком, пробел
// в фразе заменяет любое количество пробелов, регистр и "ё" не важны.

let stopwords = []; // нормализованные строки
const stopRegexCache = new Map();

function normWord(w) {
  return String(w || '')
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripQuotes(s) {
  return String(s || '').trim().replace(/^[«"“„'`]+|[»"”'`]+$/g, '').trim();
}

function stopRegex(word) {
  let re = stopRegexCache.get(word);
  if (re) return re;
  const whole = word.endsWith('$');
  const core = whole ? word.slice(0, -1) : word;
  const body = core
    .split(' ')
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  re = new RegExp(`(?<![а-яa-z0-9])${body}${whole ? '(?![а-яa-z0-9])' : ''}`, 'i');
  stopRegexCache.set(word, re);
  return re;
}

function checkStopwords(text) {
  if (!text || !stopwords.length) return null;
  const t = normWord(text);
  for (const w of stopwords) if (stopRegex(w).test(t)) return w;
  return null;
}

function loadStopwords(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(data)) stopwords = data.map(normWord).filter(Boolean);
    console.log(`Стоп-слова (/запретить): ${stopwords.length} записей`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать stopwords.json:', e.message);
  }
}

function saveStopwords() {
  if (!persistStats) return;
  const tmp = `${STOPWORDS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(stopwords));
    fs.renameSync(tmp, STOPWORDS_FILE);
  } catch (e) {
    console.error('Не удалось сохранить stopwords.json:', e.message);
  }
}

async function handleWordCommand(cmd, args, message) {
  const peerId = message.peer_id;
  if (!(await isChatAdmin(peerId, message.from_id))) return false; // не админ — обычная проверка сообщения

  const word = normWord(stripQuotes(args));
  if (!word) {
    await sendMessage(peerId, `Напишите слово: /${cmd} слово`);
    return true;
  }
  if (cmd === 'запретить') {
    if (word.replace(/\$$/, '').replace(/\s/g, '').length < 3) {
      await sendMessage(peerId, 'Слишком короткое слово: нужно минимум 3 буквы.');
    } else if (stopwords.includes(word)) {
      await sendMessage(peerId, `«${word}» уже в списке.`);
    } else {
      stopwords.push(word);
      saveStopwords();
      console.log(`[stopwords] добавлено "${word}" (админ ${message.from_id})`);
      await sendMessage(peerId, `Готово: «${word}» добавлено в список, такие сообщения будут удаляться.`);
    }
  } else {
    const idx = stopwords.indexOf(word);
    if (idx === -1) {
      await sendMessage(peerId, `«${word}» нет в списке, добавленном командой /запретить.`);
    } else {
      stopwords.splice(idx, 1);
      stopRegexCache.delete(word);
      saveStopwords();
      console.log(`[stopwords] удалено "${word}" (админ ${message.from_id})`);
      await sendMessage(peerId, `Готово: «${word}» убрано из списка.`);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Монетка: /м <ставка> (ответом на сообщение или с упоминанием/username)
// ---------------------------------------------------------------------------

const BET_TTL_MS = 5 * 60 * 1000;
const bets = new Map(); // id -> { peerId, from, to, amount, cmid, text, at }

function cleanBets() {
  const now = Date.now();
  for (const [id, b] of bets) if (now - b.at > BET_TTL_MS) bets.delete(id);
}

function mention(id, name) {
  return `[id${id}|${name}]`;
}

// Ищем соперника: ответ на сообщение -> упоминание [id123|Имя] -> username/ссылка.
async function findOpponent(message, args) {
  const reply =
    message.reply_message ||
    (Array.isArray(message.fwd_messages) && message.fwd_messages.length === 1 ? message.fwd_messages[0] : null);
  let rest = args;
  let opponentId = reply && reply.from_id > 0 ? reply.from_id : null;

  const mm = /\[id(\d+)\|[^\]]*\]/.exec(rest);
  if (mm) {
    if (!opponentId) opponentId = Number(mm[1]);
    rest = rest.replace(mm[0], ' ');
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  const ai = tokens.findIndex((t) => /^\d+$/.test(t));
  const amountTok = ai === -1 ? null : tokens.splice(ai, 1)[0];

  if (!opponentId) {
    for (const tok of tokens) {
      const url = /(?:https?:\/\/)?(?:m\.)?vk\.(?:com|ru)\/([a-z0-9_.]+)/i.exec(tok);
      const name = (url ? url[1] : tok.replace(/^@/, '')).trim();
      if (!/^[a-z0-9_.]{3,32}$/i.test(name)) continue;
      try {
        const res = await callApi('users.get', { user_ids: name });
        if (Array.isArray(res) && res[0] && res[0].id > 0) {
          opponentId = res[0].id;
          break;
        }
      } catch (e) {
        /* не нашли — пробуем следующий токен */
      }
    }
    if (!opponentId && tokens.length) return { notFound: true, amountTok };
  }
  return { opponentId, amountTok };
}

async function handleCoinCommand(args, message) {
  cleanBets();
  const peerId = message.peer_id;
  const from = message.from_id;

  const { opponentId, amountTok, notFound } = await findOpponent(message, args);
  if (notFound) {
    await sendMessage(peerId, 'Не нашёл такого пользователя. Ответьте на его сообщение или укажите его username.');
    return;
  }
  if (!opponentId) {
    await sendMessage(
      peerId,
      'Ответьте на сообщение пользователя с которым хотите подкинуть монетку, или укажите его username'
    );
    return;
  }
  if (!amountTok) {
    await sendMessage(peerId, 'Укажите ставку числом, например: /м 50');
    return;
  }
  const amount = parseInt(amountTok, 10);
  if (!(amount >= 1)) {
    await sendMessage(peerId, 'Ставка должна быть больше нуля.');
    return;
  }
  if (opponentId === from) {
    await sendMessage(peerId, 'Нельзя бросать монетку с самим собой.');
    return;
  }

  const mine = getStat(peerId, from).crystals;
  if (mine < amount) {
    await sendMessage(peerId, `У вас только ${mine} ${pluralCrystals(mine)}, ставка ${amount} не получится.`);
    return;
  }
  const theirs = getStat(peerId, opponentId).crystals;
  if (theirs < amount) {
    const oName = await getUserName(opponentId);
    await sendMessage(peerId, `У ${oName} только ${theirs} ${pluralCrystals(theirs)}, ставка ${amount} не получится.`);
    return;
  }

  const [aName, bName] = await Promise.all([getUserName(from), getUserName(opponentId)]);
  const id = crypto.randomBytes(5).toString('hex');
  const text =
    `${mention(from, aName)} предлагает ${mention(opponentId, bName)} подкинуть монетку ` +
    `на ${amount} ${pluralCrystals(amount)}. Кидаем?`;
  const btn = (label, a, color) => ({
    action: { type: 'callback', label, payload: JSON.stringify({ c: 'coin', id, a }) },
    color,
  });
  const res = await callApi('messages.send', {
    peer_ids: peerId,
    random_id: crypto.randomInt(1, 2147483647),
    message: text,
    keyboard: { inline: true, buttons: [[btn('Кидаем', 'yes', 'positive'), btn('Нет', 'no', 'negative')]] },
  });
  const cmid = Array.isArray(res) && res[0] ? res[0].conversation_message_id : null;
  bets.set(id, { peerId, from, to: opponentId, amount, cmid, text, at: Date.now() });
}

async function answerEvent(ev, snackbar) {
  try {
    await callApi('messages.sendMessageEventAnswer', {
      event_id: ev.event_id,
      user_id: ev.user_id,
      peer_id: ev.peer_id,
      event_data: snackbar ? { type: 'show_snackbar', text: snackbar } : undefined,
    });
  } catch (e) {
    console.error('Не удалось ответить на нажатие кнопки:', e.message);
  }
}

async function clearKeyboard(bet) {
  if (!bet.cmid) return;
  try {
    await callApi('messages.edit', {
      peer_id: bet.peerId,
      conversation_message_id: bet.cmid,
      message: bet.text,
      keyboard: { inline: true, buttons: [] },
      group_id: GROUP_ID,
    });
  } catch (e) {
    /* не критично: ставка и так закрыта */
  }
}

// Нажатие инлайн-кнопки (событие message_event).
async function handleMessageEvent(ev) {
  let payload = ev.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      payload = null;
    }
  }
  if (!payload || payload.c !== 'coin') return answerEvent(ev);

  const bet = bets.get(payload.id);
  if (!bet || bet.peerId !== ev.peer_id || Date.now() - bet.at > BET_TTL_MS) {
    bets.delete(payload.id);
    return answerEvent(ev, 'Ставка устарела');
  }
  const user = ev.user_id;
  const allowed = payload.a === 'yes' ? user === bet.to : user === bet.to || user === bet.from;
  if (!allowed) return answerEvent(ev, 'Эта ставка не для вас');

  bets.delete(payload.id); // ставка закрыта — повторные нажатия уже не сработают
  await answerEvent(ev);
  clearKeyboard(bet);

  if (payload.a !== 'yes') {
    await sendMessage(bet.peerId, 'Пользователь отменил бросок монетки');
    return;
  }

  const a = getStat(bet.peerId, bet.from);
  const b = getStat(bet.peerId, bet.to);
  if (a.crystals < bet.amount || b.crystals < bet.amount) {
    await sendMessage(bet.peerId, 'Бросок отменён: у одного из участников не хватает кристаллов.');
    return;
  }

  const fromWins = crypto.randomInt(2) === 0;
  const winner = fromWins ? a : b;
  const loser = fromWins ? b : a;
  const winnerId = fromWins ? bet.from : bet.to;
  const loserId = fromWins ? bet.to : bet.from;
  loser.crystals -= bet.amount;
  winner.crystals += bet.amount;
  scheduleStatsSave();

  const [wName, lName] = await Promise.all([getUserName(winnerId), getUserName(loserId)]);
  await sendMessage(
    bet.peerId,
    `Монетка подброшена! Побеждает ${wName}: +${bet.amount} ${pluralCrystals(bet.amount)}. ` +
      `У ${lName} −${bet.amount}.\n` +
      `Баланс: ${wName} — ${winner.crystals}, ${lName} — ${loser.crystals}.`
  );
}

// Возвращает false, если команду надо не выполнять, а проверить сообщение как обычное.
async function handleCommand({ cmd, args }, message) {
  if (cmd === 'правила') return handleRulesCommand(message);
  if (cmd === 'бан') return handleBanCommand(message);
  if (cmd === 'кр') return handleCrystalsCommand(message);
  if (cmd === 'запретить' || cmd === 'разрешить') return handleWordCommand(cmd, args, message);
  if (cmd === 'м') {
    // Текст в команде не должен обходить фильтр: нарушение — обычная модерация.
    if (inspectMessage(message)) return false;
    return handleCoinCommand(args, message);
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

  // Команды — только точное совпадение ("/правила", "/бан", "/кр"), так что
  // через них нельзя протащить запрещённый текст.
  if (!edited) {
    const parsed = parseCommand(message.text);
    if (parsed) {
      const handled = await handleCommand(parsed, message);
      if (handled !== false) return;
    }
  }

  // Горячий путь: проверка — это только регулярки, без сетевых запросов,
  // а удаление — один запрос к VK.
  let reason = inspectMessage(message);

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

  // Сообщение прошло проверку — начисляем кристаллы (правки не считаются).
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
  } else if (update.type === 'message_edit') {
    handleMessage(obj.message || obj, true).catch((e) => console.error('Ошибка обработки правки:', e));
  } else if (update.type === 'message_event') {
    handleMessageEvent(obj).catch((e) => console.error('Ошибка обработки нажатия кнопки:', e));
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
  loadStats(STATS_FILE);
  loadStopwords(STOPWORDS_FILE);
  persistStats = true;
  // Кнопки "Кидаем"/"Нет" шлют событие message_event — включаем его в Long Poll.
  // Если у ключа нет права управления сообществом, включите вручную (см. инструкцию).
  try {
    await callApi('groups.setLongPollSettings', {
      group_id: GROUP_ID, enabled: 1, message_new: 1, message_edit: 1, message_event: 1,
    });
    console.log('Long Poll: события сообщений и нажатий кнопок включены');
  } catch (e) {
    console.warn(`Не удалось включить message_event автоматически (${e.message}). Включите вручную в настройках API сообщества.`);
  }
  const flush = () => saveStatsNow();
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
  findCompanyName,
  parseCommand,
  pluralCrystals,
  handleMessageEvent,
  checkStopwords,
  bets,
  _config: () => ({ TOKEN, GROUP_ID }),
  _setApi: (fn) => {
    callApi = fn;
  },
};
