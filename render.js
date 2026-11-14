// SVG -> PNG (VK принимает как картинку только JPG/PNG/GIF, но не SVG).
// Используется @resvg/resvg-js: бесплатный, без системных зависимостей.
// Если пакет не установлен — render недоступен, бот отправит SVG файлом.

'use strict';

const fs = require('fs');
const path = require('path');

let Resvg = null;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch (e) {
  Resvg = null;
}

const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
const fontFiles = ['Inter-Regular.otf', 'Inter-Bold.otf']
  .map((f) => path.join(FONT_DIR, f))
  .filter((f) => fs.existsSync(f));

const available = () => Boolean(Resvg);

function svgToPng(svg, width = 1200) {
  if (!Resvg) throw new Error('пакет @resvg/resvg-js не установлен');
  const resvg = new Resvg(svg, {
    background: '#ffffff',
    fitTo: { mode: 'width', value: width },
    font: {
      fontFiles,
      loadSystemFonts: true,
      defaultFontFamily: 'Inter',
    },
  });
  return resvg.render().asPng();
}

// Достаёт <svg>…</svg> из ответа нейросети (она может обернуть его в ```svg или текст).
function extractSvg(text) {
  const m = /<svg[\s\S]*?<\/svg>/i.exec(String(text || ''));
  return m ? m[0] : null;
}

// Убирает из SVG всё опасное и внешнее: скрипты, foreignObject, обработчики on*,
// внешние ссылки и картинки. Возвращает безопасный SVG или null.
function sanitizeSvg(raw) {
  if (!raw) return null;
  let s = String(raw);
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|foreignObject|iframe|object|embed|audio|video|image|animate|set|use)\b[\s\S]*?(?:<\/\1>|\/>)/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  s = s.replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
  s = s.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
  if (!/^\s*<svg\b/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  if (!/xmlns=/.test(s)) s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/viewBox=/i.test(s)) s = s.replace(/<svg\b/i, '<svg viewBox="0 0 800 600"');
  if (s.length > 400 * 1024) return null;
  return s;
}

module.exports = { available, svgToPng, extractSvg, sanitizeSvg };
