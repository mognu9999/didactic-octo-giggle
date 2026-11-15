// Погода в любом населённом пункте. Бесплатно и без ключей: Open-Meteo
// (геокодер + прогноз). Ключ WEATHER_API_KEY из вашего списка не нужен.

'use strict';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Коды погоды WMO -> [эмодзи, описание]
const WMO = {
  0: ['☀️', 'Ясно'], 1: ['🌤', 'Преимущественно ясно'], 2: ['⛅', 'Переменная облачность'], 3: ['☁️', 'Пасмурно'],
  45: ['🌫', 'Туман'], 48: ['🌫', 'Изморозевый туман'],
  51: ['🌦', 'Лёгкая морось'], 53: ['🌦', 'Морось'], 55: ['🌧', 'Сильная морось'],
  56: ['🌧', 'Ледяная морось'], 57: ['🌧', 'Сильная ледяная морось'],
  61: ['🌦', 'Небольшой дождь'], 63: ['🌧', 'Дождь'], 65: ['🌧', 'Сильный дождь'],
  66: ['🌧', 'Ледяной дождь'], 67: ['🌧', 'Сильный ледяной дождь'],
  71: ['🌨', 'Небольшой снег'], 73: ['🌨', 'Снег'], 75: ['❄️', 'Сильный снег'], 77: ['🌨', 'Снежные зёрна'],
  80: ['🌦', 'Небольшие ливни'], 81: ['🌧', 'Ливни'], 82: ['⛈', 'Сильные ливни'],
  85: ['🌨', 'Снегопад'], 86: ['❄️', 'Сильный снегопад'],
  95: ['⛈', 'Гроза'], 96: ['⛈', 'Гроза с градом'], 99: ['⛈', 'Сильная гроза с градом'],
};
const wmo = (code) => WMO[code] || ['🌡', 'Погода'];

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WIND_DIRS = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];

