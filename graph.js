// Построение графиков функций. Без eval: выражение разбирается собственным
// безопасным парсером. Результат — SVG (в PNG его превращает render.js).
//
// Поддерживается: + - * / ^ (или **), скобки, неявное умножение (2x, 3(x+1)),
// x, константы pi (π) и e, функции sin cos tan tg ctg asin acos atan sinh cosh tanh
// sqrt (√) cbrt abs ln lg log (=log10) log2 exp floor ceil round sign, sin^2(x).
// Диапазон: "от -5 до 5" или "[-5; 5]". Несколько функций — через ";".

'use strict';

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, tg: Math.tan,
  cot: (v) => 1 / Math.tan(v), ctg: (v) => 1 / Math.tan(v),
  asin: Math.asin, arcsin: Math.asin, acos: Math.acos, arccos: Math.acos,
  atan: Math.atan, arctan: Math.atan, atg: Math.atan, arctg: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  ln: Math.log, lg: Math.log10, log: Math.log10, log10: Math.log10, log2: Math.log2,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};
const CONSTS = { pi: Math.PI, e: Math.E };
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), 'x'].sort((a, b) => b.length - a.length);

class GraphError extends Error {}

function normalizeExpr(src) {
  return String(src)
    .toLowerCase()
    .replace(/[−–—]/g, '-')
    .replace(/[×·∙]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt')
    .replace(/х/g, 'x') // русская «х»
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/\*\*/g, '^')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    let m;
    if ((m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i)))) {
      tokens.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
    } else if ((m = /^[a-z]+/.exec(s.slice(i)))) {
      let word = m[0];
      i += word.length;
      while (word) { // "sinx" -> sin, x ; "2pix" -> pi, x
        const name = NAMES.find((n) => word.startsWith(n));
        if (!name) throw new GraphError(`неизвестное имя «${word}»`);
        tokens.push(name === 'x' ? { t: 'x' } : name in CONSTS ? { t: 'num', v: CONSTS[name] } : { t: 'fn', name });
        word = word.slice(name.length);
      }
    } else if ('+-*/^()'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
    } else {
      throw new GraphError(`недопустимый символ «${c}»`);
    }
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const startsAtom = () => {
    const t = peek();
    return t && (t.t === 'num' || t.t === 'x' || t.t === 'fn' || (t.t === 'op' && t.v === '('));
  };

  function expr() {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].v;
      a = { t: 'bin', op, a, b: term() };
    }
    return a;
  }
  function term() {
    let a = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = tokens[pos++].v;
        a = { t: 'bin', op, a, b: unary() };
      } else if (startsAtom()) {
        a = { t: 'bin', op: '*', a, b: power() }; // неявное умножение: 2x, 3(x+1)
      } else break;
    }
    return a;
  }
  function unary() {
    if (isOp('-')) { pos++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { pos++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (isOp('^')) { pos++; return { t: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  }
  function atom() {
    const t = tokens[pos++];
    if (!t) throw new GraphError('выражение оборвано');
    if (t.t === 'num') return { t: 'num', v: t.v };
    if (t.t === 'x') return { t: 'x' };
    if (t.t === 'op' && t.v === '(') {
      const e = expr();
      if (!isOp(')')) throw new GraphError('не хватает закрывающей скобки');
      pos++;
      return e;
    }
    if (t.t === 'fn') {
      let exp = null;
      if (isOp('^')) { // sin^2(x)
        pos++;
        exp = unary();
      }
      let arg;
      if (isOp('(')) {
        pos++;
        arg = expr();
        if (!isOp(')')) throw new GraphError('не хватает закрывающей скобки');
        pos++;
      } else {
        arg = power(); // sin x
      }
      const call = { t: 'fn', name: t.name, a: arg };
      return exp ? { t: 'bin', op: '^', a: call, b: exp } : call;
    }
    throw new GraphError('лишний символ в выражении');
  }

  const tree = expr();
  if (pos < tokens.length) throw new GraphError('лишний символ в выражении');
  return tree;
}

function compile(node) {
  switch (node.t) {
    case 'num': { const v = node.v; return () => v; }
    case 'x': return (x) => x;
    case 'neg': { const f = compile(node.a); return (x) => -f(x); }
    case 'fn': { const f = compile(node.a); const fn = FUNCS[node.name]; return (x) => fn(f(x)); }
    case 'bin': {
      const a = compile(node.a);
      const b = compile(node.b);
      switch (node.op) {
        case '+': return (x) => a(x) + b(x);
        case '-': return (x) => a(x) - b(x);
        case '*': return (x) => a(x) * b(x);
        case '/': return (x) => a(x) / b(x);
        default: return (x) => {
          const base = a(x);
          const e = b(x);
          // (-8)^(1/3) в школьной математике = -2
          if (base < 0 && Number.isFinite(e) && !Number.isInteger(e)) {
            const inv = 1 / e;
            if (Number.isInteger(inv) && Math.abs(inv) % 2 === 1) return -Math.pow(-base, e);
          }
          return Math.pow(base, e);
        };
      }
    }
    default: throw new GraphError('внутренняя ошибка разбора');
  }
}

function compileExpr(src) {
  const s = normalizeExpr(src);
  if (!s) throw new GraphError('пустое выражение');
  if (s.length > 120) throw new GraphError('выражение слишком длинное');
  return compile(parse(tokenize(s)));
}

function evalConst(src) {
  const v = compileExpr(src)(0);
  if (!Number.isFinite(v)) throw new GraphError(`не могу вычислить границу «${src}»`);
  return v;
}

// Достаёт "от A до B" / "[A; B]" и возвращает { rest, range }.
function extractRange(text) {
  let m = /(?:\s|^)(?:на\s+(?:(?:отрезке|промежутке|интервале)\s+)?)?\[\s*([^\];,]+?)\s*[;,]\s*([^\]]+?)\s*\]/i.exec(text);
  if (!m) m = /(?:^|\s)(?:на\s+(?:отрезке|промежутке|интервале)\s+)?(?:x\s+|х\s+)?(?:от|from)\s+(\S+)\s+(?:до|to)\s+(\S+)/i.exec(text);
  if (!m) return { rest: text, range: null };
  const range = [evalConst(m[1]), evalConst(m[2])];
  return { rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim(), range };
}

// "y = x^2; sin(x) от -5 до 5" -> { exprs: [{src, fn}], xmin, xmax }
function parseGraphRequest(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new GraphError('не указана функция');
  const { rest, range } = extractRange(text);
  const parts = rest.split(/[;\n]/).map((p) => p.trim()).filter(Boolean).slice(0, 6);
  if (!parts.length) throw new GraphError('не указана функция');
  const exprs = parts.map((p) => {
    const src = p.replace(/^(?:y|f\s*\(\s*x\s*\)|у)\s*=\s*/i, '').trim();
    return { src, fn: compileExpr(src) };
  });
  let [xmin, xmax] = range || [-10, 10];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  if (!(xmax - xmin > 1e-9)) throw new GraphError('пустой диапазон по x');
  if (xmax - xmin > 1e7) throw new GraphError('слишком большой диапазон по x');
  return { exprs, xmin, xmax };
}

// ---------- рисование ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function ticks(min, max, target = 8) {
  const step = niceStep((max - min) / target);
  const out = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { step, values: out };
}
function fmt(v, step) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  let s;
  if (a >= 1e6 || a < 1e-4) s = v.toExponential(1).replace('e+', 'e');
  else {
    const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
    s = v.toFixed(decimals);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s.replace('-', '−');
}
function quantile(sorted, q) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
}

