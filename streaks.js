// Серии ("огоньки") между двумя участниками беседы.
//
// Правила:
//  * Серия начинается, когда приглашённый нажал «Принять».
//  * Серия "здорова", если в последние 24 часа ОБА участника хотя бы раз
//    написали друг другу reply (каждый — на сообщение второго).
//  * Каждую полночь по Москве (00:00) счёт дней +1 у тех серий, которые были
//    здоровы в предыдущие 24 часа.
//  * В 00:01 и далее каждые 4 часа (04:00, 08:00, 12:00, 16:00, 20:00) бот
//    напоминает о "угасающих" сериях (нездоровых).
//  * Серия умирает, если за 48 часов оба не написали друг другу reply.
//    Проверка и сообщение — раз в сутки в то время, когда серия была принята.
//
// Модуль ничего не отправляет сам: tick() возвращает список событий,
// которые index.js превращает в сообщения.

const fs = require('fs');
const crypto = require('crypto');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MSK_OFFSET = 3 * HOUR; // Москва: UTC+3, без перехода на летнее время
const INVITE_TTL = DAY;

const mskDay = (ts) => Math.floor((ts + MSK_OFFSET) / DAY);
const mskMinute = (ts) => Math.floor((((ts + MSK_OFFSET) % DAY) + DAY) % DAY / 60000);

