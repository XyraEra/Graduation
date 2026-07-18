/**
 * game.js
 * =============================================================================
 * The conductor: turns BodyTracker's gesture events into the on-screen
 * ceremony (clap -> gown -> clap -> cap -> clap -> degree -> dance -> confetti),
 * draws the whole scene to one canvas (mirrored camera + fitted costume +
 * particles), and composes the downloadable "graduATE" Polaroid.
 *
 * Costume-fitting calibration below (GOWN_CAL / CAP_CAL / DEGREE_CAL) was
 * measured directly from Assets/*.png (alpha-channel bounding boxes, color
 * segmentation to separate the cap from its tassel, and PCA to find the
 * diploma's true tilt) rather than guessed — see the comments by each block.
 *
 * All body geometry (distances/angles used to size and rotate the costume)
 * is computed in on-screen PIXEL space, not MediaPipe's raw normalized
 * coordinates — normalized x and y are scaled by different reference
 * dimensions (frame width vs. height), so mixing them in one Euclidean
 * distance/angle would subtly warp under a non-square camera aspect ratio.
 * Converting to screen pixels first keeps every measurement isotropic.
 * =============================================================================
 */

import { BodyTracker } from "./bodytracking.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const els = {
  screenStart: document.getElementById("screen-start"),
  screenLoading: document.getElementById("screen-loading"),
  screenGame: document.getElementById("screen-game"),
  screenPhoto: document.getElementById("screen-photo"),
  screenError: document.getElementById("screen-error"),

  loadingMessage: document.getElementById("loading-message"),

  stage: document.getElementById("stage"),
  video: document.getElementById("webcam"),
  canvas: document.getElementById("game-canvas"),
  cameraFlash: document.getElementById("camera-flash"),

  promptText: document.getElementById("prompt-text"),
  promptHint: document.getElementById("prompt-hint"),
  stageProgress: document.getElementById("stage-progress"),
  noPersonHint: document.getElementById("no-person-hint"),

  btnStart: document.getElementById("btn-start"),
  btnRestart: document.getElementById("btn-restart"),
  btnPhoto: document.getElementById("btn-photo"),
  btnMute: document.getElementById("btn-mute"),
  btnRetry: document.getElementById("btn-retry"),
  btnRetake: document.getElementById("btn-retake"),
  btnDownload: document.getElementById("btn-download"),

  polaroidCanvas: document.getElementById("polaroid-canvas"),
  errorMessage: document.getElementById("error-message"),
};

const screensByName = {
  start: els.screenStart,
  loading: els.screenLoading,
  game: els.screenGame,
  photo: els.screenPhoto,
  error: els.screenError,
};

const dotEls = Array.from(els.stageProgress.querySelectorAll(".dot"));
const ctx = els.canvas.getContext("2d");

// ---------------------------------------------------------------------------
// Ceremony stages
// ---------------------------------------------------------------------------
const STAGES = ["gown", "cap", "degree", "dance"];

const STAGE_COPY = {
  gown: { prompt: "Clap!", hint: "Clap your hands to put on your gown" },
  cap: { prompt: "Clap again!", hint: "One more clap to drop your cap" },
  degree: { prompt: "Clap once more!", hint: "Clap to receive your degree" },
  dance: { prompt: "Dance!", hint: "Show us your moves — the confetti's waiting" },
};
const CELEBRATION_COPY = { prompt: "You did it! 🎓", hint: "Strike a pose and tap the camera to save it" };
const AWAITING_PERSON_COPY = { prompt: "Step into frame", hint: "Make sure your shoulders and hands are visible" };

// ---------------------------------------------------------------------------
// Asset paths (as supplied — folder "Assets", capitalized filenames)
// ---------------------------------------------------------------------------
const ASSET_PATHS = {
  gown: "Assets/Gown.png",
  cap: "Assets/Cap.png",
  degree: "Assets/Degree.png",
};

// ---------------------------------------------------------------------------
// Costume calibration — measured from the real PNGs (see project notes).
// Each *_CAL describes where, within the image's own square canvas, the
// "attach point" lives (as a 0..1 fraction), and how wide/long the relevant
// feature is, so we can compute the right scale + pivot for drawFittedImage.
// ---------------------------------------------------------------------------
const GOWN_CAL = {
  anchorXFraction: 0.5, // collar sits horizontally centered in the image
  anchorYFraction: 0.06, // collar/shoulder-line depth from the image's top edge
  shoulderSpanFraction: 0.334, // fabric width at that row, as a fraction of image width
};
const GOWN_WIDTH_MULTIPLIER = 1.08; // slight extra drape beyond bare shoulder width

