/**
 * Visible virtual cursor: CDP-synthesized input moves no OS pointer, so the
 * humanized gestures would be invisible to a watching user. This module
 * injects an idempotent overlay into the TOP frame (fixed, pointer-events:
 * none, max z-index) that renders an AMPLIFIED NEON-COMET cursor show:
 *
 * - a gradient arrow cursor with layered glow, moved along the SAME Bezier
 *   path points / SAME duration as the Input.dispatchMouseEvent stream (both
 *   timelines start at the same kickoff, so they stay in sync within one
 *   evaluate roundtrip); it leans into its motion direction and
 *   squash-bounces on clicks, shedding fading afterimage silhouettes;
 * - a three-pass cyan→violet comet tail (wide additive aura + glow stroke +
 *   bright core, width scaling with segment speed) with spark particles
 *   shedding from BOTH the cursor head and the tail itself, plus a hot head
 *   knot;
 * - a breathing glow halo riding the cursor while it moves, tinting violet
 *   while keystrokes land;
 * - a click shockwave: triple expanding ring + cross flash + hot core +
 *   radial spark burst;
 * - HUMAN-OPERATION visuals the input stream previously hid: `key()` fires a
 *   key-cap pulse per keystroke at the cursor's position, `scroll()` draws
 *   directional streaks + chevrons at the scroll origin;
 * - ALWAYS-ON PRESENCE: after a gesture the cursor rests at its landing point
 *   (dimmed, slow-breathing halo) FOREVER — it never fades away, and
 *   `parkIfIdle()` materializes it on a freshly (re)loaded page at its last
 *   known position, while `touch()` brightens it to signal "the agent is
 *   alive" (the background keep-alive re-asserts both every few seconds);
 * - AI-ACTIVITY blip: `blip()` fires an amber double-ring pulse at the cursor
 *   for EVERY agent operation on the tab — pointer work answers with motion,
 *   and everything else (snapshots, navigation, evaluates, waits) still gets
 *   a visible reaction.
 *
 * No DOM/CSS animation, no injected <style>: everything rides CSSOM property
 * writes + canvas (with a 'lighter' composite pass for the glow), so strict
 * page CSP cannot block it.
 *
 * Everything here is best-effort: a page that somehow rejects the overlay
 * must never break the actual gesture — helpers swallow all errors.
 */

import type { Point } from './mouse'
import { evaluateInPage } from './dom-snapshot'

/** One point of a gesture path: viewport CSS coordinates + normalized time. */
interface GesturePoint {
  x: number
  y: number
  t: number
}

/**
 * Page-side installer (ES5). Exposes `window.__dshVC` with `move(points,
 * durationMs)`, `click(x, y)`, `key(x?, y?)`, and `scroll(x, y, dy)`.
 * Idempotent; returns 'ok'.
 * Exported for the syntax-validity unit test only.
 */