function createStore() {
  let file = null;
  let persist = false;
  let timer = null;
  let dirty = false;
  let data = { meta: {}, streaks: [], pending: [] };

  function save() {
    dirty = true;
    if (!persist || !file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 5000);
    if (timer.unref) timer.unref();
  }

  function flush() {
    if (!persist || !file || !dirty) return;
    dirty = false;
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      dirty = true;
      console.error('Не удалось сохранить streaks.json:', e.message);
    }
  }

  function load(path) {
    file = path;
    try {
      const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
      data = {
        meta: parsed.meta || {},
        streaks: Array.isArray(parsed.streaks) ? parsed.streaks : [],
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Не удалось прочитать streaks.json:', e.message);
    }
    return data.streaks.length;
  }

  const samePair = (s, peerId, u1, u2) =>
    s.peerId === peerId && ((s.a === u1 && s.b === u2) || (s.a === u2 && s.b === u1));

  function findStreak(peerId, u1, u2) {
    return data.streaks.find((s) => samePair(s, peerId, u1, u2)) || null;
  }

  function listStreaks(peerId) {
    return data.streaks.filter((s) => s.peerId === peerId).sort((x, y) => y.days - x.days);
  }

  // Приглашение: -> { status: 'exists' | 'pending' | 'created', streak?, invite? }
  function createInvite(peerId, from, to, now = Date.now()) {
    const streak = findStreak(peerId, from, to);
    if (streak) return { status: 'exists', streak };
    const old = data.pending.find((p) => p.peerId === peerId && p.from === from && p.to === to && now - p.at < INVITE_TTL);
    if (old) return { status: 'pending', invite: old };
    const invite = { id: crypto.randomBytes(6).toString('hex'), peerId, from, to, at: now };
    data.pending.push(invite);
    save();
    return { status: 'created', invite };
  }

  function getInvite(id, now = Date.now()) {
    const p = data.pending.find((x) => x.id === id);
    return p && now - p.at < INVITE_TTL ? p : null;
  }

  function removeInvite(id) {
    const i = data.pending.findIndex((x) => x.id === id);
    if (i !== -1) {
      data.pending.splice(i, 1);
      save();
    }
  }

  // Принять приглашение -> серия (или null, если приглашения нет)
  function accept(id, now = Date.now()) {
    const inv = getInvite(id, now);
    if (!inv) return null;
    removeInvite(id);
    let streak = findStreak(inv.peerId, inv.from, inv.to);
    if (streak) return streak;
    streak = {
      id: crypto.randomBytes(6).toString('hex'),
      peerId: inv.peerId,
      a: inv.from, // тот, кто предложил
      b: inv.to, // тот, кто принял
      acceptedAt: now,
      days: 0,
      lastA: 0, // когда a в последний раз ответил reply-ем b
      lastB: 0, // когда b в последний раз ответил reply-ем a
      checkedDay: mskDay(now), // день, когда проверяли "не умерла ли серия"
    };
    data.streaks.push(streak);
    save();
    return streak;
  }

  // Участник fromId ответил reply-ем на сообщение toId.
  function recordReply(peerId, fromId, toId, now = Date.now()) {
    if (!fromId || !toId || fromId === toId) return false;
    const s = findStreak(peerId, fromId, toId);
    if (!s) return false;
    if (fromId === s.a) s.lastA = now;
    else s.lastB = now;
    save();
    return true;
  }

  const isHealthy = (s, now) => s.lastA >= now - DAY && s.lastB >= now - DAY;
  const fading = (peerId, now = Date.now()) => listStreaks(peerId).filter((s) => !isHealthy(s, now));

  // Вызывать примерно раз в 30 секунд. Возвращает события для index.js.
  function tick(now = Date.now()) {
    const events = [];
    const day = mskDay(now);
    const minute = mskMinute(now);
    const meta = data.meta;
    let changed = false;

    if (meta.lastRolloverDay == null) {
      // первый запуск — ничего не пропустили
      meta.lastRolloverDay = day;
      meta.lastAnnounceDay = day;
      meta.lastReminderKey = day * 6 + Math.floor(minute / 240);
      changed = true;
    }

    // чистим просроченные приглашения
    const before = data.pending.length;
    data.pending = data.pending.filter((p) => now - p.at < INVITE_TTL);
    if (data.pending.length !== before) changed = true;

    // 1) 00:00 — обновляем счёт дней
    if (day > meta.lastRolloverDay) {
      const midnight = day * DAY - MSK_OFFSET;
      for (const s of data.streaks) {
        if (s.lastA >= midnight - DAY && s.lastB >= midnight - DAY) s.days += 1;
      }
      meta.lastRolloverDay = day;
      changed = true;
    }

    // 2) серии, которые никто не поддерживал 48 часов, завершаются
    //    в то время суток, когда они были приняты
    for (const s of [...data.streaks]) {
      if (s.checkedDay >= day || minute < mskMinute(s.acceptedAt)) continue;
      s.checkedDay = day;
      changed = true;
      const a = Math.max(s.lastA, s.acceptedAt);
      const b = Math.max(s.lastB, s.acceptedAt);
      if (!(a >= now - 2 * DAY && b >= now - 2 * DAY)) {
        data.streaks.splice(data.streaks.indexOf(s), 1);
        events.push({ type: 'ended', streak: s });
      }
    }

    // 3) 00:01 — "серии угасают" (только если бот не был выключен всю ночь)
    if (day > meta.lastAnnounceDay && minute >= 1) {
      meta.lastAnnounceDay = day;
      changed = true;
      if (minute < 120) pushFading(events, 'midnight', now);
    }

    // 4) напоминания каждые 4 часа: 04:00, 08:00, 12:00, 16:00, 20:00
    const slot = Math.floor(minute / 240);
    const key = day * 6 + slot;
    if (key !== meta.lastReminderKey) {
      meta.lastReminderKey = key;
      changed = true;
      if (slot >= 1 && minute - slot * 240 < 20) pushFading(events, 'reminder', now);
    }

    if (changed) save();
    return events;
  }

  function pushFading(events, kind, now) {
    const peers = [...new Set(data.streaks.map((s) => s.peerId))];
    for (const peerId of peers) {
      const list = fading(peerId, now);
      if (list.length) events.push({ type: 'fading', kind, peerId, streaks: list });
    }
  }

  return {
    load,
    flush,
    setPersist: (v) => {
      persist = Boolean(v);
    },
    findStreak,
    listStreaks,
    createInvite,
    getInvite,
    removeInvite,
    accept,
    recordReply,
    fading,
    tick,
    _data: () => data,
  };
}

module.exports = { createStore, mskDay, mskMinute, DAY, HOUR, MSK_OFFSET };