const CAP_CAL = {
  anchorXFraction: 0.5,
  anchorYFraction: 0.5, // the underside "head opening" band, not the diamond top
  headOpeningWidthFraction: 0.452,
};
const CAP_WIDTH_MULTIPLIER = 1.25; // a cap sits a little proud of bare ear-to-ear width
const CROWN_OFFSET_MULTIPLIER = 1.05; // how far above the eye-line the crown sits, in head-widths

const DEGREE_CAL = {
  pivotXFraction: 0.678, // the ribbon/seal — a natural "grip" point
  pivotYFraction: 0.538,
  longAxisFraction: 0.96, // scroll length as a fraction of the image's own width
  intrinsicAngleRad: 1.8098, // the scroll's built-in tilt within its square canvas (~103.7deg)
};
const DEGREE_LENGTH_MULTIPLIER = 1.45; // relative to forearm length

// ---------------------------------------------------------------------------
// MediaPipe Pose landmark indices (local copy — see bodytracking.js)
// ---------------------------------------------------------------------------
const LM = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
};

// ---------------------------------------------------------------------------
// Particle / celebration tuning
// ---------------------------------------------------------------------------
const CONFETTI_RATE_PER_SEC = 26;
const CONFETTI_MAX = 260;
const BALLOON_INTERVAL_SEC = 0.85;
const BALLOON_MAX = 10;
const CAP_FALL_INTERVAL_SEC = 2.1;
const CAP_FALL_MAX = 6;
const DANCE_BURST_ENERGY = 0.09;
const DANCE_BURST_COOLDOWN_MS = 450;

const CONFETTI_COLORS = ["#d6a53a", "#f4cc63", "#b8862b", "#171018", "#171018"];
const BALLOON_COLORS = [
  { base: "#d6a53a", light: "#f6d98a" },
  { base: "#f4cc63", light: "#fde9b8" },
  { base: "#171018", light: "#3a3340" },
];

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------
let tracker = null;
let assets = null;
let latestFrame = null;
let personEverSeen = false;

let stageIndex = 0;
const costumeOn = { gown: false, cap: false, degree: false };
let gownAppearedAt = null;
let capAppearedAt = null;
let degreeAppearedAt = null;
let celebrationActive = false;

let muted = false;
let audioCtx = null;

let gameActive = false; // true only while the live game screen should render/track
let isStarting = false; // guards beginExperience() against re-entrant calls
let dpr = Math.min(window.devicePixelRatio || 1, 2);
let lastFrameTime = performance.now();
let lastDanceBurstTime = 0;

let sparkles = [];
let confetti = [];
let balloons = [];
let fallingCaps = [];
const spawnAccum = { confetti: 0, balloon: 0, cap: 0 };

// ---------------------------------------------------------------------------
// Small math / easing helpers
// ---------------------------------------------------------------------------
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function angleOf(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function easeOutBounce(t) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}
function animProgress(startTime, durationMs) {
  if (startTime == null) return 1;
  return clamp((performance.now() - startTime) / durationMs, 0, 1);
}
function cssSize() {
  return { w: els.canvas.width / dpr, h: els.canvas.height / dpr };
}

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(name) {
  for (const key in screensByName) {
    screensByName[key].classList.toggle("active", key === name);
  }
}

// ---------------------------------------------------------------------------
// Asset loading
// ---------------------------------------------------------------------------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

async function loadAssets() {
  const [gown, cap, degree] = await Promise.all([
    loadImage(ASSET_PATHS.gown),
    loadImage(ASSET_PATHS.cap),
    loadImage(ASSET_PATHS.degree),
  ]);
  return { gown, cap, degree };
}

// ---------------------------------------------------------------------------
// Canvas sizing & the mirrored "cover fit" camera mapping
// ---------------------------------------------------------------------------
function resizeCanvasToStage() {
  const rect = els.stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  els.canvas.width = Math.round(w * dpr);
  els.canvas.height = Math.round(h * dpr);
  els.canvas.style.width = w + "px";
  els.canvas.style.height = h + "px";
}

/** Object-fit:cover math — maps a vw x vh source onto a cw x ch destination, centered. */
function computeCoverFit(cw, ch, vw, vh) {
  const scale = Math.max(cw / vw, ch / vh);
  const drawW = vw * scale;
  const drawH = vh * scale;
  return {
    offsetX: (cw - drawW) / 2,
    offsetY: (ch - drawH) / 2,
    drawW,
    drawH,
  };
}

