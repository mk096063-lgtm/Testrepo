// CNCVEYRA — Turning G-code generation backend.
//
// This is the ONLY place the actual turning algorithm lives (OD roughing
// chains, OD finishing with staged passes/tailstock, Facing, Grooving,
// Part-off, ID boring). The browser only sends inputs and displays the
// G-code text this function returns — it never receives this logic.
//
// Pure logic module — no Cloudflare-specific code here. Imported by
// src/index.js (the Worker's fetch handler) and never sent to the browser.

function fmt(v) {
  let s = Number(v).toFixed(3).replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  return s;
}

// In this lab, the entered/profile X is interpreted as the requested
// programming value (kept as its own function to mirror the original code).
function xOut(x) { return x; }

// Profile-aware progressive/rest OD roughing path builder.
// Each X pass cuts ONLY the Z intervals where material still exists
// outside the final profile + finish allowance. Once a step/shoulder has
// reached its required size, later passes completely skip that Z interval.
function roughPassPath(profile, passX, stockX, fin, clearX) {
  const sorted = profile.slice();
  if (sorted.length < 2) return [];
  const maxZ = Math.max(...sorted.map(q => q.z));
  const minZ = Math.min(...sorted.map(q => q.z));
  const frontZ = maxZ >= -1e-7 ? 0 : maxZ;
  const eps = 1e-7;
  const intervals = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const hi = Math.min(Math.max(a.z, b.z), frontZ);
    const lo = Math.max(Math.min(a.z, b.z), minZ);
    if (hi <= lo + eps) continue;
    const fa = a.x + fin - passX, fb = b.x + fin - passX;
    if (fa <= eps && fb <= eps) {
      intervals.push({ hi, lo, cross: false, seg: i });
    } else if ((fa <= eps) !== (fb <= eps)) {
      const dx = b.x - a.x, dz = b.z - a.z;
      if (Math.abs(dx) > eps) {
        const t = (passX - fin - a.x) / dx;
        const zc = a.z + t * dz;
        if (fa <= eps) intervals.push({ hi, lo: Math.max(lo, Math.min(hi, zc)), cross: true, seg: i });
        else intervals.push({ hi: Math.min(hi, Math.max(lo, zc)), lo, cross: true, seg: i });
      }
    }
  }

  intervals.sort((a, b) => b.hi - a.hi);
  const merged = [];
  for (const q of intervals) {
    if (q.hi - q.lo <= eps) continue;
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.lo - q.hi) < 1e-5) {
      last.lo = q.lo;
      last.cross = last.cross || q.cross;
      last.seg = q.seg;
    } else merged.push({ ...q });
  }

  const chains = [];
  for (const iv of merged) {
    const chain = [];
    const add = (x, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const last = chain[chain.length - 1];
      if (!last || Math.abs(last.x - x) > eps || Math.abs(last.z - z) > eps) chain.push({ x, z });
    };
    add(passX, iv.hi);
    add(passX, iv.lo);

    if (iv.cross) {
      for (let idx = iv.seg + 1; idx < sorted.length - 1; idx++) {
        const a2 = sorted[idx], b2 = sorted[idx + 1];
        if (a2.z >= iv.lo - eps) { continue; }
        const fa2 = a2.x + fin - passX, fb2 = b2.x + fin - passX;
        if (fa2 <= eps && fb2 <= eps) {
          add(b2.x + fin, Math.max(minZ, b2.z));
        } else if ((fa2 <= eps) !== (fb2 <= eps)) {
          const dx2 = b2.x - a2.x, dz2 = b2.z - a2.z;
          if (Math.abs(dx2) > eps) {
            const t2 = (passX - fin - a2.x) / dx2;
            add(passX, a2.z + t2 * dz2);
          }
          break;
        } else {
          break;
        }
      }
    }
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

function generateTurningCode(params) {
  const opn = params.op;
  const F = Number(params.feed) || 0.15;
  const S = Number(params.rpm) || 1200;
  const C = Number(params.clearance) || 2;
  const toolNum = Math.max(1, Math.round(Number(params.tool) || 1));

  const machineHeader = [`%`, `N3;`, `G0 G40 G28 U0.0 W0.0;`, `G0 T01${String(toolNum).padStart(2, '0')}`, `M8`, `G97 S${fmt(S)} M03`];
  let feedUsed = false;
  function feedTok() { if (feedUsed) return ''; feedUsed = true; return ` F${fmt(F)}`; }
  const machineFooter = [`M09`, `G28 U0. W0. M05`, `M30`, `%`];

  // FACING — independent of any DXF/manual profile geometry. Uses only OD
  // Stock X and Material Stock Z, which must be entered as a negative
  // total facing depth, e.g. -2. Number of Passes splits that total depth
  // into equal stepped Z passes (e.g. -2 over 2 passes = 1 mm per pass;
  // over 5 passes = 0.4 mm per pass). Each pass rapids down to that pass's
  // Z depth, feeds from the approach diameter (Stock X + Clearance)
  // straight in to X0, then rapids back out before the next pass steps
  // deeper.
  if (opn === 'facing') {
    const stock = Number(params.stockX) || 0;
    if (stock <= 0) throw new Error('Enter OD Stock X (Material Stock X) before generating facing code.');
    const rawZ = Number(params.stockZ);
    if (!Number.isFinite(rawZ) || rawZ >= 0) throw new Error('Facing requires Material Stock Z to be entered as a negative value (e.g. -2).');
    const totalDepth = Math.abs(rawZ);
    const passesCount = Math.max(1, Math.round(Number(params.finishPasses) || 1));
    const perPass = totalDepth / passesCount;
    const approach = stock + C, safeZ = C;
    let lines = [...machineHeader];
    lines.push(`G00 X${fmt(approach)} Z${fmt(safeZ)}`);
    for (let k = 1; k <= passesCount; k++) {
      const zDepth = -(perPass * k);
      lines.push(`G00 Z${fmt(zDepth)}`);
      lines.push(`G01 X0${feedTok()}`);
      lines.push(`G00 X${fmt(approach)}`);
    }
    lines.push(`G00 Z${fmt(safeZ)}`);
    lines.push(...machineFooter);
    return {
      code: lines.join('\n'),
      message: `Facing generated: ${fmt(totalDepth)} mm total Z depth split into ${passesCount} pass(es) of ${fmt(perPass)} mm each.`
    };
  }

  const p = Array.isArray(params.profile) ? params.profile.map(q => ({ x: Number(q.x), z: Number(q.z) })) : [];
  if (p.length < 2) throw new Error('At least two turning profile points are required.');
  const step = Number(params.step) || 1;
  const fin = Number(params.finish) || 0;
  const stockZ = Number(params.stockZ) || 0;

  const maxX = Math.max(...p.map(q => q.x)), minX = Math.min(...p.map(q => q.x));
  const stock = Number(params.stockX) || 0;
  if (stock <= 0) throw new Error('Enter Material Stock X (raw stock diameter) before generating code.');
  if (stock + 1e-9 < maxX) throw new Error(`Material Stock X${fmt(stock)} is smaller than profile maximum X${fmt(maxX)}. Enter the actual raw stock diameter; it will not be auto-changed.`);
  const approach = stock + C, safeZ = C;
  if (stockZ < 0) throw new Error('Material Stock Z cannot be negative.');
  let lines = [...machineHeader];

  if (opn === 'groove') {
    const gz = p[Math.min(1, p.length - 1)].z;
    const gx = Math.max(minX, stock - step);
    lines.push(`G00 X${fmt(stock + C)} Z${fmt(gz)}`, `G01 X${fmt(gx)}${feedTok()}`, `G01 X${fmt(Math.max(0, gx - step))}${feedTok()}`, `G00 X${fmt(stock + C)} Z${fmt(safeZ)}`);
  } else if (opn === 'partoff') {
    const z = p[p.length - 1].z;
    const gx = Math.max(0, minX - step);
    lines.push(`G00 X${fmt(stock + C)} Z${fmt(z)}`, `G01 X${fmt(gx)}${feedTok()}`, `G00 X${fmt(stock + C)} Z${fmt(safeZ)}`);
  } else if (opn === 'id-rough' || opn === 'id-finish') {
    const inner = Math.max(0, minX), start = Math.min(stock, Math.max(inner + C, inner + step));
    lines.push(`G00 X${fmt(start)} Z${fmt(safeZ)}`, `G01 Z0${feedTok()}`);
    p.forEach(q => lines.push(`G01 X${fmt(Math.max(0, q.x + fin))} Z${fmt(q.z)}${feedTok()}`));
    lines.push(`G00 X${fmt(start)} Z${fmt(safeZ)}`);
  } else if (opn === 'od-rough') {
    const endX = Math.max(0, minX + fin);
    const passes = [];
    for (let px = stock - step; px > endX + 1e-9; px -= step) {
      passes.push(Math.max(endX, Number(px.toFixed(6))));
    }
    if (!passes.length) passes.push(endX);

    const profile = p[0].z >= p[p.length - 1].z ? p.slice() : p.slice().reverse();
    const clearX = stock + C;
    for (const px of passes) {
      const path = roughPassPath(profile, px, stock, fin, clearX);
      if (!path.length) continue;

      for (const chain of path) {
        if (!chain.length) continue;
        const chainMaxX = Math.max(...chain.map(q => q.x));
        const localClearX = Math.min(clearX, chainMaxX + C);
        const a = chain[0];
        lines.push(`G00 X${fmt(localClearX)} Z${fmt(a.z)}`);
        lines.push(`G01 X${fmt(a.x)} Z${fmt(a.z)}${feedTok()}`);
        for (let i = 1; i < chain.length; i++) {
          const q = chain[i], prev = chain[i - 1];
          if (Math.abs(q.z - prev.z) > 1e-7 || Math.abs(q.x - prev.x) > 1e-7)
            lines.push(`G01 X${fmt(q.x)} Z${fmt(q.z)}${feedTok()}`);
        }
        const last = chain[chain.length - 1];
        lines.push(`G00 X${fmt(localClearX)} Z${fmt(last.z)}`);
        lines.push(`G00 X${fmt(localClearX)} Z${fmt(safeZ)}`);
      }
    }
  } else {
    // od-finish (default)
    let profileFinish = p[0].z >= p[p.length - 1].z ? p.slice() : p.slice().reverse();
    const tailstock = !!params.tailstock;
    if (tailstock && opn === 'od-finish') {
      const eps = 1e-6;
      let ts = 0, te = profileFinish.length - 1;
      while (ts <= te && profileFinish[ts].x <= eps) ts++;
      while (te >= ts && profileFinish[te].x <= eps) te--;
      if (te < ts) throw new Error('Tail Stock: the entire profile is at X0; there is no material above X0 to finish.');
      profileFinish = profileFinish.slice(ts, te + 1);
    }
    const reqPasses = Math.max(1, Math.round(Number(params.finishPasses) || 1));
    const finPasses = fin > 0 ? reqPasses : 1;
    for (let k = 1; k <= finPasses; k++) {
      const offset = fin > 0 ? Math.max(0, fin - k * (fin / finPasses)) : 0;
      const first = profileFinish[0];
      const startClearX = Math.min(maxX + C, first.x + offset + C);
      lines.push(`G00 X${fmt(startClearX)} Z${fmt(first.z)}`);
      lines.push(`G01 X${fmt(xOut(first.x + offset))} Z${fmt(first.z)}${feedTok()}`);
      for (let i = 1; i < profileFinish.length; i++) {
        const q = profileFinish[i];
        lines.push(`G01 X${fmt(xOut(q.x + offset))} Z${fmt(q.z)}${feedTok()}`);
      }
      const last = profileFinish[profileFinish.length - 1];
      const exitClearX = Math.min(maxX + C, last.x + offset + C);
      lines.push(`G00 X${fmt(exitClearX)} Z${fmt(last.z)}`);
      lines.push(`G00 X${fmt(exitClearX)} Z${fmt(safeZ)}`);
    }
  }

  lines.push(...machineFooter);
  const message = opn === 'od-rough'
    ? `Roughing generated from the X/Z profile with ${fmt(step)} mm X-depth per pass and ${fmt(fin)} mm finish allowance.`
    : 'Turning code generated from the selected operation.';
  return { code: lines.join('\n'), message };
}
// ---------------------------------------------------------------------
// THREAD PROGRAM GENERATOR (G32/G33) — moved here from the browser.
// This is the only place the pass-diameter / lead / G33 block-building
// logic lives now. The browser only sends the form inputs and displays
// whatever text this function returns.
// ---------------------------------------------------------------------

function tfmtX(v) { return Number(v).toFixed(2); }
function tfmtClearX(v) { return Number(v).toFixed(1); }
function tfmtZ(v) { return Number(v).toFixed(1); }

function validateThreadInputs(params) {
  const major = Number(params.major);
  const minor = Number(params.minor);
  const pitch = Number(params.pitch);
  const z1 = Number(params.z1);
  const z2 = Number(params.z2);
  const dep = Number(params.dep);
  const clear = Number(params.clear);
  const tool = Number(params.tool);
  const off = Number(params.off);

  if (![major, minor, pitch, z1, z2, dep, clear, tool, off].every(Number.isFinite)) {
    throw new Error('Please enter valid numeric values.');
  }
  if (major <= 0 || minor <= 0 || pitch <= 0 || dep <= 0 || clear < 0) {
    throw new Error('Diameter, pitch, cutting depth and clearance must be valid.');
  }
  if (major <= minor) throw new Error('Major Diameter must be greater than Minor Diameter.');
  if (z1 === z2) throw new Error('Start Z and End Z cannot be the same.');
  if (tool < 1 || tool > 99 || off < 1 || off > 99) throw new Error('Tool and offset must be 1-99.');
  return { major, minor, pitch, z1, z2, dep, clear, tool, off };
}

function threadPassDiameters(major, minor, dep) {
  const total = major - minor;
  const count = Math.ceil((total - 1e-9) / dep);
  const a = [];
  for (let i = 1; i <= count; i++) {
    const next = Math.min(total, i * dep);
    a.push(i === count ? Number(minor.toFixed(3)) : Number((major - next).toFixed(3)));
  }
  return a;
}

function generateThreadCode(params) {
  const v = validateThreadInputs(params);
  const spindle = (params.spindle === 'M03' || params.spindle === 'M04') ? params.spindle : 'M04';

  const passes = threadPassDiameters(v.major, v.minor, v.dep);
  const clearX = v.major + v.clear;
  const approachZ = v.z1 + 0.5;
  const retractZ = v.z2 - 0.5;
  const T = 'T' + String(v.tool).padStart(2, '0') + String(v.off).padStart(2, '0');
  const feed = Number(v.pitch).toFixed(2);

  let lines = ['%', 'N2', '', 'G0G28U0.0W0.0', '', T, '', 'G97S80' + spindle, '',
    'G0X' + tfmtClearX(clearX) + 'Z' + tfmtZ(approachZ) + 'M08'];

  for (let i = 0; i < passes.length; i++) {
    const x = passes[i];
    lines.push('',
      'G33X' + tfmtX(x) + 'Z' + tfmtZ(v.z1) + 'F' + feed,
      'G33Z' + tfmtZ(v.z2) + 'F' + feed,
      'G33X' + tfmtClearX(clearX) + 'Z' + tfmtZ(retractZ) + 'F' + feed);
    if (i < passes.length - 1) {
      lines.push('', 'G0X' + tfmtClearX(clearX) + 'Z' + tfmtZ(approachZ));
    }
  }
  lines.push('', 'G0G40X100.0Z50.0', 'G0G28U0.0W0.0M09', 'M05', 'M1', 'M30', '%');

  return {
    code: lines.join('\n'),
    message: 'Program generated in the CNCVEYRA reference G33 format. Verify before machining.',
    lead: feed + ' mm',
    starts: 1,
    passes: passes.length
  };
}

export { generateTurningCode, generateThreadCode };
