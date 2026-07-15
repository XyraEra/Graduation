/**
 * BodyTracking Manager
 * Wraps MediaPipe Pose to provide custom gesture events (clapping, dancing)
 * and real-time tracking metrics for garment auto-fitting.
 */
class BodyTracker {
    constructor(videoElement, onResultsCallback) {
        this.video = videoElement;
        this.onResults = onResultsCallback;
        this.pose = null;
        this.isTracking = false;
        
        // Gesture analysis buffers
        this.lastClapTime = 0;
        this.clapCooldown = 800; // ms
        this.danceHistory = [];
        this.danceWindowSize = 30; // ~1 second of frames
        
        this.init();
    }

    init() {
        // Initialize MediaPipe Pose
       init() ;{
    // Force absolute paths to CDN compiled assets so local directory security rules don't block WASM compilation
    this.pose = new Pose({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@${Pose.VERSION}/${file}`;
        }
    });

    this.pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        smoothSegmentation: false,
        minDetectionConfidence: 0.5, // Slightly lowered for faster initial lock-on
        minTrackingConfidence: 0.5
    });

    this.pose.onResults((results) => {
        this.processGestureMetrics(results);
        if (this.onResults) {
            this.onResults(results);
        }
    });
} }

    async start() {
        this.isTracking = true;
        const camera = new Camera(this.video, {
            onFrame: async () => {
                if (this.isTracking) {
                    await this.pose.send({ image: this.video });
                }
            },
            width: 1280,
            height: 720
        });
        return camera.start();
    }

    stop() {
        this.isTracking = false;
    }

    processGestureMetrics(results) {
        if (!results.poseLandmarks) return;

        const landmarks = results.poseLandmarks;
        
        // Keypoints definitions
        const leftWrist = landmarks[15];
        const rightWrist = landmarks[16];
        const leftShoulder = landmarks[11];
        const rightShoulder = landmarks[12];
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];

        // 1. CLAP DETECTION (Proximity of wrists + low acceleration boundary)
        if (leftWrist && rightWrist && leftWrist.visibility > 0.5 && rightWrist.visibility > 0.5) {
            const dx = leftWrist.x - rightWrist.x;
            const dy = leftWrist.y - rightWrist.y;
            const dz = leftWrist.z - rightWrist.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

            const currentTime = Date.now();
            // Trigger if hands meet closely and cooldown has passed
            if (distance < 0.08 && (currentTime - this.lastClapTime > this.clapCooldown)) {
                this.lastClapTime = currentTime;
                this.dispatchGestureEvent('gesture-clap');
            }
        }

        // 2. DANCE DETECTION (Calculates multi-axis variance of body center over time)
        if (leftShoulder && rightShoulder && leftHip && rightHip) {
            // Compute a stable center point of the torso
            const torsoCenterX = (leftShoulder.x + rightShoulder.x + leftHip.x + rightHip.x) / 4;
            const torsoCenterY = (leftShoulder.y + rightShoulder.y + leftHip.y + rightHip.y) / 4;

            this.danceHistory.push({ x: torsoCenterX, y: torsoCenterY, time: Date.now() });
            if (this.danceHistory.length > this.danceWindowSize) {
                this.danceHistory.shift();
            }

            if (this.danceHistory.length === this.danceWindowSize) {
                const variance = this.calculateTorsoVariance();
                // Threshold matching intentional lateral and vertical rhythmic movement
                if (variance > 0.0015) { 
                    this.dispatchGestureEvent('gesture-dance');
                }
            }
        }
    }

    calculateTorsoVariance() {
        const mean = this.danceHistory.reduce((acc, pt) => ({ x: acc.x + pt.x, y: acc.y + pt.y }), { x: 0, y: 0 });
        mean.x /= this.danceHistory.length;
        mean.y /= this.danceHistory.length;

        let totalVariance = 0;
        for (const pt of this.danceHistory) {
            const dx = pt.x - mean.x;
            const dy = pt.y - mean.y;
            totalVariance += (dx * dx + dy * dy);
        }
        return totalVariance / this.danceHistory.length;
    }

    dispatchGestureEvent(eventName) {
        const event = new CustomEvent(eventName);
        window.dispatchEvent(event);
    }
}