/** Maps a normalized (0..1) MediaPipe point into on-screen pixel space via the current cover fit. */
function toScreen(p, fit) {
  return { x: fit.offsetX + p.x * fit.drawW, y: fit.offsetY + p.y * fit.drawH };
}

/** Crops `source` (any canvas) to cover a destW x destH box inside destCtx, centered. Reused for both the live preview and the exported Polaroid. */
function drawCoverFitCanvasSource(destCtx, source, destW, destH, destOffsetX = 0, destOffsetY = 0) {
  const sw = source.width;
  const sh = source.height;
  const scale = Math.max(destW / sw, destH / sh);
  const drawW = sw * scale;
  const drawH = sh * scale;
  const ox = destOffsetX + (destW - drawW) / 2;
  const oy = destOffsetY + (destH - drawH) / 2;
  destCtx.drawImage(source, ox, oy, drawW, drawH);
}

// ---------------------------------------------------------------------------
// Body geometry — all computed in screen-pixel space (see file header note)
// ---------------------------------------------------------------------------
function computeBody(landmarks, fit) {
  const at = (idx) => toScreen(landmarks[idx], fit);

  const leftShoulder = at(LM.LEFT_SHOULDER);
  const rightShoulder = at(LM.RIGHT_SHOULDER);
  const leftHip = at(LM.LEFT_HIP);
  const rightHip = at(LM.RIGHT_HIP);
  const leftWrist = at(LM.LEFT_WRIST);
  const rightWrist = at(LM.RIGHT_WRIST);
  const leftElbow = at(LM.LEFT_ELBOW);
  const rightElbow = at(LM.RIGHT_ELBOW);
  const leftEar = at(LM.LEFT_EAR);
  const rightEar = at(LM.RIGHT_EAR);
  const leftEye = at(LM.LEFT_EYE);
  const rightEye = at(LM.RIGHT_EYE);

  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const eyeMid = midpoint(leftEye, rightEye);
  const shoulderWidth = Math.max(dist(leftShoulder, rightShoulder), 1);
  const headWidth = Math.max(dist(leftEar, rightEar), shoulderWidth * 0.4);
  const shoulderAngle = angleOf(leftShoulder, rightShoulder);
  const headAngle = angleOf(leftEye, rightEye);
  const crownPoint = { x: eyeMid.x, y: eyeMid.y - headWidth * CROWN_OFFSET_MULTIPLIER };

  return {
    leftShoulder, rightShoulder, shoulderMid, shoulderWidth, shoulderAngle,
    leftHip, rightHip,
    leftWrist, rightWrist, leftElbow, rightElbow,
    headWidth, headAngle, crownPoint,
  };
}

// ---------------------------------------------------------------------------
// Costume rendering
// ---------------------------------------------------------------------------
function drawFittedImage(destCtx, img, opts) {
  if (!img || !img.complete || !img.naturalWidth) return;
  const { x, y, angle, scale, pivotXFrac, pivotYFrac, alpha = 1, shadow = false } = opts;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  destCtx.save();
  destCtx.globalAlpha = clamp(alpha, 0, 1);
  destCtx.translate(x, y);
  destCtx.rotate(angle);
  if (shadow) {
    destCtx.shadowColor = "rgba(0,0,0,0.4)";
    destCtx.shadowBlur = 16;
    destCtx.shadowOffsetY = 8;
  }
  destCtx.drawImage(img, -w * pivotXFrac, -h * pivotYFrac, w, h);
  destCtx.restore();
}

function drawGown(destCtx, body, img) {
  const t = easeOutCubic(animProgress(gownAppearedAt, 550));
  const growth = 0.85 + 0.15 * t;
  const targetSpan = body.shoulderWidth * GOWN_WIDTH_MULTIPLIER * growth;
  const scale = targetSpan / (img.naturalWidth * GOWN_CAL.shoulderSpanFraction);
  drawFittedImage(destCtx, img, {
    x: body.shoulderMid.x,
    y: body.shoulderMid.y,
    angle: body.shoulderAngle,
    scale,
    pivotXFrac: GOWN_CAL.anchorXFraction,
    pivotYFrac: GOWN_CAL.anchorYFraction,
    alpha: t,
    shadow: true,
  });
}

