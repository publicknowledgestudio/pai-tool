// ── sketch.js ─────────────────────────────────────────────────
// Depends on: shared.js

let cw, ch;

function computeCanvasDimensions() {
  const ratio = ASPECT_RATIOS[state.aspectRatio];
  const wrap  = document.getElementById('canvas-wrap');
  const maxW  = wrap.clientWidth  - 60;
  const maxH  = wrap.clientHeight - 60;
  if (maxW / ratio.w * ratio.h <= maxH) {
    cw = Math.max(100, Math.floor(maxW));
    ch = Math.max(100, Math.floor(maxW / ratio.w * ratio.h));
  } else {
    ch = Math.max(100, Math.floor(maxH));
    cw = Math.max(100, Math.floor(maxH / ratio.h * ratio.w));
  }
  
  const artboard = document.getElementById('artboard');
  const overlays = document.getElementById('overlays');
  if (artboard) {
    artboard.style.width = cw + 'px';
    artboard.style.height = ch + 'px';
    // Base reference width from Figma = 2696
    const scale = cw / 2696;
    artboard.style.setProperty('--scale', scale);
    if (overlays) overlays.style.display = 'block';
  }
}

function renderBackground(p) {
  const [r,g,b] = hexToRgb(state.bgColor);
  p.background(r, g, b);
}

// ── computeRectFill ──────────────────────────────────────────
// Per-rectangle fill — each rect (including mirrored ones)
// independently samples the gradient.
//
// fillT       : 0–1, this rect's position in the distribution
// rx,ry,rw,rh : canvas-space coordinates of the rectangle
// alpha       : opacity float
// flip        : if true, reverse gradient within-rect direction
//               (used for mirrored rects so they don't look identical)
function computeRectFill(dc, fillT, rx, ry, rw, rh, alpha, flip) {
  const a       = alpha.toFixed(3);
  const isHDist = state.baseline === 'bottom' || state.baseline === 'top';
  const gradDir = state.gradientDirection;
  const sorted  = [...state.gradientStops].sort((a,b) => a.stop - b.stop);

  // Within-rect gradient when direction ⊥ to distribution axis
  const useRectGrad =
    ( isHDist && gradDir === 'vertical') ||
    (!isHDist && gradDir === 'horizontal');

  if (useRectGrad) {
    // Multi-stop gradient inside this rect, optionally flipped for mirrors
    let x0, y0, x1, y1;
    if (gradDir === 'vertical') {
      x0=rx; y0= flip ? ry+rh : ry;
      x1=rx; y1= flip ? ry     : ry+rh;
    } else { // horizontal
      x0= flip ? rx+rw : rx; y0=ry;
      x1= flip ? rx    : rx+rw; y1=ry;
    }
    const grad = dc.createLinearGradient(x0, y0, x1, y1);
    sorted.forEach(s => {
      const [r,g,b] = hexToRgb(s.color);
      grad.addColorStop(s.stop, `rgba(${r},${g},${b},${a})`);
    });
    return grad;
  } else {
    // Solid color — sample gradient at this rect's position index
    // (flip mirrors the sample position: 1-fillT)
    const t       = flip ? 1 - fillT : fillT;
    const [r,g,b] = sampleGradient(t, state.gradientStops);
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
  }
}

// ── renderRect ───────────────────────────────────────────────
// Sharp edges (dc.rect, no roundRect).
// Blur confined via clip — cannot bleed outside rect boundary.
function renderRect(p, rx, ry, rw, rh, fillStyle) {
  if (rw < 1 || rh < 1) return;
  const dc = p.drawingContext;
  dc.save();
  dc.beginPath();
  dc.rect(rx, ry, rw, rh);
  dc.clip();

  if (state.blur > 0) {
    dc.fillStyle = fillStyle;
    dc.fillRect(rx, ry, rw, rh);
    dc.filter     = `blur(${state.blur}px)`;
    dc.globalAlpha = 0.55;
    dc.fillStyle  = fillStyle;
    dc.fillRect(rx, ry, rw, rh);
    dc.globalAlpha = 1;
    dc.filter      = 'none';
  } else {
    dc.fillStyle = fillStyle;
    dc.fillRect(rx, ry, rw, rh);
  }
  dc.restore();
}

