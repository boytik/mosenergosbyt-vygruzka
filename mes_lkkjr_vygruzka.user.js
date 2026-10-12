// ==UserScript==
// @name         МЭС ЛКК ЮР — выгрузка PDF по всем договорам в ZIP
// @namespace    mes-tools
// @version      2.3
// @description  Кнопка в личном кабинете Мосэнергосбыта для юрлиц: за выбранный период обходит все договоры, скачивает все PDF и складывает в один ZIP — папка на договор, имена файлов без пробелов (иначе 1С не распознаёт).
// @match        https://lkkjr.mosenergosbyt.ru/*
// @run-at       document-start
// @grant        none
// @author       Евгений Бойтик
// @homepageURL  https://github.com/boytik/mosenergosbyt-vygruzka
// @downloadURL  https://github.com/boytik/mosenergosbyt-vygruzka/raw/main/mes_lkkjr_vygruzka.user.js
// @updateURL    https://github.com/boytik/mosenergosbyt-vygruzka/raw/main/mes_lkkjr_vygruzka.user.js
// @license      MIT
// ==/UserScript==

// ЗАДАЧА.
// В «Истории» → «Документы» выбирается период и ОДИН договор, и только тогда
// кабинет показывает пачку PDF: акт приёма-передачи, ведомость, счёт-фактура,
// счёт на оплату. Договоров в кабинете — сотни. Нужно: выбрать период один раз —
// получить все договоры разом, каждый в своей папке с именем = номер договора,
// файлы переименованы без пробелов.
//
// АДРЕСА КАБИНЕТА (разведаны 09.09.2026 перехватом собственных запросов
// страницы; версии в путях разные — так у них и есть):
//
//   GET  /api/v8/accounts
//        → [{ id: 1234567890,                       ← адрес договора в запросах
//             tenancy: { register: "50100000000001" },  ← НОМЕР договора, имя папки
//             fullName: "Общество с ограниченной ответственностью …",
//             role: { operations: { documentsHistory: true } } }, …]
//
//   GET  /api/v7/accounts/{id}/documents?period=01.07.2026|31.07.2026
//        → [{ date, canDownload,
//             value: { documentType: "Акт приема-передачи", documentNum: "Э/10/000001",
//                      documentDate, reportId: "INVOICE_ACT", documentId: "XXXXXXXXXX",
//                      system: "BILLING", amount, debt, accountingPeriod } }, …]
//
//   POST /api/v6/accounts/{id}/documents/download
//        {"document":{"reportId":…,"docId":documentId,"documentDate":…,
//          "documentType":<тип В НИЖНЕМ РЕГИСТРЕ>,"documentNumber":documentNum},
//         "system":system}
//        → application/pdf
//
// ТИП В ТЕЛЕ ЗАПРОСА ПИШЕМ СТРОЧНЫМИ. В списке кабинет отдаёт «Акт
// приема-передачи», а в запросе на скачивание шлёт «акт приема-передачи».
// Проверять, важно ли это серверу, не на чем — повторяем в точности за
// кабинетом: это дешевле, чем ловить потом 400 на половине договоров.
//
// ПОЧЕМУ ЮЗЕРСКРИПТ, А НЕ ВНЕШНИЙ КАЧАЛЬЩИК. Вход — почта, пароль и код с
// почты при каждом новом устройстве, а запросы подписаны заголовком
// Authorization, который живёт недолго. Скрипт работает внутри уже открытой
// сессии и берёт живой заголовок из запросов самой страницы — паролей не знает
// и не хранит.
//
// ПОЧЕМУ ZIP, А НЕ ПРОСТО ФАЙЛЫ. Страница не имеет права создавать папки в
// «Загрузках» — браузер запрещает, и `a.download = "папка/файл.pdf"` слэш
// просто вырежет. А папка на договор в задаче не украшение: по ней раскладывают
// документы перед загрузкой в 1С. Поэтому дерево папок отдаём внутри архива.
//
// ПОЧЕМУ НЕ «НАЖАТЬ НА ВСЕ ИКОНКИ PDF». Иконка — не ссылка, а POST с телом;
// браузер сохранит ответ под именем от сайта и в корень «Загрузок». Свой запрос
// отдаёт тот же файл как blob, и его уже можно назвать по-человечески.
//
// НИ ОДНОЙ ВНЕШНЕЙ ЗАВИСИМОСТИ. Первая версия тянула JSZip с cdnjs. Под VPN РФ
// cdnjs часто недоступен, а Tampermonkey не запускает скрипт, пока не скачает
// @require — снаружи это неотличимо от «скрипт не установлен»: ни кнопки, ни
// ошибки. Поэтому ZIP пишем сами, методом «store» (PDF уже сжат, жать нечего).
//
// ИМЕНА ФАЙЛОВ. Пробел → «_», запрещённые в именах символы («/» в номерах вида
// Э/10/000001) → «-». Тип и номер документа в имени ОСТАЮТСЯ: распознавание PDF
// в 1С работает только по именам без пробелов и опирается как раз на них.
//
// СЕССИЯ ПАДАЕТ ПОСРЕДИ ОБХОДА (правка 2.1). Обход сотен договоров идёт минуты,
// и кабинет успевает разлогинить за неактивность — свои запросы он за
// активность не считает. Дальше каждый документ отвечает 401 или HTML со
// страницей входа, и без распознавания этого скрипт честно, но бессмысленно
// пробежал бы остаток списка, пометив всё ошибкой. Теперь потеря сессии
// распознаётся и обход ОСТАНАВЛИВАЕТСЯ сразу: архив сохраняется, а в
// _ОШИБКИ.txt попадает список договоров, до которых не дошли.
//
// ПРОДОЛЖИТЬ С ДОГОВОРА (правка 2.1). Повторять с нуля выгрузку, которая
// оборвалась на 160-м договоре, — это ещё раз качать сто шестьдесят. Договоры
// обходятся в порядке возрастания номера, порядок устойчив, поэтому достаточно
// указать номер, с которого продолжить, — предыдущие пропускаются.
//
// ДЫРЫ НЕ ОТМЕНЯЮТ АРХИВ, НО И НЕ ПРЯЧУТСЯ. Недокачанный PDF ничего не портит, он просто отсутствует, поэтому архив
// собирается. Но недостача попадает в _ОШИБКИ.txt и в _перечень.csv внутри
// архива — чтобы её увидели ДО загрузки в 1С, а не после.