function drawCapAnimated(destCtx, body, img) {
  const raw = animProgress(capAppearedAt, 700);
  const bounce = easeOutBounce(raw);
  const fallDistance = body.headWidth * 2.4;
  const yOffset = -fallDistance * (1 - bounce);
  const wobble = (1 - bounce) * 0.6;
  const targetWidth = body.headWidth * CAP_WIDTH_MULTIPLIER;
  const scale = targetWidth / (img.naturalWidth * CAP_CAL.headOpeningWidthFraction);
  drawFittedImage(destCtx, img, {
    x: body.crownPoint.x,
    y: body.crownPoint.y + yOffset,
    angle: body.headAngle + wobble,
    scale,
    pivotXFrac: CAP_CAL.anchorXFraction,
    pivotYFrac: CAP_CAL.anchorYFraction,
    alpha: 1,
    shadow: true,
  });
}

function drawDegreeAnimated(destCtx, body, img) {
  const raw = animProgress(degreeAppearedAt, 550);
  const pop = Math.max(0, easeOutBack(raw));
  const forearmLen = Math.max(dist(body.rightElbow, body.rightWrist), body.shoulderWidth * 0.35);
  const forearmAngle = angleOf(body.rightElbow, body.rightWrist);
  const targetLength = forearmLen * DEGREE_LENGTH_MULTIPLIER;
  const scale = (pop * targetLength) / (img.naturalWidth * DEGREE_CAL.longAxisFraction);
  drawFittedImage(destCtx, img, {
    x: body.rightWrist.x,
    y: body.rightWrist.y,
    angle: forearmAngle - DEGREE_CAL.intrinsicAngleRad,
    scale,
    pivotXFrac: DEGREE_CAL.pivotXFraction,
    pivotYFrac: DEGREE_CAL.pivotYFraction,
    alpha: Math.min(1, raw * 3),
    shadow: true,
  });
}

function drawCostumes(destCtx, body) {
  if (costumeOn.gown) drawGown(destCtx, body, assets.gown);
  if (costumeOn.degree) drawDegreeAnimated(destCtx, body, assets.degree);
  if (costumeOn.cap) drawCapAnimated(destCtx, body, assets.cap);
}

// ---------------------------------------------------------------------------
// Particles — sparkles (gesture flourish), confetti, balloons, falling caps
// ---------------------------------------------------------------------------
function spawnSparkleBurst(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 160;
    sparkles.push({
      x, y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 40,
      life: 0,
      maxLife: 500 + Math.random() * 300,
      size: 3 + Math.random() * 4,
      color,
    });
  }
  if (sparkles.length > 200) sparkles.splice(0, sparkles.length - 200);
}
function updateSparkles(dt) {
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const s = sparkles[i];
    s.vy += 260 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life += dt * 1000;
    if (s.life > s.maxLife) sparkles.splice(i, 1);
  }
}
function drawSparkles(destCtx) {
  for (const s of sparkles) {
    const t = s.life / s.maxLife;
    destCtx.save();
    destCtx.globalAlpha = Math.max(0, 1 - t);
    destCtx.fillStyle = s.color;
    destCtx.beginPath();
    destCtx.arc(s.x, s.y, Math.max(0.5, s.size * (1 - t * 0.4)), 0, Math.PI * 2);
    destCtx.fill();
    destCtx.restore();
  }
}

function spawnConfettiPieces(n, stageSize) {
  for (let i = 0; i < n; i++) {
    confetti.push({
      baseX: Math.random() * stageSize.w,
      x: 0,
      y: -20 - Math.random() * 60,
      vy: 70 + Math.random() * 80,
      swayPhase: Math.random() * Math.PI * 2,
      swaySpeed: 1.2 + Math.random() * 1.2,
      swayAmp: 15 + Math.random() * 25,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 3,
      size: 6 + Math.random() * 8,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      shape: Math.random() < 0.5 ? "rect" : "circle",
    });
  }
  if (confetti.length > CONFETTI_MAX) confetti.splice(0, confetti.length - CONFETTI_MAX);
}
function updateConfetti(dt, stageSize) {
  for (let i = confetti.length - 1; i >= 0; i--) {
    const p = confetti[i];
    p.swayPhase += p.swaySpeed * dt;
    p.y += p.vy * dt;
    p.x = p.baseX + Math.sin(p.swayPhase) * p.swayAmp;
    p.rot += p.rotSpeed * dt;
    if (p.y > stageSize.h + 30) confetti.splice(i, 1);
  }
}
function drawConfetti(destCtx) {
  for (const p of confetti) {
    destCtx.save();
    destCtx.translate(p.x, p.y);
    destCtx.rotate(p.rot);
    destCtx.fillStyle = p.color;
    if (p.shape === "rect") {
      destCtx.fillRect(-p.size / 2, -p.size / 5, p.size, p.size / 2.5);
    } else {
      destCtx.beginPath();
      destCtx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
      destCtx.fill();
    }
    destCtx.restore();
  }
}