export const PAGE_INSTALL_SOURCE = `(function () {
  if (window.__dshVC) return 'ok';
  var root = document.createElement('div');
  root.setAttribute('data-dsh-vc', '');
  root.style.setProperty('position', 'fixed');
  root.style.setProperty('left', '0');
  root.style.setProperty('top', '0');
  root.style.setProperty('width', '100vw');
  root.style.setProperty('height', '100vh');
  root.style.setProperty('pointer-events', 'none');
  root.style.setProperty('z-index', '2147483647');
  var canvas = document.createElement('canvas');
  canvas.style.setProperty('position', 'absolute');
  canvas.style.setProperty('left', '0');
  canvas.style.setProperty('top', '0');
  var cursor = document.createElement('div');
  cursor.style.setProperty('position', 'absolute');
  cursor.style.setProperty('left', '0');
  cursor.style.setProperty('top', '0');
  cursor.style.setProperty('width', '30px');
  cursor.style.setProperty('height', '30px');
  cursor.style.setProperty('opacity', '0');
  cursor.style.setProperty('transition', 'opacity 0.25s linear');
  cursor.style.setProperty('will-change', 'transform');
  cursor.style.setProperty('filter', 'drop-shadow(0 0 3px rgba(224,231,255,0.95)) drop-shadow(0 0 9px rgba(129,140,248,0.9)) drop-shadow(0 0 22px rgba(192,132,252,0.55)) drop-shadow(0 2px 4px rgba(0,0,0,0.45))');
  cursor.innerHTML = '<svg width="30" height="30" viewBox="0 0 26 26">'
    + '<defs><linearGradient id="dsh-vc-g" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#a5f3fc"/><stop offset="0.45" stop-color="#7dd3fc"/><stop offset="0.75" stop-color="#818cf8"/><stop offset="1" stop-color="#c084fc"/>'
    + '</linearGradient></defs>'
    + '<path d="M5 2 L5 21 L10.5 16 L14 23.5 L17.2 22 L13.6 14.6 L20.5 14 Z" fill="none" stroke="#0b1220" stroke-width="3.4" stroke-linejoin="round"/>'
    + '<path d="M5 2 L5 21 L10.5 16 L14 23.5 L17.2 22 L13.6 14.6 L20.5 14 Z" fill="url(#dsh-vc-g)" stroke="#f4f8ff" stroke-width="0.9" stroke-linejoin="round"/>'
    + '</svg>';
  root.appendChild(canvas);
  root.appendChild(cursor);
  (document.documentElement || document.body).appendChild(root);

  var ctx = canvas.getContext('2d');
  var trail = [];      // {x, y, time}
  var sparks = [];     // {x, y, vx, vy, born, life, size}
  var ripples = [];    // {x, y, time}
  var blips = [];      // {x, y, time}   AI-activity amber pulses
  var ghosts = [];     // {x, y, born, ang}   fading cursor afterimages
  var keys = [];       // {x, y, born}        keystroke key-cap pulses
  var streaks = [];    // {x, y, vy, born, life} scroll streak lines
  var chevrons = [];   // {x, y, dir, born}   scroll direction chevrons
  var anim = null;     // {points, duration, start}
  var raf = 0;
  var hideAt = 0;      // bright-show ends here (full opacity + bright halo)
  var idleUntil = 0;   // …then the cursor rests at its landing point FOREVER (never fades)
  var squishAt = -1000000; // last click time, drives the squash bounce
  var lastCur = null;      // {x, y} — previous frame cursor pos (velocity lean)
  var leanDeg = 0;         // smoothed motion lean, applied as cursor rotate()
  var lastGhostAt = 0;     // afterimage throttle
  var typeUntil = 0;       // halo stays violet while keystrokes land
  var blipUntil = 0;       // halo stays amber while activity blips land

  var TRAIL_TAIL = 1400;
  var SPARK_CAP = 130;
  var CLICK_T = 560;
  var IDLE_MS = 8000; // brighten window after a gesture
  var STAY_MS = 86400000; // presence horizon: the cursor NEVER fades before this re-armms

  // cyan → indigo → violet stops for the neon gradient
  var C0 = [125, 211, 252], C1 = [129, 140, 248], C2 = [192, 132, 252];
  // amber pair for AI-activity blips (a hue the pointer never uses otherwise)
  var A0 = [253, 224, 71], A1 = [251, 146, 60];
  function mix(a, b, f) {
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function neon(f, alpha) {
    var c = f < 0.5 ? mix(C0, C1, f * 2) : mix(C1, C2, (f - 0.5) * 2);
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + alpha + ')';
  }
  function amber(f, alpha) {
    var c = mix(A0, A1, f);
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + alpha + ')';
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.setProperty('width', window.innerWidth + 'px');
    canvas.style.setProperty('height', window.innerHeight + 'px');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize, true);

  function pos(now) {
    var p = anim.points;
    if (now <= anim.start) return p[0];
    var T = (now - anim.start) / anim.duration;
    if (T >= 1) return p[p.length - 1];
    for (var i = 1; i < p.length; i++) {
      if (p[i].t >= T) {
        var a = p[i - 1], b = p[i];
        var span = b.t - a.t;
        var f = span > 0 ? (T - a.t) / span : 1;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return p[p.length - 1];
  }

  function drawHalo(x, y, radius, alpha, f, palette) {
    if (f === undefined) f = 0.35;
    if (!palette) palette = neon;
    var g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, palette(f, alpha));
    g.addColorStop(1, palette(f + 0.25 > 1 ? 1 : f + 0.25, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // the SVG arrow polygon (26-box), centered, scaled — for the afterimages
  var ARROW = [[5, 2], [5, 21], [10.5, 16], [14, 23.5], [17.2, 22], [13.6, 14.6], [20.5, 14]];
  function arrowPath(scale) {
    ctx.beginPath();
    ctx.moveTo((ARROW[0][0] - 9) * scale, (ARROW[0][1] - 9) * scale);
    for (var i = 1; i < ARROW.length; i++) {
      ctx.lineTo((ARROW[i][0] - 9) * scale, (ARROW[i][1] - 9) * scale);
    }
    ctx.closePath();
  }

  function loop() {
    raf = 0;
    var now = performance.now();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    var cx = null, cy = null, moveT = 0;
    if (anim) {
      var pt = pos(now);
      cx = pt.x; cy = pt.y;
      moveT = Math.min(1, (now - anim.start) / anim.duration);
      if (now - anim.start <= anim.duration + 40) trail.push({ x: cx, y: cy, time: now });

      // motion lean: the arrow tips toward its horizontal travel direction
      if (lastCur !== null) {
        var dx = cx - lastCur.x;
        if (dx !== 0) {
          var target = Math.max(-9, Math.min(9, dx * 0.55));
          leanDeg += (target - leanDeg) * 0.18;
        }
      }
      lastCur = { x: cx, y: cy };

      // afterimage silhouettes while moving (throttled)
      if (moveT < 1 && now - lastGhostAt > 46) {
        lastGhostAt = now;
        ghosts.push({ x: cx, y: cy, born: now, ang: leanDeg });
        if (ghosts.length > 26) ghosts.shift();
      }

      // squash bounce on clicks
      var sq = 1;
      var sinceSquish = now - squishAt;
      if (sinceSquish < 220) sq = 1 - 0.2 * Math.sin(Math.PI * (sinceSquish / 220));
      cursor.style.setProperty('transform',
        'translate3d(' + (cx - 3) + 'px,' + (cy - 1) + 'px,0) rotate(' + leanDeg.toFixed(2) + 'deg) scale(' + sq.toFixed(3) + ')');
    }

    // ── glow pass (additive): tail aura, halo, sparks, shockwaves, keys, scroll fx ──
    ctx.globalCompositeOperation = 'lighter';

    // ── the comet tail, pass 1: wide soft aura following segment speed ──
    while (trail.length > 0 && now - trail[0].time > TRAIL_TAIL) trail.shift();
    if (trail.length > 1) {
      ctx.lineCap = 'round';
      for (var i = 1; i < trail.length; i++) {
        var a = trail[i - 1], b = trail[i];
        var age = (now - b.time) / TRAIL_TAIL;
        if (age >= 1) continue;
        var depth = i / trail.length; // 0 = oldest, 1 = newest
        var segLen = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
        var speedW = 1 + Math.min(1.1, segLen / 26);
        ctx.strokeStyle = neon(depth * 0.8 + 0.1, (0.16 * (1 - age)).toFixed(3));
        ctx.lineWidth = (15 * (1 - age) + 3) * (0.35 + 0.65 * depth) * speedW;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // ── the comet tail, passes 2+3: glow stroke then the bright core ──
    if (trail.length > 1) {
      for (var i2 = 1; i2 < trail.length; i2++) {
        var a2 = trail[i2 - 1], b2 = trail[i2];
        var age2 = (now - b2.time) / TRAIL_TAIL;
        if (age2 >= 1) continue;
        var depth2 = i2 / trail.length;
        var seg2 = Math.sqrt((b2.x - a2.x) * (b2.x - a2.x) + (b2.y - a2.y) * (b2.y - a2.y));
        var speedW2 = 1 + Math.min(1.1, seg2 / 26);
        var col2 = neon(depth2 * 0.8 + 0.1, (0.6 * (1 - age2)).toFixed(3));
        ctx.strokeStyle = col2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a2.x, a2.y);
        ctx.lineTo(b2.x, b2.y);
        // outer glow stroke, then the bright core
        ctx.lineWidth = (6.5 * (1 - age2) + 1.5) * (0.35 + 0.65 * depth2) * speedW2;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = (1.8 * (1 - age2) + 0.6) * speedW2;
        ctx.stroke();
      }
    }

    // hot head knot riding the cursor (dimmed while idling)
    if (cx !== null && now <= idleUntil) {
      ctx.fillStyle = neon(0.15, now <= hideAt ? 0.9 : 0.45);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // breathing halo riding the cursor (violet while keystrokes land, amber while activity blips land)
    if (cx !== null && now <= idleUntil) {
      var active = now <= hideAt;
      var breathe = (active ? 0.16 : 0.07) + 0.08 * Math.sin(now / (active ? 180 : 520));
      drawHalo(cx, cy, active ? 17 : 13, breathe, typeUntil > now ? 0.8 : 0.35);
      if (blipUntil > now) drawHalo(cx, cy, 21 + 4 * Math.sin(now / 140), 0.22, 0, amber);
    }

    // fading cursor afterimages
    for (var gh = ghosts.length - 1; gh >= 0; gh--) {
      var g = ghosts[gh];
      var fgh = (now - g.born) / 300;
      if (fgh >= 1) { ghosts.splice(gh, 1); continue; }
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.ang * Math.PI / 180);
      ctx.globalAlpha = 0.2 * (1 - fgh);
      ctx.fillStyle = neon(0.5, 0.6);
      arrowPath(0.85);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // spark particles shed from the moving cursor AND from the tail itself
    if (anim && cx !== null && moveT < 1 && trail.length > 1 && Math.random() < 0.65 && sparks.length < SPARK_CAP) {
      var spread = (Math.random() - 0.5) * 2.4;
      sparks.push({ x: cx, y: cy, vx: spread, vy: -0.6 - Math.random() * 1.2, born: now, life: 420 + Math.random() * 320, size: 1.1 + Math.random() * 1.8 });
    }
    if (trail.length > 6 && Math.random() < 0.3 && sparks.length < SPARK_CAP) {
      var tp = trail[Math.floor(Math.random() * (trail.length - 1))];
      sparks.push({ x: tp.x, y: tp.y, vx: (Math.random() - 0.5) * 1.4, vy: -0.4 - Math.random() * 0.9, born: now, life: 360 + Math.random() * 260, size: 0.8 + Math.random() * 1.3 });
    }
    for (var s = sparks.length - 1; s >= 0; s--) {
      var sp = sparks[s];
      var ageS = (now - sp.born) / sp.life;
      if (ageS >= 1) { sparks.splice(s, 1); continue; }
      sp.x += sp.vx; sp.y += sp.vy; sp.vy += 0.02;
      ctx.fillStyle = neon(ageS * 0.7 + 0.1, 0.85 * (1 - ageS));
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.size * (1 - ageS * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    // keystroke key-cap pulses (~320ms): a small glowing key square rising off the field
    for (var k = keys.length - 1; k >= 0; k--) {
      var kp = keys[k];
      var fk = (now - kp.born) / 320;
      if (fk >= 1) { keys.splice(k, 1); continue; }
      var rise = 9 * fk;
      var ks = 7 * (1 - 0.3 * fk);
      ctx.save();
      ctx.translate(kp.x, kp.y - rise);
      ctx.rotate(-0.12);
      ctx.globalAlpha = 0.55 * (1 - fk);
      ctx.strokeStyle = neon(0.25, 1);
      ctx.lineWidth = 1.3;
      roundRect(-ks, -ks * 0.8, ks * 2, ks * 1.6, 2.5);
      ctx.stroke();
      ctx.globalAlpha = 0.18 * (1 - fk);
      ctx.fillStyle = neon(0.45, 1);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // scroll streaks: elongated lines drifting along the scroll direction
    for (var st = streaks.length - 1; st >= 0; st--) {
      var q = streaks[st];
      var fq = (now - q.born) / q.life;
      if (fq >= 1) { streaks.splice(st, 1); continue; }
      q.y += q.vy;
      var len = 10 + 10 * (1 - fq);
      var grd = ctx.createLinearGradient(q.x, q.y - len, q.x, q.y + len);
      grd.addColorStop(0, neon(0.2, 0));
      grd.addColorStop(0.5, neon(0.3, (0.5 * (1 - fq)).toFixed(3)));
      grd.addColorStop(1, neon(0.2, 0));
      ctx.strokeStyle = grd;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y - len);
      ctx.lineTo(q.x, q.y + len);
      ctx.stroke();
    }

    // scroll direction chevrons drifting with the content flow (~480ms)
    for (var c = chevrons.length - 1; c >= 0; c--) {
      var ch = chevrons[c];
      var fc = (now - ch.born) / 480;
      if (fc >= 1) { chevrons.splice(c, 1); continue; }
      var drift = 16 * fc * ch.dir;
      ctx.strokeStyle = neon(0.6, (0.7 * (1 - fc)).toFixed(3));
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (var n = 0; n < 2; n++) {
        var yy = ch.y + drift - ch.dir * n * 9;
        ctx.beginPath();
        ctx.moveTo(ch.x - 7, yy - ch.dir * 4);
        ctx.lineTo(ch.x, yy);
        ctx.lineTo(ch.x + 7, yy - ch.dir * 4);
        ctx.stroke();
      }
    }

    // click shockwaves: triple ring + cross flash + hot core (~560ms)
    for (var j = ripples.length - 1; j >= 0; j--) {
      var r = ripples[j];
      var f = (now - r.time) / CLICK_T;
      if (f >= 1) { ripples.splice(j, 1); continue; }
      var fade = 1 - f;
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = neon(0.15, 0.85 * fade);
      ctx.beginPath(); ctx.arc(r.x, r.y, 5 + 30 * f, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = neon(0.75, 0.7 * fade);
      ctx.beginPath(); ctx.arc(r.x, r.y, 3 + 18 * f, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = neon(0.5, 0.4 * fade);
      ctx.beginPath(); ctx.arc(r.x, r.y, 2 + 46 * f, 0, Math.PI * 2); ctx.stroke();
      if (f < 0.4) {
        var ray = 18 * (1 - f / 0.4);
        ctx.strokeStyle = neon(0.4, 0.9 * (1 - f / 0.4));
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(r.x - ray, r.y); ctx.lineTo(r.x + ray, r.y);
        ctx.moveTo(r.x, r.y - ray); ctx.lineTo(r.x, r.y + ray);
        ctx.stroke();
      }
      drawHalo(r.x, r.y, 12 + 20 * f, 0.32 * fade);
    }

    // AI-activity blips: amber double ring + soft halo (~460ms), distinct
    // from the click shockwave so "the agent did something" reads at a glance
    for (var b = blips.length - 1; b >= 0; b--) {
      var ab = blips[b];
      var fb = (now - ab.time) / 460;
      if (fb >= 1) { blips.splice(b, 1); continue; }
      var fadeB = 1 - fb;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = amber(0.1, 0.8 * fadeB);
      ctx.beginPath(); ctx.arc(ab.x, ab.y, 4 + 22 * fb, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = amber(0.55, 0.6 * fadeB);
      ctx.beginPath(); ctx.arc(ab.x, ab.y, 2 + 12 * fb, 0, Math.PI * 2); ctx.stroke();
      drawHalo(ab.x, ab.y, 10 + 14 * fb, 0.26 * fadeB, 0, amber);
    }

    if (now > hideAt) {
      // resting presence: dimmed and breathing at the landing point — the
      // cursor NEVER fades away (always-on visibility is the contract)
      cursor.style.setProperty('opacity', '0.6');
    }

    if (trail.length > 0 || ripples.length > 0 || sparks.length > 0 || ghosts.length > 0
      || keys.length > 0 || streaks.length > 0 || chevrons.length > 0 || anim !== null || now <= idleUntil) {
      raf = window.requestAnimationFrame(loop);
    } else {
      lastCur = null;
    }
  }

  function wake() {
    if (!raf) raf = window.requestAnimationFrame(loop);
  }

  window.__dshVC = {
    move: function (points, durationMs) {
      if (!points || points.length < 2 || !(durationMs > 0)) return;
      anim = { points: points, duration: durationMs, start: performance.now() };
      hideAt = anim.start + durationMs + 1400;
      idleUntil = anim.start + STAY_MS;
      cursor.style.setProperty('opacity', '1');
      wake();
    },
    click: function (x, y) {
      var t = performance.now();
      idleUntil = t + STAY_MS; // presence continues at the landing point, forever
      ripples.push({ x: x, y: y, time: t });
      squishAt = t;
      // radial spark burst at the landing point
      for (var i = 0; i < 12; i++) {
        if (sparks.length >= SPARK_CAP + 20) break;
        var a = Math.PI * 2 * i / 12 + Math.random() * 0.5;
        var v = 1.6 + Math.random() * 1.8;
        sparks.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: t, life: 380 + Math.random() * 260, size: 1.2 + Math.random() * 1.6 });
      }
      wake();
    },
    key: function (x, y) {
      var t = performance.now();
      typeUntil = t + 900;
      idleUntil = t + STAY_MS;
      var px = typeof x === 'number' ? x : (lastCur !== null ? lastCur.x : 0);
      var py = typeof y === 'number' ? y : (lastCur !== null ? lastCur.y : 0);
      keys.push({ x: px, y: py, born: t });
      if (keys.length > 24) keys.shift();
      for (var i = 0; i < 3; i++) {
        if (sparks.length >= SPARK_CAP) break;
        sparks.push({ x: px, y: py, vx: (Math.random() - 0.5) * 1.6, vy: -1 - Math.random() * 1.4, born: t, life: 300 + Math.random() * 200, size: 0.9 + Math.random() * 1.2 });
      }
      wake();
    },
    scroll: function (x, y, dy) {
      var t = performance.now();
      var dir = dy >= 0 ? 1 : -1;
      idleUntil = t + STAY_MS;
      chevrons.push({ x: x, y: y, dir: dir, born: t });
      if (chevrons.length > 12) chevrons.shift();
      for (var i = 0; i < 8; i++) {
        streaks.push({
          x: x + (Math.random() - 0.5) * 90,
          y: y + (Math.random() - 0.5) * 60,
          vy: (2.2 + Math.random() * 2.4) * dir,
          born: t,
          life: 420 + Math.random() * 260,
        });
      }
      if (streaks.length > 60) streaks.splice(0, streaks.length - 60);
      wake();
    },
    parkIfIdle: function (x, y) {
      // Materialize the resting cursor at (x, y) — a fresh install (page
      // navigation, first op on this tab) or a re-assert. Never disturbs an
      // in-flight gesture animation. Without coordinates it parks at a
      // viewport-fraction default (right of center, upper third).
      if (anim) return;
      if (typeof x !== 'number' || typeof y !== 'number') {
        x = Math.round(window.innerWidth * 0.72);
        y = Math.round(window.innerHeight * 0.35);
      }
      var t = performance.now();
      idleUntil = t + STAY_MS;
      lastCur = { x: x, y: y };
      cursor.style.setProperty('opacity', '0.6');
      cursor.style.setProperty('transform',
        'translate3d(' + (x - 3) + 'px,' + (y - 1) + 'px,0) rotate(0deg) scale(1)');
      wake();
    },
    touch: function () {
      // Keep-alive heartbeat: confirm the overlay is live and brighten briefly.
      var t = performance.now();
      idleUntil = t + STAY_MS;
      hideAt = t + 1200;
      wake();
      return 'ok';
    },
    blip: function (x, y) {
      // AI-activity pulse for EVERY agent operation on this tab: an amber
      // double ring at the cursor's position (a hue no pointer gesture uses),
      // so non-pointer operations still read as visible reactions.
      var t = performance.now();
      idleUntil = t + STAY_MS;
      blipUntil = t + 900;
      var px = typeof x === 'number' ? x : (lastCur !== null ? lastCur.x : 0);
      var py = typeof y === 'number' ? y : (lastCur !== null ? lastCur.y : 0);
      blips.push({ x: px, y: py, time: t });
      if (blips.length > 10) blips.shift();
      for (var i = 0; i < 4; i++) {
        if (sparks.length >= SPARK_CAP) break;
        sparks.push({ x: px, y: py, vx: (Math.random() - 0.5) * 1.8, vy: -0.8 - Math.random() * 1.2, born: t, life: 340 + Math.random() * 220, size: 0.9 + Math.random() * 1.3 });
      }
      wake();
    }
  };
  return 'ok';
})`