// ── renderCircle ─────────────────────────────────────────────
// Blur confined via clip for crisp edges
function renderCircle(p, cx, cy, radius, fillStyle) {
  if (radius < 0.5) return;
  const dc = p.drawingContext;
  dc.save();
  dc.beginPath();
  dc.arc(cx, cy, radius, 0, Math.PI * 2);
  dc.clip();

  if (state.blur > 0) {
    dc.fillStyle = fillStyle;
    dc.fill();
    dc.filter     = `blur(${state.blur}px)`;
    dc.globalAlpha = 0.55;
    dc.fillStyle  = fillStyle;
    dc.fill();
    dc.globalAlpha = 1;
    dc.filter      = 'none';
  } else {
    dc.fillStyle = fillStyle;
    dc.fill();
  }
  dc.restore();
}

// ── renderComposition ────────────────────────────────────────
function renderComposition(p) {
  const count   = Math.max(2, Math.floor(state.rectCount));
  const spacing = Math.max(0, state.spacing);
  const dir     = state.baseline;
  const sym     = state.symmetry;
  const mirror  = state.mirrorY;
  const dc      = p.drawingContext;

  // Horizontal baselines → bars are vertical, distributed L→R
  // Vertical baselines   → bars are horizontal, distributed T→B
  const isH = dir === 'bottom' || dir === 'top';

  // Slot size (width for vertical bars, height for horizontal bars)
  const totalSpacing = spacing * (count + 1);
  const axisDim  = isH ? cw : ch;     // dimension along distribution axis
  const slotSize = Math.max(2, (axisDim - totalSpacing) / count);

  // Maximum growth (extent fraction of the perpendicular dimension)
  // When mirroring: each side is capped at half so they don't overlap.
  const perpDim    = isH ? ch : cw;
  const maxGrowth  = perpDim * Math.min(state.extent, mirror ? 0.499 : 1.0);

  for (let i = 0; i < count; i++) {
    // ── Curve t (controls size distribution) ─────────────────
    let tCurve;
    if (sym) {
      const c = (count - 1) / 2;
      tCurve = 1 - (count > 1 ? Math.abs(i - c) / c : 0);
    } else {
      tCurve = count > 1 ? i / (count - 1) : 1;
    }
    tCurve = Math.max(0, Math.min(1, tCurve));
    let tVal = getCurveValue(tCurve, state.curveType);
    if (state.flipCurve) tVal = 1 - tVal;
    
    const growth = maxGrowth * Math.max(0.03, tVal);

    // ── Opacity (no edge fade) ───────────────────────────────
    const alpha = state.opacity;

    // ── Gradient position (0→1 across the distribution) ──────
    const fillT = count > 1 ? i / (count - 1) : 0;

    // ── Slot center along distribution axis ───────────────────
    const slotC = spacing + slotSize / 2 + i * (slotSize + spacing);

    // ── Build rect descriptors: primary + optional mirror ─────
    // Each rect also carries { flip } so the mirror can reverse
    // its gradient, making it a true mirror not a copy.
    const rects = [];

    if (dir === 'bottom') {
      // Primary: grows upward from bottom
      rects.push({ rx: slotC-slotSize/2, ry: ch-growth, rw: slotSize, rh: growth, flip: false });
      if (mirror)
        // Mirror: grows downward from top — genuinely offset, no overlap
        rects.push({ rx: slotC-slotSize/2, ry: 0,        rw: slotSize, rh: growth, flip: true });

    } else if (dir === 'top') {
      rects.push({ rx: slotC-slotSize/2, ry: 0,        rw: slotSize, rh: growth, flip: false });
      if (mirror)
        rects.push({ rx: slotC-slotSize/2, ry: ch-growth, rw: slotSize, rh: growth, flip: true });

    } else if (dir === 'left') {
      // Primary: grows rightward from left edge
      rects.push({ rx: 0,           ry: slotC-slotSize/2, rw: growth, rh: slotSize, flip: false });
      if (mirror)
        // Mirror: grows leftward from right edge — properly offset
        rects.push({ rx: cw-growth,  ry: slotC-slotSize/2, rw: growth, rh: slotSize, flip: true });

    } else { // right
      rects.push({ rx: cw-growth,  ry: slotC-slotSize/2, rw: growth, rh: slotSize, flip: false });
      if (mirror)
        rects.push({ rx: 0,          ry: slotC-slotSize/2, rw: growth, rh: slotSize, flip: true });
    }

    // ── Draw ─────────────────────────────────────────────────
    rects.forEach(({ rx, ry, rw, rh, flip }) => {
      const fill = computeRectFill(dc, fillT, rx, ry, rw, rh, alpha, flip);
      renderRect(p, rx, ry, rw, rh, fill);
    });
  }
}