function spawnBalloon(stageSize) {
  const c = BALLOON_COLORS[(Math.random() * BALLOON_COLORS.length) | 0];
  balloons.push({
    baseX: 40 + Math.random() * Math.max(10, stageSize.w - 80),
    x: 0,
    y: stageSize.h + 60,
    vy: -(40 + Math.random() * 30),
    swayPhase: Math.random() * Math.PI * 2,
    swaySpeed: 0.6 + Math.random() * 0.5,
    swayAmp: 18 + Math.random() * 20,
    size: 46 + Math.random() * 26,
    color: c.base,
    light: c.light,
  });
}
function updateBalloons(dt, stageSize) {
  for (let i = balloons.length - 1; i >= 0; i--) {
    const p = balloons[i];
    p.swayPhase += p.swaySpeed * dt;
    p.y += p.vy * dt;
    p.x = p.baseX + Math.sin(p.swayPhase) * p.swayAmp;
    if (p.y < -100) balloons.splice(i, 1);
  }
}
function drawBalloons(destCtx) {
  for (const p of balloons) {
    const w = p.size;
    const h = p.size * 1.2;
    destCtx.save();
    destCtx.translate(p.x, p.y);

    destCtx.strokeStyle = "rgba(244,236,216,0.5)";
    destCtx.lineWidth = 1.5;
    destCtx.beginPath();
    destCtx.moveTo(0, h / 2);
    destCtx.quadraticCurveTo(8, h / 2 + 20, 0, h / 2 + 40);
    destCtx.stroke();

    const grad = destCtx.createRadialGradient(-w * 0.2, -h * 0.25, w * 0.08, 0, 0, w * 0.7);
    grad.addColorStop(0, p.light);
    grad.addColorStop(1, p.color);
    destCtx.fillStyle = grad;
    destCtx.beginPath();
    destCtx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    destCtx.fill();

    destCtx.fillStyle = p.color;
    destCtx.beginPath();
    destCtx.moveTo(-5, h / 2 - 2);
    destCtx.lineTo(5, h / 2 - 2);
    destCtx.lineTo(0, h / 2 + 8);
    destCtx.closePath();
    destCtx.fill();

    destCtx.restore();
  }
}

function spawnFallingCap(stageSize) {
  fallingCaps.push({
    x: Math.random() * stageSize.w,
    y: -60,
    vy: 90 + Math.random() * 60,
    vx: (Math.random() - 0.5) * 30,
    rot: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 2.4,
    size: 34 + Math.random() * 22,
  });
}
function updateFallingCaps(dt, stageSize) {
  for (let i = fallingCaps.length - 1; i >= 0; i--) {
    const p = fallingCaps[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.rotSpeed * dt;
    if (p.y > stageSize.h + 60) fallingCaps.splice(i, 1);
  }
}
function drawFallingCaps(destCtx) {
  const img = assets?.cap;
  if (!img || !img.complete) return;
  for (const p of fallingCaps) {
    const scale = p.size / img.naturalWidth;
    destCtx.save();
    destCtx.globalAlpha = 0.95;
    destCtx.translate(p.x, p.y);
    destCtx.rotate(p.rot);
    destCtx.drawImage(img, (-img.naturalWidth * scale) / 2, (-img.naturalHeight * scale) / 2, img.naturalWidth * scale, img.naturalHeight * scale);
    destCtx.restore();
  }
}

function updateParticleSpawning(dt, stageSize) {
  if (!celebrationActive) return;

  spawnAccum.confetti += dt;
  const confettiInterval = 1 / CONFETTI_RATE_PER_SEC;
  while (spawnAccum.confetti > confettiInterval) {
    spawnAccum.confetti -= confettiInterval;
    spawnConfettiPieces(1, stageSize);
  }

  spawnAccum.balloon += dt;
  if (spawnAccum.balloon > BALLOON_INTERVAL_SEC && balloons.length < BALLOON_MAX) {
    spawnAccum.balloon = 0;
    spawnBalloon(stageSize);
  }

  spawnAccum.cap += dt;
  if (spawnAccum.cap > CAP_FALL_INTERVAL_SEC && fallingCaps.length < CAP_FALL_MAX) {
    spawnAccum.cap = 0;
    spawnFallingCap(stageSize);
  }
}

// ---------------------------------------------------------------------------
// Main render loop — always ticking; does real work only while gameActive
// ---------------------------------------------------------------------------
function renderLoop(now) {
  requestAnimationFrame(renderLoop);

  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  if (!gameActive) return;

  const stageSize = cssSize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, stageSize.w, stageSize.h);

  const video = tracker?.video;
  if (video && video.videoWidth) {
    const fit = computeCoverFit(stageSize.w, stageSize.h, video.videoWidth, video.videoHeight);

    // Mirrored camera frame (flip scoped locally; overlay math below needs no
    // flip of its own since bodytracking.js's landmarks are already mirrored).
    ctx.save();
    ctx.translate(stageSize.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, fit.offsetX, fit.offsetY, fit.drawW, fit.drawH);
    ctx.restore();

    if (latestFrame && latestFrame.hasPerson && latestFrame.landmarks && assets) {
      const body = computeBody(latestFrame.landmarks, fit);
      drawCostumes(ctx, body);
    }
  }

  updateParticleSpawning(dt, stageSize);
  updateSparkles(dt);
  updateConfetti(dt, stageSize);
  updateBalloons(dt, stageSize);
  updateFallingCaps(dt, stageSize);

  drawFallingCaps(ctx);
  drawBalloons(ctx);
  drawConfetti(ctx);
  drawSparkles(ctx);
}

