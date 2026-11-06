// Список слов, который пополняется командами /запретить и /разрешить.
// Совпадение — как в blocklist.txt:
//   * слово ловится с начала слова и с любым окончанием ("реклам" поймает "реклама", "рекламу");
//   * знак $ в конце — "слово целиком";
//   * пробел в фразе заменяет любое количество пробелов;
//   * регистр и "ё" не важны.
// Сообщение с таким словом просто удаляется, автор НЕ исключается.

const fs = require('fs');

const INVISIBLE_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const MIN_LENGTH = 3;
const MAX_LENGTH = 100;

let filePath = null;
let words = []; // нормализованные строки
let compiled = []; // { word, re }

function norm(text) {
  return String(text || '')
    .replace(INVISIBLE_RE, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

// Убираем кавычки вокруг слова: "слово", «слово», 'слово'.
function cleanWord(raw) {
  let w = String(raw || '').trim();
  w = w.replace(/^[«"“„'‘`]+/, '').replace(/[»"”“'’`]+$/, '');
  return norm(w);
}

function compile(word) {
  let w = word;
  const whole = w.endsWith('$');
  if (whole) w = w.slice(0, -1).trim();
  const body = w
    .split(' ')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const re = new RegExp(`(?<![а-яa-z0-9])${body}${whole ? '(?![а-яa-z0-9])' : ''}`, 'i');
  return { word, re };
}

function rebuild() {
  compiled = words.map(compile);
}

function save() {
  if (!filePath) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, words.join('\n') + (words.length ? '\n' : ''));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error('Не удалось сохранить список слов:', e.message);
  }
}

function loadCustomWords(file) {
  filePath = file;
  words = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const w = norm(line);
      if (w && !w.startsWith('#') && !words.includes(w)) words.push(w);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать список слов:', e.message);
  }
  rebuild();
  return words.length;
}

// -> { status: 'added' | 'exists' | 'too_short' | 'too_long', word }
function addCustomWord(raw) {
  const word = cleanWord(raw);
  const core = word.replace(/\$$/, '').replace(/\s/g, '');
  if (core.length < MIN_LENGTH) return { status: 'too_short', word };
  if (word.length > MAX_LENGTH) return { status: 'too_long', word };
  if (words.includes(word)) return { status: 'exists', word };
  words.push(word);
  rebuild();
  save();
  return { status: 'added', word };
}

// -> { status: 'removed' | 'not_found', word }
function removeCustomWord(raw) {
  const word = cleanWord(raw);
  const i = words.indexOf(word);
  if (i === -1) return { status: 'not_found', word };
  words.splice(i, 1);
  rebuild();
  save();
  return { status: 'removed', word };
}

// Возвращает найденное слово или null.
function containsCustomWord(text) {
  if (!compiled.length || !text) return null;
  const t = norm(text);
  // второй вариант — с убранными точками/дефисами между буквами ("с.л.о.в.о")
  const glued = t.replace(/([a-zа-я0-9])[.\-_*]+(?=[a-zа-я0-9])/g, '$1');
  for (const { word, re } of compiled) {
    if (re.test(t) || re.test(glued)) return word;
  }
  return null;
}

module.exports = { loadCustomWords, addCustomWord, removeCustomWord, containsCustomWord };