// ── renderCircularComposition ────────────────────────────────
function renderCircularComposition(p) {
  const count = Math.max(2, Math.floor(state.circleCount));
  const maxD  = state.circleDiameter;
  const minD  = Math.max(10, maxD * 0.05); // The smallest foreground circle
  
  // Stagger extent allows circles to push away from the pure tangent anchor
  const maxStagger = ch * state.extent;
  const dc    = p.drawingContext;

  for (let i = 0; i < count; i++) {
    // i=0 is back (largest), i=count-1 is front (smallest)
    const fillT = count > 1 ? i / (count - 1) : 0;
    
    let curveVal = getCurveValue(fillT, state.curveType);
    if (state.flipCurve) curveVal = 1 - curveVal;

    // Use pure linear for diameter scale so we always see all layers nicely
    const currentD = maxD - (maxD - minD) * fillT;
    const R = currentD / 2;

    // The offset dictates how far inward from the anchor point the circle is pushed
    // If the curve is 'flat', curveVal = 1, uniform offset = concentric at that offset
    const offset = maxStagger * curveVal;

    // ── X / Y Coordinates ────────────────────────────────────
    let cx = cw / 2;
    let cy = ch / 2;
    const align = state.circleAlignment;

    if (align.includes('left'))        cx = R + offset;
    else if (align.includes('right'))  cx = cw - R - offset;

    if (align.includes('top'))         cy = R + offset;
    else if (align.includes('bottom')) cy = ch - R - offset;

    // ── Fill & Render ────────────────────────────────────────
    function moveAndDraw(px, py, flipX = false) {
      const vx = px - cw/2;
      const vy = py - ch/2;
      
      const dx = Math.abs(vx) < 0.5 ? 0 : Math.sign(vx);
      const dy = Math.abs(vy) < 0.5 ? 0 : Math.sign(vy);

      const finalX = px + dx * state.circleSpacingX;
      const finalY = py + dy * state.circleSpacingY;
      
      const alpha = state.opacity;
      const fill = computeRectFill(dc, fillT, finalX - R, finalY - R, currentD, currentD, alpha, flipX);
      renderCircle(p, finalX, finalY, R, fill);
    }

    moveAndDraw(cx, cy, false);

    // ── X & Y Symmetry Mirroring ─────────────────────────────
    if (state.circleMirrorXY) {
      const mx = cw - cx;
      const my = ch - cy;
      
      const notCenterH = Math.abs(cx - cw/2) > 0.5;
      const notCenterV = Math.abs(cy - ch/2) > 0.5;

      // X mirror
      if (notCenterH) moveAndDraw(mx, cy, true);
      // Y mirror
      if (notCenterV) moveAndDraw(cx, my, false);
      // XY mirror
      if (notCenterH && notCenterV) moveAndDraw(mx, my, true);
    }
  }
}

// ── p5 Instance ──────────────────────────────────────────────
const sketch = function(p) {
  p.setup = function() {
    computeCanvasDimensions();
    p.createCanvas(cw, ch).parent('p5-target');
    p.noLoop();
  };

  p.draw = function() {
    p.drawingContext.filter = 'none';
    renderBackground(p);
    
    let target = p;
    if (state.globalOpacity) {
      if (!window._pg || window._pg.width !== cw || window._pg.height !== ch) {
        window._pg = p.createGraphics(cw, ch);
      }
      target = window._pg;
      target.clear();
    }

    if (state.showGraphics) {
      const oldAlpha = state.opacity;
      if (state.globalOpacity) state.opacity = 1.0;

      if (state.compositionType === 'circular') {
        renderCircularComposition(target);
      } else {
        renderComposition(target);
      }

      if (state.globalOpacity) {
        state.opacity = oldAlpha;
        p.drawingContext.globalAlpha = state.opacity;
        p.image(target, 0, 0);
        p.drawingContext.globalAlpha = 1.0;
      }
    }
  };

  window._p5Redraw = () => p.redraw();
  window._p5Resize = () => {
    computeCanvasDimensions();
    p.resizeCanvas(cw, ch);
    p.redraw();
  };
};

new p5(sketch);