// ---------------------------------------------------------------------------
// Gesture -> game state
// ---------------------------------------------------------------------------
function grantSparklePoint(stage) {
  const stageSize = cssSize();
  let x = stageSize.w / 2;
  let y = stageSize.h / 2;
  if (latestFrame?.landmarks && tracker?.video?.videoWidth) {
    const fit = computeCoverFit(stageSize.w, stageSize.h, tracker.video.videoWidth, tracker.video.videoHeight);
    const body = computeBody(latestFrame.landmarks, fit);
    if (stage === "gown") ({ x, y } = body.shoulderMid);
    else if (stage === "cap") ({ x, y } = body.crownPoint);
    else if (stage === "degree") ({ x, y } = body.rightWrist);
  }
  spawnSparkleBurst(x, y, "#f4cc63", 16);
}

function handleClap() {
  const stage = STAGES[stageIndex];
  if (stage === "dance") return; // dance stage advances on movement, not claps

  if (stage === "gown") { costumeOn.gown = true; gownAppearedAt = performance.now(); }
  else if (stage === "cap") { costumeOn.cap = true; capAppearedAt = performance.now(); }
  else if (stage === "degree") { costumeOn.degree = true; degreeAppearedAt = performance.now(); }

  grantSparklePoint(stage);
  playClapChime();
  advanceStage();
}

function advanceStage() {
  stageIndex = Math.min(stageIndex + 1, STAGES.length - 1);
  updateStageUI();
  if (STAGES[stageIndex] === "dance") {
    tracker?.resetDanceState();
  }
}

function handleDanceStateChange(isDancing) {
  if (STAGES[stageIndex] !== "dance") return;
  if (isDancing && !celebrationActive) {
    startCelebration();
  }
}

function startCelebration() {
  celebrationActive = true;
  updateStageUI();
  els.btnPhoto.hidden = false;
  playCheer();
  const { w, h } = cssSize();
  spawnSparkleBurst(w / 2, h / 2, "#f4cc63", 40);
}

function updateStageUI() {
  if (!personEverSeen) {
    els.promptText.textContent = AWAITING_PERSON_COPY.prompt;
    els.promptHint.textContent = AWAITING_PERSON_COPY.hint;
  } else {
    const copy = celebrationActive ? CELEBRATION_COPY : STAGE_COPY[STAGES[stageIndex]];
    els.promptText.textContent = copy.prompt;
    els.promptHint.textContent = copy.hint;
  }

  els.stageProgress.style.setProperty("--progress", celebrationActive ? 1 : stageIndex / STAGES.length);

  for (const dot of dotEls) {
    const i = STAGES.indexOf(dot.dataset.stage);
    dot.classList.toggle("done", celebrationActive || i < stageIndex);
    dot.classList.toggle("active", !celebrationActive && i === stageIndex);
  }
}