const temp = (v) => {
  const r = Math.round(v);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}°`;
};
const windDir = (deg) => WIND_DIRS[Math.round(((deg % 360) / 45)) % 8];

function dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

async function getJson(fetchFn, url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const normName = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е');

// Из нескольких найденных мест выбираем то, чьё название совпадает с запросом
// (запрос может быть в падеже: "Омске" -> "Омск"), среди таких — самое населённое.
function pickBest(results, query) {
  const q = normName(query);
  const byPop = [...results].sort((a, b) => (b.population || 0) - (a.population || 0));
  const match = byPop.find((r) => {
    const n = normName(r.name);
    return q === n || q.startsWith(n.slice(0, Math.max(3, n.length - 2)));
  });
  return match || results[0];
}

// Ищет населённый пункт. Название в падеже ("в Омске") геокодер находит
// нечётким поиском; если нет — пробуем обрезать окончание.
async function geocode(name, fetchFn) {
  const variants = [name];
  if (name.length > 4) variants.push(name.slice(0, -1));
  if (name.length > 5) variants.push(name.slice(0, -2));
  for (const v of variants) {
    const url = `${GEO_URL}?name=${encodeURIComponent(v)}&count=10&language=ru&format=json`;
    const data = await getJson(fetchFn, url);
    if (data && Array.isArray(data.results) && data.results.length) return pickBest(data.results, name);
  }
  return null;
}

// ---------- время ----------

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// Смещение часового пояса от UTC в минутах на момент date (с учётом летнего времени).
function offsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const utcLabel = (min) => {
  const sign = min < 0 ? '−' : '+';
  const a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
};

function formatTime({ label, tz }, now = new Date()) {
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(now).replace(/\s*г\.$/, '');
  const off = offsetMinutes(tz, now);
  const diff = off - offsetMinutes('Europe/Moscow', now);

  let diffText;
  if (tz === 'Europe/Moscow') diffText = null;
  else if (diff === 0) diffText = 'Совпадает с московским временем';
  else {
    const h = Math.floor(Math.abs(diff) / 60);
    const m = Math.abs(diff) % 60;
    const amount = [h ? `${h} ${plural(h, 'час', 'часа', 'часов')}` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ');
    diffText = `${diff > 0 ? 'Впереди' : 'Позади'} Москвы на ${amount}`;
  }
  return [`🕒 ${label}`, '', `⏰ ${time}`, `📅 ${date}`, `🌍 ${tz} (${utcLabel(off)})`, diffText ? `↔ ${diffText}` : null].filter((x) => x !== null).join('\n');
}

// Время в населённом пункте. Часовой пояс берёт геокодер (IANA), время считает Node —
// никаких "угадываний" смещений. Без названия — московское время.
async function getTime(rawName, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const now = opts.now || new Date();
  const name = cleanName(rawName);
  if (!name) return { found: true, text: formatTime({ label: 'Москва, Россия', tz: 'Europe/Moscow' }, now) };
  const place = await geocode(name, fetchFn);
  if (!place || !place.timezone) return { found: false };
  if (opts.minPopulation && (place.population || 0) < opts.minPopulation) return { found: false };
  const label = [place.name, place.admin1 && place.admin1 !== place.name ? place.admin1 : null, place.country].filter(Boolean).join(', ');
  return { found: true, text: formatTime({ label, tz: place.timezone }, now), place: label };
}

function cleanName(raw) {
  return String(raw || '').trim().replace(/^(?:в|во|для|на)\s+/i, '').replace(/^(?:городе|город|г\.|селе|посёлке)\s+/i, '').replace(/[?!."«»]+/g, '').trim();
}

// -> { found: false } или { found: true, text }
async function getWeather(rawName, fetchFn = globalThis.fetch) {
  const name = cleanName(rawName);
  if (name.length < 2) return { found: false };

  const place = await geocode(name, fetchFn);
  if (!place) return { found: false };

  const url =
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset' +
    '&timezone=auto&forecast_days=4&wind_speed_unit=ms';
  const data = await getJson(fetchFn, url);
  const c = data.current;
  const d = data.daily;
  if (!c || !d) throw new Error('Open-Meteo вернул неполные данные');

  const where = [place.name, place.admin1 && place.admin1 !== place.name ? place.admin1 : null, place.country].filter(Boolean).join(', ');
  const [icon, desc] = wmo(c.weather_code);
  const pressure = Math.round(c.pressure_msl * 0.750062);

  const lines = [
    `${icon} Погода: ${where}`,
    '',
    `🌡 Сейчас ${temp(c.temperature_2m)}C, ощущается как ${temp(c.apparent_temperature)}C`,
    `${icon} ${desc}`,
    `💨 Ветер ${Math.round(c.wind_speed_10m)} м/с, ${windDir(c.wind_direction_10m)}` +
      (c.wind_gusts_10m > c.wind_speed_10m + 2 ? ` (порывы до ${Math.round(c.wind_gusts_10m)} м/с)` : ''),
    `💧 Влажность ${Math.round(c.relative_humidity_2m)}% · 🧭 Давление ${pressure} мм рт. ст.`,
  ];
  if (c.precipitation > 0) lines.push(`🌧 Осадки сейчас: ${c.precipitation} мм`);

  lines.push('', '📅 Прогноз:');
  for (let i = 0; i < d.time.length; i++) {
    const [di] = wmo(d.weather_code[i]);
    const prob = d.precipitation_probability_max && d.precipitation_probability_max[i];
    lines.push(
      `${i === 0 ? 'Сегодня' : dayLabel(d.time[i])}: ${di} ${temp(d.temperature_2m_min[i])}…${temp(d.temperature_2m_max[i])}C` +
        (prob != null && prob >= 20 ? `, осадки ${prob}%` : '')
    );
  }
  const hhmm = (iso) => String(iso).slice(11, 16);
  if (d.sunrise && d.sunrise[0]) lines.push('', `🌅 Восход ${hhmm(d.sunrise[0])} · 🌇 Закат ${hhmm(d.sunset[0])} (местное время)`);

  return { found: true, text: lines.join('\n'), place: where };
}

module.exports = { getWeather, getTime, formatTime, offsetMinutes };