function pageCall(tabId: number, call: string): Promise<void> {
  // best-effort: never let the visual overlay break a real gesture. The
  // deferred chain also swallows a synchronous throw or non-promise return
  // from the evaluate seam — the overlay must stay inert by construction.
  return Promise.resolve()
    .then(() => evaluateInPage<unknown>(tabId, `(${PAGE_INSTALL_SOURCE})(); ${call}`))
    .then(
      () => undefined,
      () => undefined,
    )
}

// ───────────────────── always-on presence ─────────────────────

/** The overlay re-asserts itself on driven tabs at this cadence. */
const CURSOR_KEEP_ALIVE_MS = 4000

/**
 * Last known landing/park point per driven tab, so a re-injection after a
 * navigation materializes the cursor where it was instead of teleporting it.
 * Tabs without a known point park at the page-computed default position.
 */
const parkedPoints = new Map<number, Point>()
/** Tabs the agent has operated on (most recent last). */
const drivenOrder: number[] = []
let keepAlive: ReturnType<typeof setInterval> | undefined

function recordDriven(tabId: number, point?: Point): void {
  if (point !== undefined) parkedPoints.set(tabId, point)
  const at = drivenOrder.indexOf(tabId)
  if (at >= 0) drivenOrder.splice(at, 1)
  drivenOrder.push(tabId)
  if (drivenOrder.length > 6) {
    const evicted = drivenOrder.shift()
    if (evicted !== undefined) parkedPoints.delete(evicted)
  }
  if (keepAlive === undefined) {
    keepAlive = setInterval(keepAliveTick, CURSOR_KEEP_ALIVE_MS)
  }
}