function handleTrackerUpdate(frame) {
  latestFrame = frame;

  if (frame.hasPerson && !personEverSeen) {
    personEverSeen = true;
    updateStageUI();
  }

  els.noPersonHint.classList.toggle("visible", !frame.hasPerson && !celebrationActive);

  if (celebrationActive && frame.hasPerson) {
    const now = performance.now();
    if (frame.danceEnergy > DANCE_BURST_ENERGY && now - lastDanceBurstTime > DANCE_BURST_COOLDOWN_MS) {
      lastDanceBurstTime = now;
      spawnConfettiPieces(14, cssSize());
    }
  }
}

function handleTrackerError(err) {
  console.error("[game] tracker error", err);
  showError(describeCameraError(err));
}

// ---------------------------------------------------------------------------
// Game state reset (restart button / retry)
// ---------------------------------------------------------------------------
function resetGameState() {
  stageIndex = 0;
  costumeOn.gown = false;
  costumeOn.cap = false;
  costumeOn.degree = false;
  gownAppearedAt = null;
  capAppearedAt = null;
  degreeAppearedAt = null;
  celebrationActive = false;
  personEverSeen = false;

  sparkles = [];
  confetti = [];
  balloons = [];
  fallingCaps = [];
  spawnAccum.confetti = 0;
  spawnAccum.balloon = 0;
  spawnAccum.cap = 0;

  els.btnPhoto.hidden = true;
  els.noPersonHint.classList.remove("visible");

  tracker?.resetClapState();
  tracker?.resetDanceState();
  updateStageUI();
}

// ---------------------------------------------------------------------------
// Audio — tiny synthesized cues via Web Audio API, no external files
// ---------------------------------------------------------------------------
function ensureAudio() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  } catch (e) {
    audioCtx = null;
  }
}

function playTone(freq, duration, type, startGain, delay = 0) {
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(startGain, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playClapChime() {
  playTone(660, 0.09, "triangle", 0.16, 0);
  playTone(880, 0.14, "triangle", 0.14, 0.06);
}

function playCheer() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => playTone(f, 0.5, "triangle", 0.1, i * 0.05));
}

function playShutter() {
  if (!audioCtx || muted) return;
  const bufferSize = Math.floor(audioCtx.sampleRate * 0.06);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  noise.connect(gain).connect(audioCtx.destination);
  noise.start();
}

// ---------------------------------------------------------------------------
// Photo capture — Polaroid preview (on screen) + a separate, fully
// self-contained export image (cream border + caption baked in) for download.
// ---------------------------------------------------------------------------
const POLAROID_EXPORT_PHOTO_SIZE = 900;
const POLAROID_EXPORT_BORDER = 60;
const POLAROID_EXPORT_BOTTOM = 220;

async function ensureFontsLoaded() {
  try {
    await Promise.all([document.fonts.load("600 62px Fraunces"), document.fonts.load("700 78px Caveat")]);
    await document.fonts.ready;
  } catch (e) {
    // Non-fatal — export just falls back to the browser's default font.
  }
}

function renderPolaroidPreview() {
  const rect = els.polaroidCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  els.polaroidCanvas.width = w;
  els.polaroidCanvas.height = h;
  const pctx = els.polaroidCanvas.getContext("2d");
  drawCoverFitCanvasSource(pctx, els.canvas, w, h);
}

