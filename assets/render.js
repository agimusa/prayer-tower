/* Prayer Tower slide renderer.
 *
 * Builds the prayer <section>s of index.html from data/prayers.json.
 * Plain browser JS, no build step. Pure: no fetch, no globals touched except
 * the export itself.
 *
 *   Browser: window.PrayerRender.renderDeck(data, document)
 *   Node:    require('assets/render.js') or eval the file inside a jsdom window.
 *
 * Output must match the hand-written markup that used to live in index.html
 * (see mcp/test/parity.test.ts).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.PrayerRender = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_TIMER = 300;

  /* The add-request panel, verbatim from the original page. */
  var ADD_PANEL_HTML =
    '<div class="add-panel">' +
    '<span class="label">Add a new prayer request</span>' +
    '<textarea id="new-en" placeholder="Type prayer request in English…" rows="2"></textarea>' +
    '<textarea id="new-te" placeholder="తెలుగులో ప్రార్థన విజ్ఞాపన టైప్ చేయండి…" rows="2"></textarea>' +
    '<div class="tr-status" id="tr-status"></div>' +
    '<button class="submit" onclick="addPrayerRow()">＋ Add Prayer Request</button>' +
    '</div>';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Escape, then turn **x** into <strong>x</strong>. */
  function escapeWithBold(s) {
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  /* Seconds -> "M:SS" (300 -> "5:00", 120 -> "2:00", 75 -> "1:15"). */
  function formatTimer(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function ul(values, cls) {
    var out = '<ul' + (cls ? ' class="' + cls + '"' : '') + '>';
    for (var i = 0; i < values.length; i++) out += '<li>' + escapeHtml(values[i]) + '</li>';
    return out + '</ul>';
  }

  function pick(list, side) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push(list[i][side]);
    return out;
  }

  function isActive(r) {
    return r && r.status === 'active';
  }

  /* One side ("en" | "te") of a list-layout row. */
  function renderListSide(r, side) {
    if (r.text) return escapeWithBold(r.text[side]);
    var h = '<strong>' + escapeHtml(r.name[side]) + '</strong>';
    if (r.note) h += ' ' + escapeHtml(r.note[side]);
    if (r.label) h += ' - ' + escapeHtml(r.label[side]);
    if (r.detail) {
      h += r.label ? ': ' : ' - ';
      h += side === 'en' ? '<span class="detail">' + escapeHtml(r.detail.en) + '</span>' : escapeHtml(r.detail.te);
    }
    if (r.items && r.items.length) h += ul(pick(r.items, side), 'pr');
    return h;
  }

  function renderListRow(r) {
    return (
      '<div class="row' + (r.plain ? ' plain' : '') + '">' +
      '<div class="en">' + renderListSide(r, 'en') + '</div>' +
      '<div class="te">' + renderListSide(r, 'te') + '</div>' +
      '</div>'
    );
  }

  function cell(cls, en, te) {
    return '<div class="' + cls + '"><div class="en">' + en + '</div><div class="te">' + te + '</div></div>';
  }

  function renderHeadRow(c) {
    function head(cls, b) {
      return cell(cls, '<strong>' + escapeHtml(b.en) + '</strong>', escapeHtml(b.te));
    }
    return '<div class="row3 head">' + head('col-p', c.parents) + head('col-k', c.children) + head('col-q', c.prayer) + '</div>';
  }

  function renderRow3(r) {
    return (
      '<div class="row3">' +
      cell('col-p', '<strong>' + escapeHtml(r.name.en) + '</strong>', '<strong>' + escapeHtml(r.name.te) + '</strong>') +
      cell('col-k', ul(pick(r.children, 'en')), ul(pick(r.children, 'te'))) +
      cell('col-q', ul(pick(r.items, 'en'), 'pr'), ul(pick(r.items, 'te'), 'pr')) +
      '</div>'
    );
  }

  function renderRowsHtml(slide) {
    var html = '';
    var three = slide.layout === 'three-col';
    if (three && slide.columns) html += renderHeadRow(slide.columns);
    var reqs = slide.requests || [];
    for (var i = 0; i < reqs.length; i++) {
      if (!isActive(reqs[i])) continue;
      html += three ? renderRow3(reqs[i]) : renderListRow(reqs[i]);
    }
    return html;
  }

  /* Full <section> markup for one slide. position is 1-based among prayer slides. */
  function renderSlideHtml(slide, position, total) {
    var num = Number(slide.num);
    var secs = slide.timer_seconds || DEFAULT_TIMER;
    return (
      '<section class="slide ' + escapeHtml(slide.theme) + '" id="hdr-' + num + '" data-glow="' + escapeHtml(slide.glow) + '">' +
      '<div class="slide-inner">' +
      '<div class="slide-top">' +
      '<div class="slide-titles">' +
      '<div class="slide-index">' + pad2(position) + ' / ' + pad2(total) + '</div>' +
      '<div class="slide-title-en">' + escapeHtml(slide.title.en) + '</div>' +
      '<div class="slide-title-te">' + escapeHtml(slide.title.te) + '</div>' +
      '</div>' +
      '<div class="timer">' +
      '<button id="btn-' + num + '" onclick="toggleTimer(' + num + ')" title="Play">▶</button>' +
      '<span class="t-display" id="td-' + num + '">' + formatTimer(secs) + '</span>' +
      '<button onclick="resetTimer(' + num + ')" title="Reset">↺</button>' +
      '</div>' +
      '</div>' +
      '<div class="rows"' + (slide.add_panel ? ' id="req-rows"' : '') + '>' + renderRowsHtml(slide) + '</div>' +
      (slide.add_panel ? ADD_PANEL_HTML : '') +
      '</div>' +
      '</section>'
    );
  }

  /* Build every prayer slide and insert them between #s-hero and #s-outro.
     Returns the inserted <section> elements in display order. */
  function renderDeck(data, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('renderDeck: no document');
    if (!data || !Array.isArray(data.slides)) throw new Error('renderDeck: data.slides missing');

    var slides = data.slides;
    var html = '';
    for (var i = 0; i < slides.length; i++) html += renderSlideHtml(slides[i], i + 1, slides.length);

    var tpl = doc.createElement('template');
    tpl.innerHTML = html;
    var sections = Array.prototype.slice.call(tpl.content.children);

    // Re-rendering replaces previously rendered slides.
    var old = doc.querySelectorAll('section.slide[id^="hdr-"]');
    for (var j = 0; j < old.length; j++) old[j].parentNode.removeChild(old[j]);

    var outro = doc.getElementById('s-outro');
    var parent = outro ? outro.parentNode : doc.querySelector('main') || doc.body;
    parent.insertBefore(tpl.content, outro || null);
    return sections;
  }

  /* Seconds per slide num, e.g. { 9: 300, 6: 300 }. */
  function timerMap(data) {
    var m = {};
    var slides = (data && data.slides) || [];
    for (var i = 0; i < slides.length; i++) m[slides[i].num] = slides[i].timer_seconds || DEFAULT_TIMER;
    return m;
  }

  return {
    DEFAULT_TIMER: DEFAULT_TIMER,
    ADD_PANEL_HTML: ADD_PANEL_HTML,
    escapeHtml: escapeHtml,
    escapeWithBold: escapeWithBold,
    formatTimer: formatTimer,
    renderListRow: renderListRow,
    renderRow3: renderRow3,
    renderHeadRow: renderHeadRow,
    renderSlideHtml: renderSlideHtml,
    renderDeck: renderDeck,
    timerMap: timerMap,
  };
});