/**
 * Re-assert the overlay on every driven tab: a page that navigated (or a
 * fresh tab) gets the overlay installed and the cursor parked at its last
 * point; an existing overlay just brightens briefly. Fire-and-forget per
 * tab — detached or closed tabs swallow their error and are retried.
 */
function keepAliveTick(): void {
  for (const tabId of [...drivenOrder]) {
    const point = parkedPoints.get(tabId)
    const parkCall = point === undefined
      ? 'window.__dshVC.parkIfIdle();'
      : `window.__dshVC.parkIfIdle(${Math.round(point.x)}, ${Math.round(point.y)});`
    void Promise.resolve()
      .then(() => evaluateInPage<unknown>(
        tabId,
        `if (!window.__dshVC) { (${PAGE_INSTALL_SOURCE})(); ${parkCall} } else { window.__dshVC.touch(); }`,
      ))
      .catch(() => undefined)
  }
}

// A closed tab must not pin the keep-alive loop (or resurrect points) forever.
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    parkedPoints.delete(tabId)
    const at = drivenOrder.indexOf(tabId)
    if (at >= 0) drivenOrder.splice(at, 1)
  })
}

/**
 * Record that the agent operated on this tab and give the pointer an
 * immediate visible reaction there: install + park when the overlay is
 * missing, brighten + amber blip when it is not. Fired for EVERY browser
 * operation, pointer gestures included — motion answers pointer work, the
 * amber blip answers everything else.
 */