function buildGraphSvg({ exprs, xmin, xmax }) {
  const W = 1000, H = 700;
  const M = { l: 70, r: 30, t: 56, b: 50 };
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const N = 1400;

  const xs = Array.from({ length: N }, (_, i) => xmin + ((xmax - xmin) * i) / (N - 1));
  const curves = exprs.map((e) => xs.map((x) => {
    let y;
    try { y = e.fn(x); } catch (err) { y = NaN; }
    return Number.isFinite(y) ? y : NaN;
  }));

  const all = curves.flat().filter(Number.isFinite).sort((a, b) => a - b);
  if (!all.length) throw new GraphError('функция не определена на этом промежутке');
  let lo = quantile(all, 0.02);
  let hi = quantile(all, 0.98);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  let pad = (hi - lo) * 0.08;
  let ymin = lo - pad;
  let ymax = hi + pad;
  if (ymin > 0 && ymin < (ymax - ymin) * 0.3) ymin = Math.min(ymin, -(ymax - ymin) * 0.04);
  if (ymax < 0 && -ymax < (ymax - ymin) * 0.3) ymax = Math.max(ymax, (ymax - ymin) * 0.04);

  const X = (x) => M.l + ((x - xmin) / (xmax - xmin)) * pw;
  const Y = (y) => M.t + ((ymax - y) / (ymax - ymin)) * ph;
  const clampY = (y) => Math.max(M.t - ph * 3, Math.min(M.t + ph * 4, Y(y)));

  const xt = ticks(xmin, xmax, 9);
  const yt = ticks(ymin, ymax, 7);
  const grid = [];
  const labels = [];
  for (const v of xt.values) {
    const px = X(v).toFixed(1);
    grid.push(`<line x1="${px}" y1="${M.t}" x2="${px}" y2="${M.t + ph}"/>`);
    labels.push(`<text x="${px}" y="${M.t + ph + 22}" text-anchor="middle">${fmt(v, xt.step)}</text>`);
  }
  for (const v of yt.values) {
    const py = Y(v).toFixed(1);
    grid.push(`<line x1="${M.l}" y1="${py}" x2="${M.l + pw}" y2="${py}"/>`);
    labels.push(`<text x="${M.l - 10}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v, yt.step)}</text>`);
  }

  const axes = [];
  if (xmin < 0 && xmax > 0) axes.push(`<line x1="${X(0).toFixed(1)}" y1="${M.t}" x2="${X(0).toFixed(1)}" y2="${M.t + ph}"/>`);
  if (ymin < 0 && ymax > 0) axes.push(`<line x1="${M.l}" y1="${Y(0).toFixed(1)}" x2="${M.l + pw}" y2="${Y(0).toFixed(1)}"/>`);

  const paths = curves.map((ys, k) => {
    let d = '';
    let pen = false;
    for (let i = 0; i < N; i++) {
      const y = ys[i];
      if (!Number.isFinite(y)) { pen = false; continue; }
      if (i > 0 && Number.isFinite(ys[i - 1])) {
        const p = ys[i - 1];
        if ((p > ymax && y < ymin) || (p < ymin && y > ymax)) pen = false; // разрыв (tg, 1/x)
      }
      d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${clampY(y).toFixed(1)}`;
      pen = true;
    }
    return `<path d="${d}" fill="none" stroke="${COLORS[k % COLORS.length]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  });

  const legend = exprs.map((e, k) => {
    const x = M.l + k * 190;
    const label = `y = ${e.src}`.replace(/\*/g, '·');
    return `<line x1="${x}" y1="28" x2="${x + 26}" y2="28" stroke="${COLORS[k % COLORS.length]}" stroke-width="4" stroke-linecap="round"/>` +
      `<text x="${x + 34}" y="33" font-size="15" fill="#111827">${esc(label.length > 22 ? label.slice(0, 21) + '…' : label)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><clipPath id="plot"><rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph}"/></clipPath></defs>
<rect width="${W}" height="${H}" fill="#ffffff"/>
<g font-family="Inter, 'Segoe UI', Roboto, Arial, sans-serif" font-size="14" fill="#4b5563">
<g stroke="#e5e7eb" stroke-width="1">${grid.join('')}</g>
<rect x="${M.l}" y="${M.t}" width="${pw}" height="${ph}" fill="none" stroke="#9ca3af" stroke-width="1.5"/>
<g stroke="#111827" stroke-width="1.6">${axes.join('')}</g>
${labels.join('\n')}
<g clip-path="url(#plot)">${paths.join('')}</g>
${legend.join('')}
<text x="${M.l + pw - 4}" y="${M.t + ph - 8}" text-anchor="end" font-style="italic" fill="#111827">x</text>
<text x="${M.l + 8}" y="${M.t + 18}" font-style="italic" fill="#111827">y</text>
</g>
</svg>`;
}

function buildGraph(raw) {
  const req = parseGraphRequest(raw);
  return { svg: buildGraphSvg(req), exprs: req.exprs.map((e) => e.src), xmin: req.xmin, xmax: req.xmax };
}

module.exports = { buildGraph, parseGraphRequest, compileExpr, GraphError };