async function renderPolaroidExport() {
  await ensureFontsLoaded();

  const W = POLAROID_EXPORT_PHOTO_SIZE + POLAROID_EXPORT_BORDER * 2;
  const H = POLAROID_EXPORT_PHOTO_SIZE + POLAROID_EXPORT_BORDER * 2 + POLAROID_EXPORT_BOTTOM;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = W;
  exportCanvas.height = H;
  const ectx = exportCanvas.getContext("2d");

  ectx.fillStyle = "#f4ecd8";
  ectx.fillRect(0, 0, W, H);

  ectx.save();
  ectx.beginPath();
  ectx.rect(POLAROID_EXPORT_BORDER, POLAROID_EXPORT_BORDER, POLAROID_EXPORT_PHOTO_SIZE, POLAROID_EXPORT_PHOTO_SIZE);
  ectx.clip();
  drawCoverFitCanvasSource(ectx, els.canvas, POLAROID_EXPORT_PHOTO_SIZE, POLAROID_EXPORT_PHOTO_SIZE, POLAROID_EXPORT_BORDER, POLAROID_EXPORT_BORDER);
  ectx.restore();

  ectx.strokeStyle = "rgba(0,0,0,0.15)";
  ectx.lineWidth = 2;
  ectx.strokeRect(POLAROID_EXPORT_BORDER, POLAROID_EXPORT_BORDER, POLAROID_EXPORT_PHOTO_SIZE, POLAROID_EXPORT_PHOTO_SIZE);

  const baseline = POLAROID_EXPORT_BORDER * 2 + POLAROID_EXPORT_PHOTO_SIZE + POLAROID_EXPORT_BOTTOM * 0.62;
  ectx.font = "600 62px Fraunces, Georgia, serif";
  const part1 = "gradu";
  const part2 = "ATE";
  const w1 = ectx.measureText(part1).width;
  ectx.font = "700 78px Caveat, cursive";
  const w2 = ectx.measureText(part2).width;
  let cx = W / 2 - (w1 + w2) / 2;

  ectx.textAlign = "left";
  ectx.textBaseline = "alphabetic";
  ectx.font = "600 62px Fraunces, Georgia, serif";
  ectx.fillStyle = "#3a2f1d";
  ectx.fillText(part1, cx, baseline);
  cx += w1;
  ectx.font = "700 78px Caveat, cursive";
  ectx.fillStyle = "#a1793a";
  ectx.fillText(part2, cx, baseline);

  return exportCanvas.toDataURL("image/png");
}

async function capturePhoto() {
  els.cameraFlash.classList.add("flash-active");
  els.cameraFlash.addEventListener("animationend", () => els.cameraFlash.classList.remove("flash-active"), { once: true });
  playShutter();

  renderPolaroidPreview();
  const dataUrl = await renderPolaroidExport();
  els.btnDownload.href = dataUrl;

  gameActive = false;
  tracker?.stop();
  showScreen("photo");
}

// ---------------------------------------------------------------------------
// Camera / model bring-up and error messaging
// ---------------------------------------------------------------------------
function describeCameraError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera access was blocked. Please allow camera permissions for this site and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "We couldn't find a camera on this device.";
  }
  if (name === "NotReadableError") {
    return "Your camera seems to be in use by another app. Close it and try again.";
  }
  return "Something went wrong starting the camera or motion tracking. Please try again.";
}

function showError(message) {
  els.errorMessage.textContent = message;
  gameActive = false;
  tracker?.stop();
  showScreen("error");
}

async function beginExperience() {
  if (isStarting) return; // guards against a double-click firing two overlapping camera requests
  isStarting = true;

  showScreen("loading");
  els.loadingMessage.textContent = "Waking up your camera & loading motion tracking\u2026";
  ensureAudio();
  if (audioCtx?.state === "suspended") audioCtx.resume();

  try {
    if (!assets) assets = await loadAssets();
  } catch (err) {
    showError("We couldn't load the costume artwork. Make sure the Assets folder sits next to index.html.");
    isStarting = false;
    return;
  }

  resizeCanvasToStage();

  // Always init() on a fresh tracker instance — reusing one across a retry
  // would call init() twice on the same object, loading a second pose model
  // and requesting a second camera stream without releasing the first.
  if (tracker) tracker.destroy();
  tracker = new BodyTracker(els.video, {
    onUpdate: handleTrackerUpdate,
    onClap: handleClap,
    onDanceStateChange: handleDanceStateChange,
    onError: handleTrackerError,
  });

  try {
    await tracker.init();
  } catch (err) {
    showError(describeCameraError(err));
    isStarting = false;
    return;
  }

  resetGameState();
  tracker.start();
  gameActive = true;
  isStarting = false;
  showScreen("game");
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
els.btnStart.addEventListener("click", beginExperience);
els.btnRetry.addEventListener("click", beginExperience);

els.btnRestart.addEventListener("click", () => {
  resetGameState();
});

els.btnPhoto.addEventListener("click", capturePhoto);

els.btnRetake.addEventListener("click", () => {
  tracker?.start();
  gameActive = true;
  showScreen("game");
});

els.btnMute.addEventListener("click", () => {
  muted = !muted;
  els.btnMute.setAttribute("aria-pressed", String(muted));
});

window.addEventListener("resize", resizeCanvasToStage);
window.addEventListener("orientationchange", resizeCanvasToStage);

document.addEventListener("visibilitychange", () => {
  if (!tracker) return;
  if (document.hidden) {
    tracker.stop();
  } else if (gameActive) {
    tracker.start();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
resizeCanvasToStage();
updateStageUI();
requestAnimationFrame(renderLoop);
