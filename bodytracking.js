/**
 * bodytracking.js
 * =============================================================================
 * Webcam + MediaPipe PoseLandmarker wrapper for the "Graduation Gesture Game".
 *
 * Responsibilities (and ONLY these — rendering/game-state lives in game.js):
 *   1. Ask for the front (selfie) camera and pipe it into a <video>.
 *   2. Run MediaPipe Tasks Vision "PoseLandmarker" on every video frame.
 *   3. Mirror the landmarks so (0,0) is top-left of what the PLAYER sees on
 *      screen (i.e. it behaves like a mirror, not a raw camera feed).
 *   4. Turn the raw 33-point skeleton into two high level things game.js
 *      actually wants:
 *        - discrete GESTURE EVENTS: onClap(), onDanceStateChange(isDancing)
 *        - a friendly ANCHORS object (shoulders, head, wrists, hips, etc.)
 *          in normalized [0..1] space, so the caller can multiply by
 *          whatever canvas size it's using to position/scale/rotate the
 *          gown, cap and degree images so they track the player's body.
 *
 * Public API
 * -----------------------------------------------------------------------------
 *   const tracker = new BodyTracker(videoEl, {
 *     onUpdate:          (frame)  => {...}, // called every processed frame
 *     onClap:            ()      => {...}, // fired once per detected clap
 *     onDanceStateChange: (isDancing) => {...}, // fired on dance start/stop
 *     onCameraReady:     ()      => {...}, // camera + model are live
 *     onError:           (err)   => {...},
 *   });
 *
 *   await tracker.init();   // requests webcam + loads the pose model
 *   tracker.start();        // begins the detection loop
 *   tracker.stop();         // pauses detection loop (keeps camera open)
 *   tracker.destroy();      // stops loop + camera + frees the model
 *   tracker.resetClapState();     // let game.js force a clean slate between stages
 *   tracker.resetDanceState();
 *
 * "frame" object passed to onUpdate:
 *   {
 *     timestamp:     number,           // ms, performance.now()
 *     hasPerson:     boolean,          // false if nobody was detected
 *     landmarks:     Array|null,       // 33 mirrored {x,y,z,visibility} pts
 *     anchors:       Object|null,      // see buildAnchors() below
 *     danceEnergy:   number,           // 0..~1.5 smoothed motion energy
 *     isDancing:     boolean,
 *   }
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// MediaPipe Tasks Vision — loaded straight from jsDelivr, no build step needed.
// ---------------------------------------------------------------------------
import {
  FilesetResolver,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest";

const VISION_WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

// "lite" keeps this running smoothly in real time on an average laptop webcam.
// Swap to pose_landmarker_full.task if you want more accuracy and have GPU headroom.
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// ---------------------------------------------------------------------------
// MediaPipe Pose landmark indices (33-point BlazePose topology)
// ---------------------------------------------------------------------------
const PL = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 9,
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
// Tunable thresholds — nudge these if claps/dance feel too sensitive or numb.
// ---------------------------------------------------------------------------
const TUNING = {
  // Landmark smoothing (0 = frozen/no update, 1 = no smoothing/raw jitter).
  SMOOTHING_ALPHA: 0.55,

  // Minimum average visibility score to trust a landmark group at all.
  MIN_VISIBILITY: 0.35,

  // --- Clap detection ---
  // Wrist distance is normalized by shoulder width so it works at any distance
  // from the camera. "Apart" must be reached before a "together" can fire.
  CLAP_APART_RATIO: 1.15,
  CLAP_TOGETHER_RATIO: 0.55,
  CLAP_COOLDOWN_MS: 550,
  // Wrists must be raised above the hips (roughly chest-height clapping,
  // not arms hanging by the sides) to count.
  CLAP_MIN_HEIGHT_ABOVE_HIP: 0.03,

  // --- Dance detection ---
  // Rolling time window (ms) used to measure how much the body is moving.
  DANCE_WINDOW_MS: 900,
  DANCE_ENTER_ENERGY: 0.055,
  DANCE_EXIT_ENERGY: 0.03,
  // Must stay above/below the enter/exit threshold for this long to flip
  // state, so a single big jitter doesn't flicker isDancing on/off.
  DANCE_STATE_HOLD_MS: 350,
};

// ---------------------------------------------------------------------------
// Small math helpers (all operate on normalized {x,y} points)
// ---------------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const avgVisibility = (...pts) =>
  pts.reduce((s, p) => s + (p.visibility ?? 1), 0) / pts.length;

export class BodyTracker {
  /**
   * @param {HTMLVideoElement} videoElement - video element the webcam stream is attached to.
   * @param {Object} callbacks
   * @param {(frame: Object) => void} [callbacks.onUpdate]
   * @param {() => void} [callbacks.onClap]
   * @param {(isDancing: boolean) => void} [callbacks.onDanceStateChange]
   * @param {() => void} [callbacks.onCameraReady]
   * @param {(err: Error) => void} [callbacks.onError]
   */
  constructor(videoElement, callbacks = {}) {
    if (!videoElement) throw new Error("BodyTracker requires a <video> element.");
    this.video = videoElement;
    this.callbacks = callbacks;

    this.poseLandmarker = null;
    this.stream = null;
    this.running = false;
    this._rafId = null;

    // Smoothing memory
    this._smoothedLandmarks = null;

    // Clap state machine
    this._clapPhase = "apart"; // "apart" | "together" — "apart" means ready to detect the next clap
    this._lastClapTime = 0;

    // Dance state machine
    this._motionSamples = []; // { t, energy }
    this._isDancing = false;
    this._danceCandidateSince = null; // timestamp when we first crossed a threshold, awaiting HOLD_MS confirmation
    this._danceCandidateValue = null; // the boolean state we're trying to confirm

    this._prevLandmarksForMotion = null; // previous frame's smoothed landmarks, for motion-energy calc
  }

  /** Requests the camera and loads the MediaPipe pose model. Call once before start(). */
  async init() {
    try {
      const vision = await FilesetResolver.forVisionTasks(VISION_WASM_ROOT);
      this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: POSE_MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch (gpuErr) {
      // Some browsers/drivers choke on the GPU delegate — fall back to CPU.
      try {
        const vision = await FilesetResolver.forVisionTasks(VISION_WASM_ROOT);
        this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (cpuErr) {
        this._fail(cpuErr);
        throw cpuErr;
      }
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (camErr) {
      this._fail(camErr);
      throw camErr;
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;

    await new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.onloadeddata = () => resolve();
    });
    await this.video.play();

    this.callbacks.onCameraReady?.();
  }

  /** Begins the per-frame detection loop. */
  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this._processFrame();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  /** Pauses the detection loop. Camera stays attached; start() resumes cleanly. */
  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  /** Fully tears down camera + model. Call when leaving the game screen. */
  destroy() {
    this.stop();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.poseLandmarker) {
      this.poseLandmarker.close();
      this.poseLandmarker = null;
    }
  }

  /** Lets game.js force a fresh "ready to clap" state (e.g. entering a new stage). */
  resetClapState() {
    this._clapPhase = "apart";
    this._lastClapTime = 0;
  }

  /** Lets game.js force dancing back to "not dancing" (e.g. leaving the dance stage). */
  resetDanceState() {
    this._motionSamples = [];
    this._isDancing = false;
    this._danceCandidateSince = null;
    this._danceCandidateValue = null;
    this.callbacks.onDanceStateChange?.(false);
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  _fail(err) {
    console.error("[BodyTracker]", err);
    this.callbacks.onError?.(err);
  }

  _processFrame() {
    if (!this.poseLandmarker || this.video.readyState < 2) return;

    const timestamp = performance.now();
    let result;
    try {
      result = this.poseLandmarker.detectForVideo(this.video, timestamp);
    } catch (err) {
      this._fail(err);
      return;
    }

    const rawLandmarks = result?.landmarks?.[0] ?? null;

    if (!rawLandmarks) {
      // Nobody detected this frame — still emit an update so game.js can
      // show a "step into frame" hint, but skip gesture math.
      this.callbacks.onUpdate?.({
        timestamp,
        hasPerson: false,
        landmarks: null,
        anchors: null,
        danceEnergy: 0,
        isDancing: this._isDancing,
      });
      return;
    }

    // Mirror horizontally so it behaves like a mirror, not a raw camera feed.
    const mirrored = rawLandmarks.map((p) => ({
      x: 1 - p.x,
      y: p.y,
      z: p.z,
      visibility: p.visibility,
    }));

    const smoothed = this._smoothLandmarks(mirrored);
    this._smoothedLandmarks = smoothed;

    const anchors = this._buildAnchors(smoothed);
    const danceEnergy = this._updateMotionEnergy(smoothed, timestamp);

    this._detectClap(smoothed, anchors, timestamp);
    this._updateDanceState(danceEnergy, timestamp);

    this.callbacks.onUpdate?.({
      timestamp,
      hasPerson: true,
      landmarks: smoothed,
      anchors,
      danceEnergy,
      isDancing: this._isDancing,
    });
  }

  _smoothLandmarks(current) {
    const prev = this._smoothedLandmarks;
    const a = TUNING.SMOOTHING_ALPHA;
    if (!prev) return current;
    return current.map((p, i) => ({
      x: prev[i].x + (p.x - prev[i].x) * a,
      y: prev[i].y + (p.y - prev[i].y) * a,
      z: prev[i].z + (p.z - prev[i].z) * a,
      visibility: p.visibility,
    }));
  }

  /** Builds the friendly, game.js-facing anchor set from the 33 raw points. */
  _buildAnchors(lm) {
    const nose = lm[PL.NOSE];
    const leftEye = lm[PL.LEFT_EYE];
    const rightEye = lm[PL.RIGHT_EYE];
    const leftEar = lm[PL.LEFT_EAR];
    const rightEar = lm[PL.RIGHT_EAR];
    const leftShoulder = lm[PL.LEFT_SHOULDER];
    const rightShoulder = lm[PL.RIGHT_SHOULDER];
    const leftElbow = lm[PL.LEFT_ELBOW];
    const rightElbow = lm[PL.RIGHT_ELBOW];
    const leftWrist = lm[PL.LEFT_WRIST];
    const rightWrist = lm[PL.RIGHT_WRIST];
    const leftHip = lm[PL.LEFT_HIP];
    const rightHip = lm[PL.RIGHT_HIP];

    const shoulderMid = midpoint(leftShoulder, rightShoulder);
    const hipMid = midpoint(leftHip, rightHip);
    const shoulderWidth = dist(leftShoulder, rightShoulder);
    const headWidth = dist(leftEar, rightEar) || shoulderWidth * 0.45;
    const torsoHeight = dist(shoulderMid, hipMid);

    // Ears/nose only tell us roughly where the face is — the actual top of
    // the head (where a cap sits) is estimated a bit above the eye line,
    // scaled by head width so it works at any distance from the camera.
    const eyeMid = midpoint(leftEye, rightEye);
    const headTop = {
      x: eyeMid.x,
      y: eyeMid.y - headWidth * 1.35,
    };

    return {
      nose,
      leftEye,
      rightEye,
      leftEar,
      rightEar,
      leftShoulder,
      rightShoulder,
      shoulderMid,
      shoulderWidth,
      shoulderAngle: angle(leftShoulder, rightShoulder),
      leftElbow,
      rightElbow,
      leftWrist,
      rightWrist,
      leftHip,
      rightHip,
      hipMid,
      headTop,
      headWidth,
      torsoHeight,
    };
  }

  _detectClap(lm, anchors, timestamp) {
    const { leftShoulder, rightShoulder, leftWrist, rightWrist, hipMid, shoulderWidth } =
      anchors;

    if (shoulderWidth < 1e-4) return;
    if (avgVisibility(leftWrist, rightWrist, leftShoulder, rightShoulder) < TUNING.MIN_VISIBILITY) {
      return;
    }

    const wristDist = dist(leftWrist, rightWrist) / shoulderWidth;
    const avgWristY = (leftWrist.y + rightWrist.y) / 2;
    const raisedEnough = hipMid.y - avgWristY > TUNING.CLAP_MIN_HEIGHT_ABOVE_HIP;

    if (this._clapPhase === "apart") {
      if (wristDist <= TUNING.CLAP_TOGETHER_RATIO && raisedEnough) {
        const sinceLast = timestamp - this._lastClapTime;
        if (sinceLast > TUNING.CLAP_COOLDOWN_MS) {
          this._lastClapTime = timestamp;
          this._clapPhase = "together";
          this.callbacks.onClap?.();
        }
      }
    } else {
      // "together" — wait for hands to separate again before re-arming.
      if (wristDist >= TUNING.CLAP_APART_RATIO) {
        this._clapPhase = "apart";
      }
    }
  }

  /** Sum of frame-to-frame displacement across key limbs, averaged over a rolling time window. */
  _updateMotionEnergy(lm, timestamp) {
    const trackedIdx = [
      PL.LEFT_WRIST,
      PL.RIGHT_WRIST,
      PL.LEFT_ELBOW,
      PL.RIGHT_ELBOW,
      PL.LEFT_SHOULDER,
      PL.RIGHT_SHOULDER,
      PL.LEFT_HIP,
      PL.RIGHT_HIP,
      PL.NOSE,
    ];

    let frameEnergy = 0;
    if (this._prevLandmarksForMotion) {
      for (const idx of trackedIdx) {
        frameEnergy += dist(lm[idx], this._prevLandmarksForMotion[idx]);
      }
      frameEnergy /= trackedIdx.length;
    }
    this._prevLandmarksForMotion = lm;

    this._motionSamples.push({ t: timestamp, energy: frameEnergy });
    const cutoff = timestamp - TUNING.DANCE_WINDOW_MS;
    while (this._motionSamples.length && this._motionSamples[0].t < cutoff) {
      this._motionSamples.shift();
    }

    const total = this._motionSamples.reduce((s, e) => s + e.energy, 0);
    return this._motionSamples.length ? total / this._motionSamples.length : 0;
  }

  _updateDanceState(energy, timestamp) {
    const wantsDancing = this._isDancing
      ? energy > TUNING.DANCE_EXIT_ENERGY // stay dancing until it clearly drops
      : energy > TUNING.DANCE_ENTER_ENERGY; // need a clear rise to start

    if (wantsDancing === this._isDancing) {
      this._danceCandidateSince = null;
      this._danceCandidateValue = null;
      return;
    }

    if (this._danceCandidateValue !== wantsDancing) {
      this._danceCandidateValue = wantsDancing;
      this._danceCandidateSince = timestamp;
      return;
    }

    if (timestamp - this._danceCandidateSince >= TUNING.DANCE_STATE_HOLD_MS) {
      this._isDancing = wantsDancing;
      this._danceCandidateSince = null;
      this._danceCandidateValue = null;
      this.callbacks.onDanceStateChange?.(this._isDancing);
    }
  }
}