export function noteBrowserOperation(tabId: number): void {
  recordDriven(tabId)
  const point = parkedPoints.get(tabId)
  const parkCall = point === undefined
    ? 'window.__dshVC.parkIfIdle();'
    : `window.__dshVC.parkIfIdle(${Math.round(point.x)}, ${Math.round(point.y)});`
  void Promise.resolve()
    .then(() => evaluateInPage<unknown>(
      tabId,
      `if (!window.__dshVC) { (${PAGE_INSTALL_SOURCE})(); ${parkCall} } else { window.__dshVC.blip(); }`,
    ))
    .catch(() => undefined)
}

/** Start the visible cursor animation for one gesture (same path + duration the input stream uses). */
export async function showGesture(
  tabId: number,
  points: readonly GesturePoint[],
  durationMs: number,
): Promise<void> {
  recordDriven(tabId, points.length > 0 ? points[points.length - 1] : undefined)
  await pageCall(
    tabId,
    `window.__dshVC.move(${JSON.stringify(points)}, ${Math.round(durationMs)})`,
  )
}

/** Draw a click shockwave at one viewport point. */
export async function showClick(tabId: number, point: Point): Promise<void> {
  recordDriven(tabId, point)
  await pageCall(tabId, `window.__dshVC.click(${point.x}, ${point.y})`)
}

/**
 * Fire one keystroke pulse at the cursor's current position (typing visual).
 * Coordinates are resolved page-side — the virtual cursor already sits on the
 * focused field after the humanized click that precedes typing.
 */
export async function showTypePulse(tabId: number): Promise<void> {
  await pageCall(tabId, 'window.__dshVC.key()')
}

/** Draw scroll streaks + direction chevrons at the scroll origin point. */
export async function showScroll(tabId: number, point: Point, deltaY: number): Promise<void> {
  await pageCall(tabId, `window.__dshVC.scroll(${point.x}, ${point.y}, ${Math.round(deltaY)})`)
}