(function () {
  'use strict';

  console.log('%c[МЭС-выгрузка] скрипт загружен, версия 2.3', 'color:#f60;font-weight:700');

  const RETRIES = 3;        // повторы одного запроса
  const PAUSE_MS = 120;     // пауза между запросами: сотни договоров — длинная очередь
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const origFetch = window.fetch;

  // ── 1. Живые заголовки ────────────────────────────────────────────────────
  // Authorization подписывает каждый запрос кабинета и живёт недолго, поэтому
  // его не хардкодим, а берём из запросов самой страницы. Кабинет раз в секунду
  // опрашивает /users/current/events — заголовки всегда свежие.

  let LIVE = null;
  const grab = (h) => {
    if (!h) return;
    let o = {};
    try {
      if (h.forEach) h.forEach((v, k) => (o[k] = v));
      else o = Object.assign({}, h);
    } catch (e) { return; }
    for (const k of Object.keys(o)) if (/^authorization$/i.test(k) && o[k]) { LIVE = o; return; }
  };

  window.fetch = function (input, init) {
    try {
      const u = typeof input === 'string' ? input : input && input.url;
      if (u && String(u).indexOf('/api/') >= 0) {
        grab((init && init.headers) || (input && input.headers));
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  const xOpen = XMLHttpRequest.prototype.open;
  const xSet = XMLHttpRequest.prototype.setRequestHeader;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__h = {}; return xOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__h) this.__h[k] = v; return xSet.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    try { if (this.__u && String(this.__u).indexOf('/api/') >= 0) grab(this.__h); } catch (e) {}
    return xSend.apply(this, arguments);
  };

  // Заголовки, которые браузер ставит сам; попытка задать их руками — ошибка.
  const DENY = /^(host|content-length|connection|cookie|origin|referer|user-agent|accept-encoding|sec-)/i;
  function headers(extra) {
    const o = {};
    for (const k of Object.keys(LIVE || {})) if (!DENY.test(k)) o[k] = LIVE[k];
    return Object.assign(o, extra || {});
  }

  // ── 2. Запросы ────────────────────────────────────────────────────────────
  // Кабинет на длинной очереди отвечает 429 и 5xx, и одна осечка не повод
  // терять договор. 4xx кроме 429 повтором не лечится — выходим сразу.

  async function ask(url, opts, what) {
    let last = null;
    for (let i = 0; i < RETRIES; i++) {
      try {
        const r = await origFetch(url, Object.assign({ credentials: 'include' }, opts));
        if (r.ok) return r;
        last = new Error(what + ' → HTTP ' + r.status);
        if (r.status === 401) { last.auth = true; break; }
        if (r.status < 500 && r.status !== 429) break;
      } catch (e) { last = e; }
      await sleep(900 * (i + 1));
    }
    throw last || new Error(what + ' → неизвестная ошибка');
  }

  const getAccounts = async () =>
    (await (await ask('/api/v8/accounts', { headers: headers() }, 'список договоров')).json());

  const getDocs = async (id, period) =>
    (await (await ask('/api/v7/accounts/' + id + '/documents?period=' + encodeURIComponent(period),
      { headers: headers() }, 'документы договора ' + id)).json());

  // Тело — в точности то, что шлёт кабинет по клику на иконку PDF.
  async function getPdf(id, v) {
    const body = JSON.stringify({
      document: {
        reportId: v.reportId,
        docId: v.documentId,
        documentDate: v.documentDate,
        documentType: String(v.documentType || '').toLowerCase(),
        documentNumber: v.documentNum,
      },
      system: v.system,
    });
    const r = await ask('/api/v6/accounts/' + id + '/documents/download',
      { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body }, 'скачивание');
    const b = await r.blob();
    // Протухшая сессия отдаёт не ошибку, а HTML страницы входа: такой «PDF»
    // весит килобайт и молча лёг бы в архив. Проверяем сигнатуру.
    const sig = String.fromCharCode.apply(null, new Uint8Array(await b.slice(0, 5).arrayBuffer()));
    if (sig.indexOf('%PDF') !== 0) {
      const e = new Error('вернулся не PDF (' + b.size + ' Б)');
      // Страница входа приходит как HTML: это не сломанный документ, а конец сессии.
      if (sig.trim().indexOf('<') === 0) { e.auth = true; e.message += ' — кабинет вернул страницу входа'; }
      throw e;
    }
    return b;
  }

  // ── 3. Имена ──────────────────────────────────────────────────────────────
  // Пробелы под запретом (иначе 1С не распознаёт), «/» и прочее запрещённое в
  // именах файлов меняем на «-», но тип и номер документа сохраняем целиком.

  function safe(s) {
    return String(s == null ? '' : s)
      .replace(/[\/\\:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 150) || 'без_имени';
  }

  function fileName(register, v, withDate) {
    const parts = [safe(register), safe(v.documentType)];
    if (v.documentNum) parts.push('№' + safe(v.documentNum));
    if (withDate && v.documentDate) parts.push(safe(v.documentDate));
    return parts.join('_') + '.pdf';
  }

  // ── 3½. Таблица бухгалтерии → имя папки (правка 2.2) ─────────────────────
  // Папку договора можно называть не голым номером МЭС, а «короткий
  // номер_Наименование_номер МЭС» по таблице бухгалтерии:
  //   50150000000001 → 244_ООО_Ромашка_50150000000001
  // Колонки: 1 — № договора с МЭС, 3 — короткий номер, 5 — наименование.
  // Файлы внутри папки не меняются.
  //
  // Таблицу выбирают в панели как есть, .xlsx. Разбираем сами: xlsx — это zip
  // с XML, а распаковку deflate умеет сам браузер (DecompressionStream) — опять
  // без библиотек с CDN, по той же причине, что и ZIP выше. Последняя
  // загруженная таблица запоминается в браузере, чтобы не выбирать её каждый раз.
  //
  // Один номер МЭС в таблице бывает на нескольких строках (общий счётчик на
  // несколько договоров). Тогда короткие
  // номера и разные наименования склеиваются через «_», а договор попадает в
  // _ОШИБКИ.txt — пусть бухгалтерия глазами проверит, так ли его называть.
  // Номера, которого нет в таблице, папка остаётся голым номером, и это тоже
  // в _ОШИБКИ.txt.

  const MAP_KEY = 'mes-export-map';

  async function unzipEntries(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let eo = -1;
    for (let i = buf.byteLength - 22; i >= 0 && i >= buf.byteLength - 65557; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
    }
    if (eo < 0) throw new Error('это не .xlsx (не zip)');
    const out = {};
    let p = dv.getUint32(eo + 16, true);
    for (let n = dv.getUint16(eo + 10, true); n > 0; n--) {
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      const lo = dv.getUint32(p + 42, true);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      out[name] = { method, data: u8.subarray(start, start + size) };
      p += 46 + nl + xl + cl;
    }
    return async (name) => {
      const e = out[name];
      if (!e) return null;
      if (e.method === 0) return dec.decode(e.data);
      const s = new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return dec.decode(await new Response(s).arrayBuffer());
    };
  }

  // → [[A, B, C, …], …] первого листа, все значения строками.
  async function readXlsx(buf) {
    const get = await unzipEntries(buf);
    const xml = async (n) => { const t = await get(n); return t && new DOMParser().parseFromString(t, 'application/xml'); };
    const byTag = (d, t) => Array.from(d.getElementsByTagNameNS('*', t));

    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = await xml('xl/workbook.xml'), rels = await xml('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = byTag(wb, 'sheet')[0];
      const rid = first && (first.getAttribute('r:id') ||
        first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = byTag(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const t = rel.getAttribute('Target');
        sheetPath = t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t;
      }
    }
    const ssDoc = await xml('xl/sharedStrings.xml');
    const ss = ssDoc ? byTag(ssDoc, 'si').map((si) => byTag(si, 't').map((t) => t.textContent).join('')) : [];
    const sh = await xml(sheetPath);
    if (!sh) throw new Error('в файле не нашёлся лист');

    const col = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    return byTag(sh, 'row').map((row) => {
      const r = [];
      for (const c of byTag(row, 'c')) {
        const t = c.getAttribute('t'), v = byTag(c, 'v')[0];
        let val = v ? v.textContent : '';
        if (t === 's') val = ss[+val] || '';
        else if (t === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent).join('');
        // Длинный номер Excel может записать как 5.0150000000001E+13.
        else if (!t && /e/i.test(val) && isFinite(val)) val = Math.round(Number(val)).toString();
        r[col(c.getAttribute('r') || 'A')] = val;
      }
      return r;
    });
  }

  // { "50150000000001": [{ short: "244", name: "ООО Ромашка" }, …], … }
  function buildMap(rows) {
    const map = {};
    for (const r of rows) {
      const mes = String(r[0] || '').replace(/\D/g, ''), short = String(r[2] || '').trim();
      const name = String(r[4] || '').replace(/\s+/g, ' ').trim();
      if (mes.length < 8 || !short) continue;   // шапка, пустые строки и обрывки номеров
      (map[mes] = map[mes] || []).push({ short, name });
    }
    return map;
  }

  // Точки в имени оставляем («А.М.»), кавычки выкидываем: «"» Windows в имени
  // папки не пускает, а «ёлочки» без пары прямых выглядят мусором. Тире и
  // прочие разделители — в «_»: в имени папки только подчёркивания
  // (Строй-Сервис → Строй_Сервис).
  const nameSafe = (s) => String(s).replace(/[«»"'“”„]/g, '').replace(/[\/\\:*?<>|\-–—]+/g, '_')
    .replace(/\s+/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+|_+$/g, '');

  const uniq = (xs) => xs.filter((x, i) => x && xs.indexOf(x) === i);

  // → { folder, note } — note непустой, если имя надо проверить глазами.
  function folderFor(register, map) {
    const hits = map && map[register];
    if (!hits) return { folder: safe(register), note: map ? 'нет в таблице — папка названа только номером' : '' };
    const shorts = uniq(hits.map((h) => nameSafe(h.short)));
    const names = uniq(hits.map((h) => nameSafe(h.name)));
    const folder = (shorts.join('_') + '_' + names.join('_') + '_' + safe(register)).replace(/_{2,}/g, '_').slice(0, 180);
    return { folder, note: hits.length > 1 ? 'в таблице ' + hits.length + ' строки: ' +
      hits.map((h) => h.short + ' ' + h.name).join('; ') + ' — проверьте имя папки' : '' };
  }

  function loadMap() {
    try { return JSON.parse(localStorage.getItem(MAP_KEY) || 'null'); } catch (e) { return null; }
  }

  // Период кабинет принимает как «01.07.2026|31.07.2026» — первый и последний
  // день, а не месяц; последний день месяца считаем нулевым днём следующего.
  const ddmmyyyy = (d) => String(d.getDate()).padStart(2, '0') + '.' +
    String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  function periodOf(fromMonth, toMonth) {
    const [fy, fm] = fromMonth.split('-').map(Number);
    const [ty, tm] = toMonth.split('-').map(Number);
    return ddmmyyyy(new Date(fy, fm - 1, 1)) + '|' + ddmmyyyy(new Date(ty, tm, 0));
  }
  // ── ZIP своими руками ─────────────────────────────────────────────────────
  // Не берём библиотеку с CDN: при включённом VPN cdnjs.cloudflare.com может
  // не открыться, а Tampermonkey не запускает скрипт, пока не скачает @require
  // — снаружи это выглядит как «поставил, и ничего не произошло», без ошибки.
  // Пишем архив методом «store» (без сжатия): PDF уже сжат внутри, жать нечего,
  // зато не нужен ни deflate, ни чужой код.

  const CRCT = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dtime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const ddate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    const parts = [], dir = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);       // флаг 0x0800 ниже = имя в UTF-8,
      const crc = crc32(f.data);             // иначе кириллица в архиве поедет
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dtime, true); lh.setUint16(12, ddate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dtime, true); ch.setUint16(14, ddate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      dir.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + f.data.length;
    }
    const cdSize = dir.reduce((s, u) => s + u.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(4, 0, true); eo.setUint16(6, 0, true);
    eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true); eo.setUint16(20, 0, true);

    return new Blob(parts.concat(dir, [new Uint8Array(eo.buffer)]), { type: 'application/zip' });
  }


  // ── 5. Выгрузка ───────────────────────────────────────────────────────────

  let STOP = false;

  async function run(cfg, ui) {
    const period = periodOf(cfg.from, cfg.to);
    const files = [];
    const rows = [['Номер договора', 'Наименование', 'Тип документа', 'Номер документа', 'Дата', 'Сумма', 'Файл в архиве', 'Статус']];
    const errors = [], folderNotes = [];
    const map = cfg.map && cfg.map.data;
    let bytes = 0, saved = 0, withDocs = 0, authLost = false, stoppedAt = -1;

    ui.status('Запрашиваю список договоров…');
    let accounts = await getAccounts();
    // Договоры без права на историю документов отдадут 403 на каждый запрос —
    // это минуты пустого ожидания и красная консоль. Отсеиваем сразу.
    const skipped = accounts.filter((a) => !(a.role && a.role.operations && a.role.operations.documentsHistory));
    accounts = accounts.filter((a) => a.role && a.role.operations && a.role.operations.documentsHistory);
    accounts.sort((a, b) => String(reg(a)).localeCompare(String(reg(b))));
    for (const a of skipped) {
      rows.push([reg(a), a.fullName || '', '', '', '', '', '', 'пропущен: нет доступа к истории документов']);
    }
    ui.log(`Договоров: ${accounts.length}` + (skipped.length ? `, пропущено без доступа: ${skipped.length}` : ''));

    if (cfg.since) {
      const i = accounts.findIndex((a) => reg(a) === cfg.since);
      if (i < 0) throw new Error('договор ' + cfg.since + ' не найден среди доступных — проверьте номер');
      ui.log(`Продолжаю с ${cfg.since}: пропущено ${i} договоров до него`);
      accounts = accounts.slice(i);
    }

    for (let n = 0; n < accounts.length && !STOP && !authLost; n++) {
      const a = accounts[n];
      const register = reg(a);
      stoppedAt = n;
      const head = `${n + 1}/${accounts.length} · ${register}`;
      ui.status(`${head} · запрашиваю документы…`);

      let docs;
      try {
        docs = await getDocs(a.id, period);
      } catch (e) {
        if (e.auth) { authLost = true; ui.log(`⚠ ${register}: сессия кабинета истекла`); break; }
        errors.push(`${register}: список документов — ${e.message}`);
        rows.push([register, a.fullName || '', '', '', '', '', '', 'ОШИБКА: ' + e.message]);
        ui.log(`✗ ${register}: список документов — ${e.message}`);
        continue;
      }
      if (!docs || !docs.length) { await sleep(PAUSE_MS); continue; }
      withDocs++;

      const { folder, note } = folderFor(register, map);
      if (note) folderNotes.push(`${register} → ${folder}: ${note}`);
      const used = {};
      for (let k = 0; k < docs.length && !STOP && !authLost; k++) {
        const v = (docs[k] && docs[k].value) || {};
        let name = fileName(register, v, cfg.withDate);
        if (used[name]) name = name.replace(/\.pdf$/i, '_' + (++used[name]) + '.pdf'); else used[name] = 1;
        const path = folder + '/' + name;
        const base = [register, a.fullName || '', v.documentType || '', v.documentNum || '',
          v.documentDate || '', v.amount == null ? '' : v.amount];

        if (docs[k].canDownload === false) {
          rows.push(base.concat([path, 'кабинет не отдаёт этот документ']));
          errors.push(`${register}/${name}: кабинет пометил документ как недоступный`);
          continue;
        }
        ui.status(`${head} · файл ${k + 1}/${docs.length} · ${(bytes / 1048576).toFixed(1)} МБ`);
        try {
          const blob = await getPdf(a.id, v);
          files.push({ name: path, data: new Uint8Array(await blob.arrayBuffer()) });
          bytes += blob.size; saved++;
          rows.push(base.concat([path, 'ок']));
        } catch (e) {
          if (e.auth) { authLost = true; ui.log(`⚠ ${register}: сессия кабинета истекла`); break; }
          errors.push(`${register}/${name}: ${e.message}`);
          rows.push(base.concat([path, 'НЕ СКАЧАН: ' + e.message]));
          ui.log(`✗ ${register}/${name}: ${e.message}`);
        }
        await sleep(PAUSE_MS);
      }
      ui.log(`✓ ${register}: ${docs.length} док.`);
      await sleep(PAUSE_MS);
    }

    const rest = (authLost || STOP) && stoppedAt >= 0 ? accounts.slice(stoppedAt) : [];
    for (const a of rest) {
      rows.push([reg(a), a.fullName || '', '', '', '', '', '', 'НЕ ОБРАБОТАН: выгрузка прервана']);
    }

    const esc = (x) => (/[";\n\r]/.test(x) ? '"' + String(x).replace(/"/g, '""') + '"' : String(x));
    const enc = new TextEncoder();
    files.push({ name: '_перечень.csv', data: enc.encode('﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n')) });
    if (errors.length || rest.length || folderNotes.length) {
      const why = authLost
        ? 'ВЫГРУЗКА ОБОРВАНА: кабинет разлогинил посреди обхода (он не считает запросы скрипта за активность).\r\n' +
          'Войдите заново, впишите в поле «продолжить с договора» номер ' + reg(rest[0]) + ' и запустите снова —\r\n' +
          'уже скачанные договоры повторно качаться не будут.'
        : STOP ? 'ВЫГРУЗКА ОСТАНОВЛЕНА КНОПКОЙ. Чтобы продолжить, впишите в поле «продолжить с договора» номер ' +
          (rest.length ? reg(rest[0]) : '—') + '.'
        : errors.length ? 'Эти документы в архив не попали. Проверьте их в кабинете руками ДО загрузки в 1С.'
        : 'Все документы скачаны. Ниже — папки, имя которых стоит проверить по таблице.';
      files.push({ name: '_ОШИБКИ.txt', data: enc.encode(
        why + '\r\nПериод: ' + period + '\r\n\r\n' +
        (rest.length ? 'НЕ ОБРАБОТАНО ДОГОВОРОВ: ' + rest.length + '\r\n' +
          rest.map((a) => reg(a)).join('\r\n') + '\r\n\r\n' : '') +
        (errors.length ? 'ОТДЕЛЬНЫЕ ДОКУМЕНТЫ:\r\n' + errors.join('\r\n') + '\r\n\r\n' : '') +
        (folderNotes.length ? 'ИМЕНА ПАПОК (таблица: ' + cfg.map.file + '):\r\n' + folderNotes.join('\r\n') : '')) });
    }

    ui.status('Собираю архив…');
    const blob = makeZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mes_' + cfg.from + (cfg.to === cfg.from ? '' : '_' + cfg.to) + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return { saved, withDocs, total: accounts.length, errors: errors.length, folderNotes: folderNotes.length, mb: blob.size / 1048576,
      authLost, rest: rest.length, next: rest.length ? reg(rest[0]) : null };
  }

  const reg = (a) => (a.tenancy && a.tenancy.register) || String(a.id);

  // ── 6. Панель ─────────────────────────────────────────────────────────────
  // Не prompt(): модальное окно блокирует страницу и ломает работу скрипта.

  function monthsFromUrl() {
    const m = (location.search.match(/range=(\d{2})\.(\d{2})\.(\d{4})-(\d{2})\.(\d{2})\.(\d{4})/) || []);
    if (m.length) return [m[3] + '-' + m[2], m[6] + '-' + m[5]];
    const d = new Date();
    const cur = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return [cur, cur];
  }

  // Панель версии 2 занимает СВОЙ id и сносит панель старых версий. Обе версии
  // раньше звались 'mes-export' и проверяли, не висит ли панель уже, — если в
  // Tampermonkey оставались обе, первая занимала место, а вторая молча ничего не
  // делала. Снаружи это выглядело как «обновил скрипт, и ничего не изменилось».
  function mount() {
    if (!document.body || document.getElementById('mes-export-v2')) return;
    const old = document.getElementById('mes-export');
    if (old && old.remove) old.remove();
    const [m1, m2] = monthsFromUrl();

    const box = document.createElement('div');
    box.id = 'mes-export-v2';
    box.style.cssText =
      'position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:14px 16px;border-radius:12px;' +
      'background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.24);font:13px/1.4 system-ui,sans-serif;' +
      'display:flex;flex-direction:column;gap:8px;width:320px;color:#111';
    box.innerHTML =
      '<b>Выгрузка документов по всем договорам</b>' +
      '<span style="color:#888;font-size:11px;margin-top:-6px">версия 2.3</span>' +
      '<label>с <input id="mes-from" type="month" value="' + m1 + '"></label>' +
      '<label>по <input id="mes-to" type="month" value="' + m2 + '"></label>' +
      '<label><input id="mes-date" type="checkbox" checked> дата в имени файла</label>' +
      '<label>таблица бухгалтерии для имён папок (.xlsx)<br>' +
      '<input id="mes-map" type="file" accept=".xlsx" style="width:100%;font-size:11px"></label>' +
      '<div id="mes-map-info" style="color:#666;font-size:11px;margin-top:-4px"></div>' +
      '<label>продолжить с договора (необязательно)<br>' +
      '<input id="mes-since" type="text" placeholder="напр. 50100000000001" style="width:100%;box-sizing:border-box"></label>' +
      '<button id="mes-go" style="padding:10px 14px;border:0;border-radius:10px;background:#f60;color:#fff;' +
      'font:600 13px system-ui;cursor:pointer">Скачать всё в ZIP</button>' +
      '<button id="mes-stop" style="display:none;padding:8px 12px;border:0;border-radius:9px;background:#eee;' +
      'cursor:pointer;font:13px system-ui">Остановить и сохранить, что есть</button>' +
      '<div id="mes-msg" style="color:#444;min-height:16px"></div>' +
      '<div id="mes-log" style="color:#666;font:11px/1.35 ui-monospace,monospace;max-height:150px;overflow:auto"></div>';
    document.body.appendChild(box);

    const $ = (id) => box.querySelector(id);
    const ui = {
      status: (t) => { $('#mes-msg').textContent = t; },
      log: (t) => { const d = document.createElement('div'); d.textContent = t; $('#mes-log').appendChild(d); $('#mes-log').scrollTop = 1e6; },
    };

    const showMap = () => {
      const m = loadMap();
      $('#mes-map-info').textContent = m
        ? `загружена: ${m.file} — ${Object.keys(m.data).length} номеров МЭС (${m.at}). Папки: «244_ИП_…_номер».`
        : 'не загружена — папки будут названы только номером договора';
    };
    showMap();
    $('#mes-map').onchange = async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      try {
        const data = buildMap(await readXlsx(await f.arrayBuffer()));
        if (!Object.keys(data).length) throw new Error('не нашёл строк: номер МЭС — в 1-й колонке, короткий номер — в 3-й, наименование — в 5-й');
        const at = new Date().toLocaleDateString('ru-RU');
        try { localStorage.setItem(MAP_KEY, JSON.stringify({ file: f.name, at, data })); } catch (e) {}
        showMap();
      } catch (e) {
        $('#mes-map-info').textContent = '✗ таблица не прочиталась: ' + e.message;
        console.error('[МЭС-выгрузка]', e);
      }
      ev.target.value = '';
    };

    $('#mes-stop').onclick = () => { STOP = true; ui.status('Останавливаюсь, сохраняю уже скачанное…'); };

    $('#mes-go').onclick = async () => {
      const btn = $('#mes-go');
      if (btn.disabled) return;
      const from = $('#mes-from').value, to = $('#mes-to').value;
      if (!from || !to || from > to) { ui.status('Проверьте период'); return; }
      if (!LIVE) { ui.status('Не удалось перехватить заголовки. Обновите страницу (F5) и нажмите снова.'); return; }
      STOP = false;
      btn.disabled = true; btn.style.opacity = .7;
      $('#mes-stop').style.display = 'block';
      $('#mes-log').innerHTML = '';
      const t0 = Date.now();
      try {
        const r = await run({ from, to, withDate: $('#mes-date').checked, since: ($('#mes-since').value || '').trim(), map: loadMap() }, ui);
        const head = r.authLost ? '⚠ Кабинет разлогинил' : STOP ? '⏹ Остановлено' : '✓ Готово';
        ui.status(`${head}: ${r.saved} файлов, ${r.mb.toFixed(1)} МБ, ` +
          `договоров с документами ${r.withDocs} из ${r.total}` +
          (r.errors ? `, не скачалось ${r.errors} — см. _ОШИБКИ.txt в архиве` : '') +
          (r.folderNotes ? `, ${r.folderNotes} папок проверить по таблице — см. _ОШИБКИ.txt` : '') +
          (r.rest ? `. Не обработано ${r.rest} — войдите заново и продолжите с ${r.next}` : '') +
          ` · ${Math.round((Date.now() - t0) / 1000)} c`);
        // Номер подставляем сразу: после разлогина руки заняты входом, а не перепиской номера.
        if (r.next) $('#mes-since').value = r.next;
      } catch (e) {
        ui.status('Ошибка: ' + e.message);
        console.error('[МЭС-выгрузка]', e);
      } finally {
        btn.disabled = false; btn.style.opacity = 1;
        $('#mes-stop').style.display = 'none';
      }
    };
  }

  const boot = () => (document.body ? mount() : setTimeout(boot, 300));
  boot();
  setInterval(mount, 3000);   // кабинет — SPA, панель возвращаем после перерисовок
})();
